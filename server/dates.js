// Pure date helpers. Dates are 'YYYY-MM-DD' strings, months are 'YYYY-MM'.
// Everything is computed with UTC arithmetic on the calendar fields, so the host
// timezone never leaks in. Only todayIn() looks at a real clock value (passed in).

const pad = (n, w = 2) => String(n).padStart(w, '0');

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

export function isValidMonth(s) {
  if (typeof s !== 'string') return false;
  const m = MONTH_RE.exec(s);
  return !!m && +m[2] >= 1 && +m[2] <= 12;
}

export function isValidDate(s) {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(`${m[1]}-${m[2]}`);
}

export function monthOf(date) {
  return date.slice(0, 7);
}

export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function lastDayOf(month) {
  return `${month}-${pad(daysInMonth(month))}`;
}

function toUtc(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms) {
  const dt = new Date(ms);
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function addDays(date, n) {
  return fromUtc(toUtc(date) + n * 86400000);
}

/** Whole days from a to b (b - a). */
export function diffDays(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

/** 0 = Sunday ... 6 = Saturday */
export function weekday(date) {
  return new Date(toUtc(date)).getUTCDay();
}

export function isSaturday(date) {
  return weekday(date) === 6;
}

export function saturdaysOf(month) {
  const out = [];
  const n = daysInMonth(month);
  for (let d = 1; d <= n; d++) {
    const date = `${month}-${pad(d)}`;
    if (isSaturday(date)) out.push(date);
  }
  return out;
}

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${pad(Math.floor(idx / 12), 4)}-${pad((idx % 12) + 1)}`;
}

/** Today's calendar date in an IANA timezone. `now` is injectable for tests. */
export function todayIn(tz, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Availability window for `month`: the last N days of the previous month, inclusive.
 * `settings` is the config `settings` object (needs availability.*).
 * state: 'upcoming' | 'open' | 'closed'. alwaysOpen forces 'open'.
 */
export function availabilityWindow(month, today, settings) {
  const a = settings?.availability ?? {};
  const days = a.openDaysBeforeMonthEnd ?? 7;
  const closesOn = lastDayOf(addMonths(month, -1));
  const opensOn = addDays(closesOn, -(days - 1));
  let state;
  if (a.alwaysOpen) state = 'open';
  else if (today < opensOn) state = 'upcoming';
  else if (today <= closesOn) state = 'open';
  else state = 'closed';
  return { month, opensOn, closesOn, state };
}

/**
 * The month currently collecting availability, or the next one to collect.
 * The window for month M lives at the end of M-1, so that's always next calendar month.
 */
export function targetMonth(today, _settings) {
  return addMonths(monthOf(today), 1);
}

/** Inclusive date range covering the `n` months before `month`. */
export function previousMonthsRange(month, n = 3) {
  return { from: `${addMonths(month, -n)}-01`, to: lastDayOf(addMonths(month, -1)) };
}
