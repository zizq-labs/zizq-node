// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Probes one MonitoredUrl and records the result. Also fires a
// NotifyWebhookJob on status transitions, and a DiscoverSitemapUrlsJob
// when the result was flagged as a sitemap body.

import type { Client } from "@zizq-labs/zizq";
import type { DatabaseSync } from "node:sqlite";
import type { Dispatcher } from "undici";

import {
  ZIZQ_QUEUE,
  CHECK_URL,
  NOTIFY_WEBHOOK,
  DISCOVER_SITEMAP_URLS,
} from "./queue.ts";
import { get as getMonitored, recordCheck } from "../models/monitored-url.ts";
import { probe } from "../lib/url-prober.ts";
import { emit as emitAudit } from "../lib/audit.ts";

export interface CheckUrlPayload {
  id: number;
}

export interface CheckUrlDeps {
  db: DatabaseSync;
  client: Client;
  /** Undici dispatcher for the outbound probe. Injected in tests. */
  dispatcher?: Dispatcher;
}

export async function checkUrl(
  payload: CheckUrlPayload,
  deps: CheckUrlDeps,
): Promise<void> {
  const monitored = getMonitored(deps.db, payload.id);
  if (!monitored || !monitored.enabled) return;

  const previousStatus = monitored.lastStatus;
  const result = await probe(monitored.url, { dispatcher: deps.dispatcher });
  const check = recordCheck(deps.db, monitored, result);

  if (statusTransitioned(previousStatus, result.status)) {
    await emitAudit(deps.client, {
      eventType: "url.status.changed",
      actor: "system",
      resource: `monitored_url:${monitored.id}`,
      text: `${monitored.url} went ${result.status}`,
      data: {
        url: monitored.url,
        from: previousStatus,
        to: result.status,
      },
    });
    await deps.client.enqueue({
      type: NOTIFY_WEBHOOK,
      queue: ZIZQ_QUEUE,
      payload: { checkId: check.id },
    });
  }

  if (result.isSitemap) {
    await deps.client.enqueue({
      type: DISCOVER_SITEMAP_URLS,
      queue: ZIZQ_QUEUE,
      payload: { id: monitored.id },
    });
  }
}

/**
 * Transition semantics:
 *  - No previous status + "down" → notify (an outage should alarm
 *    immediately, not wait for a second sample).
 *  - No previous status + "up" → silent (first-ever success is not
 *    interesting).
 *  - Any change between recorded statuses → notify.
 */
function statusTransitioned(
  previous: string | null,
  current: string,
): boolean {
  if (previous === current) return false;
  if (previous) return true;
  return current === "down";
}

/** Type string used to enqueue and register a route. */
export const CHECK_URL_TYPE = CHECK_URL;
