// All dates are YYYY-MM-DD / YYYY-MM strings. Never go through local-time Date.
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const parts = (d) => d.split('-').map(Number)

export function shiftMonth(month, delta) {
  const [y, m] = parts(month)
  const idx = y * 12 + (m - 1) + delta
  const ny = Math.floor(idx / 12)
  return `${ny}-${String(idx % 12 + 1).padStart(2, '0')}`
}

export const monthLabel = (month) => {
  const [y, m] = parts(month)
  return `${MONTHS_LONG[m - 1]} ${y}`
}
export const monthShort = (month) => {
  const [y, m] = parts(month)
  return `${MONTHS[m - 1]} ${y}`
}
export const dayNum = (date) => String(parts(date)[2]).padStart(2, '0')
export const dayMonth = (date) => `${dayNum(date)} ${MONTHS[parts(date)[1] - 1]}`
export const fullDate = (date) => `${dayNum(date)} ${MONTHS[parts(date)[1] - 1]} ${parts(date)[0]}`

export function isMonth(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)
}

// ISO timestamp -> "2026-11-09 04:33" in the given IANA zone (falls back to the
// browser's local zone when tz is missing or invalid).
export function stampTime(iso, tz) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  let f
  try { f = new Intl.DateTimeFormat('en-CA', tz ? { ...opts, timeZone: tz } : opts) } catch { f = new Intl.DateTimeFormat('en-CA', opts) }
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}
