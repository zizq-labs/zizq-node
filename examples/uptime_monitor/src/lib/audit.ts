// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Emit `audit.create` events into the central audit_log app's queue.
//
// This is a cross-language producer: we don't share code with the
// audit consumer (see `../../../audit_log/`) — just a `type` string
// and a JSON payload the consumer knows how to store. Runs against
// any language's Zizq client the same way.

import type { Client } from "@zizq-labs/zizq";

export const AUDIT_QUEUE = process.env.AUDIT_QUEUE ?? "audit";
export const AUDIT_SOURCE = process.env.AUDIT_SOURCE ?? "uptime_monitor";

export interface AuditEvent {
  /** Dot-namespaced event name, e.g. "url.status.changed". */
  eventType: string;
  /** Who did it — "system", a user id/email, etc. */
  actor: string;
  /** Free-text human summary. */
  text: string;
  /** Optional resource identifier, e.g. "monitored_url:42". */
  resource?: string;
  /** Optional structured payload for the event. */
  data?: unknown;
  /** Optional source IP. */
  ip?: string;
  /** Occurred-at timestamp. Defaults to now. */
  occurredAt?: Date;
}

/**
 * Enqueue an `audit.create` job for the audit_log consumer. Wraps
 * `client.enqueue` with the correct `type`, queue, and payload shape
 * — every caller in this app funnels through here so the wire format
 * stays consistent.
 */
export async function emit(
  client: Client,
  event: AuditEvent,
): Promise<void> {
  await client.enqueue({
    type: "audit.create",
    queue: AUDIT_QUEUE,
    payload: {
      occurred_at: (event.occurredAt ?? new Date()).toISOString(),
      source: AUDIT_SOURCE,
      event_type: event.eventType,
      actor: event.actor,
      ip: event.ip ?? null,
      resource: event.resource ?? null,
      text: event.text,
      data: event.data ?? null,
    },
  });
}
