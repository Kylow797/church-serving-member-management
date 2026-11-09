// API-level tests: createApi mounted on an express app (ephemeral port), in-memory DB,
// real serving.config.yaml and an injectable clock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb, syncConfig } from '../db/index.js';
import { loadConfig } from '../config.js';
import { createApi } from '../routes.js';
import { saturdaysOf } from '../dates.js';
import { validateSession } from '../scheduler.js';

const CODE = '1234';
const DEC = saturdaysOf('2026-12'); // 05 12 19 26
// Kuala Lumpur is UTC+8: noon local = 04:00Z.
const kl = (date) => new Date(`${date}T04:00:00Z`);

async function boot() {
  const config = loadConfig();
  const db = openDb(':memory:');
  syncConfig(db, config);
  let nowDate = kl('2026-12-01');
  const { router, service } = createApi({ db, getConfig: () => config, setConfig() {}, now: () => nowDate });
  const app = express();
  app.use('/api', router);
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, admin = true) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(admin ? { 'X-Admin-Code': CODE } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };
  const people = config.people;
  const submitAll = async (month, dates, filter = () => true) => {
    for (const p of people.filter(filter)) {
      const r = await api('PUT', `/api/availability/${month}/${p.id}`, { dates });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
  };
  return {
    config, db, service, api, submitAll, people,
    setNow: (date) => { nowDate = kl(date); },
    close: () => new Promise((res) => server.close(res)),
  };
}

const sessionOf = (payload, date) => payload.sessions.find((s) => s.date === date);
const sig = (s) => JSON.stringify(s.assignments.map((a) => [a.roleId, a.slot, a.personId, a.locked]));

let ctx;
before(async () => { ctx = await boot(); });
after(async () => { await ctx.close(); });

test('(a) reshuffle mid-month keeps past Saturdays frozen', async () => {
  const { api, submitAll, setNow } = ctx;
  setNow('2026-12-01');
  await submitAll('2026-12', DEC);
  const gen = await api('POST', '/api/admin/months/2026-12/generate', {});
  assert.equal(gen.status, 200, JSON.stringify(gen.json));
  assert.ok(gen.json.sessions.every((s) => s.assignments.length > 0), 'all four Saturdays staffed');

  // An admin lock on a past Saturday must survive too.
  const lockTarget = sessionOf(gen.json, DEC[0]).assignments[0];
  const lock = await api('PUT', `/api/admin/sessions/${DEC[0]}/slot`, { roleId: lockTarget.roleId, slot: lockTarget.slot, personId: lockTarget.personId });
  assert.equal(lock.status, 200);

  // Now is after the 2nd Saturday (Dec 12), before the 3rd.
  setNow('2026-12-13');
  const before1 = sessionOf((await api('GET', '/api/months/2026-12')).json, DEC[0]);
  const before2 = sessionOf((await api('GET', '/api/months/2026-12')).json, DEC[1]);

  // Make it hostile: everyone drops out of the past dates; reshuffle repeatedly.
  await ctx.submitAll('2026-12', DEC.slice(2));
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', '/api/admin/months/2026-12/generate', { reshuffle: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(sig(sessionOf(r.json, DEC[0])), sig(before1), `Dec 5 changed on reshuffle ${i}`);
    assert.equal(sig(sessionOf(r.json, DEC[1])), sig(before2), `Dec 12 changed on reshuffle ${i}`);
  }
  // Same for a non-reshuffle regenerate and for clearLocks (locks are cleared, rows must still stay).
  for (const body of [{}, { clearLocks: true }]) {
    const r = await api('POST', '/api/admin/months/2026-12/generate', body);
    const strip = (s) => JSON.stringify(s.assignments.map((a) => [a.roleId, a.slot, a.personId]));
    assert.equal(strip(sessionOf(r.json, DEC[0])), strip(before1), `Dec 5 changed with ${JSON.stringify(body)}`);
    assert.equal(strip(sessionOf(r.json, DEC[1])), strip(before2), `Dec 12 changed with ${JSON.stringify(body)}`);
  }
});

test('(a2) future Saturdays do still change on reshuffle', async () => {
  const { api, setNow } = ctx;
  setNow('2026-12-01');
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const r = await api('POST', '/api/admin/months/2026-12/generate', { reshuffle: true, clearLocks: true });
    seen.add(sig(sessionOf(r.json, DEC[3])) + sig(sessionOf(r.json, DEC[2])));
  }
  assert.ok(seen.size > 1, 'reshuffle with seed randomisation should vary open Saturdays');
});

