# Church Serving — Team Contract

Owner: **Mark S. (lead)**. This document is the source of truth for every interface between teammates. If you need it changed, message the lead. Don't route around it.

## 1. Product

- Every **Saturday** there is one worship session. Each session is staffed from several **ministries** (Worship Team, Ushering, Tech), and each ministry has **roles** (lead singer, drummer, usher, sound, ...).
- **Availability:** during the **last 7 days of month M-1**, members choose their name and tick the Saturdays of month **M** they can serve. They don't log in.
- **Auto-assign:** once the window closes (end of month M-1), the server generates month M's schedule from the available pool. An admin can also generate or regenerate at any time.
- **Admin** (shared code `1234`, set in config): reassign or swap people between slots, clear slots, cancel or restore a session (with a reason), regenerate a month, edit anyone's availability at any time, and reload the config file.
- **Config file** (`serving.config.yaml` at project root) is the source of truth for people, ministries, roles and settings.

## 2. Stack & layout

- Node 26 (ESM), **Express 5**, built-in **`node:sqlite`** (no native deps), `yaml` for the config. API on port **3001**.
- Web: **React 19 + Vite + React Router**, plain JSX, vanilla CSS with design tokens. Dev server on 5173, which proxies `/api` to 3001.
- Production: `npm run build` then `npm start`. Express serves `web/dist` with an SPA fallback.
- All dates are `YYYY-MM-DD` strings and months are `YYYY-MM`. "Today" is computed in `settings.timezone` using `Intl`. Never use `Date#toISOString()` to get a local date.

```
church-serving/
  serving.config.yaml          lead (sample data)       -- Harmony may extend
  package.json, docs/          lead
  server/db/**                 Irving
  server/config.js, scheduler.js, routes.js, index.js, dates.js, package.json   Dylan
  server/test/**, scripts/smoke.mjs, README.md        Harmony
  web/**                       Helly
```

## 3. Config format (`serving.config.yaml`)

```yaml
settings:
  churchName: string
  timezone: IANA tz              # default Asia/Kuala_Lumpur
  adminCode: "1234"
  availability:
    openDaysBeforeMonthEnd: 7    # window = last N days of the previous month, inclusive
    alwaysOpen: false            # testing escape hatch
ministries:
  - id: worship                  # slug, unique
    name: Worship Team
    seniority:                   # optional; applies to all of this ministry's assignees in one session
      minSenior: 1               # at least N people with rank 3
      maxNewcomers: 3            # at most N people with rank 1
    roles:
      - { id: lead_singer, name: Lead Singer, min: 1, max: 1 }   # role ids are globally unique
people:
  - id: sarah-tan                # slug, unique, stable (rename `name` freely, never `id`)
    name: Sarah Tan
    rank: 3                      # 1 = newcomer, 2 = regular, 3 = senior
    roles: [lead_singer, vocalist]
    maxPerMonth: 2               # optional, default unlimited
```

Validation, which is fatal at boot and returns a 400 on reload: unique ids, rank in {1,2,3}, `0 <= min <= max`, `max >= 1`, every role a person lists must exist, `seniority` numbers >= 0.

**Sync semantics:** config → DB in one transaction. Rows are upserted by id. People, roles and ministries missing from the config are set to `active = 0` (soft delete, so history keeps rendering). `person_roles` is replaced. Display order follows the config order.

## 4. DB layer: `server/db/index.js` (Irving)

Everything is synchronous (`node:sqlite`). Turn `PRAGMA foreign_keys = ON` and WAL on. The default path is `data/serving.db`, which `DB_PATH` overrides; `:memory:` must work for tests. Use CHECK, UNIQUE and FK constraints so that bad data cannot be stored at all. Schema version tracking uses `PRAGMA user_version`.

Exports (exact names):

