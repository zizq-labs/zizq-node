// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Shared type definitions used across the Zizq client.
 *
 * This module contains pure types with no runtime dependencies, breaking
 * the circular import between client.ts and resources.ts.
 *
 * @module
 */

/** Lifecycle status of a job. */
export type JobStatus = "ready" | "in_flight" | "scheduled" | "completed" | "dead";

/** Sort direction for paginated listings. */
export type SortDirection = "asc" | "desc";

/** Uniqueness scope for deduplication. */
export type UniqueScope = "queued" | "active" | "exists";

/** Serialisation format for client-server communication. */
export type Format = "json" | "msgpack";

/**
 * Backoff configuration for retry delays.
 *
 * This is used in the following formula:
 *
 * ```
 * t = baseMs + (attempts ** exponent) + (attempts * random() * jitterMs)
 * ```
 *
 * The random jitter is designed to ensure clusters of failed jobs do not all
 * retry at the same time but are instead randomly spread out.
 */
export interface BackoffConfig {
  /** Base delay in milliseconds, applied to all retries. */
  baseMs: number;

  /** Backoff curve steepness (attempts ** exponent). */
  exponent: number;

  /** Maximum random jitter in milliseconds per attempt multiplier. */
  jitterMs: number;
}

/**
 * Retention configuration controlling how long jobs in terminal statuses are kept.
 *
 * The terminal statuses are "completed" and "dead".
 */
export interface RetentionConfig {
  /** How long completed jobs remain visible (ms). `null` clears to server default. */
  completedMs?: number | null;

  /** How long dead jobs remain visible (ms). `null` clears to server default. */
  deadMs?: number | null;
}

/**
 * Options for enqueueing a single job.
 *
 * Also used as the job template shape for cron entries (where `readyAt`
 * is not supported and will be rejected by the server).
 */
export interface EnqueueOptions {
  /** Job type identifier. */
  type: string;

  /**
   * Target queue name.
   *
   * Must be valid UTF-8 and must not contain any of the following reserved
   * characters: ",", "?", "*", "[", "]", "{", "}", "!".
   */
  queue: string;

  /** Arbitrary payload delivered to the worker. */
  payload: unknown;

  /**
   * Optional priority (lower = higher priority).
   *
   * Valid range is 0 to 65536. Default: 32768.
   */
  priority?: number;

  /**
   * Optional timestamp (ms since epoch) when the job becomes eligible.
   *
   * When set to a future timestamp the job is created in the "scheduled"
   * status. Otherwise the job is created in the "ready" status.
   *
   * Not supported for cron entries.
   */
  readyAt?: number;

  /**
   * Optional per-job retry limit.
   *
   * When not set the server default value applies.
   */
  retryLimit?: number;

  /** Optional per-job backoff configuration. */
  backoff?: BackoffConfig;

  /** Optional per-job retention configuration. */
  retention?: RetentionConfig;

  /**
   * Optional unique key for enqueue-time deduplication.
   *
   * Requires a pro license on the server.
   */
  uniqueKey?: string;

  /**
   * Uniqueness scope. Only valid when `uniqueKey` is set.
   */
  uniqueWhile?: UniqueScope;
}

/** Options for reporting a job failure. */
export interface FailureOptions {
  /** Error message describing what went wrong. */
  message: string;

  /** Optional error class name, e.g. "TimeoutError". */
  errorType?: string;

  /** Optional stack trace from the worker. */
  backtrace?: string;

  /** Optional forced retry time (ms since epoch), bypassing backoff. */
  retryAt?: number;

  /**
   * Kill the job immediately regardless of retry limit.
   *
   * Note: passing false does nothing.
   */
  kill?: boolean;
}

/** Options for updating a single job's mutable fields. */
export interface UpdateJobOptions {
  /** Move the job to a different queue. */
  queue?: string;

  /** Change the job's priority. */
  priority?: number;

