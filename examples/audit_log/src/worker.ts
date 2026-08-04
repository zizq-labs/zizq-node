// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Worker entrypoint. Standalone process that pulls `audit.create`
// jobs off the configured Zizq queue and writes them to the local
// SQLite database via the shared router.
//
// Web and worker are separate processes deliberately — same shape as
// a production deploy, and it keeps the web tier read-only.

import { Client, Worker } from "@zizq-labs/zizq";
import { openDb, defaultDbPath } from "./db.ts";
import { migrate } from "./migrate.ts";
import { createAuditRouter, ZIZQ_QUEUE } from "./audit-router.ts";

const zizqUrl = process.env.ZIZQ_URL ?? "http://127.0.0.1:7890";
const concurrency = Number(process.env.ZIZQ_WORKER_CONCURRENCY ?? "25");
const dbPath = process.env.DATABASE_PATH ?? defaultDbPath();

const db = openDb(dbPath);
migrate(db);

const client = new Client({ url: zizqUrl });
const worker = new Worker({
  client,
  handler: createAuditRouter(db).build(),
  concurrency,
  queues: [ZIZQ_QUEUE],
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`[audit_log] ${signal} — draining worker...`);
  worker.stop();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

try {
  await worker.run();
} finally {
  await client.close();
  db.close();
}
