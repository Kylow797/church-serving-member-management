// Scheduler tests, written against docs/CONTRACT.md section 5. No npm deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSchedule, validateSession } from '../scheduler.js';

// ---------- fixtures ----------
const role = (id, min, max, extra = {}) => ({ id, name: id, min, max, active: true, ...extra });
const ministry = (id, roles, sen = {}, extra = {}) => ({
  id, name: id, active: true,
  minSenior: sen.minSenior ?? null, maxNewcomers: sen.maxNewcomers ?? null,
  roles, ...extra,
});
const person = (id, rank, roles, extra = {}) => ({
  id, name: id, rank, roles, maxPerMonth: null, active: true, ...extra,
});
const mkRoster = (ministries, people) => ({ ministries, people });
const DEC = ['2026-12-05', '2026-12-12', '2026-12-19', '2026-12-26'];
const DEC5 = ['2026-12-05', '2026-12-12', '2026-12-19', '2026-12-26', '2027-01-02'];
const availAll = (roster, dates) =>
  roster.people.flatMap((p) => dates.map((date) => ({ personId: p.id, date })));
const gen = (o) =>
  generateSchedule({ locked: [], priorCounts: {}, seed: 'seed', availability: [], ...o });
const codes = (ws) => ws.map((w) => w.code);
const on = (assignments, date) => assignments.filter((a) => a.date === date);

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Asserts every hard constraint from the contract on locked + generated output.
function assertHard({ roster, dates, availability, locked = [], out }, label = '') {
  const people = new Map(roster.people.map((p) => [p.id, p]));
  const roles = new Map();
  for (const m of roster.ministries) for (const r of m.roles) roles.set(r.id, { r, m });
  const avail = new Set(availability.map((a) => `${a.personId}|${a.date}`));
  const lockedKeys = new Set(locked.map((l) => `${l.date}|${l.roleId}|${l.slot}`));
  const perMonth = new Map();
  const bySession = new Map();
  const all = [...locked.map((l) => ({ ...l, _locked: true })), ...out.assignments];
  for (const a of out.assignments) {
    const p = people.get(a.personId);
    const ro = roles.get(a.roleId);
    assert.ok(p, `${label} unknown person ${a.personId}`);
    assert.ok(ro, `${label} unknown role ${a.roleId}`);
    assert.ok(p.active, `${label} inactive person ${p.id} assigned`);
    assert.ok(ro.r.active && ro.m.active, `${label} inactive role ${a.roleId} used`);
    assert.ok(p.roles.includes(a.roleId), `${label} ${p.id} lacks role ${a.roleId}`);
    assert.ok(avail.has(`${a.personId}|${a.date}`), `${label} ${p.id} unavailable ${a.date}`);
    assert.ok(dates.includes(a.date), `${label} date ${a.date} not requested`);
    assert.ok(!lockedKeys.has(`${a.date}|${a.roleId}|${a.slot}`), `${label} output overlaps locked slot`);
  }
  for (const a of all) {
    const k = a.date;
    if (!bySession.has(k)) bySession.set(k, { persons: new Set(), slots: new Set(), roleCount: new Map() });
    const s = bySession.get(k);
    assert.ok(!s.persons.has(a.personId), `${label} ${a.personId} double-booked on ${a.date}`);
    s.persons.add(a.personId);
    const sk = `${a.roleId}|${a.slot}`;
    assert.ok(!s.slots.has(sk), `${label} slot ${sk} reused on ${a.date}`);
    s.slots.add(sk);
    const ro = roles.get(a.roleId);
    assert.ok(a.slot >= 0 && a.slot < ro.r.max, `${label} slot ${a.slot} out of range for ${a.roleId}`);
    s.roleCount.set(a.roleId, (s.roleCount.get(a.roleId) || 0) + 1);
    assert.ok(s.roleCount.get(a.roleId) <= ro.r.max, `${label} role ${a.roleId} over max`);
    perMonth.set(a.personId, (perMonth.get(a.personId) || 0) + 1);
  }
  for (const [pid, n] of perMonth) {
    const p = people.get(pid);
    if (p.maxPerMonth != null) assert.ok(n <= p.maxPerMonth, `${label} ${pid} has ${n} > maxPerMonth ${p.maxPerMonth}`);
  }
}

