// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Aggregates the four job handlers behind a single `Router.build()`
// output that both the embedded worker (from server.ts) and the
// standalone worker (from worker.ts) can consume.

import { Router, type Client, type JobHandler } from "@zizq-labs/zizq";
import type { Dispatcher } from "undici";
import type { DatabaseSync } from "node:sqlite";

import {
  CHECK_URL,
  DISCOVER_SITEMAP_URLS,
  NOTIFY_WEBHOOK,
  SCHEDULE_CHECKS,
} from "./queue.ts";
import { checkUrl, type CheckUrlPayload } from "./check-url.ts";
import {
  discoverSitemapUrls,
  type DiscoverSitemapUrlsPayload,
} from "./discover-sitemap-urls.ts";
import { notifyWebhook, type NotifyWebhookPayload } from "./notify-webhook.ts";
import { scheduleChecks } from "./schedule-checks.ts";

/**
 * Shared dependencies injected into every handler. `dispatcher` is
 * only surfaced in tests, where the same MockAgent stands in for both
 * outbound HTTP probes and webhook POSTs.
 */
export interface HandlerDeps {
  db: DatabaseSync;
  client: Client;
  dispatcher?: Dispatcher;
  webhookUrl?: string;
}

export function buildRouter(deps: HandlerDeps): Router {
  return new Router()
    .route(CHECK_URL, (payload) =>
      checkUrl(payload as CheckUrlPayload, deps),
    )
    .route(DISCOVER_SITEMAP_URLS, (payload) =>
      discoverSitemapUrls(payload as DiscoverSitemapUrlsPayload, deps),
    )
    .route(NOTIFY_WEBHOOK, (payload) =>
      notifyWebhook(payload as NotifyWebhookPayload, deps),
    )
    .route(SCHEDULE_CHECKS, (payload) => scheduleChecks(payload, deps));
}

/** Convenience: builds the router and returns the compiled handler. */
export function buildHandler(deps: HandlerDeps): JobHandler {
  return buildRouter(deps).build();
}
