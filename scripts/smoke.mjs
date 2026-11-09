#!/usr/bin/env node
// End-to-end smoke test against a RUNNING server. Usage: BASE_URL=http://localhost:3001 npm run smoke
// WARNING: this writes data (availability, generated schedule, a swap, a cancel/restore) into the
// target month of whatever database the server is using. Point the server at a throwaway DB first:
//   DB_PATH=/tmp/smoke.db npm start
import { saturdaysOf } from '../server/dates.js';

const BASE = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const CODE = process.env.ADMIN_CODE || '1234';

let failed = 0;
const results = [];
function record(ok, name, detail = '') {
  results.push({ ok, name, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}
async function step(name, fn) {
  try {
    const r = await fn();
    if (r === 'skip') { console.log(`SKIP  ${name}`); return; }
    record(true, name);
  } catch (e) {
    record(false, name, e.message);
  }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

async function api(method, path, { body, code } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (code) headers['X-Admin-Code'] = code;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}
const expectOk = (r, what) => ok(r.status >= 200 && r.status < 300, `${what}: HTTP ${r.status} ${JSON.stringify(r.json)}`);

const ctx = {};

await step('GET /api/status', async () => {
  const r = await api('GET', '/api/status');
  expectOk(r, 'status');
  const s = r.json;
  ok(typeof s.churchName === 'string' && s.churchName, 'churchName missing');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(s.today), `bad today ${s.today}`);
  ok(/^\d{4}-\d{2}$/.test(s.targetMonth), `bad targetMonth ${s.targetMonth}`);
  ok(['upcoming', 'open', 'closed'].includes(s.window?.state), `bad window ${JSON.stringify(s.window)}`);
  ctx.status = s;
});
if (!ctx.status) { console.log('\nServer not reachable or unhealthy; aborting.'); process.exit(1); }
const MONTH = ctx.status.targetMonth;
const DATES = saturdaysOf(MONTH);

await step('GET /api/roster', async () => {
  const r = await api('GET', '/api/roster');
  expectOk(r, 'roster');
  ok(Array.isArray(r.json.ministries) && r.json.ministries.length > 0, 'no ministries');
  ok(Array.isArray(r.json.people) && r.json.people.length > 0, 'no people');
  ctx.roster = r.json;
  ctx.people = r.json.people.filter((p) => p.active);
  ok(ctx.people.length > 0, 'no active people');
});

await step('401 without admin code on admin endpoints', async () => {
  for (const [m, p, b] of [
    ['POST', `/api/admin/months/${MONTH}/generate`, {}],
    ['GET', `/api/admin/availability/${MONTH}`],
    ['PUT', `/api/admin/sessions/${DATES[0]}/slot`, { roleId: 'x', slot: 0, personId: null }],
    ['POST', `/api/admin/sessions/${DATES[0]}/cancel`, { reason: 'x' }],
    ['POST', `/api/admin/sessions/${DATES[0]}/restore`, {}],
    ['POST', '/api/admin/reload-config', {}],
  ]) {
    const none = await api(m, p, { body: b });
    ok(none.status === 401, `${m} ${p} without code gave ${none.status}`);
    const wrong = await api(m, p, { body: b, code: 'definitely-wrong' });
    ok(wrong.status === 401, `${m} ${p} with wrong code gave ${wrong.status}`);
  }
  const bad = await api('POST', '/api/admin/login', { body: { code: 'definitely-wrong' } });
  ok(bad.status === 401, `login with wrong code gave ${bad.status}`);
  const good = await api('POST', '/api/admin/login', { body: { code: CODE } });
  ok(good.status === 200 && good.json?.ok === true, `login with right code gave ${good.status} ${JSON.stringify(good.json)} (set ADMIN_CODE if changed)`);
});

await step('availability write is blocked outside the window without admin code (403)', async () => {
  if (ctx.status.window.state === 'open') return 'skip';
  const r = await api('PUT', `/api/availability/${MONTH}/${ctx.people[0].id}`, { body: { dates: [DATES[0]] } });
  ok(r.status === 403, `expected 403, got ${r.status} ${JSON.stringify(r.json)}`);
});

await step('availability validation: non-Saturday and unknown person rejected (400)', async () => {
  const nonSat = Array.from({ length: 7 }, (_, i) => `${MONTH}-${String(i + 1).padStart(2, '0')}`)
    .find((d) => !DATES.includes(d));
  const r1 = await api('PUT', `/api/availability/${MONTH}/${ctx.people[0].id}`, { body: { dates: [nonSat] }, code: CODE });
  ok(r1.status === 400, `non-Saturday ${nonSat}: expected 400, got ${r1.status}`);
  const r2 = await api('PUT', `/api/availability/${MONTH}/no-such-person`, { body: { dates: [DATES[0]] }, code: CODE });
  ok(r2.status === 400, `unknown person: expected 400, got ${r2.status}`);
});

await step(`submit availability for most people (${MONTH}) using the admin override`, async () => {
  let submitted = 0;
  for (const [i, p] of ctx.people.entries()) {
    if (i % 7 === 3) continue; // a few people never respond
    const dates = DATES.filter((_, di) => !(i % 5 === 0 && di === 0)); // some miss the first Saturday
    const r = await api('PUT', `/api/availability/${MONTH}/${p.id}`, { body: { dates }, code: CODE });
    expectOk(r, `PUT availability ${p.id}`);
    ok(JSON.stringify(r.json.dates) === JSON.stringify(dates), `echo mismatch for ${p.id}`);
    submitted++;
  }
  const back = await api('GET', `/api/availability/${MONTH}/${ctx.people[0].id}`);
  expectOk(back, 'GET availability');
  ok(Array.isArray(back.json.dates), 'dates missing');
  const matrix = await api('GET', `/api/admin/availability/${MONTH}`, { code: CODE });
  expectOk(matrix, 'admin availability');
  ok(Object.keys(matrix.json).length > 0, 'admin availability matrix empty');
  ok(submitted > 0, 'nobody submitted');
});

let month;
await step('generate schedule', async () => {
  const r = await api('POST', `/api/admin/months/${MONTH}/generate`, { body: { clearLocks: true }, code: CODE });
  expectOk(r, 'generate');
  month = r.json;
  ok(month.month === MONTH, `month mismatch ${month.month}`);
  ok(month.generatedAt, 'generatedAt not set');
  ok(JSON.stringify(month.sessions.map((s) => s.date)) === JSON.stringify(DATES), `sessions ${month.sessions.map((s) => s.date)} != ${DATES}`);
  ok(month.sessions.some((s) => s.assignments.length > 0), 'no assignments generated');
});

const people = () => new Map(ctx.roster.people.map((p) => [p.id, p]));
const roleToMinistry = () => {
  const m = new Map();
  for (const mi of ctx.roster.ministries) for (const r of mi.roles) m.set(r.id, mi);
  return m;
};

await step('hard rules: one role per person per session, holders only, available only', async () => {
  const ppl = people();
  const matrix = (await api('GET', `/api/admin/availability/${MONTH}`, { code: CODE })).json;
  for (const s of month.sessions) {
    const seen = new Set();
    for (const a of s.assignments) {
      ok(!seen.has(a.personId), `${a.personId} double-booked on ${s.date}`);
      seen.add(a.personId);
      ok(ppl.get(a.personId)?.roles.includes(a.roleId), `${a.personId} lacks ${a.roleId} on ${s.date}`);
      ok((matrix[s.date] || []).includes(a.personId), `${a.personId} not available ${s.date}`);
    }
  }
  for (const p of ctx.people.filter((x) => x.maxPerMonth != null)) {
    const n = month.sessions.flatMap((s) => s.assignments).filter((a) => a.personId === p.id).length;
    ok(n <= p.maxPerMonth, `${p.id} has ${n} > maxPerMonth ${p.maxPerMonth}`);
  }
});

await step('seniority holds for every session (or a matching warning is present)', async () => {
  const ppl = people();
  const r2m = roleToMinistry();
  for (const s of month.sessions) {
    if (s.status !== 'scheduled') continue;
    for (const mi of ctx.roster.ministries.filter((m) => m.active && (m.minSenior != null || m.maxNewcomers != null))) {
      const ranks = s.assignments.filter((a) => r2m.get(a.roleId)?.id === mi.id).map((a) => ppl.get(a.personId).rank);
      const warns = s.warnings.map((w) => `${w.code}:${w.ministryId ?? ''}`);
      if (mi.minSenior != null && ranks.filter((r) => r === 3).length < mi.minSenior) {
        ok(warns.includes(`NO_SENIOR:${mi.id}`), `${s.date} ${mi.id}: seniors ${ranks.filter((r) => r === 3).length} < ${mi.minSenior} with no NO_SENIOR warning`);
      }
      if (mi.maxNewcomers != null && ranks.filter((r) => r === 1).length > mi.maxNewcomers) {
        ok(warns.includes(`TOO_MANY_NEWCOMERS:${mi.id}`), `${s.date} ${mi.id}: newcomers over ${mi.maxNewcomers} with no TOO_MANY_NEWCOMERS warning`);
      }
    }
  }
});

await step('generate is deterministic for the default seed', async () => {
  const r = await api('POST', `/api/admin/months/${MONTH}/generate`, { body: { clearLocks: true }, code: CODE });
  expectOk(r, 'regenerate');
  const strip = (m) => JSON.stringify(m.sessions.map((s) => s.assignments));
  ok(strip(r.json) === strip(month), 'regeneration with same inputs changed the schedule');
  month = r.json;
});

await step('swap two slots via PUT slot', async () => {
  const ppl = people();
  let pair = null;
  outer: for (const s of month.sessions) {
    const as = s.assignments;
    for (const x of as) for (const y of as) {
      if (x === y || (x.roleId === y.roleId && x.slot === y.slot)) continue;
      if (ppl.get(x.personId).roles.includes(y.roleId) && ppl.get(y.personId).roles.includes(x.roleId)) { pair = { s, x, y }; break outer; }
    }
  }
  if (!pair) return 'skip';
  const { s, x, y } = pair;
  const r = await api('PUT', `/api/admin/sessions/${s.date}/slot`, { body: { roleId: y.roleId, slot: y.slot, personId: x.personId }, code: CODE });
  expectOk(r, 'swap');
  const after = r.json.sessions.find((z) => z.date === s.date).assignments;
  const at = (role, slot) => after.find((a) => a.roleId === role && a.slot === slot);
  ok(at(y.roleId, y.slot)?.personId === x.personId, `${x.personId} not in ${y.roleId}/${y.slot}`);
  ok(at(x.roleId, x.slot)?.personId === y.personId, `${y.personId} not in ${x.roleId}/${x.slot}`);
  ok(at(y.roleId, y.slot).locked && at(x.roleId, x.slot).locked, 'swapped slots should be locked');
  ok(new Set(after.map((a) => a.personId)).size === after.length, 'double booking after swap');
  month = r.json;
});

await step('clear a slot, then set it back', async () => {
  const s = month.sessions.find((z) => z.assignments.length > 0);
  const a = s.assignments[0];
  const cleared = await api('PUT', `/api/admin/sessions/${s.date}/slot`, { body: { roleId: a.roleId, slot: a.slot, personId: null }, code: CODE });
  expectOk(cleared, 'clear');
  ok(!cleared.json.sessions.find((z) => z.date === s.date).assignments.some((z) => z.roleId === a.roleId && z.slot === a.slot), 'slot not cleared');
  const set = await api('PUT', `/api/admin/sessions/${s.date}/slot`, { body: { roleId: a.roleId, slot: a.slot, personId: a.personId }, code: CODE });
  expectOk(set, 'set');
  ok(set.json.sessions.find((z) => z.date === s.date).assignments.some((z) => z.personId === a.personId && z.locked), 'slot not restored/locked');
  month = set.json;
});

await step('cancel then restore a session', async () => {
  const date = DATES[DATES.length - 1];
  const c = await api('POST', `/api/admin/sessions/${date}/cancel`, { body: { reason: 'Smoke test closure' }, code: CODE });
  expectOk(c, 'cancel');
  let s = c.json.sessions.find((z) => z.date === date);
  ok(s.status === 'cancelled' && s.cancelReason === 'Smoke test closure', `bad cancelled state ${JSON.stringify(s)}`);
  ok(s.assignments.length === 0 && s.warnings.length === 0, 'cancelled session must have no assignments or warnings');
  const blocked = await api('PUT', `/api/admin/sessions/${date}/slot`, { body: { roleId: ctx.roster.ministries[0].roles[0].id, slot: 0, personId: null }, code: CODE });
  ok(blocked.status === 400, `slot edit on cancelled session: expected 400, got ${blocked.status}`);
  const r = await api('POST', `/api/admin/sessions/${date}/restore`, { code: CODE });
  expectOk(r, 'restore');
  s = r.json.sessions.find((z) => z.date === date);
  ok(s.status === 'scheduled' && s.cancelReason == null, `bad restored state ${JSON.stringify(s)}`);
  ok(s.assignments.length > 0, 'restore should refill the session');
});

await step('public month read matches and works without a code', async () => {
  const r = await api('GET', `/api/months/${MONTH}`);
  expectOk(r, 'GET month');
  ok(r.json.sessions.length === DATES.length, 'session count');
});

const passed = results.filter((r) => r.ok).length;
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed}/${results.length} checks passed against ${BASE} (month ${MONTH})`);
process.exit(failed ? 1 : 0);
