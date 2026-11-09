// Persistence layer on node:sqlite. Synchronous. See docs/CONTRACT.md section 4.
import { DatabaseSync } from 'node:sqlite';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export class DbError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'DbError';
    this.code = code;
  }
}

// ---------- helpers ----------

const stmtCache = new WeakMap();
function q(db, sql) {
  let m = stmtCache.get(db);
  if (!m) stmtCache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}

// SQLITE_CONSTRAINT (19) family -> DbError. 1555/2067 are PRIMARYKEY/UNIQUE.
function mapError(e) {
  if (e instanceof DbError) return e;
  if (e && typeof e.errcode === 'number' && (e.errcode & 0xff) === 19) {
    const unique = e.errcode === 1555 || e.errcode === 2067;
    return new DbError(unique ? 'CONFLICT' : 'INVALID', e.message, { cause: e });
  }
  return e;
}

let spCounter = 0;
/** Run fn atomically. Nested calls use savepoints. Constraint errors become DbError. */
function tx(db, fn) {
  if (db.isTransaction) {
    const sp = `sp_${++spCounter}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const r = fn();
      db.exec(`RELEASE ${sp}`);
      return r;
    } catch (e) {
      // If SQLite already aborted the outer transaction the savepoint is gone; keep the real error.
      if (db.isTransaction) {
        try {
          db.exec(`ROLLBACK TO ${sp}`);
          db.exec(`RELEASE ${sp}`);
        } catch { /* outer rollback will clean up */ }
      }
      throw mapError(e);
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw mapError(e);
  }
}

/**
 * Run fn(db) atomically for multi-step writes across several exported functions
 * (e.g. clearLocks + replaceGenerated, or restore + refill). Every exported writer
 * nests inside it via savepoints. Throws whatever fn throws; nothing is committed.
 */
export function transaction(db, fn) {
  return tx(db, () => fn(db));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertDate(d) {
  if (typeof d !== 'string' || !DATE_RE.test(d)) throw new DbError('INVALID', `Invalid date: ${d}`);
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) {
    throw new DbError('INVALID', `Invalid date: ${d}`);
  }
  return d;
}
function assertMonth(m) {
  if (typeof m !== 'string' || !MONTH_RE.test(m)) throw new DbError('INVALID', `Invalid month: ${m}`);
  return m;
}
// 'YYYY-MM-01'..'YYYY-MM-31' string-compares correctly against 'YYYY-MM-DD'.
const monthRange = (m) => [`${assertMonth(m)}-01`, `${m}-31`];

// ---------- open / migrate ----------

function migrate(db) {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const latest = files.length ? parseInt(files[files.length - 1], 10) : 0;
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > latest) {
    throw new DbError('SCHEMA_TOO_NEW', `Database schema v${current} is newer than supported v${latest}`);
  }
  for (const f of files) {
    const v = parseInt(f, 10);
    if (v <= current) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${v}`);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }
}

export function openDb(path) {
  const target = path ?? process.env.DB_PATH ?? 'data/serving.db';
  const memory = target === ':memory:';
  let file = target;
  // Startup failures name the file and the likely fix instead of a bare SQLite message.
  const fail = (e, hint) => {
    if (e instanceof DbError) return e;
    const why = hint ?? e?.message ?? String(e);
    return new DbError('OPEN_FAILED', `Cannot open database ${file}: ${why}`, { cause: e });
  };
  let db;
  try {
    if (!memory) {
      file = isAbsolute(target) ? target : resolve(ROOT, target);
      mkdirSync(dirname(file), { recursive: true });
      // GET /months writes (ensureSessions), so a read-only DB would 500 on every page.
      if (existsSync(file)) accessSync(file, fsConstants.R_OK | fsConstants.W_OK);
    }
    db = new DatabaseSync(file);
  } catch (e) {
    throw fail(e, e?.code === 'EACCES' ? 'file is not readable and writable by this user' : undefined);
  }
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    if (!memory) {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    migrate(db);
  } catch (e) {
    db.close();
    let hint;
    if (e?.errcode === 26) hint = 'file is not a SQLite database';
    else if ((e?.errcode & 0xff) === 5) hint = 'database is locked by another process (is another server running?)';
    else if ((e?.errcode & 0xff) === 8) hint = 'database or its directory is read-only';
    else if (/already exists/.test(e?.message ?? '')) {
      hint = `it was not created by this app (user_version 0 but tables exist): ${e.message}`;
    }
    throw fail(e, hint);
  }
  return db;
}

