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
 * clean database (`reset` in `beforeEach` — wipes jobs and cron groups).
 *
 * Run via: ZIZQ_URL=http://... node --test test.js
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// Import from the installed package, NOT from source.
import {
  Client,
  Worker,
  NotFoundError,
  ClientError,
  batchConfig,
} from "@zizq-labs/zizq";

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
    await client.reset();
  });

  after(async () => {
    await client?.close();
  });

  it("enqueue and get a job", async () => {
    const job = await client.enqueue({
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
    const jobs = await client.enqueueBulk([
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
    await client.enqueueBulk(Array.from({ length: count }, (_, i) => ({
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
    const job = await client.enqueue({
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
    const job = await client.enqueue({
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

    await client.enqueueBulk([
      { type: "count_a", queue: "integration", payload: {} },
      { type: "count_b", queue: "integration", payload: {} },
      { type: "count_c", queue: "integration", payload: {} },
    ]);

    assert.equal(await client.jobs().isEmpty(), false);
    assert.equal(await client.jobs().count(), 3);
    assert.equal(await client.jobs().byType("count_b").count(), 1);
  });

  it("query with jq filter", async () => {
    await client.enqueueBulk([
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
    await client.enqueueBulk([
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
    await client.enqueueBulk([
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
    await client.enqueueBulk([
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
    const job = await client.enqueue({
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
    await client.enqueueBulk([
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

    await client.enqueueBulk([
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

  // The schedule's timezone is the schedule's, not a copy smeared over every
  // entry, so a re-fetch still reports it and entries that chose their own
  // keep it.
  it("cron: group timezone round-trips", async () => {
    try {
      const cron = client.cron("integration-test");

      await cron.register({
        timezone: "Australia/Melbourne",
        entries: [
          { name: "inherits", expression: "0 9 * * *", type: "cron_test", queue: "cron-integration", payload: {} },
          { name: "scoped", expression: "0 9 * * *", timezone: "UTC", type: "cron_test", queue: "cron-integration", payload: {} },
        ],
      });

      const fetched = await cron.get();
      const inherits = fetched.entries.find(e => e.name === "inherits");
      const scoped = fetched.entries.find(e => e.name === "scoped");

      assert.equal(fetched.timezone, "Australia/Melbourne");
      assert.equal(inherits.timezone, undefined);
      assert.equal(scoped.timezone, "UTC");

      // And the schedule's timezone is what the inheriting entry actually
      // runs in: 9am in Melbourne is not 9am in UTC.
      assert.notEqual(inherits.nextEnqueueAt, scoped.nextEnqueueAt);

      await cron.delete();
    } catch (err) {
      if (err instanceof ClientError && err.status === 403) {
        return; // skip — no Pro license
      }
      throw err;
    }
  });

  // Registering replaces the schedule whole, so a timezone left out goes.
  it("cron: re-registering without a timezone clears it", async () => {
    try {
      const cron = client.cron("integration-test");
      const entries = [
        { name: "a", expression: "0 9 * * *", type: "cron_test", queue: "cron-integration", payload: {} },
      ];

      await cron.register({ timezone: "Australia/Melbourne", entries });
      assert.equal((await cron.get()).timezone, "Australia/Melbourne");

      await cron.register({ entries });
      assert.equal((await cron.get()).timezone, undefined);

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

  it("cron: deleteAllCrons wipes every group", async () => {
    try {
      for (const name of ["wipe-a", "wipe-b"]) {
        const cron = client.cron(name);
        await cron.register({
          entries: [
            { name: "e", expression: "* * * * *", type: "cron_test", queue: "cron-integration", payload: {} },
          ],
        });
      }

      const deleted = await client.deleteAllCrons();
      assert.equal(deleted, 2);

      const remaining = await client.listCronGroups();
      assert.deepEqual(remaining, []);
    } catch (err) {
      if (err instanceof ClientError && err.status === 403) {
        return;
      }
      throw err;
    }
  });

  // --- Batched jobs (Pro) ---

  it("batched: second enqueue folds into first and merges payload", async () => {
    try {
      const r1 = await client.enqueue({
        type: "audit.events",
        queue: "batched-integration",
        payload: [{ id: 1 }],
        batch: batchConfig(100),
      });
      const r2 = await client.enqueue({
        type: "audit.events",
        queue: "batched-integration",
        payload: [{ id: 2 }, { id: 3 }],
        batch: batchConfig(100),
      });

      assert.equal(r1.folded, false);
      assert.equal(r2.folded, true);
      assert.equal(r2.id, r1.id, "fold reuses the batch's job id");

      const fetched = await client.getJob(r1.id);
      assert.deepEqual(fetched.payload, [{ id: 1 }, { id: 2 }, { id: 3 }]);
      assert.ok(fetched.batch, "batch config is visible on job reads");
    } catch (err) {
      if (err instanceof ClientError && err.status === 403) return;
      throw err;
    }
  });

  it("batched: different non-batch args don't fold", async () => {
    try {
      const r1 = await client.enqueue({
        type: "push",
        queue: "batched-integration",
        payload: { deviceIds: ["a"], platform: "apple" },
        batch: batchConfig(100, ".deviceIds"),
      });
      const r2 = await client.enqueue({
        type: "push",
        queue: "batched-integration",
        payload: { deviceIds: ["b"], platform: "android" },
        batch: batchConfig(100, ".deviceIds"),
      });

      assert.equal(r1.folded, false);
      assert.equal(r2.folded, false);
      assert.notEqual(r1.id, r2.id);
    } catch (err) {
      if (err instanceof ClientError && err.status === 403) return;
      throw err;
    }
  });

  it("batched: bulk intra-fold within one call", async () => {
    try {
      const results = await client.enqueueBulk([
        {
          type: "audit.events",
          queue: "batched-integration",
          payload: [{ id: 1 }],
          batch: batchConfig(100),
        },
        {
          type: "audit.events",
          queue: "batched-integration",
          payload: [{ id: 2 }],
          batch: batchConfig(100),
        },
        {
          type: "audit.events",
          queue: "batched-integration",
          payload: [{ id: 3 }],
          batch: batchConfig(100),
        },
      ]);

      assert.equal(results[0].folded, false);
      assert.equal(results[1].folded, true);
      assert.equal(results[2].folded, true);
      assert.equal(results[1].id, results[0].id);
      assert.equal(results[2].id, results[0].id);

      const fetched = await client.getJob(results[0].id);
      assert.deepEqual(fetched.payload, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    } catch (err) {
      if (err instanceof ClientError && err.status === 403) return;
      throw err;
    }
  });

  it("batched: dedup flag collapses overlapping items", async () => {
    try {
      await client.enqueue({
        type: "audit.events",
        queue: "batched-integration",
        payload: [{ id: 1 }, { id: 2 }],
        batch: batchConfig(100, ".", { dedup: true }),
      });
      const r = await client.enqueue({
        type: "audit.events",
        queue: "batched-integration",
        payload: [{ id: 2 }, { id: 3 }],
        batch: batchConfig(100, ".", { dedup: true }),
      });
      assert.equal(r.folded, true);

      const fetched = await client.getJob(r.id);
      // `unique` in jq sorts as a side effect; assert on the sorted set.
      const ids = fetched.payload.map((h) => h.id).sort((a, b) => a - b);
      assert.deepEqual(ids, [1, 2, 3]);
    } catch (err) {
      if (err instanceof ClientError && err.status === 403) return;
      throw err;
    }
  });

  it("batched: worker receives the merged payload", async () => {
    try {
      await client.enqueue({
        type: "batched_worker",
        queue: "batched-worker-integration",
        payload: [{ id: 1 }],
        batch: batchConfig(100),
      });
      await client.enqueue({
        type: "batched_worker",
        queue: "batched-worker-integration",
        payload: [{ id: 2 }],
        batch: batchConfig(100),
      });
      await client.enqueue({
        type: "batched_worker",
        queue: "batched-worker-integration",
        payload: [{ id: 3 }],
        batch: batchConfig(100),
      });

      let received = null;
      const worker = new Worker({
        client,
        queues: ["batched-worker-integration"],
        concurrency: 1,
        logger: noopLogger,
        handler: async (job) => {
          received = job.payload;
          worker.stop();
        },
      });

      const timeout = setTimeout(() => worker.kill(), 10_000);
      await worker.run();
      clearTimeout(timeout);

      assert.deepEqual(received, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    } catch (err) {
      if (err instanceof ClientError && err.status === 403) return;
      throw err;
    }
  });

  it("batched: batch.key can be a function derived from the payload", async () => {
    try {
      const r1 = await client.enqueue({
        type: "push",
        queue: "batched-integration",
        payload: { deviceIds: ["a"], tenantId: 42 },
        batch: {
          ...batchConfig(100, ".deviceIds"),
          key: (input) => `push:tenant-${input.payload.tenantId}`,
        },
      });
      const r2 = await client.enqueue({
        type: "push",
        queue: "batched-integration",
        payload: { deviceIds: ["b"], tenantId: 42 },
        batch: {
          ...batchConfig(100, ".deviceIds"),
          key: (input) => `push:tenant-${input.payload.tenantId}`,
        },
      });

      assert.equal(r1.folded, false);
      assert.equal(r2.folded, true);
      assert.equal(r1.batch.key, "push:tenant-42");
    } catch (err) {
      if (err instanceof ClientError && err.status === 403) return;
      throw err;
    }
  });

  it("batched: uniqueKey + batch is rejected with 400", async () => {
    try {
      await client.enqueue({
        type: "push",
        queue: "batched-integration",
        payload: [{ id: 1 }],
        uniqueKey: "some-key",
        batch: batchConfig(100),
      });
      assert.fail("expected client to reject unique + batch combination");
    } catch (err) {
      if (err instanceof ClientError && err.status === 403) return;
      assert.ok(err instanceof ClientError, `expected ClientError, got: ${err}`);
      assert.equal(err.status, 400);
    }
  });

  it("batched: invalid jq expression is rejected with 422", async () => {
    try {
      await client.enqueue({
        type: "push",
        queue: "batched-integration",
        payload: [{ id: 1 }],
        batch: {
          key: "bad-expr",
          when: ".[*]", // syntactically invalid
          fold: "$existing + $new",
        },
      });
      assert.fail("expected client to reject the invalid expression");
    } catch (err) {
      if (err instanceof ClientError && err.status === 403) return;
      assert.ok(err instanceof ClientError, `expected ClientError, got: ${err}`);
      assert.equal(err.status, 422);
    }
  });
});