const countsOf = (assignments) => {
  const c = {};
  for (const a of assignments) c[a.personId] = (c[a.personId] || 0) + 1;
  return c;
};

// ---------- hard constraints ----------
test('only available people holding the role, one role each, never over max', () => {
  const roster = mkRoster(
    [ministry('m', [role('a', 1, 1), role('b', 1, 2)])],
    [
      person('p1', 2, ['a', 'b']), person('p2', 2, ['a', 'b']), person('p3', 2, ['b']),
      person('p4', 2, ['b']), person('away', 2, ['a', 'b']), person('norole', 2, []),
    ],
  );
  const availability = availAll(roster, DEC).filter((a) => a.personId !== 'away');
  const out = gen({ roster, dates: DEC, availability });
  assertHard({ roster, dates: DEC, availability, out });
  for (const d of DEC) {
    assert.equal(on(out.assignments, d).filter((a) => a.roleId === 'a').length, 1, 'role a capped at max 1');
    assert.ok(on(out.assignments, d).filter((a) => a.roleId === 'b').length <= 2);
  }
  assert.ok(!out.assignments.some((a) => a.personId === 'away' || a.personId === 'norole'));
});

test('maxPerMonth is respected, remaining dates are understaffed not over-assigned', () => {
  const roster = mkRoster(
    [ministry('m', [role('a', 1, 1)])],
    [person('solo', 2, ['a'], { maxPerMonth: 2 })],
  );
  const availability = availAll(roster, DEC);
  const out = gen({ roster, dates: DEC, availability });
  assertHard({ roster, dates: DEC, availability, out });
  assert.equal(out.assignments.length, 2);
  assert.equal(out.warnings.filter((w) => w.code === 'UNDERSTAFFED').length, 2);
});

test('inactive people, roles and ministries are ignored', () => {
  const roster = mkRoster(
    [
      ministry('m', [role('a', 1, 1), role('dead', 1, 1, { active: false })]),
      ministry('gone', [role('g', 1, 1)], {}, { active: false }),
    ],
    [
      person('ghost', 3, ['a'], { active: false }),
      person('real', 1, ['a', 'dead', 'g']),
    ],
  );
  const availability = availAll(roster, DEC);
  const out = gen({ roster, dates: DEC, availability });
  assertHard({ roster, dates: DEC, availability, out });
  assert.ok(out.assignments.every((a) => a.personId === 'real' && a.roleId === 'a'));
  assert.equal(out.assignments.length, DEC.length);
  assert.deepEqual(out.warnings.filter((w) => w.code === 'UNDERSTAFFED'), [], 'inactive roles are not required');
});

// ---------- understaffing / optional slots ----------
test('UNDERSTAFFED warning (no throw) when not enough people', () => {
  const roster = mkRoster(
    [ministry('u', [role('usher', 2, 3)])],
    [person('x', 2, ['usher']), person('y', 2, ['usher'])],
  );
  const availability = [
    { personId: 'x', date: DEC[0] }, { personId: 'y', date: DEC[0] },
    { personId: 'x', date: DEC[1] },
  ];
  const out = gen({ roster, dates: DEC.slice(0, 3), availability });
  assertHard({ roster, dates: DEC.slice(0, 3), availability, out });
  const under = out.warnings.filter((w) => w.code === 'UNDERSTAFFED');
  assert.deepEqual(under.map((w) => w.date).sort(), [DEC[1], DEC[2]]);
  assert.ok(under.every((w) => w.roleId === 'usher'));
  assert.equal(on(out.assignments, DEC[0]).length, 2);
  assert.equal(on(out.assignments, DEC[1]).length, 1, 'best effort still assigns the one available person');
});

