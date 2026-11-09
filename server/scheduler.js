// Pure scheduler. No imports, no I/O, no clock. See docs/CONTRACT.md section 5.
//
// Algorithm
//   Phase 1 (mandatory), dates in ascending order with running per-person counts:
//     per session, a branch-and-bound backtracking search fills every role's `min` slots.
//     Slots are picked dynamically by scarcity (fewest remaining candidates first), so a
//     drummer who can also usher ends up drumming. Candidates are tried best-first by
//     fairness. Cost is a lexicographic vector:
//       [unfilled mandatory slots, seniority violations, sum(month load), back-to-back,
//        sum(priorCounts), seeded random]
//     Partial branches are pruned as soon as their (monotone) partial cost cannot beat the
//     best leaf. A node budget bounds the search; the best leaf so far is the fallback.
//     At each leaf a missing senior is repaired from the ministry's optional capacity.
//   Phase 2 (optional): after every session is minimally staffed, optional slots are filled
//     date by date, scarcest role first, best-fairness candidate first, never exceeding
//     maxNewcomers. Doing this second means optional slots can never starve a later session.
//   Warnings come from validateSession over the final (locked + generated) assignments.

const NODE_BUDGET = 6000;

// ---------- small pure helpers ----------

function hash01(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function dayNum(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

function cmpVec(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function roleIndex(roster) {
  // roleId -> { role, ministry }, active only
  const map = new Map();
  for (const m of roster.ministries ?? []) {
    if (m.active === false) continue;
    for (const r of m.roles ?? []) {
      if (r.active === false) continue;
      map.set(r.id, { role: r, ministry: m });
    }
  }
  return map;
}

// ---------- validateSession ----------

export function validateSession({ date, assignments, roster, availableIds }) {
  const avail = new Set(availableIds ?? []);
  const peopleById = new Map((roster.people ?? []).map((p) => [p.id, p]));
  const allRoles = new Map();
  for (const m of roster.ministries ?? []) {
    for (const r of m.roles ?? []) allRoles.set(r.id, { role: r, ministry: m });
  }
  const warnings = [];
  const w = (code, message, extra = {}) => warnings.push({ date, code, message, ...extra });

  const goodByRole = new Map(); // roleId -> count of active people
  const goodByMinistry = new Map(); // ministryId -> { seniors, newcomers }

  for (const a of assignments ?? []) {
    const person = peopleById.get(a.personId);
    const info = allRoles.get(a.roleId);
    const ministryId = info?.ministry.id;
    const base = { roleId: a.roleId, slot: a.slot, personId: a.personId, ...(ministryId ? { ministryId } : {}) };
    const who = person?.name ?? a.personId;
    const roleName = info?.role.name ?? a.roleId;

    if (!person || person.active === false) {
      w('INACTIVE_PERSON', `${who} is no longer active but is assigned as ${roleName}`, base);
      continue;
    }
    if (!info || info.role.active === false || info.ministry.active === false) {
      w('ROLE_MISMATCH', `${who} is assigned to ${roleName}, which is not an active role`, base);
    } else if (!person.roles.includes(a.roleId)) {
      w('ROLE_MISMATCH', `${who} is not set up to serve as ${roleName}`, base);
    }
    if (!avail.has(a.personId)) {
      w('UNAVAILABLE', `${who} is not available on ${date} but is assigned as ${roleName}`, base);
    }
    goodByRole.set(a.roleId, (goodByRole.get(a.roleId) ?? 0) + 1);
    if (ministryId) {
      const s = goodByMinistry.get(ministryId) ?? { seniors: 0, newcomers: 0 };
      if (person.rank === 3) s.seniors++;
      if (person.rank === 1) s.newcomers++;
      goodByMinistry.set(ministryId, s);
    }
  }

  for (const m of roster.ministries ?? []) {
    if (m.active === false) continue;
    for (const r of m.roles ?? []) {
      if (r.active === false || !(r.min > 0)) continue;
      const have = goodByRole.get(r.id) ?? 0;
      if (have < r.min) {
        w('UNDERSTAFFED', `${m.name}: ${r.name} has ${have} of ${r.min} required`, {
          ministryId: m.id,
          roleId: r.id,
        });
      }
    }
    const s = goodByMinistry.get(m.id) ?? { seniors: 0, newcomers: 0 };
    if (m.minSenior != null && m.minSenior > 0 && s.seniors < m.minSenior) {
      w(
        'NO_SENIOR',
        m.minSenior === 1
          ? `${m.name} has no senior member`
          : `${m.name} has ${s.seniors} senior member(s), needs ${m.minSenior}`,
        { ministryId: m.id },
      );
    }
    if (m.maxNewcomers != null && s.newcomers > m.maxNewcomers) {
      w('TOO_MANY_NEWCOMERS', `${m.name} has ${s.newcomers} newcomers, maximum is ${m.maxNewcomers}`, {
        ministryId: m.id,
      });
    }
  }
  return warnings;
}

// ---------- generateSchedule ----------

export function generateSchedule({
  roster,
  dates,
  availability = [],
  locked = [],
  priorCounts = {},
  seed = '',
}) {
  const roles = roleIndex(roster);
  const activeMinistries = new Map();
  for (const { ministry } of roles.values()) activeMinistries.set(ministry.id, ministry);
  const people = new Map();
  for (const p of roster.people ?? []) {
    if (p.active === false) continue;
    people.set(p.id, { ...p, roles: p.roles.filter((r) => roles.has(r)) });
  }
  const sortedDates = [...new Set(dates)].sort();
  const seedStr = String(seed);

  const availByDate = new Map(sortedDates.map((d) => [d, new Set()]));
  for (const a of availability) availByDate.get(a.date)?.add(a.personId);

  // Running state shared across sessions.
  const count = new Map(); // personId -> assignments this month (locked included)
  const servedDays = new Map(); // personId -> Set(dayNum) (locked included)
  const bump = (pid, date) => {
    count.set(pid, (count.get(pid) ?? 0) + 1);
    if (!servedDays.has(pid)) servedDays.set(pid, new Set());
    servedDays.get(pid).add(dayNum(date));
  };
  const lockedByDate = new Map(sortedDates.map((d) => [d, []]));
  for (const l of locked) {
    bump(l.personId, l.date);
    lockedByDate.get(l.date)?.push(l);
  }
  const prior = (pid) => priorCounts[pid] ?? 0;

  const generated = new Map(sortedDates.map((d) => [d, []])); // date -> [{personId, roleId}]

  // Per-session context ------------------------------------------------------
  function sessionCtx(date) {
    const lockedHere = lockedByDate.get(date);
    const used = new Set(lockedHere.map((l) => l.personId));
    const roleHave = new Map(); // roleId -> assigned (locked + new)
    const roleCap = new Map(); // roleId -> free slot count (after locked)
    const lockedRoleCount = new Map();
    const min = new Map();
    for (const [rid, { role }] of roles) {
      const lockedSlots = new Set(lockedHere.filter((l) => l.roleId === rid).map((l) => l.slot));
      let free = 0;
      for (let s = 0; s < role.max; s++) if (!lockedSlots.has(s)) free++;
      const lc = lockedHere.filter((l) => l.roleId === rid).length;
      lockedRoleCount.set(rid, lc);
      roleHave.set(rid, lc);
      roleCap.set(rid, free);
      min.set(rid, role.min);
    }
    const mState = new Map(); // ministryId -> { seniors, newcomers }
    for (const mid of activeMinistries.keys()) mState.set(mid, { seniors: 0, newcomers: 0 });
    for (const l of lockedHere) {
      const info = roles.get(l.roleId);
      const p = people.get(l.personId);
      if (!info || !p) continue;
      const s = mState.get(info.ministry.id);
      if (p.rank === 3) s.seniors++;
      if (p.rank === 1) s.newcomers++;
    }
    return { date, used, roleHave, roleCap, mState, min, lockedRoleCount };
  }

  function poolFor(date, ctx) {
    const out = [];
    const av = availByDate.get(date);
    for (const p of people.values()) {
      if (!av.has(p.id) || ctx.used.has(p.id)) continue;
      if (p.maxPerMonth != null && (count.get(p.id) ?? 0) >= p.maxPerMonth) continue;
      if (p.roles.length === 0) continue;
      const dn = dayNum(date);
      const days = servedDays.get(p.id);
      const b2b = days && (days.has(dn - 7) || days.has(dn + 7)) ? 1 : 0;
      out.push({
        id: p.id,
        rank: p.rank,
        roles: p.roles,
        key: [count.get(p.id) ?? 0, b2b, prior(p.id), hash01(`${seedStr}|${date}|${p.id}`)],
      });
    }
    out.sort((a, b) => cmpVec(a.key, b.key) || (a.id < b.id ? -1 : 1));
    out.forEach((p, i) => (p.ord = i));
    return out;
  }

  const addVec = (acc, key) => {
    for (let i = 0; i < 4; i++) acc[i] += key[i];
  };
  const subVec = (acc, key) => {
    for (let i = 0; i < 4; i++) acc[i] -= key[i];
  };

  // Phase 1 ------------------------------------------------------------------
  function fillMandatory(date) {
    const ctx = sessionCtx(date);
    const pool = poolFor(date, ctx);

    const groups = [];
    for (const [rid] of roles) {
      const need = Math.min(ctx.roleCap.get(rid), Math.max(0, ctx.min.get(rid) - ctx.lockedRoleCount.get(rid)));
      if (need <= 0) continue;
      const cands = pool.filter((p) => p.roles.includes(rid));
      groups.push({ rid, mid: roles.get(rid).ministry.id, remaining: need, cands, lastOrd: -1 });
    }

    const used = new Set(ctx.used);
    const chosen = []; // {personId, roleId}
    const cost = [0, 0, 0, 0]; // fairness sums
    let unfilled = 0;
    let excess = 0; // newcomer excess, monotone
    const nc = new Map([...ctx.mState].map(([k, v]) => [k, v.newcomers]));
    const sn = new Map([...ctx.mState].map(([k, v]) => [k, v.seniors]));
    const roleHave = new Map(ctx.roleHave);

    const maxN = (mid) => activeMinistries.get(mid).maxNewcomers;
    for (const mid of nc.keys()) {
      const mx = maxN(mid);
      if (mx != null) excess += Math.max(0, nc.get(mid) - mx);
    }

    let best = null; // { vec, picks }
    let nodes = 0;

    const partialVec = () => [unfilled, excess, ...cost];

    function leaf() {
      const extra = [];
      const tmpCost = [0, 0, 0, 0];
      let deficit = 0;
      for (const [mid, m] of activeMinistries) {
        const need = (m.minSenior ?? 0) - sn.get(mid);
        for (let k = 0; k < need; k++) {
          // repair from optional capacity in this ministry
          let pick = null;
          let pickRole = null;
          for (const p of pool) {
            if (used.has(p.id) || p.rank !== 3) continue;
            if (pick && cmpVec(p.key, pick.key) >= 0) continue;
            for (const rid of p.roles) {
              const info = roles.get(rid);
              if (info.ministry.id !== mid) continue;
              if (roleHave.get(rid) + extra.filter((e) => e.roleId === rid).length >= roleCapTotal(rid)) continue;
              pick = p;
              pickRole = rid;
              break;
            }
          }
          if (pick) {
            extra.push({ personId: pick.id, roleId: pickRole });
            used.add(pick.id);
            addVec(tmpCost, pick.key);
            sn.set(mid, sn.get(mid) + 1);
          } else {
            deficit++;
          }
        }
      }
      const vec = [unfilled, excess + deficit, ...cost.map((c, i) => c + tmpCost[i])];
      if (!best || cmpVec(vec, best.vec) < 0) {
        best = { vec, picks: [...chosen, ...extra] };
      }
      // undo repair
      for (const e of extra) {
        used.delete(e.personId);
        const mid = roles.get(e.roleId).ministry.id;
        sn.set(mid, sn.get(mid) - 1);
      }
    }

    const roleCapTotal = (rid) => ctx.lockedRoleCount.get(rid) + ctx.roleCap.get(rid);

    function dfs() {
      if (nodes++ >= NODE_BUDGET) return;
      if (best && cmpVec(partialVec(), best.vec) >= 0) return;

      // pick the scarcest open group
      let g = null;
      let gc = Infinity;
      for (const grp of groups) {
        if (grp.remaining <= 0) continue;
        let c = 0;
        for (const p of grp.cands) if (p.ord > grp.lastOrd && !used.has(p.id)) c++;
        if (c < gc) {
          gc = c;
          g = grp;
          if (c === 0) break;
        }
      }
      if (!g) return leaf();

      const prevLast = g.lastOrd;
      if (gc > 0) {
        const mx = maxN(g.mid);
        for (const p of g.cands) {
          if (p.ord <= prevLast || used.has(p.id)) continue;
          if (nodes >= NODE_BUDGET) break;
          used.add(p.id);
          chosen.push({ personId: p.id, roleId: g.rid });
          addVec(cost, p.key);
          g.remaining--;
          g.lastOrd = p.ord;
          if (p.rank === 3) sn.set(g.mid, sn.get(g.mid) + 1);
          const newcomer = p.rank === 1;
          if (newcomer) {
            nc.set(g.mid, nc.get(g.mid) + 1);
            if (mx != null && nc.get(g.mid) > mx) excess++;
          }
          roleHave.set(g.rid, roleHave.get(g.rid) + 1);

          dfs();

          roleHave.set(g.rid, roleHave.get(g.rid) - 1);
          if (newcomer) {
            if (mx != null && nc.get(g.mid) > mx) excess--;
            nc.set(g.mid, nc.get(g.mid) - 1);
          }
          if (p.rank === 3) sn.set(g.mid, sn.get(g.mid) - 1);
          g.lastOrd = prevLast;
          g.remaining++;
          subVec(cost, p.key);
          chosen.pop();
          used.delete(p.id);
        }
      }
      // skip: leave one slot of this role unfilled (forced when no candidate remains)
      g.remaining--;
      g.lastOrd = Infinity;
      unfilled++;
      dfs();
      unfilled--;
      g.lastOrd = prevLast;
      g.remaining++;
    }

    dfs();

    const picks = best ? best.picks : [];
    for (const p of picks) {
      generated.get(date).push(p);
      bump(p.personId, date);
    }
  }

  // Phase 2 ------------------------------------------------------------------
  function fillOptional(date) {
    const ctx = sessionCtx(date);
    for (const p of generated.get(date)) {
      ctx.used.add(p.personId);
      ctx.roleHave.set(p.roleId, ctx.roleHave.get(p.roleId) + 1);
      const person = people.get(p.personId);
      const s = ctx.mState.get(roles.get(p.roleId).ministry.id);
      if (person.rank === 3) s.seniors++;
      if (person.rank === 1) s.newcomers++;
    }
    for (;;) {
      const pool = poolFor(date, ctx);
      let bestRole = null;
      let bestCands = null;
      for (const [rid, { role, ministry }] of roles) {
        const total = ctx.lockedRoleCount.get(rid) + ctx.roleCap.get(rid);
        if (ctx.roleHave.get(rid) >= Math.min(role.max, total)) continue;
        const s = ctx.mState.get(ministry.id);
        const cands = pool.filter(
          (p) =>
            p.roles.includes(rid) &&
            !(p.rank === 1 && ministry.maxNewcomers != null && s.newcomers + 1 > ministry.maxNewcomers),
        );
        if (cands.length === 0) continue;
        if (!bestCands || cands.length < bestCands.length) {
          bestRole = rid;
          bestCands = cands;
        }
      }
      if (!bestRole) break;
      const p = bestCands[0]; // pool is already sorted best-first
      generated.get(date).push({ personId: p.id, roleId: bestRole });
      bump(p.id, date);
      ctx.used.add(p.id);
      ctx.roleHave.set(bestRole, ctx.roleHave.get(bestRole) + 1);
      const s = ctx.mState.get(roles.get(bestRole).ministry.id);
      if (p.rank === 3) s.seniors++;
      if (p.rank === 1) s.newcomers++;
    }
  }

  for (const d of sortedDates) fillMandatory(d);
  for (const d of sortedDates) fillOptional(d);

  // Slot numbering + warnings -------------------------------------------------
  const assignments = [];
  const warnings = [];
  const roleOrder = [...roles.keys()];
  for (const date of sortedDates) {
    const lockedHere = lockedByDate.get(date);
    const mine = generated.get(date);
    const all = lockedHere.map((l) => ({ roleId: l.roleId, slot: l.slot, personId: l.personId }));
    for (const rid of roleOrder) {
      const taken = new Set(lockedHere.filter((l) => l.roleId === rid).map((l) => l.slot));
      let slot = 0;
      for (const m of mine.filter((x) => x.roleId === rid)) {
        while (taken.has(slot)) slot++;
        taken.add(slot);
        const a = { date, roleId: rid, slot, personId: m.personId };
        assignments.push(a);
        all.push({ roleId: rid, slot, personId: m.personId });
      }
    }
    warnings.push(
      ...validateSession({ date, assignments: all, roster, availableIds: [...availByDate.get(date)] }),
    );
  }
  return { assignments, warnings };
}