// ---------- config sync / roster ----------

export function syncConfig(db, config) {
  const ministries = config?.ministries ?? [];
  const people = config?.people ?? [];

  return tx(db, () => {
    let added = 0, updated = 0, deactivated = 0;
    const nn = (v) => (v === undefined ? null : v);

    // Ministries
    const exM = new Map(q(db, 'SELECT * FROM ministries').all().map((r) => [r.id, r]));
    const upM = q(db, `INSERT INTO ministries (id, name, min_senior, max_newcomers, active, sort_order)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, min_senior = excluded.min_senior,
        max_newcomers = excluded.max_newcomers, active = 1, sort_order = excluded.sort_order`);
    const seenM = new Set();
    ministries.forEach((m, i) => {
      const minSenior = nn(m.seniority?.minSenior);
      const maxNewcomers = nn(m.seniority?.maxNewcomers);
      const old = exM.get(m.id);
      if (!old) added++;
      else if (old.name !== m.name || old.min_senior !== minSenior || old.max_newcomers !== maxNewcomers
        || old.active !== 1 || old.sort_order !== i) updated++;
      upM.run(m.id, m.name, minSenior, maxNewcomers, i);
      seenM.add(m.id);
    });
    for (const old of exM.values()) {
      if (!seenM.has(old.id) && old.active) {
        q(db, 'UPDATE ministries SET active = 0 WHERE id = ?').run(old.id);
        deactivated++;
      }
    }

    // Roles (global config order)
    const exR = new Map(q(db, 'SELECT * FROM roles').all().map((r) => [r.id, r]));
    const upR = q(db, `INSERT INTO roles (id, ministry_id, name, min, max, active, sort_order)
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET ministry_id = excluded.ministry_id, name = excluded.name,
        min = excluded.min, max = excluded.max, active = 1, sort_order = excluded.sort_order`);
    const seenR = new Set();
    let ri = 0;
    for (const m of ministries) {
      for (const r of m.roles ?? []) {
        const old = exR.get(r.id);
        if (!old) added++;
        else if (old.ministry_id !== m.id || old.name !== r.name || old.min !== r.min || old.max !== r.max
          || old.active !== 1 || old.sort_order !== ri) updated++;
        upR.run(r.id, m.id, r.name, r.min, r.max, ri);
        seenR.add(r.id);
        ri++;
      }
    }
    for (const old of exR.values()) {
      if (!seenR.has(old.id) && old.active) {
        q(db, 'UPDATE roles SET active = 0 WHERE id = ?').run(old.id);
        deactivated++;
      }
    }

    // A lowered role max must not strand assignments at slot >= max: the slot triggers would
    // then reject every later replaceGenerated (generate / restore) for that month. Repack each
    // affected (session, role) into slots 0..max-1, keeping locked rows first, then slot order;
    // anything beyond the new max is dropped.
    const over = q(db, `SELECT DISTINCT a.session_id, a.role_id, r.max FROM assignments a
      JOIN roles r ON r.id = a.role_id WHERE a.slot >= r.max`).all();
    if (over.length) {
      const grp = q(db, `SELECT person_id, locked FROM assignments
        WHERE session_id = ? AND role_id = ? ORDER BY locked DESC, slot`);
      const delGrp = q(db, 'DELETE FROM assignments WHERE session_id = ? AND role_id = ?');
      const insA = q(db, `INSERT INTO assignments (session_id, role_id, slot, person_id, locked)
        VALUES (?, ?, ?, ?, ?)`);
      for (const g of over) {
        const keep = grp.all(g.session_id, g.role_id).slice(0, g.max);
        delGrp.run(g.session_id, g.role_id);
        keep.forEach((a, slot) => insA.run(g.session_id, g.role_id, slot, a.person_id, a.locked));
      }
    }

    // People
    const exP = new Map(q(db, 'SELECT * FROM people').all().map((r) => [r.id, r]));
    const exPR = new Map();
    for (const r of q(db, 'SELECT person_id, role_id FROM person_roles ORDER BY pos').all()) {
      if (!exPR.has(r.person_id)) exPR.set(r.person_id, []);
      exPR.get(r.person_id).push(r.role_id);
    }
    const upP = q(db, `INSERT INTO people (id, name, rank, max_per_month, active, sort_order)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, rank = excluded.rank,
        max_per_month = excluded.max_per_month, active = 1, sort_order = excluded.sort_order`);
    const delPR = q(db, 'DELETE FROM person_roles WHERE person_id = ?');
    const insPR = q(db, 'INSERT INTO person_roles (person_id, role_id, pos) VALUES (?, ?, ?)');
    const seenP = new Set();
    people.forEach((p, i) => {
      const mpm = nn(p.maxPerMonth);
      const roles = [...new Set(p.roles ?? [])];
      const old = exP.get(p.id);
      const oldRoles = exPR.get(p.id) ?? [];
      if (!old) added++;
      else if (old.name !== p.name || old.rank !== p.rank || old.max_per_month !== mpm || old.active !== 1
        || old.sort_order !== i || oldRoles.join('\0') !== roles.join('\0')) updated++;
      upP.run(p.id, p.name, p.rank, mpm, i);
      delPR.run(p.id);
      roles.forEach((rid, pos) => insPR.run(p.id, rid, pos));
      seenP.add(p.id);
    });
    for (const old of exP.values()) {
      if (!seenP.has(old.id) && old.active) {
        q(db, 'UPDATE people SET active = 0 WHERE id = ?').run(old.id);
        deactivated++;
      }
    }

    return { added, updated, deactivated };
  });
}

