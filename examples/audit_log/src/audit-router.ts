// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// The audit app's dispatcher. Cross-language by design — payloads
// are plain JSON, types are strings the producer agrees on with the
// consumer. The audit sink itself only cares about the *envelope*,
// not the event_type inside it.

import type { DatabaseSync } from "node:sqlite";
import { Router } from "@zizq-labs/zizq";
import { fromPayload, save } from "./audit-event.ts";

/** The queue name every producer writes `audit.create` jobs to. */
export const ZIZQ_QUEUE = "audit";

/**
 * Build the router that dispatches `audit.create` jobs to a persistent
 * writer. Factory (rather than a module-level singleton) so tests can
 * bind against their own DB and the app can share one connection across
 * both web and worker without global state.
 */
export function createAuditRouter(db: DatabaseSync): Router {
  return new Router().route("audit.create", (payload) => {
    // Payload shape (all keys strings):
    //   {
    //     "occurred_at": "2026-05-27T10:15:00Z",  // ISO8601 or epoch int
    //     "source":      "uptime_monitor",
    //     "event_type":  "url.status.changed",
    //     "actor":       "system",
    //     "ip":          null,
    //     "resource":    "monitored_url:42",
    //     "text":        "https://example.com went down",
    //     "data":        { "from": "up", "to": "down", ... }
    //   }
    save(db, fromPayload(payload as Record<string, unknown>));
  });
}
