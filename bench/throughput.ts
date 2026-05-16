// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * This file implements a crude but effective benchmark in which N jobs are
 * enqueued and then immediately dequeued. When the last job is dequeued the
 * script logs the time spent and stops the worker.
 */

import { Client, Worker, enqueueBulk } from "../src/index.ts";
import fs from "node:fs";

// --- Setup ---

const URL = process.env.ZIZQ_URL || "http://127.0.0.1:7890"

const FORMAT = process.env.ZIZQ_FORMAT || "json";

const CA =
  process.env.ZIZQ_CA &&
    fs.readFileSync(process.env.ZIZQ_CA);
const CLIENT_CERT =
  process.env.ZIZQ_CLIENT_CERT &&
    fs.readFileSync(process.env.ZIZQ_CLIENT_CERT);
const CLIENT_KEY =
  process.env.ZIZQ_CLIENT_KEY &&
    fs.readFileSync(process.env.ZIZQ_CLIENT_KEY);

const TLS = (CA || CLIENT_CERT) && {
  ca: CA,
  cert: CLIENT_CERT,
  key: CLIENT_KEY,
};

const JOB_COUNT = parseInt(process.env.JOB_COUNT || "5000");
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "25");
const PREFETCH = parseInt(process.env.PREFETCH || CONCURRENCY * 2);

const client = new Client({url: URL, format: FORMAT, tls: TLS});

// --- Enqueue Phase ---

const deleted = await client.deleteAllJobs({ where: { queue: "node/bench" } });

if (deleted > 0) {
  console.error(`Deleted ${deleted} leftover jobs from a previous run!`);
}

const enqueueStart = performance.now();

for (let n = 1; n <= JOB_COUNT; n += 1000) {
  const jobs = Array.from(
    { length: Math.min(JOB_COUNT - n + 1, 1000) },
    (_, i) => ({
      type: "bench",
      queue: "node/bench",
      payload: {n: n+i},
    }),
  );
  await enqueueBulk(client, jobs);
}

const enqueueFinish = performance.now();
const enqueueElapsed = (enqueueFinish - enqueueStart) / 1000;
const enqueueRate = Math.round(JOB_COUNT / enqueueElapsed);

console.log(
  `Enqueued ${JOB_COUNT} jobs ` +
    `in ${enqueueElapsed.toFixed(2)}s ` +
    `(${enqueueRate} jobs/sec)`,
);

// --- Scan Phase ----

const scanStart = performance.now();

let scanned = 0;
for await (const job of client.jobs().byQueue("node/bench").inPagesOf(2000)) {
  if (job.id) scanned++;
}

const scanFinish = performance.now();
const scanElapsed = (scanFinish - scanStart) / 1000;
const scanRate = Math.round(scanned / scanElapsed);

console.log(
  `Scanned ${scanned} jobs ` +
    `in ${scanElapsed.toFixed(2)}s ` +
    `(${scanRate} jobs/sec)`,
);

// --- Dequeue Phase ----

const dequeueStart = performance.now();

const worker = new Worker({
  client,
  queues: ["node/bench"],
  concurrency: CONCURRENCY,
  prefetch: PREFETCH,
  handler: async (job) => {
    if (job.queue == "node/bench" && job.type == "bench") {
      if (job.payload.n == JOB_COUNT) {
        worker.stop();
      }
    }
  },
});

await worker.run();

const dequeueFinish = performance.now();
const dequeueElapsed = (dequeueFinish - dequeueStart) / 1000;
const dequeueRate = Math.round(JOB_COUNT / dequeueElapsed);

console.log(
  `Dequeued ${JOB_COUNT} jobs ` +
    `in ${dequeueElapsed.toFixed(2)}s ` +
    `(${dequeueRate} jobs/sec)`,
);

await client.close();
