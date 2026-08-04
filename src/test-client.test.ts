// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TestClient, NotSupportedError } from "./test-client.ts";
import { Router } from "./router.ts";

describe("TestClient", () => {
  describe("enqueue paths buffer instead of talking to a server", () => {
    it("records single enqueue", async () => {
      const client = new TestClient();
      const job = await client.enqueue({
        type: "send_email",
        queue: "emails",
        payload: { to: "a@b.com" },
      });

      assert.equal(job.type, "send_email");
      assert.equal(job.queue, "emails");
      assert.deepEqual(job.payload, { to: "a@b.com" });
      assert.equal(client.enqueuedJobs().length, 1);
      assert.match(job.id, /^test/);
    });

    it("records bulk enqueue in order", async () => {
      const client = new TestClient();
      const jobs = await client.enqueueBulk([
        { type: "a", queue: "q", payload: 1 },
        { type: "b", queue: "q", payload: 2 },
        { type: "c", queue: "q", payload: 3 },
      ]);
      assert.deepEqual(jobs.map((j) => j.type), ["a", "b", "c"]);
      assert.deepEqual(client.enqueuedJobs().map((j) => j.payload), [1, 2, 3]);
    });

    it("enqueueRaw and enqueueBulkRaw both buffer", async () => {
      const client = new TestClient();
      await client.enqueueRaw({ type: "x", queue: "q", payload: {} });
      await client.enqueueBulkRaw([{ type: "y", queue: "q", payload: {} }]);
      assert.equal(client.enqueuedJobs().length, 2);
    });

    it("normalises payloads through JSON round-trip", async () => {
      const client = new TestClient();
      const when = new Date("2026-05-27T10:15:30Z");
      await client.enqueue({
        type: "email",
        queue: "emails",
        // Symbol values would be dropped by JSON.stringify (undefined
        // → key omitted), Dates serialise to their ISO string.
        payload: { when, tag: Symbol.for("x") as unknown as string },
      });
      const [job] = client.enqueuedJobs();
      assert.deepEqual(job!.payload, { when: when.toISOString() });
    });

    it("scheduled jobs are marked scheduled, ready jobs are ready", async () => {
      const client = new TestClient();
      const future = Date.now() + 60_000;
      await client.enqueue({
        type: "later",
        queue: "q",
        payload: {},
        readyAt: future,
      });
      await client.enqueue({ type: "now", queue: "q", payload: {} });

      assert.equal(client.pendingJobs().length, 2);
      // Both `ready` and `scheduled` count as pending.
      assert.equal(client.completedJobs().length, 0);
      assert.equal(client.inFlightJobs().length, 0);
    });
  });

  describe("filters", () => {
    async function seed(client: TestClient): Promise<void> {
      await client.enqueue({ type: "email", queue: "emails", payload: 1 });
      await client.enqueue({ type: "email", queue: "priority", payload: 2 });
      await client.enqueue({ type: "report", queue: "emails", payload: 3 });
    }

    it("onlyQueues + onlyTypes AND together", async () => {
      const client = new TestClient();
      await seed(client);
      const jobs = client.enqueuedJobs({
        onlyQueues: "emails",
        onlyTypes: "email",
      });
      assert.deepEqual(jobs.map((j) => j.payload), [1]);
    });

    it("exceptQueues removes matching entries", async () => {
      const client = new TestClient();
      await seed(client);
      const jobs = client.enqueuedJobs({ exceptQueues: "priority" });
      assert.deepEqual(jobs.map((j) => j.payload), [1, 3]);
    });

    it("filter predicate composes with named filters", async () => {
      const client = new TestClient();
      await seed(client);
      const jobs = client.enqueuedJobs({
        onlyQueues: "emails",
        filter: (j) => j.payload === 3,
      });
      assert.deepEqual(jobs.map((j) => j.payload), [3]);
    });

    it("array form accepts multiple values", async () => {
      const client = new TestClient();
      await seed(client);
      const jobs = client.enqueuedJobs({ onlyQueues: ["emails", "priority"] });
      assert.equal(jobs.length, 3);
    });
  });

  describe("predicates", () => {
    it("enqueued() is true when type matches, false otherwise", async () => {
      const client = new TestClient();
      await client.enqueue({ type: "email", queue: "q", payload: {} });
      assert.equal(client.enqueued("email"), true);
      assert.equal(client.enqueued("report"), false);
    });

    it("enqueued() with a payload requires deep-equal match", async () => {
      const client = new TestClient();
      await client.enqueue({
        type: "email",
        queue: "q",
        payload: { to: "a@b.com", cc: [1, 2] },
      });
      assert.equal(client.enqueued("email", { to: "a@b.com", cc: [1, 2] }), true);
      assert.equal(client.enqueued("email", { to: "b@c.com", cc: [1, 2] }), false);
    });

    it("enqueuedCount() counts matching jobs", async () => {
      const client = new TestClient();
      await client.enqueue({ type: "email", queue: "q", payload: 1 });
      await client.enqueue({ type: "email", queue: "q", payload: 2 });
      await client.enqueue({ type: "email", queue: "q", payload: 1 });
      assert.equal(client.enqueuedCount("email"), 3);
      assert.equal(client.enqueuedCount("email", 1), 2);
    });
  });

  describe("dispatch", () => {
    it("drains ready entries and marks them completed", async () => {
      const client = new TestClient();
      const fired: unknown[] = [];
      const handler = new Router()
        .route("email", async (p) => {
          fired.push(p);
        })
        .build();

      await client.enqueue({ type: "email", queue: "q", payload: 1 });
      await client.enqueue({ type: "email", queue: "q", payload: 2 });

      const total = await client.dispatch(handler);

      assert.equal(total, 2);
      assert.deepEqual(fired, [1, 2]);
      assert.equal(client.completedJobs().length, 2);
      assert.equal(client.pendingJobs().length, 0);
    });

    it("dispatches jobs enqueued immediately before the call", async () => {
      const client = new TestClient();
      const fired: number[] = [];
      const handler = new Router()
        .route("email", (p) => {
          fired.push(p as number);
        })
        .build();

      await client.enqueue({ type: "email", queue: "q", payload: 42 });
      const total = await client.dispatch(handler);

      assert.equal(total, 1);
      assert.deepEqual(fired, [42]);
    });

    it("respects filters and leaves non-matching entries pending", async () => {
      const client = new TestClient();
      const handler = new Router()
        .route("email", () => {})
        .route("report", () => {})
        .build();

      await client.enqueue({ type: "email", queue: "q", payload: 1 });
      await client.enqueue({ type: "report", queue: "q", payload: 2 });

      const total = await client.dispatch(handler, { onlyTypes: "email" });

      assert.equal(total, 1);
      assert.equal(client.completedJobs().length, 1);
      assert.equal(client.pendingJobs().length, 1);
      assert.equal(client.pendingJobs()[0]!.type, "report");
    });

    it("marks dead and re-throws on handler exception", async () => {
      const client = new TestClient();
      const handler = new Router()
        .route("email", () => {
          throw new Error("boom");
        })
        .build();

      await client.enqueue({ type: "email", queue: "q", payload: 1 });

      await assert.rejects(
        () => client.dispatch(handler),
        /boom/,
      );
      assert.equal(client.deadJobs().length, 1);
      assert.equal(client.completedJobs().length, 0);
    });

    it("processes only the current snapshot by default", async () => {
      const client = new TestClient();
      let fired = 0;
      const handler = new Router()
        .route("step", async () => {
          fired++;
          await client.enqueue({ type: "step", queue: "q", payload: fired });
        })
        .build();

      await client.enqueue({ type: "step", queue: "q", payload: 0 });
      const total = await client.dispatch(handler);

      assert.equal(total, 1);
      assert.equal(fired, 1);
      // The re-enqueue from within the handler stays buffered.
      assert.equal(client.pendingJobs().length, 1);
    });

    it("recursive: true drains re-enqueues in the same call", async () => {
      const client = new TestClient();
      let fired = 0;
      const handler = new Router()
        .route("step", async () => {
          fired++;
          if (fired < 3) {
            await client.enqueue({ type: "step", queue: "q", payload: fired });
          }
        })
        .build();

      await client.enqueue({ type: "step", queue: "q", payload: 0 });
      const total = await client.dispatch(handler, { recursive: true });

      assert.equal(total, 3);
      assert.equal(fired, 3);
      assert.equal(client.pendingJobs().length, 0);
    });

    it("throws when recursive dispatch exceeds maxIterations", async () => {
      const client = new TestClient();
      const handler = new Router()
        .route("step", async () => {
          // Unconditional re-enqueue — would loop forever without a cap.
          await client.enqueue({ type: "step", queue: "q", payload: null });
        })
        .build();

      await client.enqueue({ type: "step", queue: "q", payload: null });

      await assert.rejects(
        () => client.dispatch(handler, { recursive: true, maxIterations: 5 }),
        /maxIterations/,
      );
    });

    it("skips scheduled entries whose readyAt is still in the future", async () => {
      const client = new TestClient();
      const handler = new Router().route("later", () => {}).build();

      await client.enqueue({
        type: "later",
        queue: "q",
        payload: {},
        readyAt: Date.now() + 60_000,
      });

      const total = await client.dispatch(handler);
      assert.equal(total, 0);
      assert.equal(client.pendingJobs().length, 1);
    });
  });

  describe("clear", () => {
    it("wipes the buffer and resets id counter", async () => {
      const client = new TestClient();
      await client.enqueue({ type: "a", queue: "q", payload: 1 });
      await client.enqueue({ type: "a", queue: "q", payload: 2 });
      client.clear();
      assert.equal(client.enqueuedJobs().length, 0);
      const next = await client.enqueue({ type: "a", queue: "q", payload: 3 });
      // ID resets to 1 (padded) — a cosmetic guarantee, but useful
      // for tests that compare against a snapshot.
      assert.equal(next.id.endsWith("1"), true);
    });
  });

  describe("close/destroy are no-ops", () => {
    it("does not throw", async () => {
      const client = new TestClient();
      await client.close();
      await client.destroy();
    });
  });

  describe("unsupported operations", () => {
    it("throws NotSupportedError for read/mutation/streaming methods", async () => {
      const client = new TestClient();
      await assert.rejects(client.getJob("x"), NotSupportedError);
      await assert.rejects(client.deleteJob("x"), NotSupportedError);
      await assert.rejects(client.countJobs(), NotSupportedError);
      await assert.rejects(
        client.updateJob("x", { priority: 1 }),
        NotSupportedError,
      );
      await assert.rejects(client.health(), NotSupportedError);
      await assert.rejects(client.serverVersion(), NotSupportedError);
      await assert.rejects(client.queues(), NotSupportedError);
      await assert.rejects(client.take(), NotSupportedError);
    });

    it("throws NotSupportedError for cron operations", async () => {
      const client = new TestClient();
      await assert.rejects(client.listCronGroups(), NotSupportedError);
      await assert.rejects(
        client.replaceCronGroup("g", { entries: [] }),
        NotSupportedError,
      );
      await assert.rejects(client.deleteCronGroup("g"), NotSupportedError);
    });

    it("NotSupportedError names the method in its message", async () => {
      const client = new TestClient();
      try {
        await client.getJob("x");
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof NotSupportedError);
        assert.match(err.message, /getJob/);
      }
    });
  });
});
