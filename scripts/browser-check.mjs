// Real-browser smoke check for the web UI (Playwright + headless Chromium).
//
//   npm run browser-check                       # against http://localhost:3101
//   BASE_URL=http://localhost:5173 npm run browser-check
//   SHOTS_DIR=/some/dir npm run browser-check   # where screenshots go
//
// For each page x viewport it records console errors, uncaught page errors,
// failed requests and HTTP >= 400 responses; asserts #root rendered, no error
// notice is showing, and no horizontal overflow; and saves a full-page
// screenshot. /availability picks the first name (no save). /admin logs in through the UI (ADMIN_CODE, default 1234), then
// clicks Generate/Regenerate and changes one slot. Exits 1 on any failure.
//
// NOTE: the admin flow MUTATES the target database (generates the target month
// and edits a slot). Point it at a scratch DB, not real data.

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE_URL = (process.env.BASE_URL || process.argv[2] || 'http://localhost:3101').replace(/\/$/, '')
const ADMIN_CODE = process.env.ADMIN_CODE || '1234'
const SHOTS_DIR = process.env.SHOTS_DIR ||
  '/private/tmp/claude-501/-Users-kylow-Dev/a4f693a3-9a04-4ad3-bd7f-d890f86c4113/scratchpad/shots'
const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
]
const PAGES = [
  { name: 'schedule', path: '/', check: checkScheduleNov },
  { name: 'schedule-dec', path: `/?m=${process.env.SCHEDULE_MONTH || '2026-12'}`, check: checkScheduleGenerated },
  { name: 'availability', path: '/availability', avail: true },
  { name: 'admin', path: '/admin', admin: true },
]

mkdirSync(SHOTS_DIR, { recursive: true })

const results = []

async function waitSettled(page) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  // Give React a moment to commit after the last fetch, then wait out any spinner.
  await page.waitForTimeout(300)
  await page.waitForFunction(() => !document.querySelector('.loading'), null, { timeout: 10000 }).catch(() => {})
}