| Function | Returns / behaviour |
|---|---|
| `openDb(path?)` | opened + migrated `db` |
| `syncConfig(db, config)` | `{ added, updated, deactivated }` counts. Transactional |
| `getRoster(db)` | `{ ministries: [{ id, name, active, minSenior, maxNewcomers, roles: [{ id, name, min, max, active }] }], people: [{ id, name, rank, roles: [roleId], maxPerMonth, active }] }`, in config order, **including inactive** |
| `ensureSessions(db, dates)` | inserts missing session rows (`status='scheduled'`) |
| `getMonth(db, month)` | `{ generatedAt, sessions: [{ date, status, cancelReason, assignments: [{ roleId, slot, personId, locked }] }] }`. `generatedAt` is the ISO timestamp of the last generation, or null |
| `getAvailability(db, month)` | `[{ personId, date }]` |
| `getPersonAvailability(db, personId, month)` | `[date]` |
| `setAvailability(db, personId, month, dates)` | replaces that person's dates for the month. Transactional |
| `replaceGenerated(db, month, assignments)` | in one tx: deletes every **unlocked** assignment in the month's non-cancelled sessions, inserts `assignments` (`locked=0`), and stamps `generatedAt` |
| `setSlot(db, date, roleId, slot, personId \| null)` | admin edit, sets `locked=1`. If `personId` already holds another slot in the same session, **swap** the two (both locked). `null` clears the slot. One transaction. Throws `DbError` with `code` set to `NOT_FOUND`, `CANCELLED` or `CONFLICT` |
| `setSessionStatus(db, date, status, reason?)` | `'cancelled'` deletes all of that session's assignments; `'scheduled'` clears the reason |
| `clearLocks(db, month)` | sets `locked=0` for every assignment in the month |
| `transaction(db, fn)` | runs `fn()` atomically (savepoint if already inside a transaction); callers use it to make multi-step writes atomic |
| `getAssignmentCounts(db, fromDate, toDate)` | `{ [personId]: n }` over non-cancelled sessions, inclusive range |

Hard integrity rules enforced by the DB: one person at most once per session (`UNIQUE(session_id, person_id)`), one person per slot (`UNIQUE(session_id, role_id, slot)`), `slot >= 0`, rank 1–3, status in (`scheduled`, `cancelled`), and FK cascades from session → assignments and availability → person. `slot < role.max` is checked in `setSlot`.

## 5. Scheduler: `server/scheduler.js` (Dylan). Pure: no I/O, no `Date.now()`

```js
generateSchedule({
  roster,        // getRoster() shape; ignore inactive people/roles/ministries
  dates,         // ascending, non-cancelled session dates to fill
  availability,  // [{ personId, date }]
  locked,        // [{ date, roleId, slot, personId }]: keep exactly as is, count toward everything
  priorCounts,   // { personId: n } assignments in the previous 3 months (fairness tiebreak)
  seed,          // string; identical inputs + seed => identical output
}) => {
  assignments: [{ date, roleId, slot, personId }],   // NEW assignments only (excludes locked)
  warnings:    [{ date, code, message, ministryId?, roleId?, personId?, slot? }],
  // personId + slot REQUIRED on UNAVAILABLE / ROLE_MISMATCH / INACTIVE_PERSON

}

validateSession({ date, assignments, roster, availableIds }) => warnings[]
// assignments = all of the session's assignments; availableIds = person ids available that date
```

**Hard constraints** (never violated by the generator): the person is active and available that date, holds the role, has at most one role per session, the role has at most `max` people, and `maxPerMonth` is respected.

**Objectives, in priority order:**
1. Meet `min` for every role.
2. Meet ministry seniority (`>= minSenior` rank-3, `<= maxNewcomers` rank-1), counting locked assignees.
3. Fairness: spread load evenly across the month. Prefer fewer assignments this month, then avoid back-to-back Saturdays, then fewer `priorCounts`, then a seeded random tiebreak.
4. Fill optional slots up to `max`.

Fill the scarcest roles first, and do it across ministries, because a drummer who is also an usher should end up drumming. A small backtracking search per session is fine (the pools are tiny), but cap the search and fall back to the best effort found. If a goal can't be met, return a warning instead of throwing.

**Warning codes:** `UNDERSTAFFED`, `NO_SENIOR`, `TOO_MANY_NEWCOMERS`, `UNAVAILABLE`, `ROLE_MISMATCH`, `INACTIVE_PERSON`. `validateSession` produces all of them, and the API shows them live so manual admin edits get flagged too.

