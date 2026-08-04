// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp, PAGE_SIZE } from "../src/app.ts";
import { save } from "../src/audit-event.ts";
import { freshDb } from "./setup.ts";
import type { DatabaseSync } from "node:sqlite";

function makeEvent(db: DatabaseSync, overrides: {
  occurredAt?: Date;
  source?: string;
  eventType?: string;
  text?: string;
} = {}) {
  return save(db, {
    occurredAt: overrides.occurredAt ?? new Date(),
    source: overrides.source ?? "test_system",
    eventType: overrides.eventType ?? "test.event",
    text: overrides.text ?? "demo",
  });
}

describe("routes", () => {
  it("GET / with an empty database renders the empty state", async () => {
    const db = freshDb();
    try {
      const res = await request(createApp({ db })).get("/");
      assert.equal(res.status, 200);
      assert.match(res.text, /Audit Log/);
      assert.match(res.text, /No audit events yet/);
    } finally {
      db.close();
    }
  });

  it("GET / lists events most-recent-first", async () => {
    const db = freshDb();
    try {
      makeEvent(db, {
        occurredAt: new Date("2026-05-27T10:00:00Z"),
        source: "older_system",
      });
      makeEvent(db, {
        occurredAt: new Date("2026-05-27T11:00:00Z"),
        source: "newer_system",
      });

      const res = await request(createApp({ db })).get("/");
      assert.equal(res.status, 200);
      const newerPos = res.text.indexOf("newer_system");
      const olderPos = res.text.indexOf("older_system");
      assert.ok(newerPos > -1 && olderPos > -1, "both rows should render");
      assert.ok(newerPos < olderPos, "newer should appear before older");
    } finally {
      db.close();
    }
  });

  it("pagination appears when there are more than PAGE_SIZE rows", async () => {
    const db = freshDb();
    try {
      const base = new Date("2026-05-27T00:00:00Z").getTime();
      for (let i = 0; i < PAGE_SIZE + 5; i++) {
        makeEvent(db, {
          occurredAt: new Date(base + i * 1000),
          source: `src_${i}`,
        });
      }

      const res = await request(createApp({ db })).get("/");
      assert.equal(res.status, 200);
      assert.match(res.text, /\?cursor=/);
      assert.match(res.text, /Older/);
      // Minus one for the thead row.
      const rowCount = (res.text.match(/<tr>/g) ?? []).length - 1;
      assert.equal(rowCount, PAGE_SIZE);
    } finally {
      db.close();
    }
  });

  it("following the cursor returns the next page", async () => {
    const db = freshDb();
    try {
      const base = new Date("2026-05-27T00:00:00Z").getTime();
      const rows = [];
      for (let i = 0; i < PAGE_SIZE + 3; i++) {
        rows.push(makeEvent(db, {
          occurredAt: new Date(base + i * 1000),
          source: `src_${i}`,
        }));
      }

      const app = createApp({ db });
      const first = await request(app).get("/");
      assert.doesNotMatch(first.text, /Newest/); // not on page 1
      const match = first.text.match(/\?cursor=([^"]+)/);
      assert.ok(match);
      const cursor = decodeURIComponent(match[1]!);

      const second = await request(app).get(`/?cursor=${encodeURIComponent(cursor)}`);
      assert.equal(second.status, 200);
      // Oldest 3 should show; PAGE_SIZE and beyond should not.
      for (const row of rows.slice(0, 3)) {
        assert.match(second.text, new RegExp(row.source));
      }
      assert.doesNotMatch(second.text, new RegExp(`src_${PAGE_SIZE}(?!\\d)`));
      assert.doesNotMatch(second.text, /Older/);
      assert.match(second.text, /Newest/);
      assert.match(second.text, /<a href="\/">/);
    } finally {
      db.close();
    }
  });

  it("garbage cursor falls back to the first page", async () => {
    const db = freshDb();
    try {
      makeEvent(db);
      const res = await request(createApp({ db })).get("/?cursor=not-a-cursor");
      assert.equal(res.status, 200);
      assert.doesNotMatch(res.text, /No audit events yet/);
    } finally {
      db.close();
    }
  });
});
