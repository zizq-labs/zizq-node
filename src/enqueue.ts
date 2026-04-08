// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// High-level enqueue helpers that support both string types and function references.

import {
  Client,
  type BackoffConfig,
  type EnqueueOptions,
  type JobData,
  type RetentionConfig,
  type UniqueScope,
} from "./client.ts";

import type { JobFunction, ZizqOptions } from "./handler.ts";

/**
 * Per-enqueue overrides for job configuration.
 *
 * When enqueueing via a function reference, the function's `zizqOptions`
 * provide defaults. Any field set here takes precedence.
 *
 * When enqueueing via a string type, `queue` is required (there are no
 * defaults to fall back on).
 */
export interface EnqueueOverrides {
  /**
   * Target queue name.
   *
   * Must be valid UTF-8 and must not contain any of the following reserved
   * characters: ",", "?", "*", "[", "]", "{", "}", "!".
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
   */
  uniqueKey?: string;

  /** Uniqueness scope. Only valid when `uniqueKey` is set. */
  uniqueWhile?: UniqueScope;
}

// Compute the unique key from ZizqOptions + payload.
function computeUniqueKey(
  opts: ZizqOptions | undefined,
  payload: unknown
): string | undefined {
  if (!opts?.uniqueKey) return undefined;

  if (typeof opts.uniqueKey === "function") {
    return opts.uniqueKey(payload);
  }

  return opts.uniqueKey;
}

/**
 * Enqueue a job by function reference or string type name.
 *
 * When the first argument is a function, the job type is derived from
 * `fn.zizqOptions.type` or `fn.name`, and config is read from
 * `fn.zizqOptions`. Overrides can be provided in the fourth argument.
 *
 * When the first argument is a string, it is used directly as the job type and
 * the queue must be provided via overrides.
 *
 * @param client - The Zizq client to use for the HTTP request.
 * @param jobOrType - A job function (with optional `zizqOptions`) or a string job type.
 * @param payload - Arbitrary payload delivered to the worker.
 * @param overrides - Optional per-enqueue overrides for queue, priority, etc.
 * @returns The created job, including its server-assigned `id` and `status`.
 *
 * @example Enqueue using a function reference
 * ```ts
 * async function sendEmail(payload) {
 *   await mailer.send(payload.to, payload.subject, payload.body);
 * }
 * sendEmail.zizqOptions = { queue: "emails", priority: 100 };
 *
 * const job = await enqueue(client, sendEmail, {
 *   to: "user@example.com",
 *   subject: "Hello",
 *   body: "World",
 * });
 * ```
 *
 * @example Enqueue using a raw string type
 * ```ts
 * const job = await enqueue(client, "send_email", { to: "user@example.com" }, {
 *   queue: "emails",
 *   priority: 100,
 * });
 * ```
 */
export async function enqueue(
  client: Client,
  jobOrType: JobFunction | string,
  payload: unknown,
  overrides?: EnqueueOverrides
): Promise<JobData> {
  let jobType: string;
  let defaults: ZizqOptions | undefined;

  if (typeof jobOrType === "function") {
    defaults = jobOrType.zizqOptions;
    jobType = defaults?.type ?? jobOrType.name;

    if (!jobType) {
      throw new Error(
        "Job function must have a name or zizqOptions.type"
      );
    }
  } else {
    jobType = jobOrType;
  }

  const queue = overrides?.queue ?? defaults?.queue;

  if (!queue) {
    throw new Error(`No queue specified for job type "${jobType}"`);
  }

  const uniqueKey =
    overrides?.uniqueKey ?? computeUniqueKey(defaults, payload);

  const uniqueWhile =
    overrides?.uniqueWhile ?? defaults?.uniqueWhile;

  const opts: EnqueueOptions = {
    type: jobType,
    queue,
    payload,
    priority: overrides?.priority ?? defaults?.priority,
    readyAt: overrides?.readyAt,
    retryLimit: overrides?.retryLimit ?? defaults?.retryLimit,
    backoff: overrides?.backoff ?? defaults?.backoff,
    retention: overrides?.retention,
    uniqueKey,
    uniqueWhile: uniqueKey ? uniqueWhile : undefined,
  };

  return client.enqueue(opts);
}