  /**
   * Change when the job becomes ready (ms since epoch).
   * `null` clears to "now" (immediately ready).
   */
  readyAt?: number | null;

  /**
   * Override the retry limit.
   * `null` clears to server default.
   */
  retryLimit?: number | null;

  /**
   * Override backoff config.
   * `null` clears to server default.
   */
  backoff?: BackoffConfig | null;

  /**
   * Override retention config.
   * `null` clears entirely.
   */
  retention?: RetentionConfig | null;
}

/**
 * Options for the streaming take endpoint.
 *
 * Returns an async generator which never terminates as long as the connection
 * to the server remains open. Clients should use `break` to explicitly
 * disconnect from the endpoint and stop receiving jobs.
 *
 * When no jobs are available, the generator waits until new jobs are enqueued.
 */
export interface TakeOptions {
  /** Maximum number of "in_flight", unacknowledged jobs the server will send. */
  prefetch?: number;

  /** Only take jobs from these queues. Empty means all queues. */
  queues?: string[];

  /** AbortSignal to cancel the streaming connection. */
  signal?: AbortSignal;
}

/** Options for listing jobs with cursor-based pagination. */
export interface ListJobsOptions {
  /** Cursor: start after this job ID (exclusive). */
  from?: string;

  /** Sort order. Default: "asc" (oldest first). */
  order?: SortDirection;

  /** Maximum number of jobs per page (1–2000, default 50). */
  limit?: number;

  /** Filter by status. Accepts a single value or an array. */
  status?: JobStatus | JobStatus[];

  /** Filter by queue name. Accepts a single value or an array. */
  queue?: string | string[];

  /** Filter by job type. Accepts a single value or an array. */
  type?: string | string[];

  /** Filter by job ID. Accepts a single value or an array. */
  id?: string | string[];

  /** jq expression to filter jobs by payload. */
  filter?: string;
}

/** Options for listing error records for a job. */
export interface ListErrorsOptions {
  /** Cursor: start after this attempt number (exclusive). */
  from?: number;

  /** Sort order. Default: "asc" (oldest first). */
  order?: SortDirection;

  /** Maximum number of error records per page (1–2000, default 50). */
  limit?: number;
}

/** Options for bulk-updating jobs. */
export interface UpdateAllJobsOptions {
  /** Filter selecting which jobs to update. */
  where?: JobFilter;

  /** Fields to update on the matching jobs. */
  apply: UpdateJobOptions;
}

/**
 * Filter for selecting jobs in bulk operations.
 *
 * Used by `deleteAllJobs` and `updateAllJobs` to scope which jobs are
 * affected. An empty filter selects all jobs.
 */
export interface JobFilter {
  /** Filter by job ID. Accepts a single value or an array. */
  id?: string | string[];

  /** Filter by status. Accepts a single value or an array. */
  status?: JobStatus | JobStatus[];

  /** Filter by queue name. Accepts a single value or an array. */
  queue?: string | string[];

  /** Filter by job type. Accepts a single value or an array. */
  type?: string | string[];

  /** jq expression to filter jobs by payload. */
  filter?: string;
}

/** Options for bulk-deleting jobs. */
export interface DeleteAllJobsOptions {
  /** Filter selecting which jobs to delete. */
  where?: JobFilter;
}

/** A single cron entry definition for PUT/POST requests. */
export interface CronEntryInput {
  /** The name of the entry within the group. */
  name: string;

  /** The cron expression to use for scheduling. */
  expression: string;

  /**
   * The time zone in which the cron expression is evaluated.
   *
   * When not specified, the server system time zone applies.
   */
  timezone?: string;

  /** True if this entry should be paused. */
  paused?: boolean;

  /** Options to enqueue the job when it is due. */
  job: EnqueueOptions;
}

/** Options for replacing a cron group (PUT /crons/{name}). */
export interface ReplaceCronGroupOptions {
  /** True if this group is paused. */
  paused?: boolean;

  /** Named collection of entries present in this group. */
  entries: CronEntryInput[];
}


