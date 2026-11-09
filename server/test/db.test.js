// DB layer tests against an in-memory SQLite. See docs/CONTRACT.md section 4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, syncConfig, getRoster, ensureSessions, getMonth, getAvailability, getPersonAvailability,
  setAvailability, replaceGenerated, setSlot, setSessionStatus, clearLocks, getAssignmentCounts,
  transaction,
} from '../db/index.js';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEC = ['2026-12-05', '2026-12-12', '2026-12-19', '2026-12-26'];

const baseConfig = () => ({
  settings: {},
  ministries: [
    {
      id: 'worship', name: 'Worship Team', seniority: { minSenior: 1, maxNewcomers: 3 },
      roles: [
        { id: 'lead', name: 'Lead', min: 1, max: 1 },
        { id: 'voc', name: 'Vocalist', min: 1, max: 2 },
      ],
    },
    { id: 'ushering', name: 'Ushering', roles: [{ id: 'usher', name: 'Usher', min: 2, max: 3 }] },
  ],
  people: [
    { id: 'ann', name: 'Ann', rank: 3, roles: ['lead', 'voc'] },
    { id: 'bob', name: 'Bob', rank: 2, roles: ['lead', 'voc', 'usher'], maxPerMonth: 2 },
    { id: 'cat', name: 'Cat', rank: 1, roles: ['voc', 'usher'] },
    { id: 'dan', name: 'Dan', rank: 2, roles: ['usher'] },
  ],
});

function fresh() {
  const db = openDb(':memory:');
  syncConfig(db, baseConfig());
  ensureSessions(db, DEC);
  return db;
}
const session = (db, date) => getMonth(db, '2026-12').sessions.find((s) => s.date === date);
const A = (date, roleId, slot, personId) => ({ date, roleId, slot, personId });
const throwsCode = (fn, code) =>
  assert.throws(fn, (e) => { assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return true; });

// ---------- open / sync ----------
test('openDb(:memory:) migrates and enables foreign keys', () => {
  const db = openDb(':memory:');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.ok(db.prepare('PRAGMA user_version').get().user_version >= 1);
});

test('syncConfig: first sync adds, identical resync changes nothing', () => {
  const db = openDb(':memory:');
  const r1 = syncConfig(db, baseConfig());
  assert.ok(r1.added > 0);
  assert.equal(r1.deactivated, 0);
  const r2 = syncConfig(db, baseConfig());
  assert.deepEqual(r2, { added: 0, updated: 0, deactivated: 0 });
});

test('syncConfig: roster shape and config order', () => {
  const db = openDb(':memory:');
  syncConfig(db, baseConfig());
  const r = getRoster(db);
  assert.deepEqual(r.ministries.map((m) => m.id), ['worship', 'ushering']);
  assert.equal(r.ministries[0].minSenior, 1);
  assert.equal(r.ministries[0].maxNewcomers, 3);
  assert.equal(r.ministries[1].minSenior, null);
  assert.deepEqual(r.ministries[0].roles.map((x) => x.id), ['lead', 'voc']);
  assert.deepEqual(r.ministries[0].roles[1], { id: 'voc', name: 'Vocalist', min: 1, max: 2, active: true });
  assert.deepEqual(r.people.map((p) => p.id), ['ann', 'bob', 'cat', 'dan']);
  assert.deepEqual(r.people[1], { id: 'bob', name: 'Bob', rank: 2, roles: ['lead', 'voc', 'usher'], maxPerMonth: 2, active: true });
  assert.equal(r.people[0].maxPerMonth, null);

  const reordered = baseConfig();
  reordered.people.reverse();
  reordered.ministries.reverse();
  syncConfig(db, reordered);
  const r2 = getRoster(db);
  assert.deepEqual(r2.people.map((p) => p.id), ['dan', 'cat', 'bob', 'ann']);
  assert.deepEqual(r2.ministries.map((m) => m.id), ['ushering', 'worship']);
});

