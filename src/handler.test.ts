// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHandler, type JobFunction } from "./handler.ts";
import type { Job } from "./resources.ts";

describe("buildHandler", () => {
  it("dispatches a job to the matching function by zizqOptions.type", async () => {
    const calls: Array<{ type: string; payload: unknown }> = [];

    const sendEmail: JobFunction = async (payload) => {
      calls.push({ type: "send_email", payload });
    };
    sendEmail.zizqOptions = { type: "send_email", queue: "emails" };

    const handler = buildHandler([sendEmail]);
    const fakeJob = { type: "send_email", payload: { to: "a@b.com" } } as unknown as Job;

    await handler(fakeJob);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { type: "send_email", payload: { to: "a@b.com" } });
  });

  it("dispatches by function name when zizqOptions.type is absent", async () => {
    let called = false;

    async function sendEmail() {
      called = true;
    }
    (sendEmail as JobFunction).zizqOptions = { queue: "emails" };

    const handler = buildHandler([sendEmail as JobFunction]);
    const fakeJob = { type: "sendEmail", payload: null } as unknown as Job;

    await handler(fakeJob);

    assert.ok(called);
  });

  it("passes both payload and job to the function", async () => {
    let captured: { payload: unknown; job: Job } | undefined;

    const fn: JobFunction = async (payload, job) => {
      captured = { payload, job };
    };
    fn.zizqOptions = { type: "test" };

    const handler = buildHandler([fn]);
    const fakeJob = { type: "test", id: "j1", payload: { x: 1 } } as unknown as Job;

    await handler(fakeJob);

    assert.deepEqual(captured!.payload, { x: 1 });
    assert.equal(captured!.job, fakeJob);
  });

  it("throws when no function matches the job type", async () => {
    const fn: JobFunction = async () => {};
    fn.zizqOptions = { type: "send_email" };

    const handler = buildHandler([fn]);
    const fakeJob = { type: "unknown_type" } as unknown as Job;

    await assert.rejects(
      () => handler(fakeJob),
      /No handler registered for job type: unknown_type/
    );
  });

  it("throws on duplicate job types", () => {
    const a: JobFunction = async () => {};
    a.zizqOptions = { type: "shared" };
    const b: JobFunction = async () => {};
    b.zizqOptions = { type: "shared" };

    assert.throws(
      () => buildHandler([a, b]),
      /Duplicate job type registered: "shared"/
    );
  });

  it("throws if a function has no name or zizqOptions.type", () => {
    // An array literal function has no inferred name.
    const fns: JobFunction[] = [(async () => {}) as JobFunction];
    assert.throws(
      () => buildHandler(fns),
      /Job function must have a name or zizqOptions\.type/
    );
  });
});
