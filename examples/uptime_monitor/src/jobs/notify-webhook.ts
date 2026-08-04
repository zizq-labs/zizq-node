// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Posts a status-transition event to a configurable webhook URL.
//
// Retry semantics live at the Zizq level: raising re-runs with
// backoff, returning succeeds. So:
//   * 5xx / network error → raise, so Zizq retries with backoff.
//   * 4xx → log + return; a permanently-broken receiver shouldn't
//     keep us spinning.
//   * No WEBHOOK_URL set → no-op.

import { fetch, Agent, type Dispatcher } from "undici";
import type { DatabaseSync } from "node:sqlite";
import { get as getCheck } from "../models/check.ts";
import { get as getMonitored } from "../models/monitored-url.ts";

const OPEN_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_MS = 10_000;

const defaultAgent = new Agent({
  connectTimeout: OPEN_TIMEOUT_MS,
  headersTimeout: READ_TIMEOUT_MS,
  bodyTimeout: READ_TIMEOUT_MS,
});

export interface NotifyWebhookPayload {
  checkId: number;
}

export interface NotifyWebhookDeps {
  db: DatabaseSync;
  /** Undici dispatcher for the outbound POST. Injected in tests. */
  dispatcher?: Dispatcher;
  /** Where to POST. Reads from WEBHOOK_URL env by default. */
  webhookUrl?: string;
}

export async function notifyWebhook(
  payload: NotifyWebhookPayload,
  deps: NotifyWebhookDeps,
): Promise<void> {
  const check = getCheck(deps.db, payload.checkId);
  if (!check) return;

  const url = (deps.webhookUrl ?? process.env.WEBHOOK_URL ?? "").trim();
  if (url.length === 0) return;

  const monitored = getMonitored(deps.db, check.monitoredUrlId);
  if (!monitored) return;

  const body = JSON.stringify({
    check_id: check.id,
    monitored_url_id: monitored.id,
    url: monitored.url,
    status: check.status,
    http_status: check.httpStatus,
    response_time_ms: check.responseTimeMs,
    final_url: check.finalUrl,
    error_message: check.errorMessage,
    consecutive_failures: monitored.consecutiveFailures,
    checked_at: check.checkedAt.toISOString(),
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    dispatcher: deps.dispatcher ?? defaultAgent,
  });

  const status = res.status;
  if (status >= 200 && status < 300) {
    await res.text(); // drain
    return;
  }
  if (status >= 400 && status < 500) {
    console.warn(`[notify-webhook] receiver returned HTTP ${status}; giving up`);
    await res.text();
    return;
  }
  await res.text();
  throw new Error(`Webhook receiver returned HTTP ${status}`);
}