test('optional slots are filled up to max when people exist', () => {
  const roster = mkRoster(
    [ministry('u', [role('usher', 2, 3)])],
    ['a', 'b', 'c', 'd', 'e'].map((id) => person(id, 2, ['usher'])),
  );
  const availability = availAll(roster, DEC.slice(0, 1));
  const out = gen({ roster, dates: DEC.slice(0, 1), availability });
  assert.equal(out.assignments.length, 3);
  assert.deepEqual(out.warnings, []);
});

// ---------- seniority ----------
const worship = (extraRoles = []) =>
  ministry('w', [role('r1', 1, 1), role('r2', 1, 1), ...extraRoles], { minSenior: 1, maxNewcomers: 1 });

test('seniority satisfied when feasible even though greedy newcomer picks would block it', () => {
  // Senior S is the only rank-3 and can fill either role; newcomers N1/N2 fill either too.
  // Picking N1+N2 (or any two non-seniors) breaks minSenior / maxNewcomers.
  const roster = mkRoster(
    [worship()],
    [
      person('N1', 1, ['r1', 'r2']), person('N2', 1, ['r1', 'r2']),
      person('M', 2, ['r1']), person('S', 3, ['r1', 'r2']),
    ],
  );
  const availability = availAll(roster, DEC);
  for (let i = 0; i < 25; i++) {
    const out = gen({ roster, dates: DEC, availability, seed: `s${i}` });
    assertHard({ roster, dates: DEC, availability, out }, `seed s${i}`);
    assert.deepEqual(codes(out.warnings), [], `seed s${i}: ${JSON.stringify(out.warnings)}`);
    for (const d of DEC) {
      const ids = on(out.assignments, d).map((a) => a.personId);
      assert.ok(ids.includes('S'), `S must serve on ${d} (seed s${i}), got ${ids}`);
      assert.ok(ids.filter((x) => x.startsWith('N')).length <= 1);
    }
  }
});

test('seniority: senior who holds only the scarce role must take it', () => {
  // r2 can be done by newcomer N or regular M; r1 by S (senior, only r1) or M.
  // maxNewcomers=0 forces N out; M must take r2, S r1.
  const roster = mkRoster(
    [ministry('w', [role('r1', 1, 1), role('r2', 1, 1)], { minSenior: 1, maxNewcomers: 0 })],
    [person('N', 1, ['r2']), person('M', 2, ['r1', 'r2']), person('S', 3, ['r1'])],
  );
  const availability = availAll(roster, DEC.slice(0, 1));
  for (let i = 0; i < 20; i++) {
    const out = gen({ roster, dates: DEC.slice(0, 1), availability, seed: `t${i}` });
    assert.deepEqual(codes(out.warnings), [], `seed t${i}`);
    const m = Object.fromEntries(out.assignments.map((a) => [a.roleId, a.personId]));
    assert.deepEqual(m, { r1: 'S', r2: 'M' });
  }
});

test('NO_SENIOR warning (no throw) when no rank-3 is available', () => {
  const roster = mkRoster([worship()], [person('a', 2, ['r1']), person('b', 2, ['r2']), person('S', 3, ['r1'])]);
  const availability = availAll(roster, DEC.slice(0, 1)).filter((a) => a.personId !== 'S');
  const out = gen({ roster, dates: DEC.slice(0, 1), availability });
  assert.ok(codes(out.warnings).includes('NO_SENIOR'));
  assert.equal(out.assignments.length, 2, 'still staffed');
  assert.equal(out.warnings.find((w) => w.code === 'NO_SENIOR').ministryId, 'w');
});

