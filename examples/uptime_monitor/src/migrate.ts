// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Tiny migration runner. Reads `db/migrations/*.sql` in filename
// order, tracks applied ones in `schema_migrations`, runs each pending
// file inside a transaction. No `down`, no rollback — demo
// scaffolding, not a production migrations framework.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, defaultDbPath } from "./db.ts";

const MIGRATIONS_DIR = new URL("../db/migrations/", import.meta.url);

export function migrate(db: DatabaseSync): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const applied = new Set(
    db
      .prepare("SELECT filename FROM schema_migrations")
      .all()
      .map((r) => (r as { filename: string }).filename),
  );

  const files = readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const pending = files.filter((f) => !applied.has(f));

  for (const file of pending) {
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (filename) VALUES (?)").run(file);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return pending.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.env.DATABASE_PATH ?? defaultDbPath();
  const db = openDb(path);
  try {
    const applied = migrate(db);
    console.log(`Migrations applied. ${applied} new.`);
  } finally {
    db.close();
  }
}
