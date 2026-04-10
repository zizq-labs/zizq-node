// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { enqueue, enqueueBulk } from "./enqueue.ts";
import type { JobFunction } from "./handler.ts";
import { uniqueKey } from "./unique-key.ts";
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

    const job = await enqueue(ctx.client, {
      type: "send_email",
      queue: "emails",
      payload: { to: "a@b.com" },
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

    const job = await enqueue(ctx.client, {
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

    const job = await enqueue(ctx.client, { type: handler, payload: {} });
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

    const job = await enqueue(ctx.client, {
      type: handler,
      payload: {},
      priority: 1,
    });
    assert.equal(job.priority, 1);
  });

  it("throws if no queue specified", async () => {
    await assert.rejects(
      () => enqueue(ctx.client, { type: "test_job", payload: {} }),
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
      // A plain user function: receives (fn, payload) and returns a string.
      uniqueKey: (_fn, payload: any) => `user-${payload.userId}`,
      uniqueWhile: "active",
    };

    await enqueue(ctx.client, { type: handler, payload: { userId: 42 } });
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

    await enqueue(ctx.client, { type: handler, payload: { userId: 42, junk: "ignored" } });
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

    await enqueue(ctx.client, { type: handler, payload: { urgent: true } });
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

    await enqueue(ctx.client, { type: handler, payload: {} });
    assert.equal(captured.priority, 999);
  });
});

describe("enqueueBulk", () => {
  let ctx: MockContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  afterEach(async () => {
    await ctx.mockAgent.close();
  });

  it("enqueues multiple jobs in a single request", async () => {
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

    const jobs = await enqueueBulk(ctx.client, [
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

    const jobs = await enqueueBulk(ctx.client, [
      { type: sendEmail, payload: { to: "a@b.com" } },
      { type: "manual", queue: "ops", payload: {} },
    ]);

    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].id, "j1");
    assert.equal(jobs[1].id, "j2");
  });
});
