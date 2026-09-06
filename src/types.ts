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

import type { JobFunction } from "./handler.ts";

/** Lifecycle status of a job. */
export type JobStatus = "ready" | "in_flight" | "scheduled" | "completed" | "dead";

/** Sort direction for paginated listings. */
export type SortDirection = "asc" | "desc";

/** Uniqueness scope for deduplication. */
export type UniqueScope = "queued" | "active" | "exists";

/**
 * Batching configuration for folded jobs.
 *
 * When present on an enqueue, subsequent enqueues that share `key` may
 * be folded into the same pending job's payload. `when` (jq predicate)
 * decides whether to fold; `fold` (jq reducer) produces the merged
 * payload. Both run with `$existing` bound to the current pending
 * payload and `$new` bound to the incoming one.
 *
 * Requires a pro license on the server.
 */
export interface BatchConfig {
  /** Identifies the batch. Only one pending batch per key at a time. */
  key: string;

  /**
   * jq predicate deciding whether to fold. Truthy → merge into the
   * existing batch. Falsy → seal the existing batch and start a fresh
   * one from this enqueue.
   */
  when: string;

  /** jq expression producing the merged payload when `when` returns true. */
  fold: string;
}

/** Serialisation format for client-server communication. */
export type Format = "json" | "msgpack";

/**
 * Backoff configuration for retry delays.
 *
 * This is used in the following formula:
 *
 * ```
 * t = baseMs + (attempts ** exponent * 1000) + (attempts * random() * jitterMs)
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

  /**
   * Batching configuration for folded jobs.
   *
   * Requires a pro license on the server.
   */
  batch?: BatchConfig;

  /**
   * Budgets this job draws on when it dispatches.
   *
   * A job that cannot currently be afforded in any of its budgets
   * waits rather than being dispatched. Other jobs continue
   * dispatching unimpacted. Omit or leave empty for an unthrottled
   * job.
   *
   * Requires a pro license on the server.
   */
  budgets?: BudgetBindingInput[];
}

/** How a budget's tokens are managed. */
export type BudgetStrategyType = "time_based" | "while_in_flight";

/**
 * How a budget is managed.
 *
 * A discriminated union, so a `while_in_flight` budget carrying a
 * `durationMs` is a compile error rather than a request the server
 * rejects. That strategy has no clock — its tokens are released when a
 * job stops running — so a period would read as though it set a refill
 * rate that does not exist.
 *
 * `durationMs` is the period over which the whole allocation
 * replenishes. Tokens accrue on a continuous drip rather than in fixed
 * windows, so an empty bucket is half full after half the duration.
 *
 * `burst` caps how many tokens the bucket may hold at once. A bucket
 * starts full, so `100` per minute permits two hundred dispatches in
 * the first minute before settling to its long-run rate; a `burst` caps
 * that spike without changing the rate, and a `burst` of `1` paces
 * dispatches evenly with no excess accrual.
 */
export type BudgetStrategy =
  | { type: "time_based"; durationMs: number; burst?: number }
  | { type: "while_in_flight" };

/** A budget's policy, without the key it is stored under. */
export interface BudgetPolicy {
  /** Tokens the bucket makes available when full. */
  allocation: number;

  /** How those tokens are released back to the bucket. */
  strategy: BudgetStrategy;
}

/** A budget as the server reports it. */
export interface Budget extends BudgetPolicy {
  /** The key this budget is stored under, unique across the server. */
  key: string;

  /** When it was first defined (ms since epoch). */
  createdAt?: number;

  /** When its policy last changed (ms since epoch). */
  updatedAt?: number;
}

/** Options for defining a budget. */
export interface DefineBudgetOptions extends BudgetPolicy {
  /** The key to store it under. */
  key: string;

  /**
   * Overwrite an existing budget rather than conflicting.
   *
   * Without this a key that already exists is a `ConflictError`, which
   * is often desirable if handled (e.g. in application startup code).
   */
  replace?: boolean;
}

