// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ZizqError, ClientError, ResponseError } from "./client.ts";
import { createMockContext, type MockContext } from "./test-helpers.ts";

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
      const jobResponse = {
        id: "abc123",
        type: "send_email",
        queue: "emails",
        priority: 32768,
        status: "ready",
        ready_at: 1000,
        attempts: 0,
      };

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

      assert.equal(job.id, "abc123");
      assert.equal(job.type, "send_email");
      assert.equal(job.queue, "emails");
      assert.equal(job.status, "ready");
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
      const updatedJob = {
        id: "job1",
        type: "test",
        queue: "q",
        priority: 0,
        status: "scheduled",
        ready_at: 5000,
        attempts: 1,
      };

      ctx.mockPool
        .intercept({ path: "/jobs/job1/failure", method: "POST" })
        .reply(200, updatedJob, {
          headers: { "content-type": "application/json" },
        });

      const job = await ctx.client.reportFailure("job1", {
        message: "connection timeout",
        error_type: "TimeoutError",
      });

      assert.equal(job.status, "scheduled");
      assert.equal(job.attempts, 1);
    });
  });

  describe("getJob", () => {
    it("fetches a job by ID", async () => {
      const jobData = {
        id: "job1",
        type: "test",
        queue: "q",
        priority: 0,
        status: "ready",
        payload: { key: "value" },
        ready_at: 1000,
        attempts: 0,
      };

      ctx.mockPool
        .intercept({ path: "/jobs/job1", method: "GET" })
        .reply(200, jobData, {
          headers: { "content-type": "application/json" },
        });

      const job = await ctx.client.getJob("job1");

      assert.equal(job.id, "job1");
      assert.deepEqual(job.payload, { key: "value" });
    });
  });
});
