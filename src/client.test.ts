// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ZizqError, ClientError, ResponseError, Client, Job } from "./client.ts";
import type { JobFunction } from "./handler.ts";
import { uniqueKey } from "./unique-key.ts";
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

  const jobResponse = {
    id: "j1",
    type: "send_email",
    queue: "emails",
    priority: 32768,
    status: "ready",
    ready_at: 1000,
    attempts: 0,
  };

  describe("enqueue", () => {
    it("enqueues by string type", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs", method: "POST" })
        .reply(201, jobResponse, {
          headers: { "content-type": "application/json" },
        });

      const job = await ctx.client.enqueue({
        type: "send_email",
        queue: "emails",
        payload: { to: "user@test.com" },
      });

      assert.equal(job.id, "j1");
      assert.equal(job.type, "send_email");
      assert.equal(job.queue, "emails");
      assert.equal(job.status, "ready");
      assert.equal(job.readyAt, 1000);
    });

    it("enqueues by function reference", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs", method: "POST" })
        .reply(201, jobResponse, {
          headers: { "content-type": "application/json" },
        });

      const sendEmail: JobFunction = async (payload) => {};
      sendEmail.zizqOptions = { queue: "emails" };

      const job = await ctx.client.enqueue({
        type: sendEmail,
        payload: { to: "a@b.com" },
      });
      assert.equal(job.id, "j1");
    });

    it("uses zizqOptions.type over fn.name", async () => {
      const response = { ...jobResponse, type: "custom_type" };
      ctx.mockPool
        .intercept({ path: "/jobs", method: "POST" })
        .reply(201, response, {
          headers: { "content-type": "application/json" },
        });

      const handler: JobFunction = async () => {};
      handler.zizqOptions = { type: "custom_type", queue: "q" };

      const job = await ctx.client.enqueue({ type: handler, payload: {} });
      assert.equal(job.type, "custom_type");
    });

    it("inline fields override zizqOptions", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs", method: "POST" })
        .reply(201, { ...jobResponse, priority: 1 }, {
          headers: { "content-type": "application/json" },
        });

      const handler: JobFunction = async () => {};
      handler.zizqOptions = { queue: "emails", priority: 500 };

      const job = await ctx.client.enqueue({
        type: handler,
        payload: {},
        priority: 1,
      });
      assert.equal(job.priority, 1);
    });

    it("throws if no queue specified", async () => {
      await assert.rejects(
        () => ctx.client.enqueue({ type: "test_job", payload: {} }),
        { message: 'No queue specified for job type "test_job"' }
      );
    });

    it("resolves uniqueKey from a user function (no type prefix)", async () => {
      let captured: any;
      ctx.mockPool
        .intercept({
          path: "/jobs",
          method: "POST",
          body: (body: string) => {
            captured = JSON.parse(body);
            return true;
          },
        })
        .reply(201, jobResponse, {
          headers: { "content-type": "application/json" },
        });

      const handler: JobFunction = async () => {};
      handler.zizqOptions = {
        type: "sendEmail",
        queue: "q",
        uniqueKey: (_fn, payload: any) => `user-${payload.userId}`,
        uniqueWhile: "active",
      };

      await ctx.client.enqueue({ type: handler, payload: { userId: 42 } });
      assert.equal(captured.unique_key, "user-42");
    });

    it("resolves uniqueKey helper with type prefix", async () => {
      let captured: any;
      ctx.mockPool
        .intercept({
          path: "/jobs",
          method: "POST",
          body: (body: string) => {
            captured = JSON.parse(body);
            return true;
          },
        })
        .reply(201, jobResponse, {
          headers: { "content-type": "application/json" },
        });

      const handler: JobFunction = async () => {};
      handler.zizqOptions = {
        type: "sendEmail",
        queue: "q",
        uniqueKey: uniqueKey("userId"),
      };

      await ctx.client.enqueue({ type: handler, payload: { userId: 42, junk: "ignored" } });
      const [prefix, digest] = captured.unique_key.split(":");
      assert.equal(prefix, "sendEmail");
      assert.match(digest, /^[a-f0-9]{64}$/);
    });

    it("applies a transform to mutate the resolved request", async () => {
      let captured: any;
      ctx.mockPool
        .intercept({
          path: "/jobs",
          method: "POST",
          body: (body: string) => {
            captured = JSON.parse(body);
            return true;
          },
        })
        .reply(201, jobResponse, {
          headers: { "content-type": "application/json" },
        });

      const handler: JobFunction = async () => {};
      handler.zizqOptions = {
        queue: "q",
        priority: 100,
        transform: (opts, payload) => {
          if ((payload as any).urgent) {
            opts.priority = Math.floor(opts.priority! / 2);
          }
        },
      };

      await ctx.client.enqueue({ type: handler, payload: { urgent: true } });
      assert.equal(captured.priority, 50);
    });

    it("supports transform returning a new request", async () => {
      let captured: any;
      ctx.mockPool
        .intercept({
          path: "/jobs",
          method: "POST",
          body: (body: string) => {
            captured = JSON.parse(body);
            return true;
          },
        })
        .reply(201, jobResponse, {
          headers: { "content-type": "application/json" },
        });

      const handler: JobFunction = async () => {};
      handler.zizqOptions = {
        queue: "q",
        priority: 100,
        transform: (opts) => ({ ...opts, priority: 999 }),
      };

      await ctx.client.enqueue({ type: handler, payload: {} });
      assert.equal(captured.priority, 999);
    });
  });

  describe("enqueueBulk", () => {
    it("enqueues multiple jobs with function references", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/bulk", method: "POST" })
        .reply(201, {
          jobs: [
            { id: "j1", type: "send_email", queue: "emails", priority: 32768, status: "ready", ready_at: 1000, attempts: 0 },
            { id: "j2", type: "send_email", queue: "emails", priority: 32768, status: "ready", ready_at: 1000, attempts: 0 },
          ],
        }, {
          headers: { "content-type": "application/json" },
        });

      const sendEmail: JobFunction = async () => {};
      sendEmail.zizqOptions = { queue: "emails" };

      const jobs = await ctx.client.enqueueBulk([
        { type: sendEmail, payload: { to: "a@b.com" } },
        { type: sendEmail, payload: { to: "c@d.com" } },
      ]);

      assert.equal(jobs.length, 2);
      assert.equal(jobs[0].id, "j1");
      assert.equal(jobs[1].id, "j2");
    });

    it("mixes function references and string types", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/bulk", method: "POST" })
        .reply(201, {
          jobs: [
            { id: "j1", type: "sendEmail", queue: "emails", priority: 32768, status: "ready", ready_at: 1000, attempts: 0 },
            { id: "j2", type: "manual", queue: "ops", priority: 32768, status: "ready", ready_at: 1000, attempts: 0 },
          ],
        }, {
          headers: { "content-type": "application/json" },
        });

      const sendEmail: JobFunction = async () => {};
      sendEmail.zizqOptions = { queue: "emails" };

      const jobs = await ctx.client.enqueueBulk([
        { type: sendEmail, payload: { to: "a@b.com" } },
        { type: "manual", queue: "ops", payload: {} },
      ]);

      assert.equal(jobs.length, 2);
      assert.equal(jobs[0].id, "j1");
      assert.equal(jobs[1].id, "j2");
    });
  });

  describe("enqueueRaw", () => {
    it("throws ClientError on 400", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs", method: "POST" })
        .reply(400, { error: "queue must not be empty" }, {
          headers: { "content-type": "application/json" },
        });

      await assert.rejects(
        () =>
          ctx.client.enqueueRaw({
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

  describe("deleteJob", () => {
    it("deletes a job and returns void", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/j1", method: "DELETE" })
        .reply(204, "");

      await ctx.client.deleteJob("j1");
    });

    it("throws NotFoundError for missing job", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/j1", method: "DELETE" })
        .reply(404, { error: "job not found" }, {
          headers: { "content-type": "application/json" },
        });

      const { NotFoundError } = await import("./client.ts");
      await assert.rejects(
        () => ctx.client.deleteJob("j1"),
        (err: unknown) => {
          assert.ok(err instanceof NotFoundError);
          return true;
        }
      );
    });
  });

  describe("deleteAllJobs", () => {
    it("deletes jobs matching filters and returns count", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs?queue=emails&status=dead", method: "DELETE" })
        .reply(200, { deleted: 5 }, {
          headers: { "content-type": "application/json" },
        });

      const count = await ctx.client.deleteAllJobs({
        where: { queue: "emails", status: "dead" },
      });
      assert.equal(count, 5);
    });

    it("deletes all jobs when no filters given", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs", method: "DELETE" })
        .reply(200, { deleted: 100 }, {
          headers: { "content-type": "application/json" },
        });

      const count = await ctx.client.deleteAllJobs();
      assert.equal(count, 100);
    });

    it("short-circuits on empty array filter without making a request", async () => {
      // No mock — if a request was made, undici would error.
      const count = await ctx.client.deleteAllJobs({ where: { id: [] } });
      assert.equal(count, 0);
    });

    it("accepts scalar filter values", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs?id=j1", method: "DELETE" })
        .reply(200, { deleted: 1 }, {
          headers: { "content-type": "application/json" },
        });

      const count = await ctx.client.deleteAllJobs({ where: { id: "j1" } });
      assert.equal(count, 1);
    });

    it("throws on unknown top-level option (catches missing where wrapper)", async () => {
      // No mock — if a request was made, this test would fail differently.
      await assert.rejects(
        // @ts-expect-error — intentionally passing wrong shape
        () => ctx.client.deleteAllJobs({ status: "dead" }),
        /unknown option "status"/,
      );
    });
  });

  describe("updateJob", () => {
    it("patches a job and returns the updated job", async () => {
      ctx.mockPool
        .intercept({
          path: "/jobs/j1",
          method: "PATCH",
        })
        .reply(200, {
          id: "j1",
          type: "test",
          queue: "emails",
          priority: 100,
          status: "ready",
          ready_at: 1000,
          attempts: 0,
        }, {
          headers: { "content-type": "application/json" },
        });

      const job = await ctx.client.updateJob("j1", { priority: 100 });
      assert.equal(job.priority, 100);
    });

    it("preserves null values to clear fields", async () => {
      let capturedBody: string | undefined;
      ctx.mockPool
        .intercept({
          path: "/jobs/j1",
          method: "PATCH",
          body: (body) => {
            capturedBody = body;
            return true;
          },
        })
        .reply(200, {
          id: "j1",
          type: "test",
          queue: "q",
          priority: 0,
          status: "ready",
          ready_at: 1000,
          attempts: 0,
        }, {
          headers: { "content-type": "application/json" },
        });

      await ctx.client.updateJob("j1", { retryLimit: null });
      assert.ok(capturedBody);
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.retry_limit, null);
      assert.ok(!("queue" in parsed)); // omitted
    });

    it("strips undefined values", async () => {
      let capturedBody: string | undefined;
      ctx.mockPool
        .intercept({
          path: "/jobs/j1",
          method: "PATCH",
          body: (body) => {
            capturedBody = body;
            return true;
          },
        })
        .reply(200, {
          id: "j1",
          type: "test",
          queue: "q",
          priority: 0,
          status: "ready",
          ready_at: 1000,
          attempts: 0,
        }, {
          headers: { "content-type": "application/json" },
        });

      await ctx.client.updateJob("j1", { priority: 100, queue: undefined });
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.priority, 100);
      assert.ok(!("queue" in parsed));
    });
  });

  describe("updateAllJobs", () => {
    it("patches matching jobs and returns count", async () => {
      ctx.mockPool
        .intercept({
          path: "/jobs?queue=emails",
          method: "PATCH",
        })
        .reply(200, { patched: 5 }, {
          headers: { "content-type": "application/json" },
        });

      const count = await ctx.client.updateAllJobs({
        where: { queue: "emails" },
        apply: { priority: 1000 },
      });
      assert.equal(count, 5);
    });

    it("short-circuits on empty array filter", async () => {
      const count = await ctx.client.updateAllJobs({
        where: { id: [] },
        apply: { priority: 1 },
      });
      assert.equal(count, 0);
    });
  });

  describe("countJobs", () => {
    it("returns the count from the server", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/count?queue=emails", method: "GET" })
        .reply(200, { count: 42 }, {
          headers: { "content-type": "application/json" },
        });

      const count = await ctx.client.countJobs({ queue: "emails" });
      assert.equal(count, 42);
    });

    it("counts all jobs when no filters given", async () => {
      ctx.mockPool
        .intercept({ path: "/jobs/count", method: "GET" })
        .reply(200, { count: 100 }, {
          headers: { "content-type": "application/json" },
        });

      const count = await ctx.client.countJobs();
      assert.equal(count, 100);
    });

    it("short-circuits on empty array filter", async () => {
      // No mock — if a request was made, undici would error.
      const count = await ctx.client.countJobs({ queue: [] });
      assert.equal(count, 0);
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

    it("short-circuits on empty array filter", async () => {
      // No mock — if a request was made, undici would error.
      const page = await ctx.client.listJobs({ queue: [] });
      assert.deepEqual(page.jobs, []);
      assert.equal(page.hasNext, false);
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

  describe("cron scheduling", () => {
    const cronGroupResponse = {
      name: "default",
      paused: false,
      entries: [{
        name: "e1",
        expression: "* * * * *",
        paused: false,
        job: { type: "test", queue: "q", payload: {} },
        next_enqueue_at: 1700000060000,
      }],
    };

    const cronEntryResponse = cronGroupResponse.entries[0];

    it("listCronGroups returns group names", async () => {
      ctx.mockPool
        .intercept({ path: "/crons", method: "GET" })
        .reply(200, { crons: ["default", "billing"] }, {
          headers: { "content-type": "application/json" },
        });

      const groups = await ctx.client.listCronGroups();
      assert.deepEqual(groups, ["default", "billing"]);
    });

    it("getCronGroup returns a CronGroup instance", async () => {
      ctx.mockPool
        .intercept({ path: "/crons/default", method: "GET" })
        .reply(200, cronGroupResponse, {
          headers: { "content-type": "application/json" },
        });

      const group = await ctx.client.getCronGroup("default");
      assert.equal(group.name, "default");
      assert.equal(group.paused, false);
      assert.equal(group.entries.length, 1);
      assert.equal(group.entries[0].name, "e1");
      assert.equal(group.entries[0].expression, "* * * * *");
      assert.equal(group.entries[0].job.type, "test");
      assert.equal(group.entries[0].nextEnqueueAt, 1700000060000);
    });

    it("replaceCronGroup sends PUT and returns CronGroup", async () => {
      ctx.mockPool
        .intercept({ path: "/crons/default", method: "PUT" })
        .reply(200, cronGroupResponse, {
          headers: { "content-type": "application/json" },
        });

      const group = await ctx.client.replaceCronGroup("default", {
        entries: [{
          name: "e1",
          expression: "* * * * *",
          job: { type: "test", queue: "q", payload: {} },
        }],
      });
      assert.equal(group.name, "default");
      assert.equal(group.entries.length, 1);
    });

    it("updateCronGroup pauses a group", async () => {
      const paused = { ...cronGroupResponse, paused: true, paused_at: 1700000000000 };
      ctx.mockPool
        .intercept({ path: "/crons/default", method: "PATCH" })
        .reply(200, paused, {
          headers: { "content-type": "application/json" },
        });

      const group = await ctx.client.updateCronGroup("default", { paused: true });
      assert.equal(group.paused, true);
      assert.equal(group.pausedAt, 1700000000000);
    });

    it("deleteCronGroup sends DELETE", async () => {
      ctx.mockPool
        .intercept({ path: "/crons/default", method: "DELETE" })
        .reply(204);

      await ctx.client.deleteCronGroup("default");
    });

    it("getCronEntry returns a CronEntry instance", async () => {
      ctx.mockPool
        .intercept({ path: "/crons/default/entries/e1", method: "GET" })
        .reply(200, cronEntryResponse, {
          headers: { "content-type": "application/json" },
        });

      const entry = await ctx.client.getCronEntry("default", "e1");
      assert.equal(entry.name, "e1");
      assert.equal(entry.expression, "* * * * *");
      assert.equal(entry.job.type, "test");
    });

    it("addCronEntry sends POST and returns CronEntry", async () => {
      ctx.mockPool
        .intercept({ path: "/crons/default/entries", method: "POST" })
        .reply(201, cronEntryResponse, {
          headers: { "content-type": "application/json" },
        });

      const entry = await ctx.client.addCronEntry("default", {
        name: "e1",
        expression: "* * * * *",
        job: { type: "test", queue: "q", payload: {} },
      });
      assert.equal(entry.name, "e1");
    });

    it("replaceCronEntry sends PUT and returns CronEntry", async () => {
      ctx.mockPool
        .intercept({ path: "/crons/default/entries/e1", method: "PUT" })
        .reply(200, cronEntryResponse, {
          headers: { "content-type": "application/json" },
        });

      const entry = await ctx.client.replaceCronEntry("default", "e1", {
        expression: "* * * * *",
        job: { type: "test", queue: "q", payload: {} },
      });
      assert.equal(entry.name, "e1");
    });

    it("updateCronEntry pauses an entry", async () => {
      const paused = { ...cronEntryResponse, paused: true, paused_at: 1700000000000 };
      ctx.mockPool
        .intercept({ path: "/crons/default/entries/e1", method: "PATCH" })
        .reply(200, paused, {
          headers: { "content-type": "application/json" },
        });

      const entry = await ctx.client.updateCronEntry("default", "e1", { paused: true });
      assert.equal(entry.paused, true);
      assert.equal(entry.pausedAt, 1700000000000);
    });

    it("deleteCronEntry sends DELETE", async () => {
      ctx.mockPool
        .intercept({ path: "/crons/default/entries/e1", method: "DELETE" })
        .reply(204);

      await ctx.client.deleteCronEntry("default", "e1");
    });

    it("CronGroup.pause() delegates to updateCronGroup", async () => {
      ctx.mockPool
        .intercept({ path: "/crons/default", method: "GET" })
        .reply(200, cronGroupResponse, {
          headers: { "content-type": "application/json" },
        });

      const paused = { ...cronGroupResponse, paused: true };
      ctx.mockPool
        .intercept({ path: "/crons/default", method: "PATCH" })
        .reply(200, paused, {
          headers: { "content-type": "application/json" },
        });

      const group = await ctx.client.getCronGroup("default");
      const updated = await group.pause();
      assert.equal(updated.paused, true);
    });

    it("CronEntry.delete() delegates to deleteCronEntry", async () => {
      ctx.mockPool
        .intercept({ path: "/crons/default", method: "GET" })
        .reply(200, cronGroupResponse, {
          headers: { "content-type": "application/json" },
        });

      ctx.mockPool
        .intercept({ path: "/crons/default/entries/e1", method: "DELETE" })
        .reply(204);

      const group = await ctx.client.getCronGroup("default");
      await group.entries[0].delete();
    });
  });
});