test('TOO_MANY_NEWCOMERS warning when only newcomers can fill min roles', () => {
  const roster = mkRoster(
    [ministry('w', [role('r1', 1, 1), role('r2', 1, 1), role('r3', 1, 1)], { minSenior: 1, maxNewcomers: 1 })],
    [person('n1', 1, ['r1']), person('n2', 1, ['r2']), person('S', 3, ['r3'])],
  );
  const availability = availAll(roster, DEC.slice(0, 1));
  const out = gen({ roster, dates: DEC.slice(0, 1), availability });
  assert.ok(codes(out.warnings).includes('TOO_MANY_NEWCOMERS'), JSON.stringify(out.warnings));
  assert.ok(!codes(out.warnings).includes('NO_SENIOR'));
});

test('seniority applies only to ministries that declare it', () => {
  const roster = mkRoster([ministry('u', [role('usher', 1, 2)])], [person('n', 1, ['usher'])]);
  const out = gen({ roster, dates: DEC.slice(0, 1), availability: availAll(roster, DEC.slice(0, 1)) });
  assert.deepEqual(out.warnings, []);
});

// ---------- locked ----------
test('locked assignments are preserved, excluded from output, and counted', () => {
  const roster = mkRoster(
    [
      ministry('w', [role('lead', 1, 1), role('voc', 1, 2)], { minSenior: 1, maxNewcomers: 3 }),
      ministry('u', [role('usher', 1, 1)]),
    ],
    [
      person('S', 3, ['lead', 'usher']), person('n1', 1, ['voc']), person('n2', 1, ['voc']),
      person('u1', 2, ['usher']),
    ],
  );
  const dates = DEC.slice(0, 2);
  const availability = availAll(roster, dates).filter((a) => a.personId !== 'S' || a.date !== dates[1]);
  // S locked as lead on date 0 AND date 1 (even though unavailable on date 1: admin override).
  const locked = [
    { date: dates[0], roleId: 'lead', slot: 0, personId: 'S' },
    { date: dates[1], roleId: 'lead', slot: 0, personId: 'S' },
  ];
  const out = gen({ roster, dates, availability, locked });
  assertHard({ roster, dates, availability, locked, out });
  // locked senior counts: no NO_SENIOR even though only newcomers fill voc.
  assert.ok(!codes(out.warnings).includes('NO_SENIOR'), JSON.stringify(out.warnings));
  // locked slot not regenerated, locked person not double booked into usher.
  for (const d of dates) {
    assert.ok(!on(out.assignments, d).some((a) => a.roleId === 'lead'));
    assert.ok(!on(out.assignments, d).some((a) => a.personId === 'S'));
    assert.ok(on(out.assignments, d).some((a) => a.roleId === 'usher' && a.personId === 'u1'));
  }
});

test('locked assignments count toward maxPerMonth', () => {
  const roster = mkRoster(
    [ministry('m', [role('a', 1, 1)])],
    [person('lim', 2, ['a'], { maxPerMonth: 1 }), person('other', 2, ['a'])],
  );
  const availability = availAll(roster, DEC);
  const locked = [{ date: DEC[0], roleId: 'a', slot: 0, personId: 'lim' }];
  const out = gen({ roster, dates: DEC, availability, locked });
  assertHard({ roster, dates: DEC, availability, locked, out });
  assert.ok(!out.assignments.some((a) => a.personId === 'lim'));
  assert.deepEqual(out.assignments.map((a) => a.date).sort(), DEC.slice(1));
});

test('locked newcomers count toward maxNewcomers', () => {
  const roster = mkRoster(
    [ministry('w', [role('r1', 1, 1), role('r2', 1, 1), role('r3', 1, 1)], { minSenior: 0, maxNewcomers: 1 })],
    [person('n1', 1, ['r1']), person('n2', 1, ['r2']), person('m', 2, ['r2']), person('s', 3, ['r3'])],
  );
  const availability = availAll(roster, DEC.slice(0, 1));
  const locked = [{ date: DEC[0], roleId: 'r1', slot: 0, personId: 'n1' }];
  const out = gen({ roster, dates: DEC.slice(0, 1), availability, locked });
  const r2 = out.assignments.find((a) => a.roleId === 'r2');
  assert.equal(r2.personId, 'm', 'n2 would be a 2nd newcomer');
  assert.deepEqual(codes(out.warnings), []);
});

