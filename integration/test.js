// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Integration tests for the Zizq Node client.
 *
 * These tests exercise the published package artifact (not the source)
 * against a real Zizq server whose URL is provided via the ZIZQ_URL
 * environment variable. The server lifecycle is managed by run.sh.
 *
 * Tests run sequentially (concurrency: 1) and each test starts with a
 * clean database (deleteAllJobs in beforeEach).
 *
 * Run via: ZIZQ_URL=http://... node --test test.js
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// Import from the installed package, NOT from source.
import { Client, Worker, NotFoundError, enqueue, enqueueBulk } from "@zizq-labs/zizq";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const ZIZQ_URL = process.env.ZIZQ_URL;
if (!ZIZQ_URL) {
  console.error("Error: ZIZQ_URL environment variable must be set.");
  process.exit(1);
}

describe("integration", { concurrency: 1 }, () => {
  let client;

  before(async () => {
    client = new Client({ url: ZIZQ_URL });
    const health = await client.health();
    assert.equal(health.status, "ok", "server health check failed");
  });

  beforeEach(async () => {
    await client.deleteAllJobs();
  });

  after(async () => {
    await client?.close();
  });

  it("enqueue and get a job", async () => {
    const job = await enqueue(client, {
      type: "test_job",
      queue: "integration",
      payload: { hello: "world" },
    });

    assert.ok(job.id);
    assert.equal(job.type, "test_job");
    assert.equal(job.queue, "integration");

    const fetched = await client.getJob(job.id);
    assert.equal(fetched.id, job.id);
    assert.deepEqual(fetched.payload, { hello: "world" });
  });

  it("enqueue bulk", async () => {
    const jobs = await enqueueBulk(client, [
      { type: "bulk_a", queue: "integration", payload: { n: 1 } },
      { type: "bulk_b", queue: "integration", payload: { n: 2 } },
      { type: "bulk_c", queue: "integration", payload: { n: 3 } },
    ]);

    assert.equal(jobs.length, 3);
    assert.equal(jobs[0].type, "bulk_a");
    assert.equal(jobs[1].type, "bulk_b");
    assert.equal(jobs[2].type, "bulk_c");
  });

  it("worker processes jobs end-to-end", async () => {
    const count = 10;
    await enqueueBulk(client, Array.from({ length: count }, (_, i) => ({
      type: "worker_test",
      queue: "worker-integration",
      payload: { index: i },
    })));

    const received = [];
    const worker = new Worker({
      client,
      queues: ["worker-integration"],
      concurrency: 5,
      logger: noopLogger,
      handler: async (job) => {
        if (job.type === "worker_test") {
          received.push(job.payload.index);
          if (received.length === count) {
            worker.stop();
          }
        }
      },
    });

    const timeout = setTimeout(() => worker.kill(), 10_000);
    await worker.run();
    clearTimeout(timeout);

    assert.equal(received.length, count);
    assert.deepEqual(
      received.sort((a, b) => a - b),
      Array.from({ length: count }, (_, i) => i),
    );
  });

  it("query jobs", async () => {
    const job = await enqueue(client, {
      type: "query_test",
      queue: "query-integration",
      payload: { marker: "findme" },
    });

    const found = await client.jobs()
      .byQueue("query-integration")
      .byType("query_test")
      .first();

    assert.ok(found);
    assert.equal(found.id, job.id);
    assert.deepEqual(found.payload, { marker: "findme" });
  });

  it("delete a job", async () => {
    const job = await enqueue(client, {
      type: "delete_test",
      queue: "delete-integration",
      payload: {},
    });

    await client.deleteJob(job.id);

    await assert.rejects(
      () => client.getJob(job.id),
      (err) => err instanceof NotFoundError,
    );
  });

  it("count and isEmpty", async () => {
    assert.equal(await client.jobs().isEmpty(), true);
    assert.equal(await client.jobs().count(), 0);

    await enqueueBulk(client, [
      { type: "count_a", queue: "integration", payload: {} },
      { type: "count_b", queue: "integration", payload: {} },
      { type: "count_c", queue: "integration", payload: {} },
    ]);

    assert.equal(await client.jobs().isEmpty(), false);
    assert.equal(await client.jobs().count(), 3);
    assert.equal(await client.jobs().byType("count_b").count(), 1);
  });
});
