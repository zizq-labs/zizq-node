// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ClientError, ConflictError, NotFoundError } from "./client.ts";
import { createMockContext, type MockContext } from "./test-helpers.ts";

const JSON_HEADERS = { headers: { "content-type": "application/json" } };

const budgetResponse = {
  key: "emails",
  allocation: 100,
  strategy: { type: "time_based", duration_ms: 60_000 },
  created_at: 1_700_000_000_000,
};

describe("budgets", () => {
  let ctx: MockContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  afterEach(async () => {
    await ctx.mockAgent.close();
  });

  describe("listBudgets", () => {
    it("returns every budget", async () => {
      ctx.mockPool
        .intercept({ path: "/budgets", method: "GET" })
        .reply(200, { budgets: [budgetResponse] }, JSON_HEADERS);

      const budgets = await ctx.client.listBudgets();
      assert.equal(budgets.length, 1);
      assert.equal(budgets[0]!.key, "emails");
      assert.equal(budgets[0]!.allocation, 100);
    });

    it("reads an absent list as empty", async () => {
      ctx.mockPool.intercept({ path: "/budgets", method: "GET" }).reply(200, {}, JSON_HEADERS);

      assert.deepEqual(await ctx.client.listBudgets(), []);
    });

    // Budgets are Pro-gated, and the server's message is what says
    // which feature was refused.
    it("surfaces a licence refusal", async () => {
      ctx.mockPool
        .intercept({ path: "/budgets", method: "GET" })
        .reply(403, { error: "budgets require a Pro license" }, JSON_HEADERS);

      await assert.rejects(
        () => ctx.client.listBudgets(),
        (err: unknown) => {
          assert.ok(err instanceof ClientError);
          assert.equal(err.status, 403);
          assert.match(err.message, /Pro license/);
          return true;
        }
      );
    });
  });

  describe("getBudget", () => {
    // The wire uses `duration_ms`; the client uses `durationMs`. This is
    // the only place that mapping is exercised in both directions.
    it("converts the strategy to camelCase", async () => {
      ctx.mockPool
        .intercept({ path: "/budgets/emails", method: "GET" })
        .reply(200, { ...budgetResponse, strategy: { type: "time_based", duration_ms: 60_000, burst: 5 } }, JSON_HEADERS);

      const budget = await ctx.client.getBudget("emails");
      assert.deepEqual(budget.strategy, {
        type: "time_based",
        durationMs: 60_000,
        burst: 5,
      });
      assert.equal(budget.createdAt, 1_700_000_000_000);
    });

    it("omits an unset burst rather than reporting undefined", async () => {
      ctx.mockPool
        .intercept({ path: "/budgets/emails", method: "GET" })
        .reply(200, budgetResponse, JSON_HEADERS);

      const budget = await ctx.client.getBudget("emails");
      assert.ok(!("burst" in budget.strategy));
    });

    it("reads a clockless budget back with no period", async () => {
      ctx.mockPool
        .intercept({ path: "/budgets/stripe", method: "GET" })
        .reply(200, { key: "stripe", allocation: 3, strategy: { type: "while_in_flight" } }, JSON_HEADERS);

      const budget = await ctx.client.getBudget("stripe");
      assert.deepEqual(budget.strategy, { type: "while_in_flight" });
    });

    it("throws NotFoundError when missing", async () => {
      ctx.mockPool
        .intercept({ path: "/budgets/nope", method: "GET" })
        .reply(404, { error: "budget not found" }, JSON_HEADERS);

      await assert.rejects(
        () => ctx.client.getBudget("nope"),
        (err: unknown) => err instanceof NotFoundError
      );
    });

    it("encodes the key into the path", async () => {
      ctx.mockPool
        .intercept({ path: "/budgets/a%2Fb", method: "GET" })
        .reply(200, { ...budgetResponse, key: "a/b" }, JSON_HEADERS);

      assert.equal((await ctx.client.getBudget("a/b")).key, "a/b");
    });
  });

  describe("defineBudget", () => {
    it("POSTs the policy with the period in milliseconds", async () => {
      ctx.mockPool
        .intercept({
          path: "/budgets/emails",
          method: "POST",
          body: JSON.stringify({
            allocation: 100,
            strategy: { type: "time_based", duration_ms: 60_000 },
          }),
        })
        .reply(201, budgetResponse, JSON_HEADERS);

      const budget = await ctx.client.defineBudget({
        key: "emails",
        allocation: 100,
        strategy: { type: "time_based", durationMs: 60_000 },
      });
      assert.equal(budget.key, "emails");
    });

    // A clockless strategy carries the kind alone — no null period.
    it("sends only the kind for while_in_flight", async () => {
      ctx.mockPool
        .intercept({
          path: "/budgets/stripe",
          method: "POST",
          body: JSON.stringify({
            allocation: 3,
            strategy: { type: "while_in_flight" },
          }),
        })
        .reply(201, budgetResponse, JSON_HEADERS);

      await ctx.client.defineBudget({
        key: "stripe",
        allocation: 3,
        strategy: { type: "while_in_flight" },
      });
    });

    // `POST` refuses rather than overwriting, which is what lets every
    // instance declare its budgets on boot without coordinating.
    it("throws ConflictError when the key exists", async () => {
      ctx.mockPool
        .intercept({ path: "/budgets/emails", method: "POST" })
        .reply(409, { error: "budget 'emails' already exists" }, JSON_HEADERS);

      await assert.rejects(
        () =>
          ctx.client.defineBudget({
            key: "emails",
            allocation: 100,
            strategy: { type: "while_in_flight" },
          }),
        (err: unknown) => {
          assert.ok(err instanceof ConflictError);
          assert.equal(err.status, 409);
          return true;
        }
      );
    });

    it("switches to PUT when replacing", async () => {
      ctx.mockPool
        .intercept({
          path: "/budgets/emails",
          method: "PUT",
          body: JSON.stringify({
            allocation: 200,
            strategy: { type: "while_in_flight" },
          }),
        })
        .reply(200, budgetResponse, JSON_HEADERS);

      await ctx.client.defineBudget({
        key: "emails",
        allocation: 200,
        strategy: { type: "while_in_flight" },
        replace: true,
      });
    });

    // `key` and `replace` steer the request; neither belongs in the body.
    it("keeps key and replace out of the body", async () => {
      ctx.mockPool
        .intercept({
          path: "/budgets/emails",
          method: "PUT",
          body: (body) => {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            return !("key" in parsed) && !("replace" in parsed);
          },
        })
        .reply(200, budgetResponse, JSON_HEADERS);

      await ctx.client.defineBudget({
        key: "emails",
        allocation: 1,
        strategy: { type: "while_in_flight" },
        replace: true,
      });
    });
  });

  // The union stops a TypeScript caller reaching these, but plain JS
  // callers exist and a third strategy may be added server-side. What
  // must never happen is a value being silently relabelled as a kind
  // the caller did not ask for — that is a valid-looking budget of the
  // wrong sort rather than an error.
  describe("an unrecognised strategy", () => {
    it("is sent under its own name, not relabelled", async () => {
      ctx.mockPool
        .intercept({
          path: "/budgets/future",
          method: "POST",
          body: JSON.stringify({
            allocation: 1,
            strategy: { type: "sliding_window", duration_ms: 1_000 },
          }),
        })
        .reply(201, budgetResponse, JSON_HEADERS);

      await ctx.client.defineBudget({
        key: "future",
        allocation: 1,
        // Cast: the point is what happens when the union is bypassed.
        strategy: { type: "sliding_window", durationMs: 1_000 } as never,
      });
    });

    it("reads back under its own name", async () => {
      ctx.mockPool
        .intercept({ path: "/budgets/future", method: "GET" })
        .reply(
          200,
          { key: "future", allocation: 1, strategy: { type: "sliding_window", duration_ms: 1_000 } },
          JSON_HEADERS
        );

      const budget = await ctx.client.getBudget("future");
      assert.equal(budget.strategy.type as string, "sliding_window");
    });
  });

  describe("updateBudget", () => {
    it("sends only the field that was named", async () => {
      ctx.mockPool
        .intercept({
          path: "/budgets/emails",
          method: "PATCH",
          body: JSON.stringify({ strategy: { burst: 5 } }),
        })
        .reply(200, budgetResponse, JSON_HEADERS);

      await ctx.client.updateBudget("emails", { strategy: { burst: 5 } });
    });

    // `null` is the one meaningful clear, and has to survive as JSON
    // null rather than being stripped like `undefined`.
    it("sends an explicit null burst", async () => {
      ctx.mockPool
        .intercept({
          path: "/budgets/emails",
          method: "PATCH",
          body: JSON.stringify({ strategy: { burst: null } }),
        })
        .reply(200, budgetResponse, JSON_HEADERS);

      await ctx.client.updateBudget("emails", { strategy: { burst: null } });
    });

    it("converts the period to duration_ms", async () => {
      ctx.mockPool
        .intercept({
          path: "/budgets/emails",
          method: "PATCH",
          body: JSON.stringify({ strategy: { duration_ms: 30_000 } }),
        })
        .reply(200, budgetResponse, JSON_HEADERS);

      await ctx.client.updateBudget("emails", { strategy: { durationMs: 30_000 } });
    });

    it("sends the allocation outside the strategy", async () => {
      ctx.mockPool
        .intercept({
          path: "/budgets/emails",
          method: "PATCH",
          body: JSON.stringify({ allocation: 50 }),
        })
        .reply(200, budgetResponse, JSON_HEADERS);

      await ctx.client.updateBudget("emails", { allocation: 50 });
    });

    // A patch has nothing to merge into, so unlike `replace` it does not
    // create the budget.
    it("throws NotFoundError when missing", async () => {
      ctx.mockPool
        .intercept({ path: "/budgets/nope", method: "PATCH" })
        .reply(404, { error: "budget not found" }, JSON_HEADERS);

      await assert.rejects(
        () => ctx.client.updateBudget("nope", { allocation: 5 }),
        (err: unknown) => err instanceof NotFoundError
      );
    });
  });

  // The binding travels through `EnqueueInput` -> `resolveInput` ->
  // `EnqueueOptions` -> `enqueueToApi`, and each of those assembles its
  // result field by field. Testing through `enqueue()` rather than
  // `enqueueRaw()` is the point: only the former crosses `resolveInput`,
  // which is where a missed field would be dropped in silence.
  describe("binding at enqueue", () => {
    it("sends bindings through enqueue()", async () => {
      ctx.mockPool
        .intercept({
          path: "/jobs",
          method: "POST",
          body: (body) => {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            assert.deepEqual(parsed.budgets, [{ key: "emails", cost: 2 }]);
            return true;
          },
        })
        .reply(201, { id: "j1", type: "t", queue: "q", status: "ready", payload: {}, ready_at: 1, attempts: 0 }, JSON_HEADERS);

      await ctx.client.enqueue({
        type: "send_email",
        queue: "emails",
        payload: {},
        budgets: [{ key: "emails", cost: 2 }],
      });
    });

    it("sends bindings through enqueueRaw() too", async () => {
      ctx.mockPool
        .intercept({
          path: "/jobs",
          method: "POST",
          body: (body) => {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            assert.deepEqual(parsed.budgets, [{ key: "emails" }]);
            return true;
          },
        })
        .reply(201, { id: "j1", type: "t", queue: "q", status: "ready", payload: {}, ready_at: 1, attempts: 0 }, JSON_HEADERS);

      await ctx.client.enqueueRaw({
        type: "send_email",
        queue: "emails",
        payload: {},
        budgets: [{ key: "emails" }],
      });
    });

    it("converts a createWith policy to the wire form", async () => {
      ctx.mockPool
        .intercept({
          path: "/jobs",
          method: "POST",
          body: (body) => {
            const parsed = JSON.parse(body) as { budgets: Record<string, unknown>[] };
            assert.deepEqual(parsed.budgets[0]!.create_with, {
              allocation: 100,
              strategy: { type: "time_based", duration_ms: 60_000 },
            });
            return true;
          },
        })
        .reply(201, { id: "j1", type: "t", queue: "q", status: "ready", payload: {}, ready_at: 1, attempts: 0 }, JSON_HEADERS);

      await ctx.client.enqueue({
        type: "send_email",
        queue: "emails",
        payload: {},
        budgets: [
          {
            key: "emails",
            createWith: {
              allocation: 100,
              strategy: { type: "time_based", durationMs: 60_000 },
            },
          },
        ],
      });
    });

    // An unthrottled job pays nothing for the feature on the wire, which
    // is how the server reports one back too.
    it("omits the field entirely when there are no bindings", async () => {
      ctx.mockPool
        .intercept({
          path: "/jobs",
          method: "POST",
          body: (body) => !("budgets" in (JSON.parse(body) as object)),
        })
        .reply(201, { id: "j1", type: "t", queue: "q", status: "ready", payload: {}, ready_at: 1, attempts: 0 }, JSON_HEADERS)
        .times(2);

      await ctx.client.enqueue({ type: "t", queue: "q", payload: {} });
      await ctx.client.enqueue({ type: "t", queue: "q", payload: {}, budgets: [] });
    });

    // A cron entry's job template goes through `cronJobToApi`, a fourth
    // assembly of the same shape.
    it("sends bindings on a cron entry's job template", async () => {
      ctx.mockPool
        .intercept({
          path: "/crons/nightly",
          method: "PUT",
          body: (body) => {
            const parsed = JSON.parse(body) as { entries: { job: Record<string, unknown> }[] };
            assert.deepEqual(parsed.entries[0]!.job.budgets, [{ key: "emails", cost: 5 }]);
            return true;
          },
        })
        .reply(200, { name: "nightly", entries: [] }, JSON_HEADERS);

      await ctx.client.replaceCronGroup("nightly", {
        entries: [
          {
            name: "digest",
            expression: "0 9 * * *",
            job: {
              type: "digest",
              queue: "emails",
              payload: {},
              budgets: [{ key: "emails", cost: 5 }],
            },
          },
        ],
      });
    });
  });

  describe("reading bindings back off a job", () => {
    it("reports what the job draws on", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/j1", method: "GET" })
        .reply(
          200,
          {
            id: "j1", type: "t", queue: "q", status: "ready", payload: {},
            ready_at: 1, attempts: 0,
            budgets: [{ key: "emails", cost: 2 }],
          },
          JSON_HEADERS
        );

      const job = await ctx.client.getJob("j1");
      assert.deepEqual(job.budgets, [{ key: "emails", cost: 2 }]);
    });

    // Absent means none — the server omits the field rather than
    // sending an empty array, so there is nothing to distinguish.
    it("reports an unthrottled job as empty rather than undefined", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/j1", method: "GET" })
        .reply(
          200,
          { id: "j1", type: "t", queue: "q", status: "ready", payload: {}, ready_at: 1, attempts: 0 },
          JSON_HEADERS
        );

      const job = await ctx.client.getJob("j1");
      assert.deepEqual(job.budgets, []);
    });

    it("survives toJSON", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/j1", method: "GET" })
        .reply(
          200,
          {
            id: "j1", type: "t", queue: "q", status: "ready", payload: {},
            ready_at: 1, attempts: 0,
            budgets: [{ key: "emails", cost: 2 }],
          },
          JSON_HEADERS
        );

      const job = await ctx.client.getJob("j1");
      assert.deepEqual(job.toJSON().budgets, [{ key: "emails", cost: 2 }]);
    });
  });

  describe("deleteBudget", () => {
    it("deletes and resolves", async () => {
      ctx.mockPool.intercept({ path: "/budgets/emails", method: "DELETE" }).reply(204, "");

      await ctx.client.deleteBudget("emails");
    });

    // Refused while anything still draws on it; the message names which
    // of the two remedies applies.
    it("throws ConflictError while still referenced", async () => {
      ctx.mockPool
        .intercept({ path: "/budgets/emails", method: "DELETE" })
        .reply(409, { error: "budget 'emails' is referenced by 3 unfinished jobs." }, JSON_HEADERS);

      await assert.rejects(
        () => ctx.client.deleteBudget("emails"),
        (err: unknown) => {
          assert.ok(err instanceof ConflictError);
          assert.match((err as ConflictError).message, /unfinished jobs/);
          return true;
        }
      );
    });
  });
});