test('syncConfig: removed entries are soft-deleted and can come back; updates apply', () => {
  const db = openDb(':memory:');
  syncConfig(db, baseConfig());
  const c = baseConfig();
  c.people = c.people.filter((p) => p.id !== 'cat');
  c.ministries[0].roles = c.ministries[0].roles.filter((r) => r.id !== 'voc');
  c.people = c.people.map((p) => ({ ...p, roles: p.roles.filter((r) => r !== 'voc') }));
  c.ministries = c.ministries.filter((m) => m.id !== 'ushering');
  c.people = c.people.map((p) => ({ ...p, roles: p.roles.filter((r) => r !== 'usher') }));
  const res = syncConfig(db, c);
  assert.equal(res.deactivated, 1 + 1 + 1 + 1 + 0, 'person cat, role voc, ministry ushering, role usher');
  const r = getRoster(db);
  const cat = r.people.find((p) => p.id === 'cat');
  assert.ok(cat, 'inactive people stay in the roster');
  assert.equal(cat.active, false);
  assert.equal(r.ministries.find((m) => m.id === 'ushering').active, false);
  assert.equal(r.ministries[0].roles.find((x) => x.id === 'voc').active, false);
  assert.deepEqual(r.people.find((p) => p.id === 'ann').roles, ['lead'], 'person_roles replaced');

  const back = baseConfig();
  back.people[0].name = 'Ann Renamed';
  const res2 = syncConfig(db, back);
  assert.equal(res2.deactivated, 0);
  assert.ok(res2.updated >= 1);
  const r2 = getRoster(db);
  assert.equal(r2.people.find((p) => p.id === 'cat').active, true);
  assert.equal(r2.people.find((p) => p.id === 'ann').name, 'Ann Renamed');
  assert.equal(r2.ministries.find((m) => m.id === 'ushering').active, true);
});

test('syncConfig is transactional: a bad config leaves the DB unchanged', () => {
  const db = openDb(':memory:');
  syncConfig(db, baseConfig());
  const bad = baseConfig();
  bad.people.push({ id: 'zed', name: 'Zed', rank: 9, roles: [] });
  assert.throws(() => syncConfig(db, bad));
  const r = getRoster(db);
  assert.equal(r.people.length, 4);
  assert.ok(!r.people.some((p) => p.id === 'zed'));
  const bad2 = baseConfig();
  bad2.people[0].name = 'Changed Before Failure';
  bad2.people.push({ id: 'zed', name: 'Zed', rank: 1, roles: ['nope'] });
  assert.throws(() => syncConfig(db, bad2));
  assert.equal(getRoster(db).people[0].name, 'Ann', 'earlier changes rolled back');
});

// ---------- availability ----------
test('setAvailability replaces per person and month', () => {
  const db = fresh();
  setAvailability(db, 'ann', '2026-12', [DEC[0], DEC[1]]);
  setAvailability(db, 'bob', '2026-12', [DEC[1]]);
  setAvailability(db, 'ann', '2027-01', ['2027-01-02']);
  assert.deepEqual(getPersonAvailability(db, 'ann', '2026-12'), [DEC[0], DEC[1]]);
  setAvailability(db, 'ann', '2026-12', [DEC[3]]);
  assert.deepEqual(getPersonAvailability(db, 'ann', '2026-12'), [DEC[3]]);
  assert.deepEqual(getPersonAvailability(db, 'ann', '2027-01'), ['2027-01-02'], 'other months untouched');
  const all = getAvailability(db, '2026-12');
  assert.deepEqual(
    all.map((a) => `${a.personId}@${a.date}`).sort(),
    [`ann@${DEC[3]}`, `bob@${DEC[1]}`].sort(),
  );
  setAvailability(db, 'ann', '2026-12', []);
  assert.deepEqual(getPersonAvailability(db, 'ann', '2026-12'), []);
});

test('setAvailability duplicates collapse; unknown person / wrong month rejected atomically', () => {
  const db = fresh();
  setAvailability(db, 'ann', '2026-12', [DEC[0], DEC[0]]);
  assert.deepEqual(getPersonAvailability(db, 'ann', '2026-12'), [DEC[0]]);
  throwsCode(() => setAvailability(db, 'nobody', '2026-12', [DEC[0]]), 'NOT_FOUND');
  assert.throws(() => setAvailability(db, 'ann', '2026-12', [DEC[1], '2027-01-02']));
  assert.deepEqual(getPersonAvailability(db, 'ann', '2026-12'), [DEC[0]], 'failed replace keeps old data');
});

// ---------- sessions / generated ----------
test('ensureSessions is idempotent and creates scheduled sessions', () => {
  const db = fresh();
  ensureSessions(db, DEC);
  const m = getMonth(db, '2026-12');
  assert.equal(m.generatedAt, null);
  assert.deepEqual(m.sessions.map((s) => s.date), DEC);
  assert.ok(m.sessions.every((s) => s.status === 'scheduled' && s.cancelReason === null && s.assignments.length === 0));
});

