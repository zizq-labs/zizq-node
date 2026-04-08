// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { enqueue } from "./enqueue.ts";
import type { JobFunction } from "./handler.ts";
import { createMockContext, type MockContext } from "./test-helpers.ts";

describe("enqueue", () => {
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

  it("enqueues by string type", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs", method: "POST" })
      .reply(201, jobResponse, {
        headers: { "content-type": "application/json" },
      });

    const job = await enqueue(ctx.client, "send_email", { to: "a@b.com" }, {
      queue: "emails",
    });

    assert.equal(job.id, "j1");
    assert.equal(job.type, "send_email");
  });

  it("enqueues by function reference", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs", method: "POST" })
      .reply(201, jobResponse, {
        headers: { "content-type": "application/json" },
      });

    const sendEmail: JobFunction = async (payload) => {};
    sendEmail.zizqOptions = { queue: "emails" };

    const job = await enqueue(ctx.client, sendEmail, { to: "a@b.com" });
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

    const job = await enqueue(ctx.client, handler, {});
    assert.equal(job.type, "custom_type");
  });

  it("overrides zizqOptions with inline options", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs", method: "POST" })
      .reply(201, { ...jobResponse, priority: 1 }, {
        headers: { "content-type": "application/json" },
      });

    const handler: JobFunction = async () => {};
    handler.zizqOptions = { queue: "emails", priority: 500 };

    const job = await enqueue(ctx.client, handler, {}, { priority: 1 });
    assert.equal(job.priority, 1);
  });

  it("throws if no queue specified", async () => {
    await assert.rejects(
      () => enqueue(ctx.client, "test_job", {}),
      { message: 'No queue specified for job type "test_job"' }
    );
  });

  it("resolves uniqueKey from function", async () => {
    ctx.mockPool
      .intercept({ path: "/jobs", method: "POST" })
      .reply(201, jobResponse, {
        headers: { "content-type": "application/json" },
      });

    const handler: JobFunction = async () => {};
    handler.zizqOptions = {
      queue: "q",
      uniqueKey: (payload: any) => `user-${payload.userId}`,
      uniqueWhile: "active",
    };

    await enqueue(ctx.client, handler, { userId: 42 });
  });
});
