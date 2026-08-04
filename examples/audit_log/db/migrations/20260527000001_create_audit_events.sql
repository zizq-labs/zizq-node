-- SQLite stores DATETIME as TEXT (ISO8601). Cursor pagination sorts
-- lexicographically over the same string — this works because ISO8601
-- is intentionally lex-sortable when stored in UTC with a fixed
-- offset (we always write `Z` from JavaScript's `.toISOString()`).

CREATE TABLE audit_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- When the event actually happened at the source. Producer-supplied.
  occurred_at  TEXT NOT NULL,
  -- The system that produced the event (e.g. "uptime_monitor",
  -- "billing_api"). String, not enum — the audit sink stays ignorant
  -- of which systems integrate with it.
  source       TEXT NOT NULL,
  -- The event type the producer agreed on with... nobody. The audit
  -- app doesn't switch on this — it just stores it.
  event_type   TEXT NOT NULL,
  actor        TEXT,
  ip           TEXT,
  resource     TEXT,
  text         TEXT,
  -- JSON-serialised structured payload. `TEXT` because node:sqlite
  -- doesn't yet expose a JSON1 column type; we serialise / parse at
  -- the model boundary.
  data         TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Most-recent-first feed. The (occurred_at, id) tuple gives a total
-- ordering for cursor pagination even when timestamps collide.
CREATE INDEX idx_audit_events_occurred_at
  ON audit_events (occurred_at DESC, id DESC);

-- Filter-by-source feed, for the eventual `?source=...` query.
CREATE INDEX idx_audit_events_source_occurred_at
  ON audit_events (source, occurred_at DESC, id DESC);
