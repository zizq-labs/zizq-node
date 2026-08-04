// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Shared test bootstrap. Each test file imports `freshDb()` and gets
// a migrated in-memory (":memory:") SQLite database. In-memory dbs
// are per-connection, so no cross-test pollution and no file cleanup.

import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/migrate.ts";

export function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}
