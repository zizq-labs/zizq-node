// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Periodic sweep that enqueues a CheckUrlJob for every monitored URL
// whose last check is older than STALE_AFTER (or that has never been
// checked). Triggered by a 5-second cron entry registered in server.ts;
// the cron fires often but only stale URLs are re-checked.

import type { Client } from "@zizq-labs/zizq";
import type { DatabaseSync } from "node:sqlite";

import { CHECK_URL, ZIZQ_QUEUE } from "./queue.ts";
import { findStaleEnabledIds } from "../models/monitored-url.ts";

export const STALE_AFTER_MS = 60_000;
const BATCH_SIZE = 500;

export interface ScheduleChecksDeps {
  db: DatabaseSync;
  client: Client;
}

export async function scheduleChecks(
  _payload: unknown,
  deps: ScheduleChecksDeps,
): Promise<void> {
  const ids = findStaleEnabledIds(deps.db, STALE_AFTER_MS);

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    await deps.client.enqueueBulk(
      batch.map((id) => ({
        type: CHECK_URL,
        queue: ZIZQ_QUEUE,
        payload: { id },
      })),
    );
  }
}