// ---------- fairness ----------
test('fairness: interchangeable people spread within 1 over a month', () => {
  for (const max of [2, 3]) {
    const roster = mkRoster(
      [ministry('u', [role('usher', 2, max)])],
      Array.from({ length: 8 }, (_, i) => person(`p${i}`, 2, ['usher'])),
    );
    for (const dates of [DEC, DEC5]) {
      const availability = availAll(roster, dates);
      for (const seed of ['a', 'b', 'c']) {
        const out = gen({ roster, dates, availability, seed });
        assertHard({ roster, dates, availability, out });
        const c = countsOf(out.assignments);
        const vals = roster.people.map((p) => c[p.id] || 0);
        assert.ok(Math.max(...vals) - Math.min(...vals) <= 1, `max=${max} dates=${dates.length} seed=${seed}: ${JSON.stringify(c)}`);
      }
    }
  }
});

test('fairness: avoids back-to-back Saturdays when alternatives exist', () => {
  const roster = mkRoster(
    [ministry('u', [role('usher', 2, 2)])],
    ['a', 'b', 'c', 'd'].map((id) => person(id, 2, ['usher'])),
  );
  const availability = availAll(roster, DEC5);
  for (const seed of ['1', '2', '3', '4']) {
    const out = gen({ roster, dates: DEC5, availability, seed });
    for (let i = 1; i < DEC5.length; i++) {
      const prev = new Set(on(out.assignments, DEC5[i - 1]).map((a) => a.personId));
      for (const a of on(out.assignments, DEC5[i])) {
        assert.ok(!prev.has(a.personId), `seed ${seed}: ${a.personId} serves ${DEC5[i - 1]} and ${DEC5[i]}`);
      }
    }
  }
});

test('fairness: priorCounts break ties toward people who served less recently', () => {
  const roster = mkRoster(
    [ministry('m', [role('a', 1, 1)])],
    [person('busy', 2, ['a']), person('fresh', 2, ['a'])],
  );
  const availability = availAll(roster, DEC.slice(0, 1));
  for (const seed of ['x', 'y', 'z', 'w']) {
    const out = gen({ roster, dates: DEC.slice(0, 1), availability, seed, priorCounts: { busy: 9, fresh: 0 } });
    assert.equal(out.assignments[0].personId, 'fresh', `seed ${seed}`);
  }
});

// ---------- determinism ----------
test('same seed gives identical output; other seeds still valid', () => {
  const roster = mkRoster(
    [ministry('u', [role('usher', 2, 3)])],
    Array.from({ length: 9 }, (_, i) => person(`p${i}`, 1 + (i % 3), ['usher'])),
  );
  const availability = availAll(roster, DEC5);
  const a = gen({ roster, dates: DEC5, availability, seed: 'same' });
  const b = gen({ roster, dates: DEC5, availability, seed: 'same' });
  assert.deepEqual(a, b);
  for (const seed of ['other1', 'other2', 'other3']) {
    assertHard({ roster, dates: DEC5, availability, out: gen({ roster, dates: DEC5, availability, seed }) });
  }
});

test('generateSchedule does not mutate its inputs', () => {
  const roster = mkRoster([ministry('u', [role('usher', 1, 2)])], [person('a', 2, ['usher']), person('b', 2, ['usher'])]);
  const args = { roster, dates: DEC, availability: availAll(roster, DEC), locked: [], priorCounts: { a: 1 }, seed: 's' };
  const snap = JSON.stringify(args);
  generateSchedule(args);
  assert.equal(JSON.stringify(args), snap);
});

