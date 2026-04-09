// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ZizqError, ClientError, ResponseError, Client } from "./client.ts";
import { createMockContext, msgpackBody, msgpackStreamBody, type MockContext } from "./test-helpers.ts";
import { encode as msgpackEncode } from "@msgpack/msgpack";

describe("Client", () => {
  let ctx: MockContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  afterEach(async () => {
    await ctx.mockAgent.close();
  });

  describe("enqueue", () => {
    it("posts a job and returns the response", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs", method: "POST" })
        .reply(201, {
          id: "abc123",
          type: "send_email",
          queue: "emails",
          priority: 32768,
          status: "ready",
          ready_at: 1000,
          attempts: 0,
        }, {
          headers: { "content-type": "application/json" },
        });

      const job = await ctx.client.enqueue({
        type: "send_email",
        queue: "emails",
        payload: { to: "user@test.com" },
      });

      assert.equal(job.id, "abc123");
      assert.equal(job.type, "send_email");
      assert.equal(job.queue, "emails");
      assert.equal(job.status, "ready");
      assert.equal(job.readyAt, 1000);
    });

    it("throws ClientError on 400", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs", method: "POST" })
        .reply(400, { error: "queue must not be empty" }, {
          headers: { "content-type": "application/json" },
        });

      await assert.rejects(
        () =>
          ctx.client.enqueue({
            type: "test",
            queue: "",
            payload: null,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ClientError);
          assert.ok(err instanceof ResponseError);
          assert.ok(err instanceof ZizqError);
          assert.equal(err.status, 400);
          assert.equal(err.message, "queue must not be empty");
          return true;
        }
      );
    });
  });

  describe("reportSuccess", () => {
    it("posts success and returns void", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/job1/success", method: "POST" })
        .reply(204, "");

      const result = await ctx.client.reportSuccess("job1");
      assert.equal(result, undefined);
    });
  });

  describe("reportSuccessBulk", () => {
    it("posts bulk success", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/success", method: "POST" })
        .reply(204, "");

      await ctx.client.reportSuccessBulk(["job1", "job2"]);
    });
  });

  describe("reportFailure", () => {
    it("posts failure and returns updated job", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/job1/failure", method: "POST" })
        .reply(200, {
          id: "job1",
          type: "test",
          queue: "q",
          priority: 0,
          status: "scheduled",
          ready_at: 5000,
          attempts: 1,
        }, {
          headers: { "content-type": "application/json" },
        });

      const job = await ctx.client.reportFailure("job1", {
        message: "connection timeout",
        errorType: "TimeoutError",
      });

      assert.equal(job.status, "scheduled");
      assert.equal(job.attempts, 1);
      assert.equal(job.readyAt, 5000);
    });
  });

  describe("getJob", () => {
    it("fetches a job by ID", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/job1", method: "GET" })
        .reply(200, {
          id: "job1",
          type: "test",
          queue: "q",
          priority: 0,
          status: "ready",
          payload: { key: "value" },
          ready_at: 1000,
          attempts: 0,
        }, {
          headers: { "content-type": "application/json" },
        });

      const job = await ctx.client.getJob("job1");

      assert.equal(job.id, "job1");
      assert.deepEqual(job.payload, { key: "value" });
      assert.equal(job.readyAt, 1000);
    });
  });

  describe("health", () => {
    it("returns status ok", async () => {
      ctx.mockPool
        .intercept({ path: "/health", method: "GET" })
        .reply(200, { status: "ok" }, {
          headers: { "content-type": "application/json" },
        });

      const result = await ctx.client.health();
      assert.equal(result.status, "ok");
    });
  });

  describe("version", () => {
    it("returns the server version string", async () => {
      ctx.mockPool
        .intercept({ path: "/version", method: "GET" })
        .reply(200, { version: "0.1.0" }, {
          headers: { "content-type": "application/json" },
        });

      const result = await ctx.client.serverVersion();
      assert.equal(result, "0.1.0");
    });
  });

  describe("queues", () => {
    it("returns an array of queue names", async () => {
      ctx.mockPool
        .intercept({ path: "/queues", method: "GET" })
        .reply(200, { queues: ["emails", "payments"] }, {
          headers: { "content-type": "application/json" },
        });

      const result = await ctx.client.queues();
      assert.deepEqual(result, ["emails", "payments"]);
    });

    it("returns empty array when no queues exist", async () => {
      ctx.mockPool
        .intercept({ path: "/queues", method: "GET" })
        .reply(200, { queues: [] }, {
          headers: { "content-type": "application/json" },
        });

      const result = await ctx.client.queues();
      assert.deepEqual(result, []);
    });
  });

  describe("listJobs", () => {
    it("returns a page of jobs", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs?queue=emails&limit=2", method: "GET" })
        .reply(200, {
          jobs: [
            { id: "j1", type: "test", queue: "emails", priority: 0, status: "ready", ready_at: 1000, attempts: 0 },
            { id: "j2", type: "test", queue: "emails", priority: 0, status: "ready", ready_at: 2000, attempts: 0 },
          ],
          pages: {
            self: "/jobs?queue=emails&limit=2",
            next: "/jobs?queue=emails&limit=2&from=j2",
          },
        }, {
          headers: { "content-type": "application/json" },
        });

      const page = await ctx.client.listJobs({ queue: ["emails"], limit: 2 });

      assert.equal(page.jobs.length, 2);
      assert.equal(page.jobs[0].id, "j1");
      assert.equal(page.jobs[1].id, "j2");
      assert.ok(page.hasNext);
      assert.ok(!page.hasPrev);
    });

    it("follows nextPage link", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs?limit=1", method: "GET" })
        .reply(200, {
          jobs: [
            { id: "j1", type: "test", queue: "q", priority: 0, status: "ready", ready_at: 1000, attempts: 0 },
          ],
          pages: {
            self: "/jobs?limit=1",
            next: "/jobs?limit=1&from=j1",
          },
        }, {
          headers: { "content-type": "application/json" },
        });

      ctx.mockPool
        .intercept({ path: "/jobs?limit=1&from=j1", method: "GET" })
        .reply(200, {
          jobs: [
            { id: "j2", type: "test", queue: "q", priority: 0, status: "ready", ready_at: 2000, attempts: 0 },
          ],
          pages: {
            self: "/jobs?limit=1&from=j1",
          },
        }, {
          headers: { "content-type": "application/json" },
        });

      const page1 = await ctx.client.listJobs({ limit: 1 });
      assert.equal(page1.jobs[0].id, "j1");
      assert.ok(page1.hasNext);

      const page2 = await page1.nextPage();
      assert.ok(page2);
      assert.equal(page2!.jobs[0].id, "j2");
      assert.ok(!page2!.hasNext);
    });

    it("returns null for nextPage on last page", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs", method: "GET" })
        .reply(200, {
          jobs: [],
          pages: { self: "/jobs" },
        }, {
          headers: { "content-type": "application/json" },
        });

      const page = await ctx.client.listJobs();
      assert.equal(page.jobs.length, 0);
      assert.ok(!page.hasNext);

      const next = await page.nextPage();
      assert.equal(next, null);
    });

    it("jobs on page are Job instances", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs", method: "GET" })
        .reply(200, {
          jobs: [
            { id: "j1", type: "test", queue: "q", priority: 0, status: "ready", ready_at: 1000, attempts: 0 },
          ],
          pages: { self: "/jobs" },
        }, {
          headers: { "content-type": "application/json" },
        });

      const { Job } = await import("./resources.ts");
      const page = await ctx.client.listJobs();
      assert.ok(page.jobs[0] instanceof Job);
    });
  });

  describe("listErrors", () => {
    it("returns a page of error records", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/j1/errors", method: "GET" })
        .reply(200, {
          errors: [
            { attempt: 1, message: "timeout", error_type: "TimeoutError", dequeued_at: 1000, failed_at: 2000 },
            { attempt: 2, message: "refused", dequeued_at: 3000, failed_at: 4000 },
          ],
          pages: { self: "/jobs/j1/errors" },
        }, {
          headers: { "content-type": "application/json" },
        });

      const page = await ctx.client.listErrors("j1");

      assert.equal(page.errors.length, 2);
      assert.equal(page.errors[0].attempt, 1);
      assert.equal(page.errors[0].message, "timeout");
      assert.equal(page.errors[0].errorType, "TimeoutError");
      assert.equal(page.errors[0].dequeuedAt, 1000);
      assert.equal(page.errors[1].attempt, 2);
      assert.equal(page.errors[1].errorType, undefined);
    });

    it("follows nextPage link", async () => {
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
        }, {
          headers: { "content-type": "application/json" },
        });

      ctx.mockPool
        .intercept({ path: "/jobs/j1/errors?limit=1&from=1", method: "GET" })
        .reply(200, {
          errors: [
            { attempt: 2, message: "second", dequeued_at: 3000, failed_at: 4000 },
          ],
          pages: { self: "/jobs/j1/errors?limit=1&from=1" },
        }, {
          headers: { "content-type": "application/json" },
        });

      const page1 = await ctx.client.listErrors("j1", { limit: 1 });
      assert.equal(page1.errors[0].message, "first");
      assert.ok(page1.hasNext);

      const page2 = await page1.nextPage();
      assert.ok(page2);
      assert.equal(page2!.errors[0].message, "second");
      assert.ok(!page2!.hasNext);
    });

    it("is iterable", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/j1/errors", method: "GET" })
        .reply(200, {
          errors: [
            { attempt: 1, message: "a", dequeued_at: 1000, failed_at: 2000 },
            { attempt: 2, message: "b", dequeued_at: 3000, failed_at: 4000 },
          ],
          pages: { self: "/jobs/j1/errors" },
        }, {
          headers: { "content-type": "application/json" },
        });

      const page = await ctx.client.listErrors("j1");
      const messages = [...page].map(e => e.message);
      assert.deepEqual(messages, ["a", "b"]);
    });

    it("fetches a single error by attempt", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/j1/errors/2", method: "GET" })
        .reply(200, {
          attempt: 2,
          message: "connection refused",
          error_type: "ConnectionError",
          backtrace: "at line 42",
          dequeued_at: 3000,
          failed_at: 4000,
        }, {
          headers: { "content-type": "application/json" },
        });

      const error = await ctx.client.getError("j1", 2);

      assert.equal(error.attempt, 2);
      assert.equal(error.message, "connection refused");
      assert.equal(error.errorType, "ConnectionError");
      assert.equal(error.backtrace, "at line 42");
      assert.equal(error.dequeuedAt, 3000);
      assert.equal(error.failedAt, 4000);
    });

    it("passes order and from params", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/j1/errors?from=2&order=desc&limit=5", method: "GET" })
        .reply(200, {
          errors: [],
          pages: { self: "/jobs/j1/errors?from=2&order=desc&limit=5" },
        }, {
          headers: { "content-type": "application/json" },
        });

      const page = await ctx.client.listErrors("j1", { from: 2, order: "desc", limit: 5 });
      assert.equal(page.errors.length, 0);
    });
  });

  describe("msgpack format", () => {
    let msgCtx: MockContext;

    beforeEach(() => {
      msgCtx = createMockContext("msgpack");
    });

    afterEach(async () => {
      await msgCtx.mockAgent.close();
    });

    it("sends msgpack-encoded body and decodes msgpack response", async () => {
      const jobResponse = {
        id: "m1",
        type: "test",
        queue: "q",
        priority: 0,
        status: "ready",
        ready_at: 1000,
        attempts: 0,
      };

      msgCtx.mockPool
        .intercept({ path: "/jobs", method: "POST" })
        .reply(201, msgpackBody(jobResponse), {
          headers: { "content-type": "application/msgpack" },
        });

      const job = await msgCtx.client.enqueue({
        type: "test",
        queue: "q",
        payload: { x: 1 },
      });

      assert.equal(job.id, "m1");
      assert.equal(job.readyAt, 1000);
    });

    it("decodes JSON error response even when using msgpack", async () => {
      // Server may respond with JSON for errors regardless of Accept header.
      msgCtx.mockPool
        .intercept({ path: "/jobs", method: "POST" })
        .reply(400, { error: "bad request" }, {
          headers: { "content-type": "application/json" },
        });

      await assert.rejects(
        () => msgCtx.client.enqueue({ type: "t", queue: "q", payload: null }),
        (err: unknown) => {
          assert.ok(err instanceof ClientError);
          assert.equal(err.message, "bad request");
          return true;
        }
      );
    });

    it("streams jobs via msgpack-stream take endpoint", async () => {
      const job1 = {
        id: "s1",
        type: "test",
        queue: "q",
        priority: 0,
        status: "in_flight",
        payload: { n: 1 },
        ready_at: 1000,
        attempts: 0,
      };
      const job2 = {
        id: "s2",
        type: "test",
        queue: "q",
        priority: 0,
        status: "in_flight",
        payload: { n: 2 },
        ready_at: 1000,
        attempts: 0,
      };

      msgCtx.mockPool
        .intercept({
          path: (path: string) => path.startsWith("/jobs/take"),
          method: "GET",
        })
        .reply(200, msgpackStreamBody([job1, job2]), {
          headers: { "content-type": "application/vnd.zizq.msgpack-stream" },
        });

      const stream = await msgCtx.client.take({ prefetch: 2 });
      const jobs = [];
      for await (const job of stream) {
        jobs.push(job);
      }

      assert.equal(jobs.length, 2);
      assert.equal(jobs[0].id, "s1");
      assert.deepEqual(jobs[0].payload, { n: 1 });
      assert.equal(jobs[1].id, "s2");
      assert.deepEqual(jobs[1].payload, { n: 2 });
    });
  });
});
