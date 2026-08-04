// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockAgent } from "undici";
import { probe } from "../src/lib/url-prober.ts";

function mockedAgent(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return agent;
}

describe("UrlProber", () => {
  it("2xx is up", async () => {
    const agent = mockedAgent();
    agent
      .get("https://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(200, "");

    const result = await probe("https://example.com/", { dispatcher: agent });

    assert.equal(result.status, "up");
    assert.equal(result.httpStatus, 200);
    assert.equal(typeof result.responseTimeMs, "number");
  });

  it("non-2xx is down with status code captured", async () => {
    const agent = mockedAgent();
    agent
      .get("https://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(404, "");

    const result = await probe("https://example.com/", { dispatcher: agent });

    assert.equal(result.status, "down");
    assert.equal(result.httpStatus, 404);
    assert.equal(result.errorMessage, "HTTP 404");
  });

  it("network error is down with a friendly message", async () => {
    const agent = mockedAgent();
    agent
      .get("https://nonexistent.invalid")
      .intercept({ path: "/", method: "GET" })
      .replyWithError(Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }));

    const result = await probe("https://nonexistent.invalid/", { dispatcher: agent });

    assert.equal(result.status, "down");
    assert.match(result.errorMessage ?? "", /Connection failed:/);
  });

  // --- Sitemap detection --------------------------------------------

  it("XML urlset is flagged as a sitemap", async () => {
    const agent = mockedAgent();
    const body = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/page</loc></url>
      </urlset>`;
    agent
      .get("https://example.com")
      .intercept({ path: "/sitemap.xml", method: "GET" })
      .reply(200, body, { headers: { "content-type": "application/xml" } });

    const result = await probe("https://example.com/sitemap.xml", { dispatcher: agent });

    assert.equal(result.status, "up");
    assert.equal(result.isSitemap, true);
    assert.equal(result.errorMessage, null);
  });

  it("XML sitemapindex is flagged as a sitemap", async () => {
    const agent = mockedAgent();
    const body = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
      </sitemapindex>`;
    agent
      .get("https://example.com")
      .intercept({ path: "/sitemap.xml", method: "GET" })
      .reply(200, body, { headers: { "content-type": "text/xml" } });

    const result = await probe("https://example.com/sitemap.xml", { dispatcher: agent });

    assert.equal(result.isSitemap, true);
  });

  it("non-sitemap XML is not flagged", async () => {
    const agent = mockedAgent();
    agent
      .get("https://example.com")
      .intercept({ path: "/feed.xml", method: "GET" })
      .reply(
        200,
        `<?xml version="1.0"?><rss><channel></channel></rss>`,
        { headers: { "content-type": "application/rss+xml" } },
      );

    const result = await probe("https://example.com/feed.xml", { dispatcher: agent });

    assert.equal(result.isSitemap, false);
    assert.equal(result.errorMessage, null);
  });

  it("non-XML response is not inspected for sitemap content", async () => {
    const agent = mockedAgent();
    agent
      .get("https://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(200, "<html></html>", { headers: { "content-type": "text/html" } });

    const result = await probe("https://example.com/", { dispatcher: agent });

    assert.equal(result.isSitemap, false);
    assert.equal(result.errorMessage, null);
  });

  it("malformed XML with an XML content-type captures the parse error", async () => {
    const agent = mockedAgent();
    agent
      .get("https://example.com")
      .intercept({ path: "/sitemap.xml", method: "GET" })
      .reply(200, "<unclosed", {
        headers: { "content-type": "application/xml" },
      });

    const result = await probe("https://example.com/sitemap.xml", { dispatcher: agent });

    // HTTP succeeded → still "up"; parse problem surfaces on
    // errorMessage for the Check row's history.
    assert.equal(result.status, "up");
    assert.equal(result.isSitemap, false);
    assert.match(
      result.errorMessage ?? "",
      /Body advertised XML but failed to parse/,
    );
  });
});