async function overflowInfo(page) {
  return page.evaluate(() => {
    const se = document.scrollingElement
    const vw = window.innerWidth
    const offenders = []
    if (se.scrollWidth > vw) {
      // Report the outermost elements that stick out past their parent's box (or the
      // viewport), ignoring anything inside a container that clips/scrolls horizontally.
      const desc = (el, r, why) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : ''} ${why} (right=${Math.round(r.right)} w=${Math.round(r.width)})`
      const clipped = (el) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(p).overflowX)) return true
        }
        return false
      }
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect()
        if (!r.width || clipped(el)) continue
        const pr = el.parentElement.getBoundingClientRect()
        const why = r.right > vw + 0.5 ? 'past viewport' : r.right > pr.right + 0.5 ? `past parent by ${Math.round(r.right - pr.right)}px` : null
        if (!why || offenders.some((o) => o.el.contains(el))) continue
        offenders.push({ el, text: desc(el, r, why) })
        if (offenders.length >= 8) break
      }
    }
    return { scrollWidth: se.scrollWidth, innerWidth: vw, offenders: offenders.map((o) => o.text) }
  })
}

async function availabilityFlow(page, failures, notes) {
  // Pick the first name so step B (the Saturday grid) renders; does not save.
  const first = page.locator('.names button').first()
  if (!(await first.count())) { failures.push('availability: no names listed'); return }
  const name = (await first.locator('span').first().innerText()).trim()
  await first.click()
  await waitSettled(page)
  const cells = await page.locator('.grid .cell').count()
  if (!cells) failures.push(`availability: no Saturday cells after selecting ${name}`)
  else notes.push(`selected ${name}: ${cells} Saturday cells`)
}

// '/' defaults to the current month (Nov 2026 in the scratch setup, not generated):
// session stamps should read PENDING, never OPEN.
async function checkScheduleNov(page, failures, notes) {
  const stamps = (await page.locator('.schedule .stamp').allInnerTexts()).map((t) => t.trim().toUpperCase())
  if (stamps.includes('OPEN')) failures.push(`schedule: card stamp says OPEN (stamps: ${stamps.join(', ')})`)
  else notes.push(`stamps: ${[...new Set(stamps)].join(', ') || '(none)'}`)
}

// A generated month should show people, not "Awaiting assignment". If the month is
// not generated yet (e.g. a fresh DB, since /admin generates later in the run), the
// correct empty state is "Roster not generated yet" with PENDING stamps and no OPEN.
async function checkScheduleGenerated(page, failures, notes) {
  const month = new URL(page.url()).searchParams.get('m')
  const res = await page.request.get(`${BASE_URL}/api/months/${month}`)
  if (!res.ok()) { failures.push(`schedule-dec: GET /api/months/${month} -> HTTP ${res.status()}`); return }
  const data = await res.json()
  const generated = !!data.generatedAt || data.sessions.some((s) => s.assignments.length > 0)
  const text = await page.locator('.schedule').innerText().catch(() => '')
  if (generated) {
    const awaiting = (text.match(/awaiting assignment/gi) || []).length
    if (awaiting) failures.push(`schedule-dec: ${awaiting} session(s) still say "Awaiting assignment"`)
    else notes.push('generated roster rendered')
  } else {
    const stamps = (await page.locator('.schedule .stamp').allInnerTexts()).map((t) => t.trim().toUpperCase())
    if (!/roster not generated yet/i.test(text)) failures.push('schedule-dec: month not generated but "Roster not generated yet" notice missing')
    else if (stamps.includes('OPEN')) failures.push(`schedule-dec: ungenerated month has an OPEN stamp (${stamps.join(', ')})`)
    else notes.push(`not generated yet: empty state shown (stamps: ${[...new Set(stamps)].join(', ')})`)
  }
}

async function adminFlow(page, failures, notes) {
  const input = page.locator('form.login input[type="password"]')
  // Wait out "Checking credentials" until either the login form or the console shows.
  await page.locator('form.login, .admin').first().waitFor({ timeout: 10000 }).catch(() => {})
  if (!(await input.count())) {
    // Already authed (code in sessionStorage) or the login form never rendered.
    if (!(await page.locator('.admin').count())) { failures.push('admin: login form not found'); return }
  } else {
    await input.fill(ADMIN_CODE)
    await page.locator('form.login button').click()
    try {
      await page.locator('.admin').waitFor({ timeout: 10000 })
    } catch {
      const alert = await page.locator('[role="alert"]').allInnerTexts().catch(() => [])
      failures.push(`admin: console did not appear after login ${alert.length ? '(' + alert.join(' | ') + ')' : ''}`)
      return
    }
    notes.push('logged in')
  }
  await waitSettled(page)

  // Generate / Regenerate.
  const gen = page.locator('.admin .btns button.primary').first()
  if (!(await gen.count())) { failures.push('admin: Generate button not found'); return }
  const genLabel = (await gen.innerText()).trim()
  const genResp = page.waitForResponse((r) => /\/api\/admin\/months\/[^/]+\/generate$/.test(r.url()), { timeout: 15000 }).catch(() => null)
  await gen.click()
  const gr = await genResp
  if (!gr) failures.push(`admin: ${genLabel} sent no generate request`)
  else if (!gr.ok()) failures.push(`admin: ${genLabel} -> HTTP ${gr.status()}`)
  else {
    try {
      await page.locator('.notice.ok').waitFor({ timeout: 5000 })
      notes.push(`${genLabel} ok`)
    } catch {
      const err = await page.locator('.admin .notice.err').allInnerTexts().catch(() => [])
      failures.push(`admin: ${genLabel} showed no success notice ${err.length ? '(' + err.join(' | ') + ')' : ''}`)
    }
  }
  await waitSettled(page)

  // Change one slot: first enabled slot select that has a person option different from current.
  const selects = page.locator('.admin .se select.sel')
  const n = await selects.count()
  if (!n) { failures.push('admin: no slot selects rendered after generate'); return }
  let changed = false
  for (let i = 0; i < Math.min(n, 30) && !changed; i++) {
    const sel = selects.nth(i)
    if (await sel.isDisabled()) continue
    const target = await sel.evaluate((s) => {
      const opts = [...s.options].filter((o) => o.value && o.value !== s.value)
      return opts.length ? opts[0].value : null
    })
    if (!target) continue
    const label = await sel.getAttribute('aria-label')
    const resp = page.waitForResponse((r) => r.request().method() !== 'GET' && /\/api\/admin\/sessions\//.test(r.url()), { timeout: 10000 }).catch(() => null)
    await sel.selectOption(target)
    const r = await resp
    if (!r) failures.push(`admin: slot change on "${label}" sent no request`)
    else if (!r.ok()) failures.push(`admin: slot change on "${label}" -> HTTP ${r.status()} ${await r.text().catch(() => '')}`)
    else {
      await waitSettled(page)
      const now = await selects.nth(i).inputValue()
      if (now !== target) failures.push(`admin: slot "${label}" shows ${now || '(empty)'} after change, expected ${target}`)
      else notes.push(`slot "${label}" -> ${target}`)
      const err = await page.locator('.admin .notice.err').allInnerTexts().catch(() => [])
      if (err.length) failures.push(`admin: error notice after slot change: ${err.join(' | ')}`)
    }
    changed = true
  }
  if (!changed) failures.push('admin: no slot select had an alternative option to switch to')

  const gen2 = await page.locator('.admin .meta').first().innerText().catch(() => '')
  if (/UTC/.test(gen2)) failures.push(`admin: Generated shows UTC suffix: ${gen2.replace(/\s+/g, ' ')}`)
  else notes.push(`Generated: ${gen2.replace(/\s+/g, ' ').replace(/^GENERATED /i, '')}`)
}

const browser = await chromium.launch()
try {
  for (const vp of VIEWPORTS) {
    for (const pg of PAGES) {
      const context = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 })
      const page = await context.newPage()
      const failures = []
      const notes = []
      const consoleErrors = []
      const pageErrors = []
      const failedRequests = []

      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
      page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`))
      page.on('requestfailed', (r) => {
        // Google Fonts may be blocked offline; note but do not fail on third-party font loads.
        const ext = !r.url().startsWith(BASE_URL)
        failedRequests.push({ ext, text: `${r.method()} ${r.url()} ${r.failure()?.errorText || ''}` })
      })
      page.on('response', (r) => {
        if (r.status() >= 400) failedRequests.push({ ext: !r.url().startsWith(BASE_URL), text: `HTTP ${r.status()} ${r.request().method()} ${r.url()}` })
      })
      page.on('dialog', (d) => d.accept().catch(() => {}))

      try {
        await page.goto(BASE_URL + pg.path, { waitUntil: 'domcontentloaded', timeout: 15000 })
        await waitSettled(page)

        if (pg.admin) await adminFlow(page, failures, notes)
        if (pg.avail) await availabilityFlow(page, failures, notes)
        if (pg.check) await pg.check(page, failures, notes)

        const rootLen = await page.evaluate(() => document.getElementById('root')?.innerHTML.length ?? -1)
        if (rootLen <= 0) failures.push(`#root is empty (${rootLen})`)
        if (await page.locator('.loading').count()) failures.push('still showing a loading spinner')
        const alerts = await page.locator('.notice.err').allInnerTexts().catch(() => [])
        if (alerts.length) failures.push(`error notice visible: ${alerts.map((a) => a.replace(/\s+/g, ' ')).join(' | ')}`)

        const ov = await overflowInfo(page)
        if (ov.scrollWidth > ov.innerWidth) {
          failures.push(`horizontal overflow: scrollWidth ${ov.scrollWidth} > innerWidth ${ov.innerWidth}` +
            (ov.offenders.length ? `\n        offenders: ${ov.offenders.join('\n                   ')}` : ''))
        }
      } catch (e) {
        failures.push(`navigation/script error: ${e.message.split('\n')[0]}`)
      }

      const shot = join(SHOTS_DIR, `${pg.name}-${vp.width}.png`)
      await page.screenshot({ path: shot, fullPage: true }).catch((e) => failures.push(`screenshot failed: ${e.message}`))

      for (const e of pageErrors) failures.push(`page error: ${e}`)
      for (const e of consoleErrors) failures.push(`console error: ${e}`)
      for (const r of failedRequests) (r.ext ? notes : failures).push(`${r.ext ? '(external) ' : ''}request failed: ${r.text}`)

      results.push({ page: pg.path, width: vp.width, failures, notes, shot })
      await context.close()
    }
  }
} finally {
  await browser.close()
}

console.log(`\nbrowser-check against ${BASE_URL}\n`)
let failed = 0
for (const r of results) {
  const ok = r.failures.length === 0
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.page.padEnd(14)} @${r.width}px  ${r.shot}`)
  for (const f of r.failures) console.log(`      - ${f.replace(/\n/g, '\n        ')}`)
  for (const n of r.notes) console.log(`      . ${n}`)
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
