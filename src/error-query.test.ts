// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ErrorQuery } from "./error-query.ts";
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