test('replaceGenerated inserts unlocked, stamps generatedAt, and keeps locked on rerun', () => {
  const db = fresh();
  replaceGenerated(db, '2026-12', [A(DEC[0], 'lead', 0, 'ann'), A(DEC[0], 'voc', 0, 'cat'), A(DEC[1], 'lead', 0, 'ann')]);
  const m = getMonth(db, '2026-12');
  assert.ok(m.generatedAt && !Number.isNaN(Date.parse(m.generatedAt)));
  assert.equal(session(db, DEC[0]).assignments.length, 2);
  assert.ok(session(db, DEC[0]).assignments.every((a) => a.locked === false));

  setSlot(db, DEC[0], 'lead', 0, 'bob'); // locks bob in lead
  replaceGenerated(db, '2026-12', [A(DEC[0], 'voc', 0, 'ann'), A(DEC[2], 'voc', 0, 'cat')]);
  assert.deepEqual(session(db, DEC[0]).assignments, [
    { roleId: 'lead', slot: 0, personId: 'bob', locked: true },
    { roleId: 'voc', slot: 0, personId: 'ann', locked: false },
  ]);
  assert.equal(session(db, DEC[1]).assignments.length, 0, 'old unlocked removed');
  assert.equal(session(db, DEC[2]).assignments.length, 1);
});

test('replaceGenerated rejects duplicates atomically (double booking at API level)', () => {
  const db = fresh();
  replaceGenerated(db, '2026-12', [A(DEC[0], 'lead', 0, 'ann')]);
  const before = getMonth(db, '2026-12');
  throwsCode(() => replaceGenerated(db, '2026-12', [A(DEC[0], 'lead', 0, 'bob'), A(DEC[0], 'voc', 0, 'bob')]), 'CONFLICT');
  throwsCode(() => replaceGenerated(db, '2026-12', [A(DEC[0], 'voc', 0, 'ann'), A(DEC[0], 'voc', 0, 'bob')]), 'CONFLICT');
  assert.deepEqual(getMonth(db, '2026-12'), before, 'transaction rolled back, old rows + generatedAt intact');
});

test('replaceGenerated cannot double-book against a locked assignment', () => {
  const db = fresh();
  setSlot(db, DEC[0], 'lead', 0, 'ann');
  throwsCode(() => replaceGenerated(db, '2026-12', [A(DEC[0], 'voc', 0, 'ann')]), 'CONFLICT');
  throwsCode(() => replaceGenerated(db, '2026-12', [A(DEC[0], 'lead', 0, 'bob')]), 'CONFLICT');
});

test('replaceGenerated: cancelled / missing sessions and out-of-month dates rejected', () => {
  const db = fresh();
  setSessionStatus(db, DEC[1], 'cancelled', 'Rain');
  throwsCode(() => replaceGenerated(db, '2026-12', [A(DEC[1], 'lead', 0, 'ann')]), 'CANCELLED');
  throwsCode(() => replaceGenerated(db, '2026-12', [A('2026-12-02', 'lead', 0, 'ann')]), 'NOT_FOUND');
  assert.throws(() => replaceGenerated(db, '2026-12', [A('2027-01-02', 'lead', 0, 'ann')]));
});

test('clearLocks unlocks everything in the month', () => {
  const db = fresh();
  setSlot(db, DEC[0], 'lead', 0, 'ann');
  setSlot(db, DEC[1], 'lead', 0, 'bob');
  clearLocks(db, '2026-12');
  assert.ok(getMonth(db, '2026-12').sessions.flatMap((s) => s.assignments).every((a) => !a.locked));
  replaceGenerated(db, '2026-12', []);
  assert.equal(getMonth(db, '2026-12').sessions.flatMap((s) => s.assignments).length, 0);
});

// ---------- setSlot ----------
test('setSlot assigns, locks, and replaces an occupant', () => {
  const db = fresh();
  setSlot(db, DEC[0], 'lead', 0, 'ann');
  assert.deepEqual(session(db, DEC[0]).assignments, [{ roleId: 'lead', slot: 0, personId: 'ann', locked: true }]);
  setSlot(db, DEC[0], 'lead', 0, 'bob');
  assert.deepEqual(session(db, DEC[0]).assignments, [{ roleId: 'lead', slot: 0, personId: 'bob', locked: true }]);
});

