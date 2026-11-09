// HTTP API. See docs/CONTRACT.md section 6.
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import express from 'express';
import {
  DbError,
  clearLocks,
  ensureSessions,
  getAssignmentCounts,
  getAvailability,
  getMonth,
  getPersonAvailability,
  getRoster,
  replaceGenerated,
  setAvailability,
  setSessionStatus,
  setSlot,
  syncConfig,
  transaction,
} from './db/index.js';
import {
  addMonths,
  availabilityWindow,
  isSaturday,
  isValidDate,
  isValidMonth,
  lastDayOf,
  monthOf,
  previousMonthsRange,
  saturdaysOf,
  targetMonth,
  todayIn,
} from './dates.js';
import { ConfigError, loadConfig } from './config.js';
import { generateSchedule, validateSession } from './scheduler.js';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const digest = (s) => createHash('sha256').update(String(s)).digest();
const codesMatch = (a, b) => typeof a === 'string' && timingSafeEqual(digest(a), digest(b));

/**
 * ctx: { db, getConfig(): config, setConfig(config), now?: () => Date }
 * Returns { router, service } so index.js can reuse the service for automation.
 */
export function createApi(ctx) {
  const { db } = ctx;
  const now = () => (ctx.now ? ctx.now() : new Date());
  const config = () => ctx.getConfig();
  const today = () => todayIn(config().settings.timezone, now());

  // ---------- service ----------

  const isAdmin = (req) => codesMatch(req.get('x-admin-code'), config().settings.adminCode);

  function requireMonth(month) {
    const year = Number(String(month).slice(0, 4));
    if (!isValidMonth(month) || year < 2000 || year > 2100) {
      throw new HttpError(400, `Invalid month "${month}", expected YYYY-MM`);
    }
    return month;
  }

  function requireSession(date) {
    if (!isValidDate(date)) throw new HttpError(400, `Invalid date "${date}", expected YYYY-MM-DD`);
    requireMonth(monthOf(date));
    if (!isSaturday(date)) throw new HttpError(400, `${date} is not a Saturday`);
    ensureSessions(db, saturdaysOf(monthOf(date)));
    return date;
  }

  function windowFor(month) {
    return availabilityWindow(month, today(), config().settings);
  }

  function monthPayload(month) {
    ensureSessions(db, saturdaysOf(month));
    const data = getMonth(db, month);
    const roster = getRoster(db);
    const avail = new Map();
    for (const a of getAvailability(db, month)) {
      if (!avail.has(a.date)) avail.set(a.date, []);
      avail.get(a.date).push(a.personId);
    }
    const sessions = data.sessions.map((s) => {
      let warnings = [];
      if (s.status === 'scheduled' && (data.generatedAt || s.assignments.length > 0)) {
        warnings = validateSession({
          date: s.date,
          assignments: s.assignments,
          roster,
          availableIds: avail.get(s.date) ?? [],
        });
      }
      return { ...s, warnings };
    });
    return { month, window: windowFor(month), generatedAt: data.generatedAt, sessions };
  }

  /** Build scheduler input for `dates` of `month` and run it. */
  function runScheduler(month, dates, { seed, existing }) {
    const prev = previousMonthsRange(month, 3);
    return generateSchedule({
      roster: getRoster(db),
      dates,
      availability: getAvailability(db, month),
      locked: existing,
      priorCounts: getAssignmentCounts(db, prev.from, prev.to),
      seed,
    });
  }

  const flat = (sessions, pred) =>
    sessions.flatMap((s) =>
      s.assignments.filter(pred).map((a) => ({
        date: s.date,
        roleId: a.roleId,
        slot: a.slot,
        personId: a.personId,
      })),
    );

  function generateMonth(month, opts = {}) {
    return transaction(db, () => generateMonthTx(month, opts));
  }

  function generateMonthTx(month, { reshuffle = false, clearLocksFirst = false }) {
    ensureSessions(db, saturdaysOf(month));
    if (clearLocksFirst) clearLocks(db, month);
    const cur = getMonth(db, month);
    const t = today();
    const open = cur.sessions.filter((s) => s.status === 'scheduled');
    // Past sessions are frozen: they count toward fairness only and are re-inserted unchanged.
    const future = open.filter((s) => s.date >= t);
    const past = open.filter((s) => s.date < t);
    const result = runScheduler(
      month,
      future.map((s) => s.date),
      {
        seed: reshuffle ? randomUUID() : month,
        existing: [...flat(past, () => true), ...flat(future, (a) => a.locked)],
      },
    );
    replaceGenerated(db, month, [...flat(past, (a) => !a.locked), ...result.assignments]);
    return result;
  }

  function fillRestoredDate(month, date) {
    const cur = getMonth(db, month);
    if (!cur.generatedAt || date < today()) return; // never refill history
    const scheduled = cur.sessions.filter((s) => s.status === 'scheduled');
    const others = scheduled.filter((s) => s.date !== date);
    const result = runScheduler(month, [date], {
      seed: month,
      existing: flat(others, () => true), // other dates count toward fairness only
    });
    replaceGenerated(db, month, [...flat(others, (a) => !a.locked), ...result.assignments]);
  }

  /** Automation: current and next month, once their window is closed and nothing was generated. */
  function runAutomation() {
    const t = today();
    const done = [];
    for (const month of [monthOf(t), addMonths(monthOf(t), 1)]) {
      const closesOn = lastDayOf(addMonths(month, -1));
      if (t <= closesOn) continue;
      ensureSessions(db, saturdaysOf(month));
      if (getMonth(db, month).generatedAt) continue;
      if (getAvailability(db, month).length === 0) continue; // nobody has submitted yet
      generateMonth(month);
      done.push(month);
    }
    return done;
  }

  // ---------- router ----------

  const router = express.Router();
  router.use(express.json({ limit: '100kb' }));

  const requireAdmin = (req, _res, next) => {
    if (!isAdmin(req)) return next(new HttpError(401, 'Admin code required'));
    next();
  };

  router.get('/status', (_req, res) => {
    const t = today();
    const target = targetMonth(t, config().settings);
    res.json({
      churchName: config().settings.churchName,
      timezone: config().settings.timezone,
      today: t,
      targetMonth: target,
      window: windowFor(target),
    });
  });

  router.get('/roster', (_req, res) => res.json(getRoster(db)));

  router.get('/months/:month', (req, res) => {
    res.json(monthPayload(requireMonth(req.params.month)));
  });

  function requireActivePerson(personId) {
    const p = getRoster(db).people.find((x) => x.id === personId);
    if (!p) throw new HttpError(404, `Unknown person "${personId}"`);
    return p;
  }

  router.get('/availability/:month/:personId', (req, res) => {
    const month = requireMonth(req.params.month);
    requireActivePerson(req.params.personId);
    res.json({ dates: getPersonAvailability(db, req.params.personId, month) });
  });

  router.put('/availability/:month/:personId', (req, res) => {
    const month = requireMonth(req.params.month);
    const admin = isAdmin(req);
    if (!admin && windowFor(month).state !== 'open') {
      throw new HttpError(403, `Availability for ${month} is not open for submissions`);
    }
    const person = getRoster(db).people.find((x) => x.id === req.params.personId);
    if (!person || !person.active) {
      throw new HttpError(400, `Unknown or inactive person "${req.params.personId}"`);
    }
    const dates = req.body?.dates;
    if (!Array.isArray(dates) || !dates.every((d) => typeof d === 'string')) {
      throw new HttpError(400, 'Body must be { dates: ["YYYY-MM-DD", ...] }');
    }
    const valid = new Set(saturdaysOf(month));
    const bad = dates.filter((d) => !valid.has(d));
    if (bad.length) throw new HttpError(400, `Not a Saturday in ${month}: ${bad.join(', ')}`);
    const uniq = [...new Set(dates)].sort();
    setAvailability(db, person.id, month, uniq);
    res.json({ dates: getPersonAvailability(db, person.id, month) });
  });

  // ----- admin -----

  router.post('/admin/login', (req, res) => {
    if (!codesMatch(req.body?.code, config().settings.adminCode)) {
      throw new HttpError(401, 'Incorrect admin code');
    }
    res.json({ ok: true });
  });

  router.use('/admin', requireAdmin);

  router.get('/admin/availability/:month', (req, res) => {
    const month = requireMonth(req.params.month);
    const out = Object.fromEntries(saturdaysOf(month).map((d) => [d, []]));
    for (const a of getAvailability(db, month)) (out[a.date] ??= []).push(a.personId);
    res.json(out);
  });

  router.post('/admin/months/:month/generate', (req, res) => {
    const month = requireMonth(req.params.month);
    generateMonth(month, {
      reshuffle: req.body?.reshuffle === true,
      clearLocksFirst: req.body?.clearLocks === true,
    });
    res.json(monthPayload(month));
  });

  router.put('/admin/sessions/:date/slot', (req, res) => {
    const date = requireSession(req.params.date);
    const { roleId, slot, personId } = req.body ?? {};
    if (typeof roleId !== 'string' || !roleId) throw new HttpError(400, 'roleId is required');
    if (!Number.isInteger(slot) || slot < 0) throw new HttpError(400, 'slot must be an integer >= 0');
    if (personId !== null && (typeof personId !== 'string' || !personId)) {
      throw new HttpError(400, 'personId must be a string or null');
    }
    if (personId !== null) {
      const person = getRoster(db).people.find((p) => p.id === personId);
      if (!person || !person.active) throw new HttpError(400, `Unknown or inactive person "${personId}"`);
    }
    setSlot(db, date, roleId, slot, personId);
    res.json(monthPayload(monthOf(date)));
  });

  router.post('/admin/sessions/:date/cancel', (req, res) => {
    const date = requireSession(req.params.date);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) throw new HttpError(400, 'A cancellation reason is required');
    if (reason.length > 500) throw new HttpError(400, 'Reason is too long (500 characters max)');
    setSessionStatus(db, date, 'cancelled', reason);
    res.json(monthPayload(monthOf(date)));
  });

  router.post('/admin/sessions/:date/restore', (req, res) => {
    const date = requireSession(req.params.date);
    transaction(db, () => {
      setSessionStatus(db, date, 'scheduled');
      fillRestoredDate(monthOf(date), date);
    });
    res.json(monthPayload(monthOf(date)));
  });

  router.post('/admin/reload-config', (_req, res) => {
    const next = loadConfig(); // throws ConfigError -> 400
    const counts = syncConfig(db, next);
    ctx.setConfig(next);
    res.json(counts);
  });

  // ---------- errors ----------

  router.use((req, _res, next) => next(new HttpError(404, `No such endpoint: ${req.method} ${req.originalUrl}`)));

  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    let status = 500;
    let body = { error: 'Internal server error' };
    if (err instanceof HttpError) {
      status = err.status;
      body = { error: err.message, ...err.extra };
    } else if (err instanceof ConfigError) {
      status = 400;
      body = { error: err.message, errors: err.errors };
    } else if (err instanceof DbError) {
      status = { NOT_FOUND: 404, CONFLICT: 409, CANCELLED: 400, INVALID: 400 }[err.code] ?? 500;
      body = { error: err.message };
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      body = { error: 'Request body is not valid JSON' };
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      body = { error: 'Request body too large' };
    }
    if (status >= 500) console.error(err);
    res.status(status).json(body);
  });

  return { router, service: { monthPayload, generateMonth, runAutomation } };
}
