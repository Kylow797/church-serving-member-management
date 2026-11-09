-- Church Serving schema v1. Applied by openDb(); PRAGMA user_version tracks the version.
-- Booleans are INTEGER 0/1. Dates are 'YYYY-MM-DD' text, months 'YYYY-MM'.

CREATE TABLE ministries (
  id            TEXT    PRIMARY KEY CHECK (length(id) > 0),
  name          TEXT    NOT NULL CHECK (length(name) > 0),
  min_senior    INTEGER CHECK (min_senior IS NULL OR min_senior >= 0),
  max_newcomers INTEGER CHECK (max_newcomers IS NULL OR max_newcomers >= 0),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order    INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE roles (
  id          TEXT    PRIMARY KEY CHECK (length(id) > 0),
  ministry_id TEXT    NOT NULL REFERENCES ministries(id) ON UPDATE CASCADE,
  name        TEXT    NOT NULL CHECK (length(name) > 0),
  min         INTEGER NOT NULL CHECK (min >= 0),
  max         INTEGER NOT NULL CHECK (max >= 1),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  CHECK (min <= max)
) STRICT;
CREATE INDEX idx_roles_ministry ON roles(ministry_id);

CREATE TABLE people (
  id            TEXT    PRIMARY KEY CHECK (length(id) > 0),
  name          TEXT    NOT NULL CHECK (length(name) > 0),
  rank          INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),
  max_per_month INTEGER CHECK (max_per_month IS NULL OR max_per_month >= 0),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order    INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE person_roles (
  person_id TEXT    NOT NULL REFERENCES people(id) ON DELETE CASCADE ON UPDATE CASCADE,
  role_id   TEXT    NOT NULL REFERENCES roles(id)  ON DELETE CASCADE ON UPDATE CASCADE,
  pos       INTEGER NOT NULL DEFAULT 0,   -- order as listed in config
  PRIMARY KEY (person_id, role_id)
) STRICT;
CREATE INDEX idx_person_roles_role ON person_roles(role_id);

CREATE TABLE sessions (
  id            INTEGER PRIMARY KEY,
  date          TEXT    NOT NULL UNIQUE
                CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(date) IS date),
  status        TEXT    NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  cancel_reason TEXT,
  CHECK (status = 'cancelled' OR cancel_reason IS NULL)
) STRICT;

CREATE TABLE assignments (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role_id    TEXT    NOT NULL REFERENCES roles(id) ON UPDATE CASCADE,
  slot       INTEGER NOT NULL CHECK (slot >= 0),
  person_id  TEXT    NOT NULL REFERENCES people(id) ON UPDATE CASCADE,
  locked     INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  UNIQUE (session_id, person_id),
  UNIQUE (session_id, role_id, slot)
) STRICT;
CREATE INDEX idx_assignments_person ON assignments(person_id);

-- No assignments in cancelled sessions; slot must be below the role's max.
CREATE TRIGGER trg_assignments_not_cancelled
BEFORE INSERT ON assignments
WHEN (SELECT status FROM sessions WHERE id = NEW.session_id) = 'cancelled'
BEGIN
  SELECT RAISE(ABORT, 'session is cancelled');
END;

CREATE TRIGGER trg_assignments_slot_ins
BEFORE INSERT ON assignments
WHEN NEW.slot >= (SELECT max FROM roles WHERE id = NEW.role_id)
BEGIN
  SELECT RAISE(ABORT, 'slot exceeds role max');
END;

CREATE TRIGGER trg_assignments_slot_upd
BEFORE UPDATE OF role_id, slot ON assignments
WHEN NEW.slot >= (SELECT max FROM roles WHERE id = NEW.role_id)
BEGIN
  SELECT RAISE(ABORT, 'slot exceeds role max');
END;

-- Cancelling a session must never leave assignments behind.
CREATE TRIGGER trg_sessions_cancel_clears
AFTER UPDATE OF status ON sessions
WHEN NEW.status = 'cancelled'
BEGIN
  DELETE FROM assignments WHERE session_id = NEW.id;
END;

CREATE TABLE availability (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE ON UPDATE CASCADE,
  date      TEXT NOT NULL
            CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(date) IS date),
  PRIMARY KEY (person_id, date)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_availability_date ON availability(date, person_id);

CREATE TABLE months (
  month        TEXT PRIMARY KEY CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  generated_at TEXT NOT NULL
) STRICT;
