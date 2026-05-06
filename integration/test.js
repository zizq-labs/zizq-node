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
import { Client, Worker, NotFoundError, ClientError, enqueue, enqueueBulk } from "@zizq-labs/zizq";

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

  it("query with jq filter", async () => {
    await enqueueBulk(client, [
      { type: "jq_test", queue: "integration", payload: { priority: "high", region: "eu" } },
      { type: "jq_test", queue: "integration", payload: { priority: "low", region: "eu" } },
      { type: "jq_test", queue: "integration", payload: { priority: "high", region: "us" } },
    ]);

    const highPriority = await client.jobs()
      .addJqFilter('.priority == "high"')
      .toArray();
    assert.equal(highPriority.length, 2);

    const highEu = await client.jobs()
      .addJqFilter('.priority == "high"')
      .addJqFilter('.region == "eu"')
      .first();
    assert.ok(highEu);
    assert.deepEqual(highEu.payload, { priority: "high", region: "eu" });
  });

  it("query with withPayload (exact match)", async () => {
    await enqueueBulk(client, [
      { type: "wp_test", queue: "integration", payload: { action: "send", to: "alice" } },
      { type: "wp_test", queue: "integration", payload: { action: "send", to: "bob" } },
      { type: "wp_test", queue: "integration", payload: { action: "receive", to: "alice" } },
    ]);

    const match = await client.jobs()
      .withPayload({ action: "send", to: "alice" })
      .toArray();
    assert.equal(match.length, 1);
    assert.deepEqual(match[0].payload, { action: "send", to: "alice" });
  });

  it("query with withPayloadSubset (partial match)", async () => {
    await enqueueBulk(client, [
      { type: "wps_test", queue: "integration", payload: { kind: "email", to: "alice", urgent: true } },
      { type: "wps_test", queue: "integration", payload: { kind: "email", to: "bob", urgent: false } },
      { type: "wps_test", queue: "integration", payload: { kind: "sms", to: "alice", urgent: true } },
    ]);

    // Subset match — any email.
    const emails = await client.jobs()
      .withPayloadSubset({ kind: "email" })
      .toArray();
    assert.equal(emails.length, 2);

    // Subset match — urgent emails only.
    const urgentEmails = await client.jobs()
      .withPayloadSubset({ kind: "email", urgent: true })
      .toArray();
    assert.equal(urgentEmails.length, 1);
    assert.equal(urgentEmails[0].payload.to, "alice");
  });

  it("delete all jobs", async () => {
    await enqueueBulk(client, [
      { type: "del_a", queue: "q1", payload: {} },
      { type: "del_b", queue: "q1", payload: {} },
      { type: "del_c", queue: "q2", payload: {} },
    ]);

    // Filtered delete — only q1.
    const deleted = await client.deleteAllJobs({ where: { queue: "q1" } });
    assert.equal(deleted, 2);
    assert.equal(await client.countJobs(), 1);

    // Unfiltered delete — everything remaining.
    const deletedAll = await client.deleteAllJobs();
    assert.equal(deletedAll, 1);
    assert.equal(await client.countJobs(), 0);
  });

  it("update a job", async () => {
    const job = await enqueue(client, {
      type: "update_test",
      queue: "integration",
      payload: { x: 1 },
      priority: 100,
    });

    const updated = await client.updateJob(job.id, { priority: 50 });
    assert.equal(updated.id, job.id);
    assert.equal(updated.priority, 50);

    const fetched = await client.getJob(job.id);
    assert.equal(fetched.priority, 50);
  });

  it("update all jobs", async () => {
    await enqueueBulk(client, [
      { type: "upd_a", queue: "q1", payload: {}, priority: 100 },
      { type: "upd_b", queue: "q1", payload: {}, priority: 100 },
      { type: "upd_c", queue: "q2", payload: {}, priority: 100 },
    ]);

    // Filtered update — only q1.
    const patched = await client.updateAllJobs({
      where: { queue: "q1" },
      apply: { priority: 1 },
    });
    assert.equal(patched, 2);

    // Verify the update applied to q1 and not q2.
    const q1Job = await client.jobs().byQueue("q1").first();
    assert.equal(q1Job.priority, 1);

    const q2Job = await client.jobs().byQueue("q2").first();
    assert.equal(q2Job.priority, 100);
  });

  it("countJobs", async () => {
    assert.equal(await client.countJobs(), 0);

    await enqueueBulk(client, [
      { type: "count_a", queue: "q1", payload: {} },
      { type: "count_b", queue: "q1", payload: {} },
      { type: "count_c", queue: "q2", payload: {} },
    ]);

    assert.equal(await client.countJobs(), 3);
    assert.equal(await client.countJobs({ queue: "q1" }), 2);
    assert.equal(await client.countJobs({ queue: "q2" }), 1);
    assert.equal(await client.countJobs({ type: "count_a" }), 1);
    assert.equal(await client.countJobs({ queue: "q1", type: "count_b" }), 1);
    assert.equal(await client.countJobs({ queue: "nonexistent" }), 0);
  });

  // --- Cron scheduling (requires Pro license) ---

  it("cron: define schedule and re-fetch", async () => {
    try {
      const cron = client.cron("integration-test");

      // Define a schedule with three entries.
      const group = await cron.register({
        entries: [
          { name: "entry-a", expression: "* * * * *", type: "cron_a", queue: "cron-integration", payload: {} },
          { name: "entry-b", expression: "*/5 * * * *", type: "cron_b", queue: "cron-integration", payload: {} },
          { name: "entry-c", expression: "0 0 * * *", type: "cron_c", queue: "cron-integration", payload: {} },
        ],
      });

      assert.equal(group.entries.length, 3);

      // Re-fetch and verify.
      const fetched = await cron.get();
      assert.equal(fetched.entries.length, 3);

      const names = fetched.entries.map(e => e.name).sort();
      assert.deepEqual(names, ["entry-a", "entry-b", "entry-c"]);

      assert.equal(fetched.entries.find(e => e.name === "entry-a").expression, "* * * * *");
      assert.equal(fetched.entries.find(e => e.name === "entry-b").expression, "*/5 * * * *");
      assert.equal(fetched.entries.find(e => e.name === "entry-c").expression, "0 0 * * *");

      // Cleanup.
      await cron.delete();
    } catch (err) {
      if (err instanceof ClientError && err.status === 403) {
        return; // skip — no Pro license
      }
      throw err;
    }
  });

  it("cron: redefine removes absent entries", async () => {
    try {
      const cron = client.cron("integration-test");

      // Define with three entries.
      await cron.register({
        entries: [
          { name: "keep-a", expression: "* * * * *", type: "cron_test", queue: "cron-integration", payload: {} },
          { name: "keep-b", expression: "* * * * *", type: "cron_test", queue: "cron-integration", payload: {} },
          { name: "remove-c", expression: "* * * * *", type: "cron_test", queue: "cron-integration", payload: {} },
        ],
      });

      // Redefine with only two entries.
      await cron.register({
        entries: [
          { name: "keep-a", expression: "* * * * *", type: "cron_test", queue: "cron-integration", payload: {} },
          { name: "keep-b", expression: "* * * * *", type: "cron_test", queue: "cron-integration", payload: {} },
        ],
      });

      // Re-fetch and verify remove-c is gone.
      const fetched = await cron.get();
      assert.equal(fetched.entries.length, 2);

      const names = fetched.entries.map(e => e.name).sort();
      assert.deepEqual(names, ["keep-a", "keep-b"]);

      // Cleanup.
      await cron.delete();
    } catch (err) {
      if (err instanceof ClientError && err.status === 403) {
        return;
      }
      throw err;
    }
  });

  it("cron: pause and resume an entry", async () => {
    try {
      const cron = client.cron("integration-test");

      await cron.register({
        entries: [
          { name: "pausable", expression: "* * * * *", type: "cron_test", queue: "cron-integration", payload: {} },
        ],
      });

      // Verify not paused initially.
      let entry = await cron.entry("pausable").get();
      assert.equal(entry.paused, false);

      // Pause.
      await cron.entry("pausable").pause();
      entry = await cron.entry("pausable").get();
      assert.equal(entry.paused, true);
      assert.ok(entry.pausedAt);

      // Resume.
      await cron.entry("pausable").resume();
      entry = await cron.entry("pausable").get();
      assert.equal(entry.paused, false);
      assert.ok(entry.resumedAt);

      // Cleanup.
      await cron.delete();
    } catch (err) {
      if (err instanceof ClientError && err.status === 403) {
        return;
      }
      throw err;
    }
  });
});
