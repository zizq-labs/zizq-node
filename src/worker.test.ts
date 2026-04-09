// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "./worker.ts";
import type { JobFunction } from "./handler.ts";
import { createMockContext, ndjsonBody, type MockContext } from "./test-helpers.ts";

describe("Worker", () => {
  let ctx: MockContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  afterEach(async () => {
    await ctx.mockAgent.close();
  });

  it("throws if both jobs and handler are provided", () => {
    assert.throws(
      () =>
        new Worker({
          client: ctx.client,
          jobs: [],
          handler: async () => {},
        }),
      { message: "Provide either `jobs` or `handler`, not both." }
    );
  });

  it("throws if neither jobs nor handler are provided", () => {
    assert.throws(
      () => new Worker({ client: ctx.client }),
      { message: "Provide either `jobs` or `handler`." }
    );
  });

  it("dispatches to registered job functions", async () => {
    const processed: unknown[] = [];
    let worker: Worker;

    const testJob: JobFunction = async (payload) => {
      processed.push(payload);
      worker.stop();
    };
    testJob.zizqOptions = { queue: "q" };

    const job = {
      id: "j1",
      type: "testJob",
      queue: "q",
      priority: 0,
      status: "in_flight",
      payload: { msg: "hello" },
      ready_at: 1000,
      attempts: 0,
    };

    ctx.mockPool
      .intercept({
        path: (path: string) => path.startsWith("/jobs/take"),
        method: "GET",
      })
      .reply(200, ndjsonBody([job]), {
        headers: { "content-type": "application/x-ndjson" },
      });

    ctx.mockPool
      .intercept({ path: "/jobs/success", method: "POST" })
      .reply(204, "");

    worker = new Worker({
      client: ctx.client,
      jobs: [testJob],
      logger: { info() {}, error() {} },
    });

    await worker.run();

    assert.equal(processed.length, 1);
    assert.deepEqual(processed[0], { msg: "hello" });
  });

  it("dispatches to a raw handler", async () => {
    const processed: string[] = [];
    let worker: Worker;

    const job = {
      id: "j2",
      type: "custom_type",
      queue: "q",
      priority: 0,
      status: "in_flight",
      payload: null,
      ready_at: 1000,
      attempts: 0,
    };

    ctx.mockPool
      .intercept({
        path: (path: string) => path.startsWith("/jobs/take"),
        method: "GET",
      })
      .reply(200, ndjsonBody([job]), {
        headers: { "content-type": "application/x-ndjson" },
      });

    ctx.mockPool
      .intercept({ path: "/jobs/success", method: "POST" })
      .reply(204, "");

    worker = new Worker({
      client: ctx.client,
      queues: ["q"],
      handler: async (job) => {
        processed.push(job.type);
        worker.stop();
      },
      logger: { info() {}, error() {} },
    });

    await worker.run();

    assert.equal(processed.length, 1);
    assert.equal(processed[0], "custom_type");
  });

  it("reports failure when a handler throws", async () => {
    let worker: Worker;

    const failingJob: JobFunction = async () => {
      worker.stop();
      throw new Error("boom");
    };
    failingJob.zizqOptions = { queue: "q" };

    const job = {
      id: "j3",
      type: "failingJob",
      queue: "q",
      priority: 0,
      status: "in_flight",
      payload: null,
      ready_at: 1000,
      attempts: 0,
    };

    ctx.mockPool
      .intercept({
        path: (path: string) => path.startsWith("/jobs/take"),
        method: "GET",
      })
      .reply(200, ndjsonBody([job]), {
        headers: { "content-type": "application/x-ndjson" },
      });

    ctx.mockPool
      .intercept({ path: "/jobs/j3/failure", method: "POST" })
      .reply(200, { ...job, status: "scheduled", attempts: 1 }, {
        headers: { "content-type": "application/json" },
      });

    worker = new Worker({
      client: ctx.client,
      jobs: [failingJob],
      logger: { info() {}, error() {} },
    });

    await worker.run();
  });
});
