// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Smoke tests for the deprecated top-level enqueue/enqueueBulk functions.
// Full coverage of input resolution (function references, uniqueKey,
// transforms, etc.) lives in client.test.ts under the Client.enqueue and
// Client.enqueueBulk sections.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { enqueue, enqueueBulk } from "./enqueue.ts";
import type { JobFunction } from "./handler.ts";
import { createMockContext, type MockContext } from "./test-helpers.ts";

const jobResponse = {
  id: "j1",
  type: "send_email",
  queue: "emails",
  priority: 32768,
  status: "ready",
  ready_at: 1000,
  attempts: 0,
};

describe("enqueue (deprecated)", () => {
  let ctx: MockContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  afterEach(async () => {
    await ctx.mockAgent.close();
  });

  it("delegates to client.enqueue", async () => {
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
  });
});

describe("enqueueBulk (deprecated)", () => {
  let ctx: MockContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  afterEach(async () => {
    await ctx.mockAgent.close();
  });

  it("delegates to client.enqueueBulk", async () => {
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
  });
});
