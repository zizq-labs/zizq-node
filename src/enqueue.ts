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
 * Input for enqueueing a job.
 *
 * The `type` field accepts either a string job type name or a function
 * reference with optional `zizqOptions`. When a function is provided, its
 * `zizqOptions` supplies defaults for `queue`, `priority`, etc. Inline
 * fields on this object take precedence over `zizqOptions` defaults.
 *
 * When `type` is a string, `queue` is required.
 *
 * @example Function reference
 * ```ts
 * await enqueue(client, { type: sendEmail, payload: { to: "a@b.com" } });
 * ```
 *
 * @example String type with explicit config
 * ```ts
 * await enqueue(client, {
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
   */
  uniqueKey?: string;

  /** Uniqueness scope. Only valid when `uniqueKey` is set. */
  uniqueWhile?: UniqueScope;
}

/**
 * Enqueue a single job.
 *
 * @param client - The Zizq client to use for the HTTP request.
 * @param input - Job type, payload, and optional configuration.
 * @returns The created job, including its server-assigned `id` and `status`.
 *
 * @example Function reference
 * ```ts
 * async function sendEmail(payload) { ... }
 * sendEmail.zizqOptions = { queue: "emails", priority: 100 };
 *
 * const job = await enqueue(client, {
 *   type: sendEmail,
 *   payload: { to: "user@example.com" },
 * });
 * ```
 *
 * @example String type
 * ```ts
 * const job = await enqueue(client, {
 *   type: "send_email",
 *   queue: "emails",
 *   payload: { to: "user@example.com" },
 * });
 * ```
 */
export async function enqueue(
  client: Client,
  input: EnqueueInput,
): Promise<JobData> {
  return client.enqueue(resolveInput(input));
}

/**
 * Enqueue multiple jobs in a single request.
 *
 * @param client - The Zizq client to use for the HTTP request.
 * @param inputs - Array of job inputs.
 * @returns An array of created jobs in the same order as the input.
 *
 * @example
 * ```ts
 * const jobs = await enqueueBulk(client, [
 *   { type: sendEmail, payload: { to: "a@b.com" } },
 *   { type: sendEmail, payload: { to: "c@d.com" }, priority: 1 },
 *   { type: "manual_job", queue: "ops", payload: {} },
 * ]);
 * ```
 */
export async function enqueueBulk(
  client: Client,
  inputs: EnqueueInput[],
): Promise<JobData[]> {
  return client.enqueueBulk(inputs.map(resolveInput));
}

// --- Internal ---

// Compute the unique key from ZizqOptions + payload.
function computeUniqueKey(
  opts: ZizqOptions | undefined,
  payload: unknown,
): string | undefined {
  if (!opts?.uniqueKey) return undefined;

  if (typeof opts.uniqueKey === "function") {
    return opts.uniqueKey(payload);
  }

  return opts.uniqueKey;
}

// Resolve an EnqueueInput into a low-level EnqueueOptions by merging
// inline fields with zizqOptions defaults.
function resolveInput(input: EnqueueInput): EnqueueOptions {
  let jobType: string;
  let defaults: ZizqOptions | undefined;

  if (typeof input.type === "function") {
    defaults = input.type.zizqOptions;
    jobType = defaults?.type ?? input.type.name;

    if (!jobType) {
      throw new Error(
        "Job function must have a name or zizqOptions.type"
      );
    }
  } else {
    jobType = input.type;
  }

  const queue = input.queue ?? defaults?.queue;

  if (!queue) {
    throw new Error(`No queue specified for job type "${jobType}"`);
  }

  const uniqueKey =
    input.uniqueKey ?? computeUniqueKey(defaults, input.payload);

  const uniqueWhile =
    input.uniqueWhile ?? defaults?.uniqueWhile;

  return {
    type: jobType,
    queue,
    payload: input.payload,
    priority: input.priority ?? defaults?.priority,
    readyAt: input.readyAt,
    retryLimit: input.retryLimit ?? defaults?.retryLimit,
    backoff: input.backoff ?? defaults?.backoff,
    retention: input.retention,
    uniqueKey,
    uniqueWhile: uniqueKey ? uniqueWhile : undefined,
  };
}
