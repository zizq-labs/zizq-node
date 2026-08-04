// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// `monitored_urls` row shape plus CRUD helpers. No class — pure data
// + functions, same style as `audit-event.ts` in the audit_log
// example. See the audit_log README for the rationale.

import type { DatabaseSync } from "node:sqlite";
import type { CheckResult } from "./check.ts";
import { insertCheck, type Check } from "./check.ts";

export const SOURCES = ["manual", "sitemap"] as const;
export const STATUSES = ["up", "down"] as const;

export type Source = (typeof SOURCES)[number];
export type Status = (typeof STATUSES)[number];

export interface MonitoredUrl {
  id: number;
  url: string;
  source: Source;
  sourceSitemapUrl: string | null;
  enabled: boolean;
  consecutiveFailures: number;
  lastCheckedAt: Date | null;
  lastStatus: Status | null;
  createdAt: Date;
  updatedAt: Date;
}

export class ValidationError extends Error {
  readonly errors: Record<string, string[]>;
  constructor(errors: Record<string, string[]>) {
    super(
      Object.entries(errors)
        .map(([k, msgs]) => `${k} ${msgs.join(", ")}`)
        .join("; "),
    );
    this.name = "ValidationError";
    this.errors = errors;
  }
}

export interface CreateInput {
  url: string;
  source?: Source;
  sourceSitemapUrl?: string | null;
  enabled?: boolean;
  lastStatus?: Status | null;
  lastCheckedAt?: Date | null;
  consecutiveFailures?: number;
}

/** Validate the input, insert a row, return it. Raises on validation. */
export function create(db: DatabaseSync, input: CreateInput): MonitoredUrl {
  const source = input.source ?? "manual";
  const errors: Record<string, string[]> = {};

  const url = String(input.url ?? "").trim();
  if (url.length === 0) {
    (errors.url ??= []).push("is required");
  } else {
    const scheme = validateScheme(url);
    if (scheme) (errors.url ??= []).push(scheme);
  }
  if (!SOURCES.includes(source)) {
    (errors.source ??= []).push(`must be one of ${JSON.stringify(SOURCES)}`);
  }
  if (input.lastStatus && !STATUSES.includes(input.lastStatus)) {
    (errors.lastStatus ??= []).push(
      `must be one of ${JSON.stringify(STATUSES)}`,
    );
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);

  const info = db
    .prepare(
      `INSERT INTO monitored_urls
         (url, source, source_sitemap_url, enabled,
          consecutive_failures, last_checked_at, last_status,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .run(
      url,
      source,
      input.sourceSitemapUrl ?? null,
      input.enabled === false ? 0 : 1,
      input.consecutiveFailures ?? 0,
      input.lastCheckedAt?.toISOString() ?? null,
      input.lastStatus ?? null,
    );

  return get(db, Number(info.lastInsertRowid))!;
}

export function get(db: DatabaseSync, id: number): MonitoredUrl | null {
  const row = db
    .prepare("SELECT * FROM monitored_urls WHERE id = ?")
    .get(id) as Row | undefined;
  return row ? rowTo(row) : null;
}

export function findByUrlScoped(
  db: DatabaseSync,
  url: string,
  sourceSitemapUrl: string | null,
): MonitoredUrl | null {
  const row = db
    .prepare(
      `SELECT * FROM monitored_urls
       WHERE url = ? AND COALESCE(source_sitemap_url, '') = COALESCE(?, '')
       LIMIT 1`,
    )
    .get(url, sourceSitemapUrl) as Row | undefined;
  return row ? rowTo(row) : null;
}

export function listAllOrderedByLastCheck(db: DatabaseSync): MonitoredUrl[] {
  const rows = db
    .prepare(
      `SELECT * FROM monitored_urls
       ORDER BY (last_checked_at IS NULL) ASC,
                last_checked_at DESC,
                created_at DESC`,
    )
    .all() as unknown as Row[];
  return rows.map(rowTo);
}

/**
 * Insert a Check row and update the denormalised summary columns
 * on `monitored`, atomically. Returns the newly-inserted Check.
 */
export function recordCheck(
  db: DatabaseSync,
  monitored: MonitoredUrl,
  result: CheckResult,
): Check {
  db.exec("BEGIN");
  try {
    const check = insertCheck(db, monitored.id, result);
    const consecutive =
      result.status === "up" ? 0 : monitored.consecutiveFailures + 1;
    db.prepare(
      `UPDATE monitored_urls
         SET last_checked_at = ?,
             last_status = ?,
             consecutive_failures = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(
      result.checkedAt.toISOString(),
      result.status,
      consecutive,
      monitored.id,
    );
    db.exec("COMMIT");
    return check;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * IDs of enabled URLs whose last check is older than `staleAfterMs`
 * (or that have never been checked). Selected as raw IDs to keep the
 * caller's bulk-enqueue loop tight.
 */
export function findStaleEnabledIds(
  db: DatabaseSync,
  staleAfterMs: number,
): number[] {
  const threshold = new Date(Date.now() - staleAfterMs).toISOString();
  const rows = db
    .prepare(
      `SELECT id FROM monitored_urls
       WHERE enabled = 1
         AND (last_checked_at IS NULL OR last_checked_at < ?)`,
    )
    .all(threshold) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

/** Enabled sitemap-sourced children of the given sitemap parent URL. */
export function enabledSitemapChildrenIds(
  db: DatabaseSync,
  sitemapUrl: string,
): number[] {
  const rows = db
    .prepare(
      `SELECT id FROM monitored_urls
       WHERE source_sitemap_url = ? AND enabled = 1`,
    )
    .all(sitemapUrl) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

/**
 * Bulk enable / disable sitemap children based on a discovered URL
 * set. Returning children still in the set are re-enabled; children
 * not in the set are disabled.
 */
export function reconcileSitemapChildren(
  db: DatabaseSync,
  sitemapUrl: string,
  discoveredUrls: string[],
): void {
  if (discoveredUrls.length === 0) {
    db.prepare(
      `UPDATE monitored_urls
         SET enabled = 0, updated_at = CURRENT_TIMESTAMP
       WHERE source_sitemap_url = ?`,
    ).run(sitemapUrl);
    return;
  }

  const placeholders = discoveredUrls.map(() => "?").join(",");
  db.prepare(
    `UPDATE monitored_urls
       SET enabled = 1, updated_at = CURRENT_TIMESTAMP
     WHERE source_sitemap_url = ? AND url IN (${placeholders})`,
  ).run(sitemapUrl, ...discoveredUrls);

  db.prepare(
    `UPDATE monitored_urls
       SET enabled = 0, updated_at = CURRENT_TIMESTAMP
     WHERE source_sitemap_url = ? AND url NOT IN (${placeholders})`,
  ).run(sitemapUrl, ...discoveredUrls);
}

// --- Internal --------------------------------------------------------

interface Row {
  id: number;
  url: string;
  source: Source;
  source_sitemap_url: string | null;
  enabled: number;
  consecutive_failures: number;
  last_checked_at: string | null;
  last_status: Status | null;
  created_at: string;
  updated_at: string;
}

function rowTo(row: Row): MonitoredUrl {
  return {
    id: row.id,
    url: row.url,
    source: row.source,
    sourceSitemapUrl: row.source_sitemap_url,
    enabled: row.enabled === 1,
    consecutiveFailures: row.consecutive_failures,
    lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at) : null,
    lastStatus: row.last_status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function validateScheme(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return "must be an http:// or https:// URL";
    }
    if (!u.hostname) return "must be an http:// or https:// URL";
    return null;
  } catch {
    return "is not a valid URL";
  }
}
