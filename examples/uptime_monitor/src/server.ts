// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Web + embedded worker + cron registration in one process. Spawns
// a `Worker.run()` alongside `app.listen()`.
//
// Skip when NODE_ENV=test (tests dispatch via TestClient) or
// ZIZQ_DISABLE_WORKER=1 (for one-off scripts / REPLs).

import { Client, Worker, ResponseError } from "@zizq-labs/zizq";
import { createApp } from "./app.ts";
import { openDb, defaultDbPath } from "./db.ts";
import { migrate } from "./migrate.ts";
import { buildHandler } from "./jobs/index.ts";
import {
  CRON_GROUP,
  SCHEDULE_CHECKS,
  ZIZQ_QUEUE,
} from "./jobs/queue.ts";

const bind = process.env.BIND ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "3000");
const zizqUrl = process.env.ZIZQ_URL ?? "http://127.0.0.1:7890";
const concurrency = Number(process.env.ZIZQ_WORKER_CONCURRENCY ?? "4");
const dbPath = process.env.DATABASE_PATH ?? defaultDbPath();

const db = openDb(dbPath);
migrate(db);

const client = new Client({ url: zizqUrl });

const shouldRunWorker =
  process.env.NODE_ENV !== "test" &&
  process.env.ZIZQ_DISABLE_WORKER !== "1";

let worker: Worker | null = null;
let workerPromise: Promise<void> = Promise.resolve();

if (shouldRunWorker) {
  await registerCron();
  worker = new Worker({
    client,
    handler: buildHandler({ db, client }),
    concurrency,
    queues: [ZIZQ_QUEUE],
  });
  workerPromise = worker.run();
}

const app = createApp({ db, client });
const server = app.listen(port, bind, () => {
  console.log(`[uptime_monitor] web listening on http://${bind}:${port}`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[uptime_monitor] ${signal} — draining...`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  worker?.stop();
  await workerPromise;
  await client.close();
  db.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// --- Cron registration -----------------------------------------------

async function registerCron(): Promise<void> {
  try {
    await client.replaceCronGroup(CRON_GROUP, {
      entries: [
        {
          name: "schedule_checks",
          expression: "*/5 * * * * *",
          job: {
            type: SCHEDULE_CHECKS,
            queue: ZIZQ_QUEUE,
            payload: {},
          },
        },
      ],
    });
  } catch (err) {
    if (err instanceof ResponseError && err.status === 403) {
      console.warn(
        "[uptime_monitor] Periodic re-checks disabled: cron requires a Pro license (HTTP 403).",
      );
      return;
    }
    console.warn(
      `[uptime_monitor] Could not register cron: ${err instanceof Error ? err.message : err}`,
    );
  }
}
