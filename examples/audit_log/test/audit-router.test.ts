// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UnknownJobTypeError, type Job } from "@zizq-labs/zizq";
import { createAuditRouter, ZIZQ_QUEUE } from "../src/audit-router.ts";
import { freshDb } from "./setup.ts";

// Stand-in for a real `Job`. The router only reads `type` and
// `payload`, so a partial cast is enough.
function job(type: string, payload: unknown): Job {
  return { type, queue: ZIZQ_QUEUE, id: "test-1", payload } as unknown as Job;
}

describe("audit-router", () => {
  it("audit.create inserts a row", async () => {
    const db = freshDb();
    try {
      const handler = createAuditRouter(db).build();

      await handler(job("audit.create", {
        occurred_at: "2026-05-27T10:15:30Z",
        source: "billing_api",
        event_type: "invoice.refunded",
        actor: "alice@example.com",
        ip: "203.0.113.7",
        resource: "invoice:42",
        text: "Refunded $24.00",
        data: { amount_cents: 2400 },
      }));

      const row = db.prepare("SELECT * FROM audit_events LIMIT 1").get() as {
        source: string;
        event_type: string;
        actor: string;
        data: string;
      } | undefined;
      assert.ok(row);
      assert.equal(row.source, "billing_api");
      assert.equal(row.event_type, "invoice.refunded");
      assert.equal(row.actor, "alice@example.com");
      assert.deepEqual(JSON.parse(row.data), { amount_cents: 2400 });
    } finally {
      db.close();
    }
  });

  it("unknown type raises UnknownJobTypeError", async () => {
    const db = freshDb();
    try {
      const handler = createAuditRouter(db).build();
      await assert.rejects(
        async () => handler(job("audit.unknown", {
          occurred_at: new Date().toISOString(),
          source: "x",
          event_type: "y",
        })),
        UnknownJobTypeError,
      );
    } finally {
      db.close();
    }
  });
});