test('setSlot swaps when the person already holds another slot, both locked', () => {
  const db = fresh();
  replaceGenerated(db, '2026-12', [A(DEC[0], 'lead', 0, 'ann'), A(DEC[0], 'voc', 0, 'bob')]);
  setSlot(db, DEC[0], 'lead', 0, 'bob');
  const asg = session(db, DEC[0]).assignments;
  assert.equal(asg.length, 2);
  assert.deepEqual(asg.find((a) => a.roleId === 'lead'), { roleId: 'lead', slot: 0, personId: 'bob', locked: true });
  assert.deepEqual(asg.find((a) => a.roleId === 'voc'), { roleId: 'voc', slot: 0, personId: 'ann', locked: true });
});

test('setSlot: moving a person into an empty slot never leaves them double-booked', () => {
  const db = fresh();
  replaceGenerated(db, '2026-12', [A(DEC[0], 'lead', 0, 'ann')]);
  setSlot(db, DEC[0], 'voc', 1, 'ann');
  const asg = session(db, DEC[0]).assignments;
  assert.deepEqual(asg, [{ roleId: 'voc', slot: 1, personId: 'ann', locked: true }]);
});

test('setSlot null clears; clearing an empty slot is a no-op', () => {
  const db = fresh();
  replaceGenerated(db, '2026-12', [A(DEC[0], 'lead', 0, 'ann')]);
  setSlot(db, DEC[0], 'lead', 0, null);
  assert.deepEqual(session(db, DEC[0]).assignments, []);
  assert.doesNotThrow(() => setSlot(db, DEC[0], 'lead', 0, null));
});

test('setSlot errors: NOT_FOUND, CANCELLED, bad slot', () => {
  const db = fresh();
  throwsCode(() => setSlot(db, '2026-12-06', 'lead', 0, 'ann'), 'NOT_FOUND');
  throwsCode(() => setSlot(db, DEC[0], 'nope', 0, 'ann'), 'NOT_FOUND');
  throwsCode(() => setSlot(db, DEC[0], 'lead', 0, 'nobody'), 'NOT_FOUND');
  assert.throws(() => setSlot(db, DEC[0], 'lead', 1, 'ann'), /./, 'slot >= role.max');
  assert.throws(() => setSlot(db, DEC[0], 'lead', -1, 'ann'));
  setSessionStatus(db, DEC[0], 'cancelled', 'Typhoon');
  throwsCode(() => setSlot(db, DEC[0], 'lead', 0, 'ann'), 'CANCELLED');
  throwsCode(() => setSlot(db, DEC[0], 'lead', 0, null), 'CANCELLED');
});

test('setSlot failure leaves no partial change (CONFLICT is reserved for unique violations)', () => {
  const db = fresh();
  replaceGenerated(db, '2026-12', [A(DEC[0], 'lead', 0, 'ann'), A(DEC[0], 'voc', 0, 'bob')]);
  const before = getMonth(db, '2026-12');
  assert.throws(() => setSlot(db, DEC[0], 'voc', 5, 'ann'));
  assert.deepEqual(getMonth(db, '2026-12'), before);
});

// ---------- cancel / restore ----------
test('cancel deletes assignments and stores the reason; restore clears the reason', () => {
  const db = fresh();
  replaceGenerated(db, '2026-12', [A(DEC[0], 'lead', 0, 'ann'), A(DEC[1], 'lead', 0, 'ann')]);
  setSlot(db, DEC[0], 'voc', 0, 'cat'); // locked ones go too
  setSessionStatus(db, DEC[0], 'cancelled', 'Public holiday');
  let s = session(db, DEC[0]);
  assert.equal(s.status, 'cancelled');
  assert.equal(s.cancelReason, 'Public holiday');
  assert.deepEqual(s.assignments, []);
  assert.equal(session(db, DEC[1]).assignments.length, 1, 'other sessions untouched');
  setSessionStatus(db, DEC[0], 'scheduled');
  s = session(db, DEC[0]);
  assert.equal(s.status, 'scheduled');
  assert.equal(s.cancelReason, null);
  assert.deepEqual(s.assignments, [], 'restore does not bring back assignments');
  throwsCode(() => setSessionStatus(db, '2026-12-06', 'cancelled', 'x'), 'NOT_FOUND');
  assert.throws(() => setSessionStatus(db, DEC[0], 'weird'));
});