## 6. HTTP API (Dylan). JSON only. Errors return `{ error: string }` with the matching 4xx/5xx status

Admin endpoints require the header `X-Admin-Code` to equal `settings.adminCode`, or they return 401. A public endpoint that accepts the header treats a valid one as an admin override.

| Method & path | Body | Response |
|---|---|---|
| `GET /api/status` | — | `{ churchName, timezone, today, targetMonth, window }`. `targetMonth` is the month currently collecting (or next to collect) availability |
| `GET /api/roster` | — | `getRoster()` shape |
| `GET /api/months/:month` | — | **MonthPayload** (below). Lazily ensures session rows |
| `GET /api/availability/:month/:personId` | — | `{ dates: [date] }` |
| `PUT /api/availability/:month/:personId` | `{ dates }` | `{ dates }`. 403 if the window isn't open and there's no admin header. 400 for unknown or inactive people, or for a date that isn't a Saturday in that month |
| `POST /api/admin/login` | `{ code }` | `{ ok: true }` or 401 |
| `GET /api/admin/availability/:month` | — | `{ [date]: [personId] }` |
| `POST /api/admin/months/:month/generate` | `{ reshuffle?: bool, clearLocks?: bool }` | MonthPayload. `reshuffle` uses a fresh random seed instead of the default `seed = month` |
| `PUT /api/admin/sessions/:date/slot` | `{ roleId, slot, personId \| null }` | MonthPayload. 409 for a conflict, 400 when the session is cancelled |
| `POST /api/admin/sessions/:date/cancel` | `{ reason }` | MonthPayload |
| `POST /api/admin/sessions/:date/restore` | — | MonthPayload. Also fills the restored date using the scheduler |
| `POST /api/admin/reload-config` | — | `{ added, updated, deactivated }`, or 400 with validation errors |

**MonthPayload**
```json
{
  "month": "2026-12",
  "window": { "month": "2026-12", "opensOn": "2026-11-24", "closesOn": "2026-11-30", "state": "upcoming|open|closed" },
  "generatedAt": "2026-12-01T00:00:03.000Z",
  "sessions": [{
    "date": "2026-12-05", "status": "scheduled", "cancelReason": null,
    "assignments": [{ "roleId": "drummer", "slot": 0, "personId": "jon-lim", "locked": false }],
    "warnings": [{ "code": "NO_SENIOR", "message": "Worship Team has no senior member", "ministryId": "worship" }]
  }]
}
```
The frontend joins names, ranks and roles from `/api/roster`. Cancelled sessions have `assignments: []` and `warnings: []`.

**Automation:** on boot and every hour, for the current month and the next one: if the window for that month is closed (today > closesOn) and `generatedAt` is null, generate it.

## 7. Frontend (Helly)

Routes:
- `/`: the schedule. A month switcher and one panel per Saturday showing ministry → role → people, with rank markers. Cancelled sessions are clearly marked and show the reason. The next upcoming Saturday is highlighted.
- `/availability`: the window state banner (open / opens on X / closed), a searchable name picker, toggles for the target month's Saturdays, and save.
- `/admin`: enter the code (kept in `sessionStorage`). Then:
  - month generate / regenerate / reshuffle and clear locks
  - per-session slot editor. Each slot's picker lists people who hold that role, marked available or unavailable with their rank. Swaps go through the same endpoint, and locked slots are marked
  - cancel with a reason, and restore
  - live warnings
  - an availability matrix (people × Saturdays) that's editable
  - reload config

**Design direction:** industrial / corporate operations console. Think a 1970s–80s office systems manual crossed with a modern data-dense ops tool:
- an off-white or warm grey paper base with a deep green-black ink, and one restrained signal accent
- monospaced labels and IDs paired with a strong grotesk for headings
- hairline rules, visible grid structure, square corners, tabular numbers
- stamped status labels (`CANCELLED`, `LOCKED`, `RANK 3`)

Avoid anything that looks AI-generated: no purple or blue gradients, glassmorphism, emoji, sparkle icons, giant rounded cards or soft drop shadows. It must be mobile-first, because members will use their phones. Light theme first, with a dark theme that follows the system preference.
