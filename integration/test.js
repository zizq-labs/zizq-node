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
  ConflictError,
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

  // --- Budgets (requires Pro license) ---
  //
  // `reset()` in `beforeEach` wipes budgets as well as jobs and cron
  // groups (the server deletes cron groups, then jobs, then budgets, so
  // nothing references a budget by the time it is removed), which is
  // what keeps these isolated from each other.

  describe("budgets", () => {
    it("defines, reads, amends and deletes a policy", async () => {
      try {
        const created = await client.defineBudget({
          key: "emails",
          allocation: 100,
          strategy: { type: "time_based", durationMs: 60_000 },
        });
        assert.equal(created.key, "emails");

        // The round trip that matters: milliseconds out, the same
        // milliseconds back. A mocked response cannot catch a mismatch
        // in the `duration_ms` mapping.
        const read = await client.getBudget("emails");
        assert.equal(read.allocation, 100);
        assert.deepEqual(read.strategy, { type: "time_based", durationMs: 60_000 });
        assert.ok(typeof read.createdAt === "number");

        const keys = (await client.listBudgets()).map((b) => b.key);
        assert.ok(keys.includes("emails"));

        // Merge patch recurses into the strategy: the burst changes
        // without restating the kind or the period.
        const patched = await client.updateBudget("emails", { strategy: { burst: 5 } });
        assert.equal(patched.strategy.burst, 5);
        assert.equal(patched.strategy.durationMs, 60_000);

        // `null` is the one meaningful clear.
        const cleared = await client.updateBudget("emails", { strategy: { burst: null } });
        assert.ok(!("burst" in cleared.strategy));

        await client.deleteBudget("emails");
        await assert.rejects(() => client.getBudget("emails"), NotFoundError);
      } catch (err) {
        if (err instanceof ClientError && err.status === 403) return;
        throw err;
      }
    });

    it("round trips a clockless budget", async () => {
      try {
        await client.defineBudget({
          key: "stripe",
          allocation: 3,
          strategy: { type: "while_in_flight" },
        });

        const read = await client.getBudget("stripe");
        assert.deepEqual(read.strategy, { type: "while_in_flight" });
      } catch (err) {
        if (err instanceof ClientError && err.status === 403) return;
        throw err;
      }
    });

    // `POST` refuses rather than overwriting, which is what lets every
    // instance declare its budgets on boot without coordinating.
    it("conflicts on a second definition, unless replacing", async () => {
      try {
        const policy = {
          key: "emails",
          allocation: 1,
          strategy: { type: "while_in_flight" },
        };
        await client.defineBudget(policy);

        await assert.rejects(() => client.defineBudget(policy), ConflictError);
        assert.equal((await client.getBudget("emails")).allocation, 1);

        await client.defineBudget({ ...policy, allocation: 5, replace: true });
        assert.equal((await client.getBudget("emails")).allocation, 5);
      } catch (err) {
        if (err instanceof ClientError && err.status === 403) return;
        throw err;
      }
    });

    it("binds at enqueue and reads back off the job", async () => {
      try {
        await client.defineBudget({
          key: "emails",
          allocation: 100,
          strategy: { type: "while_in_flight" },
        });

        const job = await client.enqueue({
          type: "bound_job",
          queue: "budget-integration",
          payload: {},
          budgets: [{ key: "emails", cost: 3 }],
        });
        assert.deepEqual(job.budgets, [{ key: "emails", cost: 3 }]);

        // And on a fresh read, not only on the enqueue response.
        const refetched = await client.getJob(job.id);
        assert.deepEqual(refetched.budgets, [{ key: "emails", cost: 3 }]);
      } catch (err) {
        if (err instanceof ClientError && err.status === 403) return;
        throw err;
      }
    });

    // Binding and creating in one request, which is what lets an
    // application bring its own throttles up without a provisioning
    // step.
    it("creates the budget as a side effect of createWith", async () => {
      try {
        const job = await client.enqueue({
          type: "bound_job",
          queue: "budget-integration",
          payload: {},
          budgets: [
            {
              key: "made-on-demand",
              cost: 2,
              createWith: {
                allocation: 50,
                strategy: { type: "time_based", durationMs: 30_000 },
              },
            },
          ],
        });
        assert.equal(job.budgets[0].cost, 2);

        const budget = await client.getBudget("made-on-demand");
        assert.equal(budget.allocation, 50);
        assert.equal(budget.strategy.durationMs, 30_000);
      } catch (err) {
        if (err instanceof ClientError && err.status === 403) return;
        throw err;
      }
    });

    it("changes what one job draws on", async () => {
      try {
        for (const key of ["a", "b"]) {
          await client.defineBudget({
            key,
            allocation: 100,
            strategy: { type: "while_in_flight" },
          });
        }

        let job = await client.enqueue({
          type: "rebind_job",
          queue: "budget-integration",
          payload: {},
        });
        assert.deepEqual(job.budgets, []);

        job = await job.bindBudget({ key: "a", cost: 2 });
        assert.deepEqual(job.budgets, [{ key: "a", cost: 2 }]);

        await assert.rejects(() => job.bindBudget({ key: "a" }), ConflictError);

        job = await job.setBudgetCost("a", 4);
        assert.equal(job.budgets[0].cost, 4);

        // A replace is whole, so the cost returns to the default.
        job = await job.rebindBudget({ key: "a" });
        assert.equal(job.budgets[0].cost, 1);

        job = await job.replaceBudgets([{ key: "a" }, { key: "b", cost: 5 }]);
        assert.deepEqual(job.budgets.map((b) => b.key).sort(), ["a", "b"]);

        job = await job.unbindBudget("b");
        assert.deepEqual(job.budgets.map((b) => b.key), ["a"]);

        job = await job.unbindAllBudgets();
        assert.deepEqual(job.budgets, []);
      } catch (err) {
        if (err instanceof ClientError && err.status === 403) return;
        throw err;
      }
    });

    // The pairing `budgetsKey` exists for: a budget cannot be deleted
    // while anything draws on it, and the filter selects what is in the
    // way.
    it("drains a budget by what draws on it, then deletes it", async () => {
      try {
        await client.defineBudget({
          key: "emails",
          allocation: 100,
          strategy: { type: "while_in_flight" },
        });

        for (let i = 0; i < 3; i++) {
          await client.enqueue({
            type: "bound_job",
            queue: "budget-integration",
            payload: { i },
            budgets: [{ key: "emails" }],
          });
        }

        assert.equal(await client.countJobs({ budgetsKey: "emails" }), 3);
        await assert.rejects(() => client.deleteBudget("emails"), ConflictError);

        const change = await client.jobs().byBudgetsKey("emails").unbindBudget("emails");
        assert.deepEqual(change, { changed: 3, blocked: [] });

        assert.equal(await client.countJobs({ budgetsKey: "emails" }), 0);
        await client.deleteBudget("emails");
      } catch (err) {
        if (err instanceof ClientError && err.status === 403) return;
        throw err;
      }
    });

    it("binds and clears in bulk over a query", async () => {
      try {
        await client.defineBudget({
          key: "emails",
          allocation: 100,
          strategy: { type: "while_in_flight" },
        });

        for (let i = 0; i < 3; i++) {
          await client.enqueue({
            type: "bulk_job",
            queue: "budget-bulk",
            payload: { i },
          });
        }

        const bound = await client.jobs().byQueue("budget-bulk")
          .bindBudget({ key: "emails", cost: 2 });
        assert.equal(bound.changed, 3);

        await client.jobs().byQueue("budget-bulk").setBudgetCost("emails", 7);
        const costs = [];
        for await (const job of client.jobs().byQueue("budget-bulk")) {
          costs.push(job.budgets[0].cost);
        }
        assert.deepEqual(costs, [7, 7, 7]);

        const cleared = await client.jobs().byQueue("budget-bulk").clearBudgets();
        assert.equal(cleared.changed, 3);
        assert.equal(await client.countJobs({ budgetsKey: "emails" }), 0);
      } catch (err) {
        if (err instanceof ClientError && err.status === 403) return;
        throw err;
      }
    });
  });

  // --- Throttling (requires Pro license) ---
  //
  // Built so the assertions are about *counts*, not elapsed time. The
  // rate-limit test uses a one-minute period, so the second token
  // cannot arrive inside the few seconds the test runs however loaded
  // the machine is; the concurrency test measures overlap rather than
  // duration and has no timing component at all.

  describe("throttling", () => {
    it("while_in_flight never runs two at once", async () => {
      try {
        await client.defineBudget({
          key: "one-at-a-time",
          allocation: 1,
          strategy: { type: "while_in_flight" },
        });

        const count = 5;
        for (let i = 0; i < count; i++) {
          await client.enqueue({
            type: "concurrency_probe",
            queue: "budget-concurrency",
            payload: { i },
            budgets: [{ key: "one-at-a-time" }],
          });
        }

        let inFlight = 0;
        let peak = 0;
        let done = 0;

        const worker = new Worker({
          client,
          queues: ["budget-concurrency"],
          concurrency: 4,
          logger: noopLogger,
          handler: async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 50));
            inFlight -= 1;
            done += 1;
            if (done === count) worker.stop();
          },
        });

        const timeout = setTimeout(() => worker.kill(), 30_000);
        await worker.run();
        clearTimeout(timeout);

        assert.equal(done, count);
        assert.equal(peak, 1, `budget allowed ${peak} jobs in flight at once`);
      } catch (err) {
        if (err instanceof ClientError && err.status === 403) return;
        throw err;
      }
    });

    // One token per *minute* with a burst of 1, so exactly one job is
    // affordable and the refill provably cannot arrive inside the
    // window this test waits. The assertion is a count, and the grace
    // is the best part of a minute.
    it("a rate limit withholds what it cannot afford", async () => {
      try {
        await client.defineBudget({
          key: "one-per-minute",
          allocation: 1,
          strategy: { type: "time_based", durationMs: 60_000, burst: 1 },
        });

        for (let i = 0; i < 3; i++) {
          await client.enqueue({
            type: "throttled_probe",
            queue: "budget-throttled",
            payload: { i },
            budgets: [{ key: "one-per-minute" }],
          });
        }

        let performed = 0;
        const worker = new Worker({
          client,
          queues: ["budget-throttled"],
          concurrency: 2,
          logger: noopLogger,
          handler: async () => {
            performed += 1;
          },
        });

        // Run for a fixed window rather than until a count is reached:
        // the point is what does *not* happen in it.
        const stop = setTimeout(() => worker.stop(), 4_000);
        const timeout = setTimeout(() => worker.kill(), 30_000);
        await worker.run();
        clearTimeout(stop);
        clearTimeout(timeout);

        assert.equal(performed, 1, `expected the budget to afford exactly one job`);
        assert.equal(
          await client.countJobs({ queue: "budget-throttled", status: ["ready", "scheduled"] }),
          2,
        );
      } catch (err) {
        if (err instanceof ClientError && err.status === 403) return;
        throw err;
      }
    });

    // The positive control: a budget with room to spare must not hold
    // anything back, so a bug that throttles everything cannot pass the
    // test above by accident.
    it("a generous budget does not throttle", async () => {
      try {
        await client.defineBudget({
          key: "roomy",
          allocation: 100,
          strategy: { type: "time_based", durationMs: 1_000 },
        });

        const count = 3;
        for (let i = 0; i < count; i++) {
          await client.enqueue({
            type: "throttled_probe",
            queue: "budget-throttled",
            payload: { i },
            budgets: [{ key: "roomy" }],
          });
        }

        let performed = 0;
        const worker = new Worker({
          client,
          queues: ["budget-throttled"],
          concurrency: 2,
          logger: noopLogger,
          handler: async () => {
            performed += 1;
            if (performed === count) worker.stop();
          },
        });

        const timeout = setTimeout(() => worker.kill(), 30_000);
        await worker.run();
        clearTimeout(timeout);

        assert.equal(performed, count);
      } catch (err) {
        if (err instanceof ClientError && err.status === 403) return;
        throw err;
      }
    });
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
