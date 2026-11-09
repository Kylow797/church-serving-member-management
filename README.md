# Church Serving

A roster web app for a church's Saturday services. Members say which Saturdays they can serve, and the server builds each month's team schedule automatically. It respects who holds which role, how senior people are, and how often each person has already served.

- Every Saturday is one session. Each session is staffed from several **ministries** (Worship Team, Ushering, Tech), and each ministry has **roles** (lead singer, drummer, usher, sound, ...).
- Members do not log in. They pick their name and tick the Saturdays they are free.
- An **admin** (shared code) can swap people between slots, clear slots, cancel or restore a session, regenerate a month, edit anyone's availability, and reload the config.
- `serving.config.yaml` is the source of truth for people, ministries, roles and settings.

Stack: Node 26 (ESM), Express 5, built-in `node:sqlite`, React 19 + Vite. API on port 3001, Vite dev server on 5173.

## Setup

```bash
npm run install:all     # root + server + web dependencies
npm run dev             # API on :3001 and web on :5173 (open http://localhost:5173)
```

Production:

```bash
npm run build           # builds web/dist
npm start               # Express serves the API and web/dist on :3001
```

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | API / production web port |
| `DB_PATH` | `data/serving.db` | SQLite file (relative paths resolve from the project root) |
| `CONFIG_PATH` | `serving.config.yaml` | Config file location |

The database lives in `data/` and is ignored by git. The database runs in WAL mode, so recent writes can sit in `serving.db-wal`. To back it up, either stop the server first (shutdown checkpoints and removes the `-wal` file) and then copy `data/serving.db`, or, with the server running, use `sqlite3 data/serving.db ".backup backup.db"`. Don't copy `serving.db` on its own while the server is running.

## Editing `serving.config.yaml`

Edit the file, then either restart the server or press **Reload config** on the `/admin` page. An invalid file is rejected with a list of errors (fatal at boot, a 400 on reload) and nothing is changed.

**Add a person**

```yaml
people:
  - { id: jane-doe, name: Jane Doe, rank: 2, roles: [vocalist, usher], maxPerMonth: 2 }
```

- `rank`: 1 = newcomer, 2 = regular, 3 = senior.
- `roles`: every role id the person can serve in. Each must exist under some ministry.
- `maxPerMonth` (optional): the most times they will be scheduled in one month. Default is unlimited.

**Add a ministry or role**

```yaml
ministries:
  - id: kids
    name: Kids Ministry
    seniority:            # optional
      minSenior: 1        # at least 1 rank-3 person serving in this ministry each Saturday
      maxNewcomers: 2     # at most 2 rank-1 people in this ministry each Saturday
    roles:
      - { id: teacher, name: Teacher, min: 1, max: 2 }
```

- `min` is how many people the role needs, and `max` is how many it can take. The scheduler always tries to reach `min` and then fills up to `max` when people are available.
- Role ids must be unique across the whole file. A person's `roles` list refers to them.
- `seniority` applies per ministry per Saturday. Without it, rank does not matter for that ministry.

**Why ids must be stable.** History, availability and locked assignments are keyed by `id`. Rename `name` freely, but never change an `id`: the old one is treated as removed and the new one as a brand new person or role, so past records no longer match. Entries removed from the file are deactivated, not deleted, so past schedules still show them. Putting the id back reactivates it. Display order follows the order in the file.

**Settings**

```yaml
settings:
  churchName: Grace Community Church
  timezone: Asia/Kuala_Lumpur       # "today" and the windows are computed in this zone
  adminCode: "1234"                 # change this before real use
  availability:
    openDaysBeforeMonthEnd: 7
    alwaysOpen: false               # testing only: keeps the window open all the time
```

## Admin

Open `/admin` and enter the admin code (`settings.adminCode`, `1234` in the sample config). API calls send it as the `X-Admin-Code` header. Admin can:

- generate, regenerate, or reshuffle a month, and clear locks
- edit any slot. Each slot's picker shows who holds that role and whether they are available. Picking someone who already serves in that session swaps the two. Edited slots are **locked**, so regenerating keeps them.
- cancel a session with a reason, and restore it (a restored session is refilled automatically)
- see live warnings and edit the availability matrix at any time
- reload the config file

## Availability windows and auto-generation

- Members submit availability for month **M** during the **last 7 days of month M-1** (`openDaysBeforeMonthEnd`, inclusive). For December that is 24-30 November. Outside the window the form is read-only, and the server answers 403 unless an admin code is sent.
- Only Saturdays of the target month can be ticked.
- On boot and then every hour, the server looks at the current month and the next one. If the window is **closed** (today is after its last day), nothing has been generated yet, **and at least one person has submitted availability**, it generates that month automatically. (So on a fresh install the current month stays empty until an admin generates it.) Admin can generate or regenerate whenever they like.

How the scheduler picks people (`server/scheduler.js`, a pure function):

1. **Hard rules, never broken:** the person is active, available that Saturday and holds the role. They serve in at most one role per session, a role never exceeds `max`, and `maxPerMonth` is respected.
2. Every role reaches its `min`.
3. Ministry seniority is met (at least `minSenior` rank-3, at most `maxNewcomers` rank-1), counting locked people.
4. **Fairness:** fewer assignments this month first, then avoiding back-to-back Saturdays, then fewer assignments in the previous three months, then a seeded random tiebreak. Scarce roles are filled first, so someone who can drum and usher ends up drumming.
5. Optional slots are filled up to `max`.

If a goal cannot be met, the schedule is still produced with **warnings** (`UNDERSTAFFED`, `NO_SENIOR`, `TOO_MANY_NEWCOMERS`). Manual edits are checked too, and can also raise `UNAVAILABLE`, `ROLE_MISMATCH` and `INACTIVE_PERSON`. Generation is deterministic: the default seed is the month, so regenerating with the same inputs gives the same roster. "Reshuffle" uses a fresh random seed.

## Tests

```bash
npm test                # unit tests: scheduler, database, dates (node:test, no extra dependencies)
npm run smoke           # end-to-end check against a running server
```

The unit tests use in-memory SQLite and need no server. The scheduler suite includes a seeded property test that runs 200 random rosters and asserts every hard rule.

The smoke test talks to a **running** server (`BASE_URL`, default `http://localhost:3001`; `ADMIN_CODE` if you changed the code). It submits availability for most people for the target month using the admin override, generates, checks hard rules and seniority, swaps and clears slots, cancels and restores a session, and checks that admin endpoints return 401 without the code. It writes real data, so run it against a throwaway database:

```bash
DB_PATH=/tmp/smoke.db npm start &
npm run smoke
```

It prints one PASS/FAIL line per check and exits non-zero if anything failed.
