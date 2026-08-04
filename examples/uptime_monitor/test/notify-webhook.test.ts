// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { create as createMonitored } from "../src/models/monitored-url.ts";
import { insertCheck } from "../src/models/check.ts";
import { notifyWebhook } from "../src/jobs/notify-webhook.ts";
import { freshEnv, type TestEnv } from "./setup.ts";

const WEBHOOK_URL = "https://hook.example.com/notify";

function seedCheck(env: TestEnv) {
  const monitored = createMonitored(env.db, {
    url: "https://site.example.com",
    lastStatus: "down",
    lastCheckedAt: new Date(Date.now() - 60_000),
    consecutiveFailures: 3,
  });
  const check = insertCheck(env.db, monitored.id, {
    status: "down",
    httpStatus: 500,
    responseTimeMs: 120,
    finalUrl: "https://site.example.com/",
    errorMessage: "HTTP 500",
    isSitemap: false,
    checkedAt: new Date(Date.now() - 60_000),
  });
  return { monitored, check };
}

describe("NotifyWebhookJob", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = freshEnv();
  });

  it("POSTs a JSON payload on success", async () => {
    const { monitored, check } = seedCheck(env);
    let capturedBody: string | undefined;
    // undici MockAgent's reply function receives the request options —
    // snapshot the body from there instead of the WebMock-style
    // `assert_requested` block form.
    env.mockAgent
      .get("https://hook.example.com")
      .intercept({ path: "/notify", method: "POST" })
      .reply((opts) => {
        capturedBody = String(opts.body);
        return { statusCode: 200, data: "" };
      });

    await notifyWebhook(
      { checkId: check.id },
      { db: env.db, dispatcher: env.mockAgent, webhookUrl: WEBHOOK_URL },
    );

    assert.ok(capturedBody, "webhook receiver should have been called");
    const body = JSON.parse(capturedBody!);
    assert.equal(body.check_id, check.id);
    assert.equal(body.monitored_url_id, monitored.id);
    assert.equal(body.url, monitored.url);
    assert.equal(body.status, "down");
    assert.equal(body.http_status, 500);
    assert.equal(body.response_time_ms, 120);
    assert.equal(body.consecutive_failures, 3);
    assert.equal(body.error_message, "HTTP 500");
  });

  it("no-ops cleanly when the webhook URL is empty", async () => {
    const { check } = seedCheck(env);
    // No mock: any HTTP call would fail against the disabled net.
    await notifyWebhook(
      { checkId: check.id },
      { db: env.db, dispatcher: env.mockAgent, webhookUrl: "" },
    );
  });

  it("no-ops when the webhook URL is whitespace", async () => {
    const { check } = seedCheck(env);
    await notifyWebhook(
      { checkId: check.id },
      { db: env.db, dispatcher: env.mockAgent, webhookUrl: "   " },
    );
  });

  it("4xx is treated as permanent — no throw", async () => {
    const { check } = seedCheck(env);
    env.mockAgent
      .get("https://hook.example.com")
      .intercept({ path: "/notify", method: "POST" })
      .reply(404, "");

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await notifyWebhook(
        { checkId: check.id },
        { db: env.db, dispatcher: env.mockAgent, webhookUrl: WEBHOOK_URL },
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it("5xx throws so Zizq retries", async () => {
    const { check } = seedCheck(env);
    env.mockAgent
      .get("https://hook.example.com")
      .intercept({ path: "/notify", method: "POST" })
      .reply(503, "");

    await assert.rejects(
      notifyWebhook(
        { checkId: check.id },
        { db: env.db, dispatcher: env.mockAgent, webhookUrl: WEBHOOK_URL },
      ),
      /HTTP 503/,
    );
  });

  it("network error throws so Zizq retries", async () => {
    const { check } = seedCheck(env);
    env.mockAgent
      .get("https://hook.example.com")
      .intercept({ path: "/notify", method: "POST" })
      .replyWithError(new Error("connect ECONNREFUSED"));

    await assert.rejects(
      notifyWebhook(
        { checkId: check.id },
        { db: env.db, dispatcher: env.mockAgent, webhookUrl: WEBHOOK_URL },
      ),
    );
  });
});