test('(b) automation generates nothing when nobody submitted availability', async () => {
  const c = await boot();
  try {
    c.setNow('2026-12-01'); // Dec window closed on Nov 30
    assert.deepEqual(c.service.runAutomation(), []);
    const m = (await c.api('GET', '/api/months/2026-12')).json;
    assert.equal(m.generatedAt, null);
    assert.ok(m.sessions.every((s) => s.assignments.length === 0));
    // Still nothing for next month (window not closed yet) and idempotent.
    assert.deepEqual(c.service.runAutomation(), []);

    // Positive control: with availability it does generate, exactly once.
    await c.submitAll('2026-12', DEC);
    assert.deepEqual(c.service.runAutomation(), ['2026-12']);
    const m2 = (await c.api('GET', '/api/months/2026-12')).json;
    assert.ok(m2.generatedAt);
    assert.ok(m2.sessions.some((s) => s.assignments.length > 0));
    assert.deepEqual(c.service.runAutomation(), []);
  } finally { await c.close(); }
});

test('(b2) automation waits for the window to close', async () => {
  const c = await boot();
  try {
    c.setNow('2026-11-27'); // Dec window open, not closed
    await c.submitAll('2026-12', DEC);
    assert.deepEqual(c.service.runAutomation(), []);
    c.setNow('2026-12-01');
    assert.deepEqual(c.service.runAutomation(), ['2026-12']);
  } finally { await c.close(); }
});

test('(c) warnings carry personId and slot for admin-placed unavailable / mismatched people', async () => {
  const c = await boot();
  try {
    c.setNow('2026-12-01');
    // Everyone available except sarah-tan on Dec 5.
    await c.submitAll('2026-12', DEC, (p) => p.id !== 'sarah-tan');
    await c.api('PUT', '/api/availability/2026-12/sarah-tan', { dates: DEC.slice(1) });
    await c.api('POST', '/api/admin/months/2026-12/generate', {});

    // sarah-tan holds lead_singer; put her there on Dec 5 where she is unavailable.
    let r = await c.api('PUT', `/api/admin/sessions/${DEC[0]}/slot`, { roleId: 'lead_singer', slot: 0, personId: 'sarah-tan' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const s = sessionOf(r.json, DEC[0]);
    const slotOfSarah = s.assignments.find((a) => a.personId === 'sarah-tan');
    const un = s.warnings.find((w) => w.code === 'UNAVAILABLE');
    assert.ok(un, JSON.stringify(s.warnings));
    assert.equal(un.personId, 'sarah-tan');
    assert.equal(un.slot, slotOfSarah.slot);
    assert.equal(un.roleId, 'lead_singer');
    assert.equal(un.date, DEC[0]);

    // marcus-yeo is a drummer only; put him on the sound desk.
    r = await c.api('PUT', `/api/admin/sessions/${DEC[0]}/slot`, { roleId: 'sound', slot: 0, personId: 'marcus-yeo' });
    assert.equal(r.status, 200);
    const mm = sessionOf(r.json, DEC[0]).warnings.find((w) => w.code === 'ROLE_MISMATCH' && w.personId === 'marcus-yeo');
    assert.ok(mm, JSON.stringify(sessionOf(r.json, DEC[0]).warnings));
    assert.equal(mm.personId, 'marcus-yeo');
    assert.equal(mm.slot, 0);
    assert.equal(mm.roleId, 'sound');
  } finally { await c.close(); }
});

test('(c2) validateSession INACTIVE_PERSON carries personId and slot (API refuses to assign inactive people)', () => {
  const roster = {
    ministries: [{ id: 'u', name: 'u', active: true, minSenior: null, maxNewcomers: null, roles: [{ id: 'usher', name: 'usher', min: 1, max: 2, active: true }] }],
    people: [
      { id: 'a', name: 'a', rank: 2, roles: ['usher'], maxPerMonth: null, active: true },
      { id: 'gone', name: 'gone', rank: 2, roles: ['usher'], maxPerMonth: null, active: false },
    ],
  };
  const ws = validateSession({
    date: DEC[0], roster, availableIds: ['a', 'gone'],
    assignments: [{ date: DEC[0], roleId: 'usher', slot: 0, personId: 'a' }, { date: DEC[0], roleId: 'usher', slot: 1, personId: 'gone' }],
  });
  const w = ws.find((x) => x.code === 'INACTIVE_PERSON');
  assert.ok(w, JSON.stringify(ws));
  assert.equal(w.personId, 'gone');
  assert.equal(w.slot, 1);
});

test('admin endpoints reject a missing code', async () => {
  const r = await ctx.api('POST', '/api/admin/months/2026-12/generate', {}, false);
  assert.equal(r.status, 401);
});
