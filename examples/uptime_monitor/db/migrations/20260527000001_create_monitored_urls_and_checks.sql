CREATE TABLE monitored_urls (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  url                   TEXT NOT NULL,
  source                TEXT NOT NULL DEFAULT 'manual',
  source_sitemap_url    TEXT,
  enabled               INTEGER NOT NULL DEFAULT 1,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_checked_at       TEXT,
  last_status           TEXT,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Composite unique index distinguishing manual rows (NULL
-- source_sitemap_url) from sitemap-sourced rows. SQLite treats two
-- NULLs as distinct, so COALESCE to '' inside the index.
CREATE UNIQUE INDEX idx_monitored_urls_url_scoped
  ON monitored_urls (url, COALESCE(source_sitemap_url, ''));

CREATE TABLE checks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  monitored_url_id  INTEGER NOT NULL
    REFERENCES monitored_urls(id) ON DELETE CASCADE,
  checked_at        TEXT NOT NULL,
  status            TEXT NOT NULL,
  http_status       INTEGER,
  response_time_ms  INTEGER,
  final_url         TEXT,
  error_message     TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_checks_monitored_url_id ON checks (monitored_url_id);
