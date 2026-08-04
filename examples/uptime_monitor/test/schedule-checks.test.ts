// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { create as createMonitored } from "../src/models/monitored-url.ts";
import {
  scheduleChecks,
  STALE_AFTER_MS,
} from "../src/jobs/schedule-checks.ts";
import { CHECK_URL } from "../src/jobs/queue.ts";
import { freshEnv, type TestEnv } from "./setup.ts";

describe("ScheduleChecksJob", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = freshEnv();
  });

  it("schedules a check for never-checked URLs", async () => {
    const m = createMonitored(env.db, { url: "https://example.com" });

    await scheduleChecks(null, { db: env.db, client: env.client });

    assert.equal(env.client.enqueued(CHECK_URL, { id: m.id }), true);
  });

  it("schedules a check for stale URLs", async () => {
    const stale = createMonitored(env.db, {
      url: "https://stale.example.com",
      lastCheckedAt: new Date(Date.now() - STALE_AFTER_MS - 1000),
    });

    await scheduleChecks(null, { db: env.db, client: env.client });

    assert.equal(env.client.enqueued(CHECK_URL, { id: stale.id }), true);
  });

  it("skips URLs checked within the stale threshold", async () => {
    const fresh = createMonitored(env.db, {
      url: "https://fresh.example.com",
      lastCheckedAt: new Date(Date.now() - 10_000),
    });

    await scheduleChecks(null, { db: env.db, client: env.client });

    assert.equal(env.client.enqueued(CHECK_URL, { id: fresh.id }), false);
  });

  it("skips disabled URLs", async () => {
    const disabled = createMonitored(env.db, {
      url: "https://disabled.example.com",
      enabled: false,
      lastCheckedAt: new Date(Date.now() - 3_600_000),
    });

    await scheduleChecks(null, { db: env.db, client: env.client });

    assert.equal(env.client.enqueued(CHECK_URL, { id: disabled.id }), false);
  });

  it("enqueues one check per stale URL in a single sweep", async () => {
    for (let i = 0; i < 3; i++) {
      createMonitored(env.db, { url: `https://stale-${i}.example.com` });
    }

    await scheduleChecks(null, { db: env.db, client: env.client });

    assert.equal(env.client.enqueuedCount(CHECK_URL), 3);
  });
});
