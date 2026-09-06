// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createMockContext, type MockContext } from "./test-helpers.ts";
import type { JobFunction } from "./handler.ts";
import { batchConfig } from "./batch-config.ts";

describe("CronHandle", () => {
  let ctx: MockContext;

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

  beforeEach(() => {
    ctx = createMockContext();
  });

  afterEach(async () => {
    await ctx.mockAgent.close();
  });

  it("client.cron() returns a handle without making an API call", () => {
    // No mocks — if an API call is made, undici will error.
    const handle = ctx.client.cron("default");
    assert.equal(handle.name, "default");
  });

  it("get() fetches the group", async () => {
    ctx.mockPool
      .intercept({ path: "/crons/default", method: "GET" })
      .reply(200, cronGroupResponse, {
        headers: { "content-type": "application/json" },
      });

    const group = await ctx.client.cron("default").get();
    assert.equal(group.name, "default");
    assert.equal(group.entries.length, 1);
  });

  it("register() sends PUT with resolved entries", async () => {
    ctx.mockPool
      .intercept({
        path: "/crons/default",
        method: "PUT",
        body: (body: string) => {
          const parsed = JSON.parse(body);
          return (
            parsed.entries.length === 1 &&
            parsed.entries[0].name === "e1" &&
            parsed.entries[0].expression === "0 9 * * *" &&
            parsed.entries[0].job.type === "test" &&
            parsed.entries[0].job.queue === "q"
          );
        },
      })
      .reply(200, cronGroupResponse, {
        headers: { "content-type": "application/json" },
      });

    const group = await ctx.client.cron("default").register({
      entries: [{
        name: "e1",
        expression: "0 9 * * *",
        type: "test",
        queue: "q",
        payload: {},
      }],
    });
    assert.equal(group.name, "default");
  });

  // The high-level form assembles its job template separately from
  // `enqueue()`, so every enqueue field it offers needs its own
  // coverage — a field declared on the definition but not passed
  // through `resolveEntryDefinition` is dropped in silence.
  it("register() carries batch config, resolving a function key", async () => {
    let sent: Record<string, unknown> | undefined;

    ctx.mockPool
      .intercept({
        path: "/crons/default",
        method: "PUT",
        body: (body: string) => {
          sent = JSON.parse(body).entries[0].job.batch;
          return true;
        },
      })
      .reply(200, cronGroupResponse, {
        headers: { "content-type": "application/json" },
      });

    await ctx.client.cron("default").register({
      entries: [{
        name: "e1",
        expression: "0 9 * * *",
        type: "digest",
        queue: "q",
        payload: { items: [1] },
        batch: batchConfig(1000, ".items"),
      }],
    });

    assert.ok(sent, "batch was dropped from the job template");
    // The key is a function on the way in and a string on the wire.
    assert.equal(typeof sent.key, "string");
    assert.match(sent.when as string, /length <= 1000/);
    assert.match(sent.fold as string, /\.items/);
  });

  it("register() carries budgets", async () => {
    let sent: unknown;

    ctx.mockPool
      .intercept({
        path: "/crons/default",
        method: "PUT",
        body: (body: string) => {
          sent = JSON.parse(body).entries[0].job.budgets;
          return true;
        },
      })
      .reply(200, cronGroupResponse, {
        headers: { "content-type": "application/json" },
      });

    await ctx.client.cron("default").register({
      entries: [{
        name: "e1",
        expression: "0 9 * * *",
        type: "digest",
        queue: "q",
        payload: {},
        budgets: [{ key: "emails", cost: 5 }],
      }],
    });

    assert.deepEqual(sent, [{ key: "emails", cost: 5 }]);
  });

  it("register() resolves function references", async () => {
    const syncFn: JobFunction = async () => {};
    syncFn.zizqOptions = { type: "sync_analytics", queue: "analytics" };

    ctx.mockPool
      .intercept({
        path: "/crons/default",
        method: "PUT",
        body: (body: string) => {
          const parsed = JSON.parse(body);
          return (
            parsed.entries[0].job.type === "sync_analytics" &&
            parsed.entries[0].job.queue === "analytics"
          );
        },
      })
      .reply(200, cronGroupResponse, {
        headers: { "content-type": "application/json" },
      });

    await ctx.client.cron("default").register({
      entries: [{
        name: "sync",
        expression: "* * * * *",
        type: syncFn,
        payload: { incremental: true },
      }],
    });
  });

  // Sent as the group's timezone rather than copied onto each entry, so a
  // schedule read back still reports which timezone it runs in.
  it("register() sends the group timezone on the group", async () => {
    ctx.mockPool
      .intercept({
        path: "/crons/default",
        method: "PUT",
        body: (body: string) => {
          const parsed = JSON.parse(body);
          return (
            parsed.timezone === "Australia/Melbourne" &&
            parsed.entries[0].timezone === undefined
          );
        },
      })
      .reply(200, { ...cronGroupResponse, timezone: "Australia/Melbourne" }, {
        headers: { "content-type": "application/json" },
      });

    const group = await ctx.client.cron("default").register({
      timezone: "Australia/Melbourne",
      entries: [{
        name: "e1",
        expression: "* * * * *",
        type: "test",
        queue: "q",
        payload: {},
      }],
    });

    assert.equal(group.timezone, "Australia/Melbourne");
  });

  it("register() allows entry-level timezone to override group", async () => {
    ctx.mockPool
      .intercept({
        path: "/crons/default",
        method: "PUT",
        body: (body: string) => {
          const parsed = JSON.parse(body);
          return (
            parsed.timezone === "Australia/Melbourne" &&
            parsed.entries[0].timezone === "Europe/London"
          );
        },
      })
      .reply(200, cronGroupResponse, {
        headers: { "content-type": "application/json" },
      });

    await ctx.client.cron("default").register({
      timezone: "Australia/Melbourne",
      entries: [{
        name: "e1",
        expression: "* * * * *",
        timezone: "Europe/London",
        type: "test",
        queue: "q",
        payload: {},
      }],
    });
  });

  it("register() omits the timezone when none is given", async () => {
    ctx.mockPool
      .intercept({
        path: "/crons/default",
        method: "PUT",
        body: (body: string) => !("timezone" in JSON.parse(body)),
      })
      .reply(200, cronGroupResponse, {
        headers: { "content-type": "application/json" },
      });

    const group = await ctx.client.cron("default").register({
      entries: [{
        name: "e1",
        expression: "* * * * *",
        type: "test",
        queue: "q",
        payload: {},
      }],
    });

    assert.equal(group.timezone, undefined);
  });

  it("get() reads the group timezone", async () => {
    ctx.mockPool
      .intercept({ path: "/crons/default", method: "GET" })
      .reply(200, { ...cronGroupResponse, timezone: "Australia/Melbourne" }, {
        headers: { "content-type": "application/json" },
      });

    const group = await ctx.client.cron("default").get();
    assert.equal(group.timezone, "Australia/Melbourne");
    // The entry inherits it rather than carrying a copy.
    assert.equal(group.entries[0].timezone, undefined);
  });

  it("register() passes paused flag", async () => {
    ctx.mockPool
      .intercept({
        path: "/crons/default",
        method: "PUT",
        body: (body: string) => {
          const parsed = JSON.parse(body);
          return parsed.paused === true;
        },
      })
      .reply(200, { ...cronGroupResponse, paused: true }, {
        headers: { "content-type": "application/json" },
      });

    const group = await ctx.client.cron("default").register({
      paused: true,
      entries: [{
        name: "e1",
        expression: "* * * * *",
        type: "test",
        queue: "q",
        payload: {},
      }],
    });
    assert.equal(group.paused, true);
  });

  it("pause() sends PATCH", async () => {
    ctx.mockPool
      .intercept({ path: "/crons/default", method: "PATCH" })
      .reply(200, { ...cronGroupResponse, paused: true }, {
        headers: { "content-type": "application/json" },
      });

    const group = await ctx.client.cron("default").pause();
    assert.equal(group.paused, true);
  });

  it("resume() sends PATCH", async () => {
    ctx.mockPool
      .intercept({ path: "/crons/default", method: "PATCH" })
      .reply(200, cronGroupResponse, {
        headers: { "content-type": "application/json" },
      });

    const group = await ctx.client.cron("default").resume();
    assert.equal(group.paused, false);
  });

  it("delete() sends DELETE", async () => {
    ctx.mockPool
      .intercept({ path: "/crons/default", method: "DELETE" })
      .reply(204);

    await ctx.client.cron("default").delete();
  });

  it("entry().get() fetches a single entry", async () => {
    ctx.mockPool
      .intercept({ path: "/crons/default/entries/e1", method: "GET" })
      .reply(200, cronEntryResponse, {
        headers: { "content-type": "application/json" },
      });

    const entry = await ctx.client.cron("default").entry("e1").get();
    assert.equal(entry.name, "e1");
    assert.equal(entry.expression, "* * * * *");
  });

  it("entry().pause() sends PATCH", async () => {
    ctx.mockPool
      .intercept({ path: "/crons/default/entries/e1", method: "PATCH" })
      .reply(200, { ...cronEntryResponse, paused: true }, {
        headers: { "content-type": "application/json" },
      });

    const entry = await ctx.client.cron("default").entry("e1").pause();
    assert.equal(entry.paused, true);
  });

  it("entry().resume() sends PATCH", async () => {
    ctx.mockPool
      .intercept({ path: "/crons/default/entries/e1", method: "PATCH" })
      .reply(200, cronEntryResponse, {
        headers: { "content-type": "application/json" },
      });

    const entry = await ctx.client.cron("default").entry("e1").resume();
    assert.equal(entry.paused, false);
  });

  it("entry().delete() sends DELETE", async () => {
    ctx.mockPool
      .intercept({ path: "/crons/default/entries/e1", method: "DELETE" })
      .reply(204);

    await ctx.client.cron("default").entry("e1").delete();
  });

  it("entry().register() sends PUT with resolved function ref", async () => {
    const syncFn: JobFunction = async () => {};
    syncFn.zizqOptions = { type: "sync_job", queue: "sync-q" };

    ctx.mockPool
      .intercept({
        path: "/crons/default/entries/sync",
        method: "PUT",
        body: (body: string) => {
          const parsed = JSON.parse(body);
          return (
            parsed.name === "sync" &&
            parsed.job.type === "sync_job" &&
            parsed.job.queue === "sync-q"
          );
        },
      })
      .reply(200, { ...cronEntryResponse, name: "sync" }, {
        headers: { "content-type": "application/json" },
      });

    const entry = await ctx.client.cron("default").entry("sync").register({
      expression: "0 9 * * *",
      type: syncFn,
      payload: { incremental: true },
    });
    assert.equal(entry.name, "sync");
  });

  it("register() rejects readyAt set by transform", async () => {
    const delayedFn: JobFunction = async () => {};
    delayedFn.zizqOptions = {
      type: "delayed",
      queue: "q",
      transform: (opts) => ({ ...opts, readyAt: Date.now() + 60000 }),
    };

    await assert.rejects(
      () => ctx.client.cron("default").register({
        entries: [{
          name: "bad",
          expression: "* * * * *",
          type: delayedFn,
          payload: {},
        }],
      }),
      { message: /readyAt/i },
    );
  });
});
