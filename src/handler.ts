// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Job handler types and configuration.
 *
 * These types define how job functions are structured and configured. They
 * are used both at enqueue time (to read defaults from `zizqOptions`) and
 * at worker registration time (to build the dispatch table).
 *
 * @module
 */

import type {
  BackoffConfig,
  RetentionConfig,
  UniqueScope,
} from "./client.ts";
import type { Job } from "./job.ts";

/**
 * Configuration that can be attached to a job function via `fn.zizqOptions`.
 *
 * These options provide defaults when the function is used with `enqueue()`
 * or registered with a `Worker`. All fields are optional.
 *
 * @example
 * ```ts
 * async function sendEmail(payload) { ... }
 *
 * sendEmail.zizqOptions = {
 *   queue: "emails",
 *   priority: 100,
 *   retryLimit: 5,
 * };
 * ```
 */
export interface ZizqOptions {
  /**
   * Explicit job type name.
   *
   * When omitted, the function's `.name` property is used instead. Set this
   * if the function name could be mangled by minification.
   */
  type?: string;

  /** Default queue for this job. */
  queue?: string;

  /** Default priority (lower = higher priority). */
  priority?: number;

  /** Default retry limit before the job is killed. */
  retryLimit?: number;

  /** Default backoff configuration. */
  backoff?: BackoffConfig;

  /** Default retention configuration. */
  retention?: RetentionConfig;

  /**
   * Unique key for deduplication.
   *
   * Can be a static string or a function that computes the key from the
   * payload at enqueue time.
   */
  uniqueKey?: string | ((payload: unknown) => string);

  /** Uniqueness scope. Only used when `uniqueKey` is set. */
  uniqueWhile?: UniqueScope;
}

/**
 * A function that processes a job's payload.
 *
 * Receives the payload as the first argument and the full job data as the
 * second (for access to metadata like `id`, `type`, `attempts`, etc.).
 *
 * - Returning (or resolving) normally signals success.
 * - Throwing (or rejecting) signals failure.
 */
export type JobHandler = (payload: unknown, job: Job) => Promise<void> | void;

/**
 * A job handler function with optional Zizq configuration.
 *
 * This is the type expected by the `jobs` array in `WorkerOptions` and
 * by the `enqueue()` helper. Attach configuration via the `zizqOptions`
 * property.
 *
 * @example
 * ```ts
 * const sendEmail: JobFunction = async (payload) => {
 *   await mailer.send(payload.to, payload.subject);
 * };
 * sendEmail.zizqOptions = { queue: "emails" };
 * ```
 */
export interface JobFunction extends JobHandler {
  zizqOptions?: ZizqOptions;
}
