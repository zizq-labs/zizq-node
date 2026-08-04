// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Express factory for the read-only audit feed. Constructed as a
// factory so tests can bind against an in-process DB and the runtime
// can inject its own instance from `server.ts`.

import express, { type Express, type Request } from "express";
import type { DatabaseSync } from "node:sqlite";
import { ZIZQ_QUEUE } from "./audit-router.ts";
import { rowToEvent, type AuditEvent } from "./audit-event.ts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PAGE_SIZE = 50;

export interface AppOptions {
  db: DatabaseSync;
}

export function createApp({ db }: AppOptions): Express {
  const app = express();

  app.set("view engine", "ejs");
  app.set("views", `${HERE}/../views`);
  app.use(express.static(`${HERE}/../public`));

  app.get("/", (req: Request, res) => {
    const cursor =
      typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const events = pageDataset(db, cursor);
    const nextCursor = nextCursorFor(events);

    res.render("index", {
      events,
      nextCursor,
      hasCursor: !!cursor,
      queue: ZIZQ_QUEUE,
      helpers: { timeAgo, formatData },
    });
  });

  return app;
}

// --- Pagination ------------------------------------------------------
//
// Cursor format: "<epoch_micros>:<id>". Older-than semantics — the
// first page omits it, `nextCursor` moves back through history.

function pageDataset(db: DatabaseSync, cursor: string | undefined): AuditEvent[] {
  const parsed = cursor ? parseCursor(cursor) : null;
  if (parsed) {
    const [occurredAt, id] = parsed;
    const iso = occurredAt.toISOString();
    const rows = db
      .prepare(
        `SELECT * FROM audit_events
         WHERE occurred_at < ?
            OR (occurred_at = ? AND id < ?)
         ORDER BY occurred_at DESC, id DESC
         LIMIT ?`,
      )
      .all(iso, iso, id, PAGE_SIZE);
    return rows.map((r) => rowToEvent(r as never));
  }

  const rows = db
    .prepare(
      `SELECT * FROM audit_events
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
    )
    .all(PAGE_SIZE);
  return rows.map((r) => rowToEvent(r as never));
}

function parseCursor(cursor: string): [Date, number] | null {
  const [microsStr, idStr] = cursor.split(":", 2);
  if (!microsStr || !idStr) return null;
  const micros = Number(microsStr);
  const id = Number(idStr);
  if (!Number.isFinite(micros) || !Number.isFinite(id)) return null;
  return [new Date(micros / 1000), id];
}

function nextCursorFor(events: AuditEvent[]): string | null {
  if (events.length < PAGE_SIZE) return null;
  const last = events[events.length - 1]!;
  const micros = Math.floor(last.occurredAt.getTime() * 1000);
  return `${micros}:${last.id}`;
}

// --- View helpers ----------------------------------------------------

function timeAgo(time: Date | null | undefined): string {
  if (!time) return "";
  const seconds = Math.floor((Date.now() - time.getTime()) / 1000);
  if (seconds < 0) return time.toISOString();
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function formatData(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) {
    return "";
  }
  return JSON.stringify(value, null, 2);
}