export function getRoster(db) {
  const roles = q(db, 'SELECT * FROM roles ORDER BY sort_order, id').all();
  const byMinistry = new Map();
  for (const r of roles) {
    if (!byMinistry.has(r.ministry_id)) byMinistry.set(r.ministry_id, []);
    byMinistry.get(r.ministry_id).push({
      id: r.id, name: r.name, min: r.min, max: r.max, active: !!r.active,
    });
  }
  const ministries = q(db, 'SELECT * FROM ministries ORDER BY sort_order, id').all().map((m) => ({
    id: m.id,
    name: m.name,
    active: !!m.active,
    minSenior: m.min_senior,
    maxNewcomers: m.max_newcomers,
    roles: byMinistry.get(m.id) ?? [],
  }));

  const prs = new Map();
  for (const r of q(db, 'SELECT person_id, role_id FROM person_roles ORDER BY pos').all()) {
    if (!prs.has(r.person_id)) prs.set(r.person_id, []);
    prs.get(r.person_id).push(r.role_id);
  }
  const people = q(db, 'SELECT * FROM people ORDER BY sort_order, id').all().map((p) => ({
    id: p.id,
    name: p.name,
    rank: p.rank,
    roles: prs.get(p.id) ?? [],
    maxPerMonth: p.max_per_month,
    active: !!p.active,
  }));
  return { ministries, people };
}

// ---------- sessions / schedule ----------

export function ensureSessions(db, dates) {
  for (const d of dates) assertDate(d);
  // Every GET /months calls this; skip the write lock when nothing is missing.
  const has = q(db, 'SELECT 1 FROM sessions WHERE date = ?');
  if (dates.every((d) => has.get(d))) return;
  tx(db, () => {
    const s = q(db, 'INSERT OR IGNORE INTO sessions (date) VALUES (?)');
    for (const d of dates) s.run(d);
  });
}

