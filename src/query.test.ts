// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ErrorQuery, JobQuery } from "./query.ts";
import { createMockContext, type MockContext } from "./test-helpers.ts";

describe("ErrorQuery", () => {
  let ctx: MockContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  afterEach(async () => {
    await ctx.mockAgent.close();
  });

  it("iterates over all errors across pages", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs/j1/errors?limit=1", method: "GET" })
      .reply(200, {
        errors: [
          { attempt: 1, message: "first", dequeued_at: 1000, failed_at: 2000 },
        ],
        pages: {
          self: "/jobs/j1/errors?limit=1",
          next: "/jobs/j1/errors?limit=1&from=1",
        },
      }, { headers: { "content-type": "application/json" } });

    ctx.mockPool
      .intercept({ path: "/jobs/j1/errors?limit=1&from=1", method: "GET" })
      .reply(200, {
        errors: [
          { attempt: 2, message: "second", dequeued_at: 3000, failed_at: 4000 },
        ],
        pages: { self: "/jobs/j1/errors?limit=1&from=1" },
      }, { headers: { "content-type": "application/json" } });

    const query = new ErrorQuery(ctx.client, "j1").inPagesOf(1);
    const messages: string[] = [];

    for await (const error of query) {
      messages.push(error.message);
    }

    assert.deepEqual(messages, ["first", "second"]);
  });

  it("respects limit across pages", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs/j1/errors?limit=2", method: "GET" })
      .reply(200, {
        errors: [
          { attempt: 1, message: "a", dequeued_at: 1000, failed_at: 2000 },
          { attempt: 2, message: "b", dequeued_at: 3000, failed_at: 4000 },
        ],
        pages: {
          self: "/jobs/j1/errors?limit=2",
          next: "/jobs/j1/errors?limit=2&from=2",
        },
      }, { headers: { "content-type": "application/json" } });

    const query = new ErrorQuery(ctx.client, "j1").limit(2);
    const messages: string[] = [];

    for await (const error of query) {
      messages.push(error.message);
    }

    assert.deepEqual(messages, ["a", "b"]);
  });

  it("first() fetches a single error", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs/j1/errors?limit=1", method: "GET" })
      .reply(200, {
        errors: [
          { attempt: 1, message: "boom", dequeued_at: 1000, failed_at: 2000 },
        ],
        pages: { self: "/jobs/j1/errors?limit=1" },
      }, { headers: { "content-type": "application/json" } });

    const query = new ErrorQuery(ctx.client, "j1");
    const error = await query.first();

    assert.ok(error);
    assert.equal(error.message, "boom");
  });

  it("first() returns undefined when no errors", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs/j1/errors?limit=1", method: "GET" })
      .reply(200, {
        errors: [],
        pages: { self: "/jobs/j1/errors?limit=1" },
      }, { headers: { "content-type": "application/json" } });

    const query = new ErrorQuery(ctx.client, "j1");
    const error = await query.first();

    assert.equal(error, undefined);
  });

  it("last() reverses order and fetches one", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs/j1/errors?order=desc&limit=1", method: "GET" })
      .reply(200, {
        errors: [
          { attempt: 5, message: "latest", dequeued_at: 9000, failed_at: 10000 },
        ],
        pages: { self: "/jobs/j1/errors?order=desc&limit=1" },
      }, { headers: { "content-type": "application/json" } });

    const query = new ErrorQuery(ctx.client, "j1");
    const error = await query.last();

    assert.ok(error);
    assert.equal(error.message, "latest");
    assert.equal(error.attempt, 5);
  });

  it("isEmpty() returns true when no errors exist", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs/j1/errors?limit=1", method: "GET" })
      .reply(200, {
        errors: [],
        pages: { self: "/jobs/j1/errors?limit=1" },
      }, { headers: { "content-type": "application/json" } });

    assert.equal(await new ErrorQuery(ctx.client, "j1").isEmpty(), true);
  });

  it("isEmpty() returns false when there's at least one error", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs/j1/errors?limit=1", method: "GET" })
      .reply(200, {
        errors: [
          { attempt: 1, message: "boom", dequeued_at: 1000, failed_at: 2000 },
        ],
        pages: { self: "/jobs/j1/errors?limit=1" },
      }, { headers: { "content-type": "application/json" } });

    assert.equal(await new ErrorQuery(ctx.client, "j1").isEmpty(), false);
  });

  it("passes order to the server", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs/j1/errors?order=desc&limit=2000", method: "GET" })
      .reply(200, {
        errors: [
          { attempt: 2, message: "b", dequeued_at: 3000, failed_at: 4000 },
          { attempt: 1, message: "a", dequeued_at: 1000, failed_at: 2000 },
        ],
        pages: { self: "/jobs/j1/errors?order=desc&limit=2000" },
      }, { headers: { "content-type": "application/json" } });

    const messages: string[] = [];
    for await (const error of new ErrorQuery(ctx.client, "j1").order("desc")) {
      messages.push(error.message);
    }

    assert.deepEqual(messages, ["b", "a"]);
  });

  it("pages() yields ErrorPage instances", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs/j1/errors?limit=1", method: "GET" })
      .reply(200, {
        errors: [
          { attempt: 1, message: "a", dequeued_at: 1000, failed_at: 2000 },
        ],
        pages: {
          self: "/jobs/j1/errors?limit=1",
          next: "/jobs/j1/errors?limit=1&from=1",
        },
      }, { headers: { "content-type": "application/json" } });

    ctx.mockPool
      .intercept({ path: "/jobs/j1/errors?limit=1&from=1", method: "GET" })
      .reply(200, {
        errors: [
          { attempt: 2, message: "b", dequeued_at: 3000, failed_at: 4000 },
        ],
        pages: { self: "/jobs/j1/errors?limit=1&from=1" },
      }, { headers: { "content-type": "application/json" } });

    const query = new ErrorQuery(ctx.client, "j1").inPagesOf(1);
    const pageSizes: number[] = [];

    for await (const page of query.pages()) {
      pageSizes.push(page.errors.length);
    }

    assert.deepEqual(pageSizes, [1, 1]);
  });
});