/**
 * A merge patch over a budget's strategy.
 *
 * Only what is named is sent. `burst: null` clears the ceiling back to
 * the allocation; `burst: undefined` leaves it alone. A `null` `type` or
 * `durationMs` is not valid.
 */
export interface BudgetStrategyPatch {
  type?: BudgetStrategyType;
  durationMs?: number;
  burst?: number | null;
}

/** Options for amending a budget's policy. */
export interface UpdateBudgetOptions {
  /** Change the tokens the bucket is holds when full. */
  allocation?: number;

  /** Change part of the strategy, leaving the rest alone. */
  strategy?: BudgetStrategyPatch;
}

/**
 * A job's binding to a budget, as written.
 *
 * `cost` is how many tokens one job debits when it dispatches,
 * defaulting to 1, so jobs can weigh differently against the same
 * budget. It has to fit inside the budget's capacity — the burst where
 * one is set, and the allocation otherwise — or the job could never
 * be dispatched.
 */
export interface BudgetBindingInput {
  /** Key of the budget to draw from. */
  key: string;

  /** Tokens this job consumes on dispatch. Defaults to 1. */
  cost?: number;

  /**
   * Policy to create the budget with if it does not exist yet, binding
   * and creating in one request.
   *
   * Ignored when the budget already exists — the server stays
   * authoritative, so an enqueue cannot restate a throttle an operator
   * has configured.
   */
  createWith?: BudgetPolicy;
}

/**
 * A job's binding to a budget, as the server reports it.
 *
 * Intentionally narrower than {@link BudgetBindingInput}: `cost` is
 * always present, resolved to the default where the enqueue omitted it,
 * and there is no `createWith`.
 */
export interface BudgetBinding {
  /** Key of the budget this job draws from. */
  key: string;

  /** Tokens consumed when it dispatches. */
  cost: number;
}

/**
 * The outcome of changing the budgets of many jobs at once.
 *
 * `blocked` lists the jobs that matched the filter and would have
 * changed, but could not because they were in flight and already
 * consumed tokens against their budgets. They drain on their own, so
 * it is a retry list. Jobs that matched and needed no change are
 * counted in neither.
 */
export interface BudgetChange {
  /** How many jobs were changed. */
  changed: number;

  /** IDs of jobs that were in flight so could not be changed. */
  blocked: string[];
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

/**
 * A range with inclusive bounds. Omit either side for an unbounded end.
 *
 * Used by the `priority`, `readyAt`, and `attempts` filter fields. An
 * empty object (`{}`) is treated as a fully unbounded range.
 */
export interface RangeBounds {
  /** Lower bound, inclusive. Omit for no lower bound. */
  min?: number;

  /** Upper bound, inclusive. Omit for no upper bound. */
  max?: number;
}

/**
 * A range filter that matches either a single value or a span of values.
 *
 * Pass a bare `number` for an exact match. Pass an object with `min` and/or
 * `max` for a range — both bounds are **inclusive**. Omit either side for
 * an unbounded end.
 *
 * @example
 * priority: 50                   // exactly 50
 * priority: { min: 0, max: 100 } // 0..100 inclusive
 * priority: { min: 50 }          // 50 or higher
 * priority: { max: 100 }         // 100 or lower
 */
export type RangeFilter = number | RangeBounds;

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

  /**
   * Filter by priority. Accepts an exact value or a `{min, max}` range
   * with inclusive bounds. Lower numbers are higher priority.
   */
  priority?: RangeFilter;

  /**
   * Filter by `readyAt` (milliseconds since the Unix epoch). Accepts an
   * exact value or a `{min, max}` range with inclusive bounds.
   */
  readyAt?: RangeFilter;

  /**
   * Filter by failure count. Accepts an exact value or a `{min, max}`
   * range with inclusive bounds. `0` selects jobs that have never failed.
   */
  attempts?: RangeFilter;

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

  /**
   * Filter by priority. Accepts an exact value or a `{min, max}` range
   * with inclusive bounds. Lower numbers are higher priority.
   */
  priority?: RangeFilter;