export function getMonth(db, month) {
  const [from, to] = monthRange(month);
  const sessions = q(db, 'SELECT id, date, status, cancel_reason FROM sessions WHERE date BETWEEN ? AND ? ORDER BY date')
    .all(from, to);
  const rows = q(db, `SELECT a.session_id, a.role_id, a.slot, a.person_id, a.locked
    FROM assignments a
    JOIN sessions s ON s.id = a.session_id
    JOIN roles r ON r.id = a.role_id
    JOIN ministries m ON m.id = r.ministry_id
    WHERE s.date BETWEEN ? AND ?
    ORDER BY s.date, m.sort_order, r.sort_order, a.slot`).all(from, to);
  const bySession = new Map();
  for (const r of rows) {
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id).push({
      roleId: r.role_id, slot: r.slot, personId: r.person_id, locked: !!r.locked,
    });
  }
  const gen = q(db, 'SELECT generated_at FROM months WHERE month = ?').get(month);
  return {
    generatedAt: gen ? gen.generated_at : null,
    sessions: sessions.map((s) => ({
      date: s.date,
      status: s.status,
      cancelReason: s.cancel_reason,
      assignments: bySession.get(s.id) ?? [],
    })),
  };
}

export function replaceGenerated(db, month, assignments) {
  const [from, to] = monthRange(month);
  tx(db, () => {
    q(db, `DELETE FROM assignments WHERE locked = 0 AND session_id IN
      (SELECT id FROM sessions WHERE date BETWEEN ? AND ? AND status = 'scheduled')`).run(from, to);
    const find = q(db, 'SELECT id, status FROM sessions WHERE date = ?');
    const ins = q(db, `INSERT INTO assignments (session_id, role_id, slot, person_id, locked)
      VALUES (?, ?, ?, ?, 0)`);
    for (const a of assignments) {
      assertDate(a.date);
      if (a.date < from || a.date > to) {
        throw new DbError('INVALID', `Assignment date ${a.date} is outside ${month}`);
      }
      const s = find.get(a.date);
      if (!s) throw new DbError('NOT_FOUND', `No session on ${a.date}`);
      if (s.status === 'cancelled') throw new DbError('CANCELLED', `Session ${a.date} is cancelled`);
      ins.run(s.id, a.roleId, a.slot, a.personId);
    }
    q(db, `INSERT INTO months (month, generated_at) VALUES (?, ?)
      ON CONFLICT(month) DO UPDATE SET generated_at = excluded.generated_at`)
      .run(month, new Date().toISOString());
  });
}

export function setSlot(db, date, roleId, slot, personId) {
  assertDate(date);
  if (!Number.isInteger(slot) || slot < 0) throw new DbError('INVALID', `Invalid slot: ${slot}`);
  tx(db, () => {
    const s = q(db, 'SELECT id, status FROM sessions WHERE date = ?').get(date);
    if (!s) throw new DbError('NOT_FOUND', `No session on ${date}`);
    if (s.status === 'cancelled') throw new DbError('CANCELLED', `Session ${date} is cancelled`);
    const role = q(db, 'SELECT max FROM roles WHERE id = ?').get(roleId);
    if (!role) throw new DbError('NOT_FOUND', `Unknown role: ${roleId}`);
    if (slot >= role.max) throw new DbError('INVALID', `Slot ${slot} out of range for ${roleId} (max ${role.max})`);

    const target = q(db, 'SELECT id, person_id FROM assignments WHERE session_id = ? AND role_id = ? AND slot = ?')
      .get(s.id, roleId, slot);

    if (personId === null || personId === undefined) {
      if (target) q(db, 'DELETE FROM assignments WHERE id = ?').run(target.id);
      return;
    }
    if (!q(db, 'SELECT 1 FROM people WHERE id = ?').get(personId)) {
      throw new DbError('NOT_FOUND', `Unknown person: ${personId}`);
    }
    const mine = q(db, 'SELECT id, role_id, slot FROM assignments WHERE session_id = ? AND person_id = ?')
      .get(s.id, personId);

    if (mine && target && mine.id === target.id) {
      q(db, 'UPDATE assignments SET locked = 1 WHERE id = ?').run(mine.id);
    } else if (!mine) {
      if (target) q(db, 'UPDATE assignments SET person_id = ?, locked = 1 WHERE id = ?').run(personId, target.id);
      else q(db, 'INSERT INTO assignments (session_id, role_id, slot, person_id, locked) VALUES (?, ?, ?, ?, 1)')
        .run(s.id, roleId, slot, personId);
    } else if (!target) {
      // move person to the empty target slot
      q(db, 'UPDATE assignments SET role_id = ?, slot = ?, locked = 1 WHERE id = ?').run(roleId, slot, mine.id);
    } else {
      // swap the two people
      const del = q(db, 'DELETE FROM assignments WHERE id = ?');
      del.run(mine.id);
      del.run(target.id);
      const ins = q(db, 'INSERT INTO assignments (session_id, role_id, slot, person_id, locked) VALUES (?, ?, ?, ?, 1)');
      ins.run(s.id, roleId, slot, personId);
      ins.run(s.id, mine.role_id, mine.slot, target.person_id);
    }
  });
}

