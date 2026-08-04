// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fromPayload, validate, save, getEvent } from "../src/audit-event.ts";
import { freshDb } from "./setup.ts";

describe("audit-event", () => {
  describe("validate", () => {
    it("flags all three required fields when empty", () => {
      const errors = validate({});
      assert.ok(errors);
      assert.deepEqual(errors.occurredAt, ["is required"]);
      assert.deepEqual(errors.source, ["is required"]);
      assert.deepEqual(errors.eventType, ["is required"]);
    });

    it("returns null when required fields are present", () => {
      const errors = validate({
        occurredAt: new Date(),
        source: "billing_api",
        eventType: "invoice.refunded",
      });
      assert.equal(errors, null);
    });
  });

  describe("fromPayload", () => {
    it("parses an ISO8601 occurred_at", () => {
      const evt = fromPayload({
        occurred_at: "2026-05-27T10:15:30Z",
        source: "billing_api",
        event_type: "invoice.refunded",
      });
      assert.equal(evt.occurredAt.toISOString(), "2026-05-27T10:15:30.000Z");
    });

    it("parses an epoch-seconds occurred_at", () => {
      const evt = fromPayload({
        occurred_at: 1_700_000_000,
        source: "billing_api",
        event_type: "invoice.refunded",
      });
      assert.equal(evt.occurredAt.getTime(), 1_700_000_000_000);
    });

    it("passes a Date occurred_at through unchanged", () => {
      const now = new Date();
      const evt = fromPayload({
        occurred_at: now,
        source: "billing_api",
        event_type: "invoice.refunded",
      });
      assert.equal(evt.occurredAt.getTime(), now.getTime());
    });

    it("copies optional fields", () => {
      const evt = fromPayload({
        occurred_at: "2026-05-27T10:15:30Z",
        source: "billing_api",
        event_type: "invoice.refunded",
        actor: "alice@example.com",
        ip: "203.0.113.7",
        resource: "invoice:42",
        text: "Refunded $24.00",
        data: { amount_cents: 2400 },
      });
      assert.equal(evt.actor, "alice@example.com");
      assert.equal(evt.ip, "203.0.113.7");
      assert.equal(evt.resource, "invoice:42");
      assert.equal(evt.text, "Refunded $24.00");
      assert.deepEqual(evt.data, { amount_cents: 2400 });
    });

    it("throws on unsupported occurred_at type", () => {
      assert.throws(() =>
        fromPayload({
          occurred_at: {} as unknown,
          source: "billing_api",
          event_type: "invoice.refunded",
        }),
      );
    });
  });

  describe("save + JSON round-trip", () => {
    it("round-trips the data column as JSON", () => {
      const db = freshDb();
      const saved = save(db, {
        occurredAt: new Date(),
        source: "test",
        eventType: "demo",
        data: { k: "v", nested: { a: 1 } },
      });

      const reloaded = getEvent(db, saved.id!);
      assert.deepEqual(reloaded?.data, { k: "v", nested: { a: 1 } });
      db.close();
    });
  });
});
