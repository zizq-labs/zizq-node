// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Job handler types and configuration.
 *
 * These types define how handlers and job functions are structured and
 * configured. They are used both at enqueue time (to read defaults fro
 * `zizqOptions`) and when building a handler for the worker (to build the
 * dispatch table).
 *
 * @module
 */

import type {
  BackoffConfig,
  EnqueueOptions,
  RetentionConfig,
  UniqueScope,
} from "./types.ts";

import type { Job } from "./resources.ts";
import { Router } from "./router.ts";

/**
 * Configuration that can be attached to a job function via `fn.zizqOptions`.
 *
 * These options provide defaults when the function is used with `enqueue()`
 * or registered with `buildHandler()`. All fields are optional.
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
   * job function (for metadata like the type name) and the payload at
   * enqueue time.
   *
   * For common cases, use the `uniqueKey(...fields)` helper from this
   * module, which returns a resolver that picks fields from the payload
   * and prefixes the job type automatically.
   */
  uniqueKey?: string | ((fn: JobFunction, payload: unknown) => string);

  /** Uniqueness scope. Only used when `uniqueKey` is set. */
  uniqueWhile?: UniqueScope;

  /**
   * Final transform applied to the resolved enqueue options before it is sent
   * to the server.
   *
   * Receives the fully-resolved `EnqueueOptions` (with defaults and
   * inline overrides already merged) along with the job payload. The transform
   * can mutate the options in place, or return a new object.
   *
   * Useful for dynamic adjustments that need to see the already-computed
   * values e.g. lowering priority for "important" payloads relative
   * to the default priority.
   *
   * @example
   * ```ts
   * sendEmail.zizqOptions = {
   *   queue: "emails",
   *   priority: 100,
   *   transform: (opts, payload) => {
   *     if ((payload as any).urgent) {
   *       opts.priority = Math.floor(opts.priority! / 2);
   *     }
   *   },
   * };
   * ```
   *
   * @example Composing multiple transforms
   * ```ts
   * function compose(...transforms: EnqueueTransform[]): EnqueueTransform {
   *   return (opts, payload) => {
   *     for (const t of transforms) opts = t(opts, payload);
   *     return opts;
   *   };
   * }
   *
   * sendEmail.zizqOptions = {
   *   transform: compose(doublePriority, tagWithUser),
   * };
   * ```
   */
  transform?: EnqueueTransform;
}

/**
 * A final transform applied to a resolved enqueue options before it is
 * sent to the server. May mutate `opts` in place, or return a new optsuest.
 */
export type EnqueueTransform = (
  opts: EnqueueOptions,
  payload: unknown,
) => EnqueueOptions | void;

/**
 * Top-level function that processes a single job dispatched by the worker.
 *
 * Receives the full job, with `job.payload` for the user-supplied payload
 * and metadata like `job.id`, `job.type`, `job.attempts`, etc.
 *
 * This would typically be implemented with an internal lookup table or switch
 * statement based on the queue/type.
 *
 * - Returning (or resolving) normally signals success.
 * - Throwing (or rejecting) signals failure.
 */
export type JobHandler = (job: Job) => Promise<void> | void;

/**
 * A user-defined job function.
 *
 * Use the `job` argument to access metadata like `id`, `type`, or `attempts`.
 *
 * The worker always passes both `payload` and `job`, but most handlers
 * likely only declare `payload` unless they explicitly need full access to the
 * job.
 *
 * Most handlers only need the payload:
 *
 * ```ts
 * const sendEmail: JobFunction = async (payload) => {
 *   await mailer.send(payload.to, payload.subject);
 * };
 * sendEmail.zizqOptions = { queue: "emails" };
 * ```
 *
 * Handlers that need job metadata can take both:
 *
 * ```ts
 * const retryWithBackoff: JobFunction = async (payload, job) => {
 *   if (job.attempts > 3) { ... }
 * };
 * ```
 *
 * Use `buildHandler([...])` to wrap an array of `JobFunction`s
 * into a single `JobHandler` for the `Worker`.
 */
export interface JobFunction {
  /** Function signature for the handler function. */
  (payload: unknown, job: Job): Promise<void> | void;

  /** Optional defaults and configuration for this job */
  zizqOptions?: ZizqOptions;
}

/**
 * Build a `JobHandler` that dispatches incoming jobs to the matching
 * function from an array, looking up by `zizqOptions.type` (or `.name`).
 *
 * Works with plain JS functions, named functions, and `JobFunction`s with
 * attached `zizqOptions`. Each function is called with `(payload, job)`.
 *
 * @example
 * ```ts
 * import { Worker, buildHandler } from "@zizq-labs/zizq";
 *
 * async function sendEmail(payload) { ... }
 * sendEmail.zizqOptions = { queue: "emails" };
 *
 * const worker = new Worker({
 *   client,
 *   handler: buildHandler([sendEmail, generateReport]),
 * });
 * ```
 *
 * @throws If any function lacks a name or `zizqOptions.type`, or if two
 *   functions resolve to the same type.
 */
export function buildHandler(jobs: JobFunction[]): JobHandler {
  const seen = new Set<string>();
  const router = new Router();

  for (const fn of jobs) {
    const typeName = fn.zizqOptions?.type ?? fn.name;
    if (!typeName) {
      throw new Error(
        "Job function must have a name or zizqOptions.type"
      );
    }
    if (seen.has(typeName)) {
      throw new Error(`Duplicate job type registered: "${typeName}"`);
    }
    seen.add(typeName);
    router.route(typeName, fn);
  }

  return router.build();
}