export function setSessionStatus(db, date, status, reason) {
  assertDate(date);
  if (status !== 'scheduled' && status !== 'cancelled') {
    throw new DbError('INVALID', `Invalid status: ${status}`);
  }
  tx(db, () => {
    const s = q(db, 'SELECT id FROM sessions WHERE date = ?').get(date);
    if (!s) throw new DbError('NOT_FOUND', `No session on ${date}`);
    if (status === 'cancelled') {
      q(db, 'DELETE FROM assignments WHERE session_id = ?').run(s.id);
      q(db, "UPDATE sessions SET status = 'cancelled', cancel_reason = ? WHERE id = ?").run(reason ?? null, s.id);
    } else {
      q(db, "UPDATE sessions SET status = 'scheduled', cancel_reason = NULL WHERE id = ?").run(s.id);
    }
  });
}

export function clearLocks(db, month) {
  const [from, to] = monthRange(month);
  q(db, `UPDATE assignments SET locked = 0 WHERE locked = 1 AND session_id IN
    (SELECT id FROM sessions WHERE date BETWEEN ? AND ?)`).run(from, to);
}

export function getAssignmentCounts(db, fromDate, toDate) {
  assertDate(fromDate);
  assertDate(toDate);
  const out = {};
  for (const r of q(db, `SELECT a.person_id, COUNT(*) AS n FROM assignments a
    JOIN sessions s ON s.id = a.session_id
    WHERE s.status = 'scheduled' AND s.date BETWEEN ? AND ?
    GROUP BY a.person_id`).all(fromDate, toDate)) {
    out[r.person_id] = r.n;
  }
  return out;
}

// ---------- availability ----------

export function getAvailability(db, month) {
  const [from, to] = monthRange(month);
  return q(db, `SELECT a.person_id, a.date FROM availability a
    JOIN people p ON p.id = a.person_id
    WHERE a.date BETWEEN ? AND ? ORDER BY a.date, p.sort_order, p.id`)
    .all(from, to).map((r) => ({ personId: r.person_id, date: r.date }));
}

export function getPersonAvailability(db, personId, month) {
  const [from, to] = monthRange(month);
  return q(db, 'SELECT date FROM availability WHERE person_id = ? AND date BETWEEN ? AND ? ORDER BY date')
    .all(personId, from, to).map((r) => r.date);
}

export function setAvailability(db, personId, month, dates) {
  const [from, to] = monthRange(month);
  const uniq = [...new Set(dates)];
  for (const d of uniq) {
    assertDate(d);
    if (d < from || d > to) throw new DbError('INVALID', `Date ${d} is outside ${month}`);
  }
  tx(db, () => {
    if (!q(db, 'SELECT 1 FROM people WHERE id = ?').get(personId)) {
      throw new DbError('NOT_FOUND', `Unknown person: ${personId}`);
    }
    q(db, 'DELETE FROM availability WHERE person_id = ? AND date BETWEEN ? AND ?').run(personId, from, to);
    const ins = q(db, 'INSERT INTO availability (person_id, date) VALUES (?, ?)');
    for (const d of uniq) ins.run(personId, d);
  });
}
