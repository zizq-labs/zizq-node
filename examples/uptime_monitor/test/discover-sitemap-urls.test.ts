// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { create as createMonitored, findByUrlScoped } from "../src/models/monitored-url.ts";
import { discoverSitemapUrls } from "../src/jobs/discover-sitemap-urls.ts";
import { CHECK_URL } from "../src/jobs/queue.ts";
import { freshEnv, type TestEnv } from "./setup.ts";

const SITEMAP_URL = "https://example.com/sitemap.xml";

function sitemapBody(...urls: string[]): string {
  const entries = urls.map((u) => `<url><loc>${u}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      ${entries}
    </urlset>`;
}

function stubSitemap(env: TestEnv, ...urls: string[]): void {
  env.mockAgent
    .get("https://example.com")
    .intercept({ path: "/sitemap.xml", method: "GET" })
    .reply(200, sitemapBody(...urls), {
      headers: { "content-type": "application/xml" },
    });
}

describe("DiscoverSitemapUrlsJob", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = freshEnv();
  });

  it("discovers and creates child URLs as sitemap-sourced", async () => {
    const sitemap = createMonitored(env.db, { url: SITEMAP_URL });
    stubSitemap(env, "https://example.com/a", "https://example.com/b");

    await discoverSitemapUrls(
      { id: sitemap.id },
      { db: env.db, client: env.client, dispatcher: env.mockAgent },
    );

    const children = env.db
      .prepare("SELECT * FROM monitored_urls WHERE source_sitemap_url = ?")
      .all(sitemap.url) as Array<{ url: string; source: string; enabled: number }>;
    assert.equal(children.length, 2);
    const urls = children.map((c) => c.url).sort();
    assert.deepEqual(urls, ["https://example.com/a", "https://example.com/b"]);
    assert.ok(children.every((c) => c.enabled === 1));
    assert.ok(children.every((c) => c.source === "sitemap"));
  });

  it("re-enables previously disabled children back in the sitemap", async () => {
    const sitemap = createMonitored(env.db, { url: SITEMAP_URL });
    const child = createMonitored(env.db, {
      url: "https://example.com/a",
      source: "sitemap",
      sourceSitemapUrl: sitemap.url,
      enabled: false,
    });
    stubSitemap(env, "https://example.com/a");

    await discoverSitemapUrls(
      { id: sitemap.id },
      { db: env.db, client: env.client, dispatcher: env.mockAgent },
    );

    const reloaded = env.db
      .prepare("SELECT enabled FROM monitored_urls WHERE id = ?")
      .get(child.id) as { enabled: number };
    assert.equal(reloaded.enabled, 1);
  });

  it("disables children no longer present in the sitemap", async () => {
    const sitemap = createMonitored(env.db, { url: SITEMAP_URL });
    const toRemove = createMonitored(env.db, {
      url: "https://example.com/old",
      source: "sitemap",
      sourceSitemapUrl: sitemap.url,
    });
    stubSitemap(env, "https://example.com/new");

    await discoverSitemapUrls(
      { id: sitemap.id },
      { db: env.db, client: env.client, dispatcher: env.mockAgent },
    );

    const reloaded = env.db
      .prepare("SELECT enabled FROM monitored_urls WHERE id = ?")
      .get(toRemove.id) as { enabled: number };
    assert.equal(reloaded.enabled, 0);
  });

  it("manual and sitemap-sourced rows for the same URL can coexist", async () => {
    createMonitored(env.db, { url: "https://example.com/page" });
    const sitemap = createMonitored(env.db, { url: SITEMAP_URL });
    stubSitemap(env, "https://example.com/page");

    await discoverSitemapUrls(
      { id: sitemap.id },
      { db: env.db, client: env.client, dispatcher: env.mockAgent },
    );

    assert.ok(findByUrlScoped(env.db, "https://example.com/page", null));
    assert.ok(findByUrlScoped(env.db, "https://example.com/page", sitemap.url));
  });

  it("malformed sitemap leaves existing children untouched", async () => {
    const sitemap = createMonitored(env.db, { url: SITEMAP_URL });
    const child = createMonitored(env.db, {
      url: "https://example.com/keep",
      source: "sitemap",
      sourceSitemapUrl: sitemap.url,
      enabled: true,
    });
    env.mockAgent
      .get("https://example.com")
      .intercept({ path: "/sitemap.xml", method: "GET" })
      .reply(200, "<unclosed", {
        headers: { "content-type": "application/xml" },
      });

    // Silence the warn() output during the test.
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await discoverSitemapUrls(
        { id: sitemap.id },
        { db: env.db, client: env.client, dispatcher: env.mockAgent },
      );
    } finally {
      console.warn = originalWarn;
    }

    const reloaded = env.db
      .prepare("SELECT enabled FROM monitored_urls WHERE id = ?")
      .get(child.id) as { enabled: number };
    assert.equal(reloaded.enabled, 1);
  });

  it("enqueues an immediate check for each discovered child", async () => {
    const sitemap = createMonitored(env.db, { url: SITEMAP_URL });
    stubSitemap(env, "https://example.com/a", "https://example.com/b");

    await discoverSitemapUrls(
      { id: sitemap.id },
      { db: env.db, client: env.client, dispatcher: env.mockAgent },
    );

    assert.equal(env.client.enqueuedCount(CHECK_URL), 2);
  });

  it("disabled children are not enqueued for immediate check", async () => {
    const sitemap = createMonitored(env.db, { url: SITEMAP_URL });
    createMonitored(env.db, {
      url: "https://example.com/gone",
      source: "sitemap",
      sourceSitemapUrl: sitemap.url,
    });
    stubSitemap(env, "https://example.com/still-here");

    await discoverSitemapUrls(
      { id: sitemap.id },
      { db: env.db, client: env.client, dispatcher: env.mockAgent },
    );

    assert.equal(env.client.enqueuedCount(CHECK_URL), 1);
  });

  it("emits an audit.create event after discovering URLs", async () => {
    const sitemap = createMonitored(env.db, { url: SITEMAP_URL });
    stubSitemap(env, "https://example.com/a", "https://example.com/b");

    await discoverSitemapUrls(
      { id: sitemap.id },
      { db: env.db, client: env.client, dispatcher: env.mockAgent },
    );

    const audits = env.client.enqueuedJobs({ onlyTypes: "audit.create" });
    assert.equal(audits.length, 1);
    const payload = audits[0]!.payload as Record<string, unknown>;
    assert.equal(payload.event_type, "sitemap.scanned");
    assert.deepEqual(payload.data, {
      sitemap_url: SITEMAP_URL,
      discovered_count: 2,
    });
  });

  it("a sitemapindex discovers zero URLs and disables prior children", async () => {
    const sitemap = createMonitored(env.db, { url: SITEMAP_URL });
    const old = createMonitored(env.db, {
      url: "https://example.com/old",
      source: "sitemap",
      sourceSitemapUrl: sitemap.url,
    });
    env.mockAgent
      .get("https://example.com")
      .intercept({ path: "/sitemap.xml", method: "GET" })
      .reply(
        200,
        `<?xml version="1.0"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>https://example.com/inner.xml</loc></sitemap>
        </sitemapindex>`,
        { headers: { "content-type": "application/xml" } },
      );

    await discoverSitemapUrls(
      { id: sitemap.id },
      { db: env.db, client: env.client, dispatcher: env.mockAgent },
    );

    const reloaded = env.db
      .prepare("SELECT enabled FROM monitored_urls WHERE id = ?")
      .get(old.id) as { enabled: number };
    assert.equal(reloaded.enabled, 0);
    assert.equal(env.client.enqueuedCount(CHECK_URL), 0);
  });
});