test('replaceGenerated skips cancelled sessions when deleting and keeps them empty', () => {
  const db = fresh();
  setSessionStatus(db, DEC[1], 'cancelled', 'x');
  replaceGenerated(db, '2026-12', [A(DEC[0], 'lead', 0, 'ann')]);
  assert.equal(session(db, DEC[1]).status, 'cancelled');
  assert.deepEqual(session(db, DEC[1]).assignments, []);
});

// ---------- counts ----------
test('getAssignmentCounts: inclusive range, excludes cancelled sessions', () => {
  const db = fresh();
  replaceGenerated(db, '2026-12', [
    A(DEC[0], 'lead', 0, 'ann'), A(DEC[1], 'lead', 0, 'ann'), A(DEC[2], 'lead', 0, 'ann'),
    A(DEC[0], 'voc', 0, 'bob'), A(DEC[3], 'voc', 0, 'bob'),
  ]);
  assert.deepEqual(getAssignmentCounts(db, DEC[0], DEC[3]), { ann: 3, bob: 2 });
  assert.deepEqual(getAssignmentCounts(db, DEC[0], DEC[0]), { ann: 1, bob: 1 }, 'inclusive both ends');
  assert.deepEqual(getAssignmentCounts(db, DEC[1], DEC[2]), { ann: 2 });
  setSessionStatus(db, DEC[1], 'cancelled', 'x');
  assert.deepEqual(getAssignmentCounts(db, DEC[0], DEC[3]), { ann: 2, bob: 2 });
  assert.deepEqual(getAssignmentCounts(db, '2026-01-01', '2026-01-31'), {});
});

// ---------- DB-level integrity ----------
test('double-booking and bad rows are impossible even via raw SQL', () => {
  const db = fresh();
  const sid = db.prepare('SELECT id FROM sessions WHERE date = ?').get(DEC[0]).id;
  const ins = db.prepare('INSERT INTO assignments (session_id, role_id, slot, person_id) VALUES (?, ?, ?, ?)');
  ins.run(sid, 'lead', 0, 'ann');
  assert.throws(() => ins.run(sid, 'voc', 0, 'ann'), /UNIQUE/i, 'same person twice in a session');
  assert.throws(() => ins.run(sid, 'lead', 0, 'bob'), /UNIQUE/i, 'same slot twice');
  assert.throws(() => ins.run(sid, 'lead', 1, 'bob'), /slot exceeds/i, 'slot >= role max');
  assert.throws(() => ins.run(sid, 'voc', -1, 'bob'), /CHECK/i, 'negative slot');
  assert.throws(() => ins.run(sid, 'ghost', 0, 'bob'), /FOREIGN/i, 'unknown role');
  assert.throws(() => ins.run(sid, 'voc', 0, 'ghost'), /FOREIGN/i, 'unknown person');
  assert.throws(() => ins.run(9999, 'voc', 0, 'bob'), /FOREIGN/i, 'unknown session');
  assert.throws(() => db.prepare("UPDATE people SET rank = 4 WHERE id = 'ann'").run(), /CHECK/i);
  assert.throws(() => db.prepare("UPDATE sessions SET status = 'weird' WHERE id = ?").run(sid), /CHECK/i);
  assert.throws(() => db.prepare("INSERT INTO sessions (date) VALUES ('2026-13-45')").run(), /CHECK/i);
  assert.throws(() => db.prepare('INSERT INTO roles (id, ministry_id, name, min, max) VALUES (?, ?, ?, ?, ?)')
    .run('bad', 'worship', 'Bad', 3, 2), /CHECK/i, 'min > max');
});

test('raw SQL cannot add assignments to a cancelled session; cancelling cascades', () => {
  const db = fresh();
  const sid = db.prepare('SELECT id FROM sessions WHERE date = ?').get(DEC[0]).id;
  const ins = db.prepare('INSERT INTO assignments (session_id, role_id, slot, person_id) VALUES (?, ?, ?, ?)');
  ins.run(sid, 'lead', 0, 'ann');
  db.prepare("UPDATE sessions SET status = 'cancelled', cancel_reason = 'r' WHERE id = ?").run(sid);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments WHERE session_id = ?').get(sid).n, 0);
  assert.throws(() => ins.run(sid, 'lead', 0, 'ann'), /cancelled/i);
});