// ---------- validateSession ----------
const vRoster = mkRoster(
  [
    ministry('w', [role('lead', 1, 1), role('voc', 1, 2)], { minSenior: 1, maxNewcomers: 1 }),
    ministry('u', [role('usher', 2, 3)]),
  ],
  [
    person('S', 3, ['lead', 'voc']), person('M', 2, ['voc']), person('N1', 1, ['voc']),
    person('N2', 1, ['voc']), person('U1', 2, ['usher']), person('U2', 2, ['usher']),
    person('X', 2, ['voc', 'usher'], { active: false }),
  ],
);
const A = (roleId, slot, personId) => ({ date: DEC[0], roleId, slot, personId, locked: false });
const validate = (assignments, availableIds) =>
  validateSession({ date: DEC[0], assignments, roster: vRoster, availableIds });
const ALL_IDS = vRoster.people.map((p) => p.id);

test('validateSession: clean session has no warnings', () => {
  const ws = validate([A('lead', 0, 'S'), A('voc', 0, 'M'), A('usher', 0, 'U1'), A('usher', 1, 'U2')], ALL_IDS);
  assert.deepEqual(ws, []);
});

test('validateSession flags UNAVAILABLE', () => {
  const ws = validate(
    [A('lead', 0, 'S'), A('voc', 0, 'M'), A('usher', 0, 'U1'), A('usher', 1, 'U2')],
    ALL_IDS.filter((x) => x !== 'M'),
  );
  assert.deepEqual(codes(ws), ['UNAVAILABLE']);
  assert.equal(ws[0].date, DEC[0]);
});

test('validateSession flags ROLE_MISMATCH', () => {
  const ws = validate([A('lead', 0, 'S'), A('voc', 0, 'U1'), A('usher', 0, 'U2'), A('usher', 1, 'M')], ALL_IDS);
  assert.deepEqual(codes(ws).sort(), ['ROLE_MISMATCH', 'ROLE_MISMATCH']);
});

test('validateSession flags INACTIVE_PERSON', () => {
  const ws = validate([A('lead', 0, 'S'), A('voc', 0, 'M'), A('usher', 0, 'U1'), A('usher', 1, 'X')], ALL_IDS);
  assert.ok(codes(ws).includes('INACTIVE_PERSON'));
});

test('validateSession flags NO_SENIOR and TOO_MANY_NEWCOMERS', () => {
  const noSenior = validate([A('lead', 0, 'M')], ALL_IDS);
  // M lacks `lead`, so ROLE_MISMATCH too; still expect NO_SENIOR for ministry w.
  assert.ok(codes(noSenior).includes('NO_SENIOR'));
  assert.equal(noSenior.find((w) => w.code === 'NO_SENIOR').ministryId, 'w');

  const many = validate([A('lead', 0, 'S'), A('voc', 0, 'N1'), A('voc', 1, 'N2')], ALL_IDS);
  assert.ok(codes(many).includes('TOO_MANY_NEWCOMERS'));
  assert.ok(!codes(many).includes('NO_SENIOR'));
});

test('validateSession flags UNDERSTAFFED (partial and empty roles)', () => {
  const ws = validate([A('lead', 0, 'S'), A('usher', 0, 'U1')], ALL_IDS);
  const under = ws.filter((w) => w.code === 'UNDERSTAFFED');
  assert.deepEqual(under.map((w) => w.roleId).sort(), ['usher', 'voc']);
});

