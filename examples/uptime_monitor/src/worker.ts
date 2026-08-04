// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Standalone worker entrypoint. Same handler as the embedded worker
// in server.ts; useful when you want to scale workers independently
// of the web tier.

import { Client, Worker } from "@zizq-labs/zizq";
import { openDb, defaultDbPath } from "./db.ts";
import { migrate } from "./migrate.ts";
import { buildHandler } from "./jobs/index.ts";
import { ZIZQ_QUEUE } from "./jobs/queue.ts";

const zizqUrl = process.env.ZIZQ_URL ?? "http://127.0.0.1:7890";
const concurrency = Number(process.env.ZIZQ_WORKER_CONCURRENCY ?? "4");
const dbPath = process.env.DATABASE_PATH ?? defaultDbPath();

const db = openDb(dbPath);
migrate(db);

const client = new Client({ url: zizqUrl });
const worker = new Worker({
  client,
  handler: buildHandler({ db, client }),
  concurrency,
  queues: [ZIZQ_QUEUE],
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`[uptime_monitor:worker] ${signal} — draining...`);
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