test('FK cascades: deleting a session removes its assignments; deleting a person removes availability', () => {
  const db = fresh();
  replaceGenerated(db, '2026-12', [A(DEC[0], 'lead', 0, 'ann')]);
  setAvailability(db, 'dan', '2026-12', [DEC[0]]);
  db.prepare('DELETE FROM sessions WHERE date = ?').run(DEC[0]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments').get().n, 0);
  db.prepare("DELETE FROM people WHERE id = 'dan'").run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM availability').get().n, 0);
});

// ---------- integration hardening ----------

test('syncConfig: lowering a role max repacks assignments so later generation still works', () => {
  const db = fresh();
  replaceGenerated(db, '2026-12', [A(DEC[0], 'voc', 0, 'cat'), A(DEC[0], 'voc', 1, 'ann'), A(DEC[1], 'voc', 1, 'cat')]);
  setSlot(db, DEC[0], 'voc', 1, 'ann'); // locked rows are kept first
  const cfg = baseConfig();
  cfg.ministries[0].roles[1].max = 1;
  syncConfig(db, cfg);
  assert.deepEqual(session(db, DEC[0]).assignments.filter((a) => a.roleId === 'voc'),
    [{ roleId: 'voc', slot: 0, personId: 'ann', locked: true }]);
  assert.deepEqual(session(db, DEC[1]).assignments.filter((a) => a.roleId === 'voc'),
    [{ roleId: 'voc', slot: 0, personId: 'cat', locked: false }]);
  // regenerating with the surviving rows no longer trips the slot trigger
  const keep = session(db, DEC[1]).assignments.map((a) => ({ date: DEC[1], ...a }));
  replaceGenerated(db, '2026-12', keep);
});

test('transaction(): multi-step writes roll back together, including clearLocks', () => {
  const db = fresh();
  replaceGenerated(db, '2026-12', [A(DEC[0], 'lead', 0, 'ann')]);
  setSlot(db, DEC[0], 'lead', 0, 'ann');
  setSessionStatus(db, DEC[1], 'cancelled', 'x');
  throwsCode(() => transaction(db, () => {
    clearLocks(db, '2026-12');
    setSessionStatus(db, DEC[1], 'scheduled');
    replaceGenerated(db, '2026-12', [A(DEC[2], 'usher', 0, 'dan'), A(DEC[2], 'usher', 1, 'dan')]);
  }), 'CONFLICT');
  assert.equal(session(db, DEC[0]).assignments[0].locked, true);
  assert.equal(session(db, DEC[1]).status, 'cancelled');
  assert.equal(session(db, DEC[2]).assignments.length, 0);
  assert.equal(db.isTransaction, false);
  assert.equal(transaction(db, () => 42), 42);
});

test('ensureSessions does not open a write transaction when all sessions exist', () => {
  const db = fresh();
  let began = 0;
  const exec = db.exec.bind(db);
  db.exec = (sql) => { if (/^BEGIN/.test(sql)) began++; return exec(sql); };
  ensureSessions(db, DEC);
  assert.equal(began, 0);
  ensureSessions(db, ['2027-01-02']);
  assert.equal(began, 1);
});

test('openDb: unusable files fail at startup with OPEN_FAILED / SCHEMA_TOO_NEW naming the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'serving-db-'));
  try {
    const path = (n) => join(dir, n);
    writeFileSync(path('junk.db'), 'x'.repeat(200));
    throwsCode(() => openDb(path('junk.db')), 'OPEN_FAILED');
    const newer = new DatabaseSync(path('newer.db'));
    newer.exec('PRAGMA user_version = 99');
    newer.close();
    throwsCode(() => openDb(path('newer.db')), 'SCHEMA_TOO_NEW');
    const foreign = new DatabaseSync(path('foreign.db'));
    foreign.exec('CREATE TABLE ministries (x)');
    foreign.close();
    assert.throws(() => openDb(path('foreign.db')), (e) => e.code === 'OPEN_FAILED' && e.message.includes('foreign.db'));
    openDb(path('ro.db')).close();
    chmodSync(path('ro.db'), 0o444);
    if (process.getuid?.() !== 0) throwsCode(() => openDb(path('ro.db')), 'OPEN_FAILED');
    const db = openDb(path('nested/dir/ok.db')); // creates parent dirs, WAL on
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
