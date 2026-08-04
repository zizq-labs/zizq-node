// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { create as createMonitored, get as getMonitored } from "../src/models/monitored-url.ts";
import { buildHandler } from "../src/jobs/index.ts";
import {
  CHECK_URL,
  DISCOVER_SITEMAP_URLS,
  NOTIFY_WEBHOOK,
  ZIZQ_QUEUE,
} from "../src/jobs/queue.ts";
import { freshEnv, type TestEnv } from "./setup.ts";

/** Convenience: enqueue a CheckUrlJob for the given monitored URL id. */
function enqueueCheck(env: TestEnv, id: number): Promise<unknown> {
  return env.client.enqueue({
    type: CHECK_URL,
    queue: ZIZQ_QUEUE,
    payload: { id },
  });
}

describe("CheckUrlJob", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = freshEnv();
  });

  it("enqueueing buffers the job", async () => {
    const m = createMonitored(env.db, { url: "https://example.com" });

    await enqueueCheck(env, m.id);

    assert.equal(env.client.enqueued(CHECK_URL, { id: m.id }), true);
    assert.equal(env.client.enqueuedCount(CHECK_URL), 1);
  });

  it("dispatching probes and records a check", async () => {
    const m = createMonitored(env.db, { url: "https://example.com" });
    env.mockAgent
      .get("https://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(200, "");

    const handler = buildHandler({
      db: env.db,
      client: env.client,
      dispatcher: env.mockAgent,
    });

    await enqueueCheck(env, m.id);
    await env.client.dispatch(handler);

    const reloaded = getMonitored(env.db, m.id)!;
    assert.equal(reloaded.lastStatus, "up");
    const checks = env.db.prepare("SELECT * FROM checks").all() as Array<{
      http_status: number;
    }>;
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.http_status, 200);
  });

  it("skips disabled URLs", async () => {
    const m = createMonitored(env.db, {
      url: "https://example.com",
      enabled: false,
    });
    // No mock: if the prober ran, undici would raise on the unstubbed
    // request and fail the test.
    const handler = buildHandler({
      db: env.db,
      client: env.client,
      dispatcher: env.mockAgent,
    });

    await enqueueCheck(env, m.id);
    await env.client.dispatch(handler);

    const reloaded = getMonitored(env.db, m.id)!;
    assert.equal(reloaded.lastStatus, null);
  });

  it("enqueues DiscoverSitemapUrls when the result is a sitemap", async () => {
    const m = createMonitored(env.db, { url: "https://example.com/sitemap.xml" });
    const body = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
    env.mockAgent
      .get("https://example.com")
      .intercept({ path: "/sitemap.xml", method: "GET" })
      .reply(200, body, { headers: { "content-type": "application/xml" } });

    const handler = buildHandler({
      db: env.db,
      client: env.client,
      dispatcher: env.mockAgent,
    });

    // Only dispatch CHECK_URL so DISCOVER_SITEMAP_URLS stays buffered
    // for us to assert on.
    await enqueueCheck(env, m.id);
    await env.client.dispatch(handler, { onlyTypes: CHECK_URL });

    assert.equal(env.client.enqueued(DISCOVER_SITEMAP_URLS, { id: m.id }), true);
  });

  it("does not enqueue DiscoverSitemapUrls for non-sitemap responses", async () => {
    const m = createMonitored(env.db, { url: "https://example.com" });
    env.mockAgent
      .get("https://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(200, "");

    const handler = buildHandler({
      db: env.db,
      client: env.client,
      dispatcher: env.mockAgent,
    });

    await enqueueCheck(env, m.id);
    await env.client.dispatch(handler, { onlyTypes: CHECK_URL });

    assert.equal(env.client.enqueued(DISCOVER_SITEMAP_URLS), false);
  });

  // --- Status transitions -------------------------------------------

  it("enqueues NotifyWebhook on an up->down transition", async () => {
    const m = createMonitored(env.db, {
      url: "https://example.com",
      lastStatus: "up",
      lastCheckedAt: new Date(Date.now() - 60_000),
    });
    env.mockAgent
      .get("https://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(500, "");

    const handler = buildHandler({
      db: env.db,
      client: env.client,
      dispatcher: env.mockAgent,
    });

    await enqueueCheck(env, m.id);
    await env.client.dispatch(handler, { onlyTypes: CHECK_URL });

    assert.equal(env.client.enqueued(NOTIFY_WEBHOOK), true);
  });

  it("enqueues NotifyWebhook on a down->up transition", async () => {
    const m = createMonitored(env.db, {
      url: "https://example.com",
      lastStatus: "down",
      lastCheckedAt: new Date(Date.now() - 60_000),
      consecutiveFailures: 3,
    });
    env.mockAgent
      .get("https://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(200, "");

    const handler = buildHandler({
      db: env.db,
      client: env.client,
      dispatcher: env.mockAgent,
    });

    await enqueueCheck(env, m.id);
    await env.client.dispatch(handler, { onlyTypes: CHECK_URL });

    assert.equal(env.client.enqueued(NOTIFY_WEBHOOK), true);
  });

  it("enqueues NotifyWebhook when the first-ever check is down", async () => {
    const m = createMonitored(env.db, { url: "https://example.com" });
    env.mockAgent
      .get("https://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(500, "");

    const handler = buildHandler({
      db: env.db,
      client: env.client,
      dispatcher: env.mockAgent,
    });

    await enqueueCheck(env, m.id);
    await env.client.dispatch(handler, { onlyTypes: CHECK_URL });

    assert.equal(env.client.enqueued(NOTIFY_WEBHOOK), true);
  });

  it("does NOT enqueue NotifyWebhook when the first-ever check is up", async () => {
    const m = createMonitored(env.db, { url: "https://example.com" });
    env.mockAgent
      .get("https://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(200, "");

    const handler = buildHandler({
      db: env.db,
      client: env.client,
      dispatcher: env.mockAgent,
    });

    await enqueueCheck(env, m.id);
    await env.client.dispatch(handler, { onlyTypes: CHECK_URL });

    assert.equal(env.client.enqueued(NOTIFY_WEBHOOK), false);
  });

  it("does NOT enqueue NotifyWebhook when the status is unchanged", async () => {
    const m = createMonitored(env.db, {
      url: "https://example.com",
      lastStatus: "up",
      lastCheckedAt: new Date(Date.now() - 60_000),
    });
    env.mockAgent
      .get("https://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(200, "");

    const handler = buildHandler({
      db: env.db,
      client: env.client,
      dispatcher: env.mockAgent,
    });

    await enqueueCheck(env, m.id);
    await env.client.dispatch(handler, { onlyTypes: CHECK_URL });

    assert.equal(env.client.enqueued(NOTIFY_WEBHOOK), false);
  });

  it("emits an audit.create event on a status transition", async () => {
    const m = createMonitored(env.db, {
      url: "https://example.com",
      lastStatus: "up",
      lastCheckedAt: new Date(Date.now() - 60_000),
    });
    env.mockAgent
      .get("https://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(500, "");

    const handler = buildHandler({
      db: env.db,
      client: env.client,
      dispatcher: env.mockAgent,
    });

    await enqueueCheck(env, m.id);
    await env.client.dispatch(handler, { onlyTypes: CHECK_URL });

    const audits = env.client.enqueuedJobs({ onlyTypes: "audit.create" });
    assert.equal(audits.length, 1);
    const payload = audits[0]!.payload as Record<string, unknown>;
    assert.equal(payload.event_type, "url.status.changed");
    assert.deepEqual(payload.data, {
      url: "https://example.com",
      from: "up",
      to: "down",
    });
  });

  it("does NOT emit an audit.create event when the status is unchanged", async () => {
    const m = createMonitored(env.db, {
      url: "https://example.com",
      lastStatus: "up",
      lastCheckedAt: new Date(Date.now() - 60_000),
    });
    env.mockAgent
      .get("https://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(200, "");

    const handler = buildHandler({
      db: env.db,
      client: env.client,
      dispatcher: env.mockAgent,
    });

    await enqueueCheck(env, m.id);
    await env.client.dispatch(handler, { onlyTypes: CHECK_URL });

    assert.equal(env.client.enqueued("audit.create"), false);
  });

  it("failed probe increments consecutive_failures", async () => {
    const m = createMonitored(env.db, {
      url: "https://example.com",
      consecutiveFailures: 2,
    });
    env.mockAgent
      .get("https://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(500, "");

    const handler = buildHandler({
      db: env.db,
      client: env.client,
      dispatcher: env.mockAgent,
    });

    await enqueueCheck(env, m.id);
    await env.client.dispatch(handler, { onlyTypes: CHECK_URL });

    const reloaded = getMonitored(env.db, m.id)!;
    assert.equal(reloaded.lastStatus, "down");
    assert.equal(reloaded.consecutiveFailures, 3);
  });
});
