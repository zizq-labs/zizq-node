// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// `checks` row shape plus a single insert helper. Checks are
// immutable history — no update/delete surface.

import type { DatabaseSync } from "node:sqlite";
import type { Status } from "./monitored-url.ts";

export interface Check {
  id: number;
  monitoredUrlId: number;
  checkedAt: Date;
  status: Status;
  httpStatus: number | null;
  responseTimeMs: number | null;
  finalUrl: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

/** The shape produced by `UrlProber` and consumed by `recordCheck`. */
export interface CheckResult {
  status: Status;
  httpStatus: number | null;
  responseTimeMs: number;
  finalUrl: string;
  errorMessage: string | null;
  isSitemap: boolean;
  checkedAt: Date;
}

export function insertCheck(
  db: DatabaseSync,
  monitoredUrlId: number,
  result: CheckResult,
): Check {
  const info = db
    .prepare(
      `INSERT INTO checks
         (monitored_url_id, checked_at, status, http_status,
          response_time_ms, final_url, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
    .run(
      monitoredUrlId,
      result.checkedAt.toISOString(),
      result.status,
      result.httpStatus,
      result.responseTimeMs,
      result.finalUrl,
      result.errorMessage,
    );

  return get(db, Number(info.lastInsertRowid))!;
}

export function get(db: DatabaseSync, id: number): Check | null {
  const row = db
    .prepare("SELECT * FROM checks WHERE id = ?")
    .get(id) as Row | undefined;
  return row ? rowTo(row) : null;
}

interface Row {
  id: number;
  monitored_url_id: number;
  checked_at: string;
  status: Status;
  http_status: number | null;
  response_time_ms: number | null;
  final_url: string | null;
  error_message: string | null;
  created_at: string;
}

function rowTo(row: Row): Check {
  return {
    id: row.id,
    monitoredUrlId: row.monitored_url_id,
    checkedAt: new Date(row.checked_at),
    status: row.status,
    httpStatus: row.http_status,
    responseTimeMs: row.response_time_ms,
    finalUrl: row.final_url,
    errorMessage: row.error_message,
    createdAt: new Date(row.created_at),
  };
}