// ---------- property-style ----------
function randomCase(rnd) {
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const nMin = int(1, 3);
  const ministries = [];
  const roleIds = [];
  for (let i = 0; i < nMin; i++) {
    const roles = [];
    for (let j = 0; j < int(1, 4); j++) {
      const max = int(1, 3);
      const id = `m${i}r${j}`;
      roles.push(role(id, int(0, max), max, { active: rnd() > 0.1 }));
      roleIds.push(id);
    }
    const sen = rnd() < 0.5 ? { minSenior: int(0, 2), maxNewcomers: int(0, 3) } : {};
    ministries.push(ministry(`m${i}`, roles, sen, { active: rnd() > 0.05 }));
  }
  const people = Array.from({ length: int(4, 25) }, (_, i) =>
    person(`p${i}`, int(1, 3), roleIds.filter(() => rnd() < 0.3), {
      maxPerMonth: rnd() < 0.3 ? int(1, 3) : null,
      active: rnd() > 0.08,
    }));
  const dates = DEC5.slice(0, int(4, 5));
  const density = 0.3 + rnd() * 0.6;
  const availability = [];
  for (const p of people) for (const date of dates) if (rnd() < density) availability.push({ personId: p.id, date });
  // a few valid locks
  const roster = mkRoster(ministries, people);
  const locked = [];
  const used = new Map(); // date -> Set(person)
  const slotUsed = new Set();
  const monthCount = new Map();
  for (let k = 0; k < int(0, 4); k++) {
    const date = pick(dates);
    const p = pick(people);
    const rid = pick(roleIds);
    const rl = ministries.flatMap((m) => m.roles).find((r) => r.id === rid);
    const slot = int(0, rl.max - 1);
    if (!p.active || !p.roles.includes(rid)) continue;
    if (used.get(date)?.has(p.id) || slotUsed.has(`${date}|${rid}|${slot}`)) continue;
    if (p.maxPerMonth != null && (monthCount.get(p.id) || 0) >= p.maxPerMonth) continue;
    if (!used.has(date)) used.set(date, new Set());
    used.get(date).add(p.id);
    slotUsed.add(`${date}|${rid}|${slot}`);
    monthCount.set(p.id, (monthCount.get(p.id) || 0) + 1);
    locked.push({ date, roleId: rid, slot, personId: p.id });
  }
  return { roster, dates, availability, locked, seed: `r${int(0, 1e6)}` };
}

const ALLOWED = new Set(['UNDERSTAFFED', 'NO_SENIOR', 'TOO_MANY_NEWCOMERS', 'UNAVAILABLE', 'ROLE_MISMATCH', 'INACTIVE_PERSON']);

test('property: 200 random rosters always satisfy hard constraints', () => {
  const rnd = mulberry32(20261109);
  for (let i = 0; i < 200; i++) {
    const c = randomCase(rnd);
    let out;
    assert.doesNotThrow(() => { out = generateSchedule({ ...c, priorCounts: {} }); }, `case ${i}`);
    assertHard({ ...c, out }, `case ${i}`);
    assert.ok(Array.isArray(out.warnings));
    for (const w of out.warnings) {
      assert.ok(ALLOWED.has(w.code), `case ${i}: bad code ${w.code}`);
      assert.ok(typeof w.message === 'string' && w.date, `case ${i}: warning needs message+date`);
    }
    // determinism on every case
    assert.deepEqual(generateSchedule({ ...c, priorCounts: {} }), out, `case ${i} nondeterministic`);
  }
});

test('property: warnings are consistent with the output (min unmet => UNDERSTAFFED)', () => {
  const rnd = mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const c = randomCase(rnd);
    const out = generateSchedule({ ...c, priorCounts: {} });
    const all = [...c.locked, ...out.assignments];
    for (const m of c.roster.ministries.filter((x) => x.active)) {
      for (const r of m.roles.filter((x) => x.active)) {
        for (const d of c.dates) {
          const n = all.filter((a) => a.date === d && a.roleId === r.id).length;
          if (n < r.min) {
            assert.ok(
              out.warnings.some((w) => w.code === 'UNDERSTAFFED' && w.date === d && (w.roleId === r.id || w.ministryId === m.id)),
              `case ${i}: ${r.id} on ${d} has ${n}<${r.min} without UNDERSTAFFED`,
            );
          }
        }
      }
    }
  }
});
