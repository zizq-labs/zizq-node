// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// The `audit_events` row shape plus a couple of pure helpers. No
// class, no ORM — the whole point of this example is that Zizq
// doesn't care what your persistence layer looks like.

import type { DatabaseSync } from "node:sqlite";

/** All fields on an audit_events row, after JSON parsing of `data`. */
export interface AuditEvent {
  id?: number;
  occurredAt: Date;
  source: string;
  eventType: string;
  actor?: string | null;
  ip?: string | null;
  resource?: string | null;
  text?: string | null;
  data?: unknown;
  createdAt?: Date;
}

/** Fields the producer must supply. */
const REQUIRED = ["occurredAt", "source", "eventType"] as const;

export type ValidationErrors = Partial<Record<keyof AuditEvent, string[]>>;

/**
 * Return per-field validation errors, or `null` if the event is valid.
 * Only the three producer-mandated fields are validated — everything
 * else is optional and the producer's concern.
 */
export function validate(evt: Partial<AuditEvent>): ValidationErrors | null {
  const errors: ValidationErrors = {};
  for (const field of REQUIRED) {
    const value = evt[field];
    const empty =
      value == null ||
      (typeof value === "string" && value.trim() === "") ||
      (value instanceof Date && Number.isNaN(value.getTime()));
    if (empty) {
      (errors[field] ??= []).push("is required");
    }
  }
  return Object.keys(errors).length ? errors : null;
}

/**
 * Build (don't save) an AuditEvent from an `audit.create` job payload.
 * The payload is plain JSON — string keys, JSON-scalar values.
 * `occurred_at` accepts an ISO8601 string, an epoch integer/float
 * (seconds), or a Date.
 */
export function fromPayload(payload: Record<string, unknown>): AuditEvent {
  return {
    occurredAt: parseTime(payload["occurred_at"]),
    source: String(payload["source"] ?? ""),
    eventType: String(payload["event_type"] ?? ""),
    actor: (payload["actor"] as string | null | undefined) ?? null,
    ip: (payload["ip"] as string | null | undefined) ?? null,
    resource: (payload["resource"] as string | null | undefined) ?? null,
    text: (payload["text"] as string | null | undefined) ?? null,
    data: payload["data"] ?? null,
  };
}

/** Insert an event and return the row (with server-assigned id + timestamps). */
export function save(db: DatabaseSync, evt: AuditEvent): AuditEvent {
  const errors = validate(evt);
  if (errors) {
    throw new ValidationError(errors);
  }

  const info = db
    .prepare(
      `INSERT INTO audit_events
         (occurred_at, source, event_type, actor, ip, resource, text, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      evt.occurredAt.toISOString(),
      evt.source,
      evt.eventType,
      evt.actor ?? null,
      evt.ip ?? null,
      evt.resource ?? null,
      evt.text ?? null,
      evt.data == null ? null : JSON.stringify(evt.data),
    );

  return getEvent(db, Number(info.lastInsertRowid))!;
}

/** Fetch a single event by id. Returns null if not found. */
export function getEvent(
  db: DatabaseSync,
  id: number,
): AuditEvent | null {
  const row = db
    .prepare("SELECT * FROM audit_events WHERE id = ?")
    .get(id) as AuditEventRow | undefined;
  return row ? rowToEvent(row) : null;
}

export class ValidationError extends Error {
  readonly errors: ValidationErrors;

  constructor(errors: ValidationErrors) {
    super(formatErrors(errors));
    this.name = "ValidationError";
    this.errors = errors;
  }
}

// --- Internal ---

interface AuditEventRow {
  id: number;
  occurred_at: string;
  source: string;
  event_type: string;
  actor: string | null;
  ip: string | null;
  resource: string | null;
  text: string | null;
  data: string | null;
  created_at: string;
}

export function rowToEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    occurredAt: new Date(row.occurred_at),
    source: row.source,
    eventType: row.event_type,
    actor: row.actor,
    ip: row.ip,
    resource: row.resource,
    text: row.text,
    data: row.data ? JSON.parse(row.data) : null,
    createdAt: new Date(row.created_at),
  };
}

function parseTime(value: unknown): Date {
  if (value == null) return new Date(NaN);
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    // Seconds vs milliseconds heuristic: values beyond ~10^12 are ms.
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === "string") return new Date(value);
  throw new TypeError(
    `unsupported occurred_at: ${JSON.stringify(value)}`,
  );
}

function formatErrors(errors: ValidationErrors): string {
  return Object.entries(errors)
    .map(([field, msgs]) => `${field} ${(msgs ?? []).join(", ")}`)
    .join("; ");
}