// ---------------------------------------------------------------------------
// JobQuery
// ---------------------------------------------------------------------------

/** Build a minimal job response payload for mock replies. */
function mockJob(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type: "test",
    queue: "q",
    priority: 0,
    status: "ready",
    ready_at: 1000,
    attempts: 0,
    ...overrides,
  };
}

describe("JobQuery", () => {
  let ctx: MockContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  afterEach(async () => {
    await ctx.mockAgent.close();
  });

  it("client.jobs() returns a JobQuery", () => {
    assert.ok(ctx.client.jobs() instanceof JobQuery);
  });

  it("iterates over all jobs across pages", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs?limit=1", method: "GET" })
      .reply(200, {
        jobs: [mockJob("j1")],
        pages: { self: "/jobs?limit=1", next: "/jobs?limit=1&from=j1" },
      }, { headers: { "content-type": "application/json" } });

    ctx.mockPool
      .intercept({ path: "/jobs?limit=1&from=j1", method: "GET" })
      .reply(200, {
        jobs: [mockJob("j2")],
        pages: { self: "/jobs?limit=1&from=j1" },
      }, { headers: { "content-type": "application/json" } });

    const ids: string[] = [];
    for await (const job of ctx.client.jobs().inPagesOf(1)) {
      ids.push(job.id);
    }
    assert.deepEqual(ids, ["j1", "j2"]);
  });

  it("respects limit across pages", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs?limit=2", method: "GET" })
      .reply(200, {
        jobs: [mockJob("j1"), mockJob("j2")],
        pages: { self: "/jobs?limit=2", next: "/jobs?limit=2&from=j2" },
      }, { headers: { "content-type": "application/json" } });

    const ids = (await ctx.client.jobs().limit(2).toArray()).map((j) => j.id);
    assert.deepEqual(ids, ["j1", "j2"]);
  });

  it("uses pageSize smaller than limit for request sizing", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs?limit=2", method: "GET" })
      .reply(200, {
        jobs: [mockJob("j1"), mockJob("j2")],
        pages: { self: "/jobs?limit=2", next: "/jobs?limit=2&from=j2" },
      }, { headers: { "content-type": "application/json" } });

    ctx.mockPool
      .intercept({ path: "/jobs?limit=2&from=j2", method: "GET" })
      .reply(200, {
        jobs: [mockJob("j3"), mockJob("j4")],
        pages: { self: "/jobs?limit=2&from=j2" },
      }, { headers: { "content-type": "application/json" } });

    const jobs = await ctx.client.jobs().limit(5).inPagesOf(2).toArray();
    assert.deepEqual(jobs.map((j) => j.id), ["j1", "j2", "j3", "j4"]);
  });

  it("serialises filter params to the server", async () => {
    // MockAgent normalises query strings alphabetically and uses `+` for
    // spaces (form-urlencoded), so intercept paths must match that form.
    ctx.mockPool
      .intercept({
        path: "/jobs?filter=.urgent+%3D%3D+true&id=j1&limit=2000&order=desc&queue=emails&status=ready%2Cdead&type=send_email",
        method: "GET",
      })
      .reply(200, {
        jobs: [],
        pages: { self: "/jobs" },
      }, { headers: { "content-type": "application/json" } });

    await ctx.client.jobs()
      .byId("j1")
      .byQueue("emails")
      .byType("send_email")
      .byStatus(["ready", "dead"])
      .byJqFilter(".urgent == true")
      .order("desc")
      .toArray();
  });

  it("unions add* filters with existing values", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs?limit=2000&status=ready%2Cdead&queue=a%2Cb", method: "GET" })
      .reply(200, {
        jobs: [],
        pages: { self: "/jobs" },
      }, { headers: { "content-type": "application/json" } });

    await ctx.client.jobs()
      .byQueue("a").addQueue("b")
      .byStatus("ready").addStatus("dead")
      .toArray();
  });

  it("addJqFilter composes with the existing filter via and", async () => {
    ctx.mockPool
      .intercept({
        path: "/jobs?limit=2000&filter=.a%20%3D%3D%201%20and%20(.b%20%3D%3D%202)",
        method: "GET",
      })
      .reply(200, { jobs: [], pages: { self: "/jobs" } },
        { headers: { "content-type": "application/json" } });

    await ctx.client.jobs()
      .byJqFilter(".a == 1")
      .addJqFilter(".b == 2")
      .toArray();
  });

  it("withPayload emits an exact-match jq filter", async () => {
    ctx.mockPool
      .intercept({
        path: `/jobs?limit=2000&filter=${encodeURIComponent('(. == {"userId":42,"name":"bob"})')}`,
        method: "GET",
      })
      .reply(200, { jobs: [], pages: { self: "/jobs" } },
        { headers: { "content-type": "application/json" } });

    await ctx.client.jobs()
      .withPayload({ userId: 42, name: "bob" })
      .toArray();
  });

  it("withPayloadSubset emits contains() for objects", async () => {
    ctx.mockPool
      .intercept({
        path: `/jobs?limit=2000&filter=${encodeURIComponent('(. | contains({"userId":42}))')}`,
        method: "GET",
      })
      .reply(200, { jobs: [], pages: { self: "/jobs" } },
        { headers: { "content-type": "application/json" } });

    await ctx.client.jobs()
      .withPayloadSubset({ userId: 42 })
      .toArray();
  });

  it("withPayloadSubset emits a prefix slice for arrays", async () => {
    ctx.mockPool
      .intercept({
        path: `/jobs?limit=2000&filter=${encodeURIComponent('(.[0:2] == ["a","b"])')}`,
        method: "GET",
      })
      .reply(200, { jobs: [], pages: { self: "/jobs" } },
        { headers: { "content-type": "application/json" } });

    await ctx.client.jobs()
      .withPayloadSubset(["a", "b"])
      .toArray();
  });

  it("withPayloadSubset emits equality for scalars", async () => {
    ctx.mockPool
      .intercept({
        path: `/jobs?limit=2000&filter=${encodeURIComponent("(. == 42)")}`,
        method: "GET",
      })
      .reply(200, { jobs: [], pages: { self: "/jobs" } },
        { headers: { "content-type": "application/json" } });

    await ctx.client.jobs()
      .withPayloadSubset(42)
      .toArray();
  });

  it("first() fetches a single job with limit=1", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs?limit=1&queue=emails", method: "GET" })
      .reply(200, {
        jobs: [mockJob("j1", { queue: "emails" })],
        pages: { self: "/jobs?limit=1&queue=emails" },
      }, { headers: { "content-type": "application/json" } });

    const job = await ctx.client.jobs().byQueue("emails").first();
    assert.equal(job?.id, "j1");
  });

  it("first() returns undefined when no jobs match", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs?limit=1", method: "GET" })
      .reply(200, { jobs: [], pages: { self: "/jobs?limit=1" } },
        { headers: { "content-type": "application/json" } });

    assert.equal(await ctx.client.jobs().first(), undefined);
  });

  it("last() reverses order and fetches one", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs?order=desc&limit=1", method: "GET" })
      .reply(200, { jobs: [mockJob("jN")], pages: { self: "/jobs" } },
        { headers: { "content-type": "application/json" } });

    const job = await ctx.client.jobs().last();
    assert.equal(job?.id, "jN");
  });

  it("isEmpty() returns true when no jobs match", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs?limit=1", method: "GET" })
      .reply(200, { jobs: [], pages: { self: "/jobs?limit=1" } },
        { headers: { "content-type": "application/json" } });

    assert.equal(await ctx.client.jobs().isEmpty(), true);
  });

  it("isEmpty() returns false when there's at least one match", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs?limit=1", method: "GET" })
      .reply(200, { jobs: [mockJob("j1")], pages: { self: "/jobs?limit=1" } },
        { headers: { "content-type": "application/json" } });

    assert.equal(await ctx.client.jobs().isEmpty(), false);
  });

  it("map() delegates to the built-in async iterator helper", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs?limit=2000", method: "GET" })
      .reply(200, {
        jobs: [mockJob("j1"), mockJob("j2"), mockJob("j3")],
        pages: { self: "/jobs?limit=2000" },
      }, { headers: { "content-type": "application/json" } });

    const ids = await ctx.client.jobs().map((j) => j.id).toArray();
    assert.deepEqual(ids, ["j1", "j2", "j3"]);
  });

  it("filter() delegates to the built-in async iterator helper", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs?limit=2000", method: "GET" })
      .reply(200, {
        jobs: [
          mockJob("j1", { priority: 1 }),
          mockJob("j2", { priority: 100 }),
          mockJob("j3", { priority: 1 }),
        ],
        pages: { self: "/jobs?limit=2000" },
      }, { headers: { "content-type": "application/json" } });

    const high = await ctx.client.jobs()
      .filter((j) => j.priority === 1)
      .toArray();
    assert.deepEqual(high.map((j) => j.id), ["j1", "j3"]);
  });

  it("chains map() and filter() through iterator helpers", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs?limit=2000", method: "GET" })
      .reply(200, {
        jobs: [
          mockJob("j1", { priority: 1 }),
          mockJob("j2", { priority: 100 }),
          mockJob("j3", { priority: 1 }),
        ],
        pages: { self: "/jobs?limit=2000" },
      }, { headers: { "content-type": "application/json" } });

    const ids = await ctx.client.jobs()
      .filter((j) => j.priority === 1)
      .map((j) => j.id)
      .toArray();
    assert.deepEqual(ids, ["j1", "j3"]);
  });

  it("forEach() visits each item", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs?limit=2000", method: "GET" })
      .reply(200, {
        jobs: [mockJob("j1"), mockJob("j2")],
        pages: { self: "/jobs?limit=2000" },
      }, { headers: { "content-type": "application/json" } });

    const seen: string[] = [];
    await ctx.client.jobs().forEach((j) => { seen.push(j.id); });
    assert.deepEqual(seen, ["j1", "j2"]);
  });

  it("count() hits /jobs/count instead of paginating", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs/count", method: "GET" })
      .reply(200, { count: 42 }, { headers: { "content-type": "application/json" } });

    assert.equal(await ctx.client.jobs().count(), 42);
  });

  it("count() passes filters to /jobs/count", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs/count?queue=default&status=pending", method: "GET" })
      .reply(200, { count: 7 }, { headers: { "content-type": "application/json" } });

    assert.equal(await ctx.client.jobs().byQueue("default").byStatus("pending").count(), 7);
  });

  it("count() caps at the configured limit", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs/count", method: "GET" })
      .reply(200, { count: 10 }, { headers: { "content-type": "application/json" } });

    assert.equal(await ctx.client.jobs().limit(2).count(), 2);
  });

  it("pages() yields JobPage instances", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs?limit=1", method: "GET" })
      .reply(200, {
        jobs: [mockJob("j1")],
        pages: { self: "/jobs?limit=1", next: "/jobs?limit=1&from=j1" },
      }, { headers: { "content-type": "application/json" } });

    ctx.mockPool
      .intercept({ path: "/jobs?limit=1&from=j1", method: "GET" })
      .reply(200, {
        jobs: [mockJob("j2")],
        pages: { self: "/jobs?limit=1&from=j1" },
      }, { headers: { "content-type": "application/json" } });

    const pageSizes: number[] = [];
    for await (const page of ctx.client.jobs().inPagesOf(1).pages()) {
      pageSizes.push(page.jobs.length);
    }
    assert.deepEqual(pageSizes, [1, 1]);
  });

  describe("deleteAll", () => {
    it("unbounded: issues a single filter-scoped DELETE", async () => {
      ctx.mockPool
        .intercept({
          path: "/jobs?status=dead&queue=emails",
          method: "DELETE",
        })
        .reply(200, { deleted: 17 }, {
          headers: { "content-type": "application/json" },
        });

      const n = await ctx.client.jobs()
        .byQueue("emails")
        .byStatus("dead")
        .deleteAll();

      assert.equal(n, 17);
    });

    it("bounded by limit: iterates pages and deletes by ID per page", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs?limit=2&queue=emails", method: "GET" })
        .reply(200, {
          jobs: [mockJob("j1"), mockJob("j2")],
          pages: {
            self: "/jobs?limit=2&queue=emails",
            next: "/jobs?limit=2&queue=emails&from=j2",
          },
        }, { headers: { "content-type": "application/json" } });

      ctx.mockPool
        .intercept({ path: "/jobs?id=j1%2Cj2&queue=emails", method: "DELETE" })
        .reply(200, { deleted: 2 }, {
          headers: { "content-type": "application/json" },
        });

      const n = await ctx.client.jobs()
        .byQueue("emails")
        .limit(2)
        .deleteAll();

      assert.equal(n, 2);
    });

    it("bounded by pageSize: deletes a batch per page", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs?limit=2", method: "GET" })
        .reply(200, {
          jobs: [mockJob("j1"), mockJob("j2")],
          pages: {
            self: "/jobs?limit=2",
            next: "/jobs?limit=2&from=j2",
          },
        }, { headers: { "content-type": "application/json" } });

      ctx.mockPool
        .intercept({ path: "/jobs?id=j1%2Cj2", method: "DELETE" })
        .reply(200, { deleted: 2 }, {
          headers: { "content-type": "application/json" },
        });

      ctx.mockPool
        .intercept({ path: "/jobs?limit=2&from=j2", method: "GET" })
        .reply(200, {
          jobs: [mockJob("j3")],
          pages: { self: "/jobs?limit=2&from=j2" },
        }, { headers: { "content-type": "application/json" } });

      ctx.mockPool
        .intercept({ path: "/jobs?id=j3", method: "DELETE" })
        .reply(200, { deleted: 1 }, {
          headers: { "content-type": "application/json" },
        });

      const n = await ctx.client.jobs().inPagesOf(2).deleteAll();
      assert.equal(n, 3);
    });

    it("deleteOne issues a limit=1 bounded delete", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs?limit=1", method: "GET" })
        .reply(200, {
          jobs: [mockJob("j1")],
          pages: { self: "/jobs?limit=1" },
        }, { headers: { "content-type": "application/json" } });

      ctx.mockPool
        .intercept({ path: "/jobs?id=j1", method: "DELETE" })
        .reply(200, { deleted: 1 }, {
          headers: { "content-type": "application/json" },
        });

      assert.equal(await ctx.client.jobs().deleteOne(), 1);
    });
  });

  describe("updateAll", () => {
    it("unbounded: issues a single filter-scoped PATCH", async () => {
      let body: any;
      ctx.mockPool
        .intercept({
          path: "/jobs?queue=old",
          method: "PATCH",
          body: (b: string) => {
            body = JSON.parse(b);
            return true;
          },
        })
        .reply(200, { patched: 5 }, {
          headers: { "content-type": "application/json" },
        });

      const n = await ctx.client.jobs()
        .byQueue("old")
        .updateAll({ queue: "new" });

      assert.equal(n, 5);
      assert.deepEqual(body, { queue: "new" });
    });

    it("bounded: iterates pages and patches by ID per page", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs?limit=2", method: "GET" })
        .reply(200, {
          jobs: [mockJob("j1"), mockJob("j2")],
          pages: { self: "/jobs?limit=2" },
        }, { headers: { "content-type": "application/json" } });

      ctx.mockPool
        .intercept({
          path: "/jobs?id=j1%2Cj2",
          method: "PATCH",
        })
        .reply(200, { patched: 2 }, {
          headers: { "content-type": "application/json" },
        });

      const n = await ctx.client.jobs()
        .limit(2)
        .updateAll({ priority: 100 });

      assert.equal(n, 2);
    });

    it("bounded: truncates the final page to honour limit", async () => {
      // inPagesOf(2) + limit(3): pageSize 2 is smaller than limit 3, so the
      // server returns 2 jobs per page. After the first page, remaining is 1,
      // so the second page's [j3, j4] is truncated to [j3] before patching.
      ctx.mockPool
        .intercept({ path: "/jobs?limit=2", method: "GET" })
        .reply(200, {
          jobs: [mockJob("j1"), mockJob("j2")],
          pages: { self: "/jobs?limit=2", next: "/jobs?from=j2&limit=2" },
        }, { headers: { "content-type": "application/json" } });

      ctx.mockPool
        .intercept({ path: "/jobs?id=j1%2Cj2", method: "PATCH" })
        .reply(200, { patched: 2 }, {
          headers: { "content-type": "application/json" },
        });

      ctx.mockPool
        .intercept({ path: "/jobs?from=j2&limit=2", method: "GET" })
        .reply(200, {
          jobs: [mockJob("j3"), mockJob("j4")],
          pages: { self: "/jobs?from=j2&limit=2" },
        }, { headers: { "content-type": "application/json" } });

      ctx.mockPool
        .intercept({ path: "/jobs?id=j3", method: "PATCH" })
        .reply(200, { patched: 1 }, {
          headers: { "content-type": "application/json" },
        });

      const n = await ctx.client.jobs()
        .inPagesOf(2)
        .limit(3)
        .updateAll({ priority: 10 });

      assert.equal(n, 3);
    });

    it("updateOne issues a limit=1 bounded patch", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs?limit=1", method: "GET" })
        .reply(200, {
          jobs: [mockJob("j1")],
          pages: { self: "/jobs?limit=1" },
        }, { headers: { "content-type": "application/json" } });

      ctx.mockPool
        .intercept({ path: "/jobs?id=j1", method: "PATCH" })
        .reply(200, { patched: 1 }, {
          headers: { "content-type": "application/json" },
        });

      assert.equal(
        await ctx.client.jobs().updateOne({ priority: 1 }),
        1,
      );
    });
  });
});
