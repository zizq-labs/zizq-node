// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Thin wrapper around Node's built-in synchronous SQLite driver. Sync
// I/O on the event loop is fine here — each request only fires a few
// small queries, and the audit table is bounded by rate of arrival.
// Can replace with `better-sqlite3` in the future if async would really
// pay off here.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path: string): DatabaseSync {
  // SQLite errors with "no such directory" if the parent doesn't
  // exist yet — the tests use a `storage/` dir that we ship as a
  // git-tracked placeholder, but be defensive if someone points at
  // a custom path.
  mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function defaultDbPath(env = process.env.NODE_ENV): string {
  return `storage/${env ?? "development"}.sqlite3`;
}