  /**
   * Filter by `readyAt` (milliseconds since the Unix epoch). Accepts an
   * exact value or a `{min, max}` range with inclusive bounds.
   */
  readyAt?: RangeFilter;

  /**
   * Filter by failure count. Accepts an exact value or a `{min, max}`
   * range with inclusive bounds. `0` selects jobs that have never failed.
   */
  attempts?: RangeFilter;

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
   * When not specified, the group's time zone applies, falling back to the
   * server system time zone when the group does not specify one either.
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

  /**
   * The time zone applied to every entry that does not specify one of its
   * own.
   *
   * Since this replaces the group in full, omitting it clears whatever time
   * zone the group had. Requires Zizq 0.7.0 or newer on the server.
   */
  timezone?: string;

  /** Named collection of entries present in this group. */
  entries: CronEntryInput[];
}

/**
 * Input for enqueueing a job.
 *
 * The `type` field accepts either a string job type name or a function
 * reference with optional attached `zizqOptions`. When a function is provided,
 * its `zizqOptions` supplies defaults for `queue`, `priority`, etc. These
 * defaults can be overridden by inputs specified at enqueue-time.
 *
 * When `type` is a string, `queue` is required in the inputs.
 *
 * @example Function reference
 * ```ts
 * await client.enqueue({ type: sendEmail, payload: { to: "a@b.com" } });
 * ```
 *
 * @example String type with explicit config
 * ```ts
 * await client.enqueue({
 *   type: "send_email",
 *   queue: "emails",
 *   payload: { to: "a@b.com" },
 *   priority: 100,
 * });
 * ```
 */
export interface EnqueueInput {
  /** Job type — a function reference or a string type name. */
  type: JobFunction | string;

  /** Arbitrary payload delivered to the worker. */
  payload: unknown;

  /**
   * Target queue name.
   *
   * Required when `type` is a string and no `zizqOptions.queue` default
   * is available.
   */
  queue?: string;

  /**
   * Priority (lower = higher priority).
   *
   * Valid range is 0 to 65536. Default: 32768.
   */
  priority?: number;

  /**
   * Timestamp (ms since epoch) when the job becomes eligible.
   *
   * When set to a future timestamp the job is created in the "scheduled"
   * status. Otherwise the job is created in the "ready" status.
   */
  readyAt?: number;

  /**
   * Per-job retry limit.
   *
   * When not set the server default value applies.
   */
  retryLimit?: number;

  /** Per-job backoff configuration. */
  backoff?: BackoffConfig;

  /** Per-job retention configuration. */
  retention?: RetentionConfig;

  /**
   * Unique key for enqueue-time deduplication.
   *
   * Requires a pro license on the server.
   *
   * The key is global across all queues and job types. Prefix with the job
   * type to make it unique per job type.
   *
   * Accepts either a literal string or a function that derives the key
   * from this enqueue input at call time. The function form is what
   * `payloadHasher(...)` returns.
   */
  uniqueKey?: string | ((input: EnqueueInput) => string);

  /** Uniqueness scope. Only valid when `uniqueKey` is set. */
  uniqueWhile?: UniqueScope;

  /**
   * Batching configuration for folded jobs.
   *
   * `key` can be either a literal string or a function that derives the
   * key from this enqueue input at call time. `batchConfig(...)`
   * returns a value shaped like this with `key` as a function; users
   * can also spread its result and override `key` with a custom
   * derivation.
   *
   * Requires a pro license on the server.
   */
  batch?: {
    key: string | ((input: EnqueueInput) => string);
    when: string;
    fold: string;
  };

  /**
   * Budgets this job draws on when it dispatches.
   *
   * A job that cannot afford its cost waits rather than dispatching —
   * it is not failed, and it does not leave the queue. Omit or leave
   * empty for an unthrottled job.
   *
   * Requires a pro license on the server.
   */
  budgets?: BudgetBindingInput[];
}


