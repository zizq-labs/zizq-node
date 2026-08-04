// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.ts";
import { create as createMonitored } from "../src/models/monitored-url.ts";
import { CHECK_URL } from "../src/jobs/queue.ts";
import { freshEnv, type TestEnv } from "./setup.ts";

describe("routes", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = freshEnv();
  });

  it("GET / renders the form", async () => {
    const res = await request(createApp({ db: env.db, client: env.client })).get("/");
    assert.equal(res.status, 200);
    assert.match(res.text, /Uptime Monitor/);
    assert.match(res.text, /<form/);
    assert.match(res.text, /<div id="urls">/);
  });

  it("XHR returns just the urls partial", async () => {
    const res = await request(createApp({ db: env.db, client: env.client }))
      .get("/")
      .set("X-Requested-With", "XMLHttpRequest");
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /<html/);
    assert.match(res.text, /<div id="urls">/);
  });

  it("POST creates a MonitoredUrl and enqueues a check", async () => {
    const res = await request(createApp({ db: env.db, client: env.client }))
      .post("/monitored_urls")
      .type("form")
      .send({ url: "https://example.com" });

    assert.equal(res.status, 302);
    const created = env.db
      .prepare("SELECT * FROM monitored_urls LIMIT 1")
      .get() as { url: string; source: string; id: number };
    assert.equal(created.url, "https://example.com");
    assert.equal(created.source, "manual");
    assert.equal(env.client.enqueued(CHECK_URL, { id: created.id }), true);
  });

  it("POST strips whitespace", async () => {
    await request(createApp({ db: env.db, client: env.client }))
      .post("/monitored_urls")
      .type("form")
      .send({ url: "  https://example.com  " });

    const created = env.db
      .prepare("SELECT url FROM monitored_urls LIMIT 1")
      .get() as { url: string };
    assert.equal(created.url, "https://example.com");
  });

  it("POST prepends https:// when no scheme", async () => {
    await request(createApp({ db: env.db, client: env.client }))
      .post("/monitored_urls")
      .type("form")
      .send({ url: "example.com" });

    const created = env.db
      .prepare("SELECT url FROM monitored_urls LIMIT 1")
      .get() as { url: string };
    assert.equal(created.url, "https://example.com");
  });

  it("POST existing URL does not duplicate", async () => {
    createMonitored(env.db, { url: "https://example.com" });

    await request(createApp({ db: env.db, client: env.client }))
      .post("/monitored_urls")
      .type("form")
      .send({ url: "https://example.com" });

    const count = env.db
      .prepare("SELECT COUNT(*) as c FROM monitored_urls")
      .get() as { c: number };
    assert.equal(count.c, 1);
    assert.equal(env.client.enqueued(CHECK_URL), true);
  });

  it("POST invalid URL shows an alert and does not enqueue", async () => {
    const app = createApp({ db: env.db, client: env.client });
    const agent = request.agent(app);
    const post = await agent
      .post("/monitored_urls")
      .type("form")
      .send({ url: "ftp://example.com" });
    assert.equal(post.status, 302);

    const count = env.db
      .prepare("SELECT COUNT(*) as c FROM monitored_urls")
      .get() as { c: number };
    assert.equal(count.c, 0);
    assert.equal(env.client.enqueuedCount(CHECK_URL), 0);

    // Follow the redirect and inspect the flash alert.
    const follow = await agent.get("/");
    assert.match(follow.text, /must be an http/);
  });

  it("POST emits an audit.create event for a newly monitored URL", async () => {
    await request(createApp({ db: env.db, client: env.client }))
      .post("/monitored_urls")
      .type("form")
      .send({ url: "https://example.com" });

    const audits = env.client.enqueuedJobs({ onlyTypes: "audit.create" });
    assert.equal(audits.length, 1);
    const payload = audits[0]!.payload as Record<string, unknown>;
    assert.equal(payload.event_type, "url.added");
    assert.equal(payload.actor, "user");
    assert.deepEqual(payload.data, { url: "https://example.com" });
  });

  it("POST does NOT emit an audit.create event when re-checking an existing URL", async () => {
    createMonitored(env.db, { url: "https://example.com" });

    await request(createApp({ db: env.db, client: env.client }))
      .post("/monitored_urls")
      .type("form")
      .send({ url: "https://example.com" });

    assert.equal(env.client.enqueued("audit.create"), false);
  });

  it("index lists existing URLs with their status", async () => {
    createMonitored(env.db, {
      url: "https://up.example.com",
      lastStatus: "up",
      lastCheckedAt: new Date(Date.now() - 60_000),
    });
    createMonitored(env.db, {
      url: "https://down.example.com",
      lastStatus: "down",
      lastCheckedAt: new Date(Date.now() - 120_000),
    });
    createMonitored(env.db, { url: "https://pending.example.com" });

    const res = await request(createApp({ db: env.db, client: env.client })).get("/");
    assert.equal(res.status, 200);
    assert.match(res.text, /status-up[\s\S]*UP/);
    assert.match(res.text, /status-down[\s\S]*DOWN/);
    assert.match(res.text, /status-pending[\s\S]*PENDING/);
  });
});
