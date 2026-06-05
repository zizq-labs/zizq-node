// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Type-based job dispatch.
 *
 * @module
 */

import type { Job } from "./resources.ts";
import type { JobHandler } from "./handler.ts";

/**
 * Handler for a specific job type.
 *
 * Receives the unwrapped `payload` (the JSON body of the job) along with the
 * full `Job` for access to metadata like `id`, `type`, or `attempts`. Most
 * handlers will only need the payload — JS lets you omit the second arg.
 */
export type RouteHandler = (
  /**
   * The payload of the job to be performed, equivalent to `job.payload`.
   */
  payload: unknown,

  /**
   * The full `Job` resource received from the server.
   */
  job: Job,
) => Promise<void> | void;

/**
 * Thrown when a job arrives with no registered route and no fallback.
 *
 * Caught by the worker's normal failure path: the job is nacked for retry,
 * and eventually dead-lettered once the retry limit is hit.
 */
export class UnknownJobTypeError extends Error {
  /**
   * The name of the unhandled job type.
   */
  readonly type: string;

  constructor(type: string) {
    super(`No handler registered for job type "${type}"`);
    this.name = "UnknownJobTypeError";
    this.type = type;
  }
}

/**
 * Dispatch jobs by `type` string to registered handler functions.
 *
 * Designed for cross-language workflows: payloads are plain JSON values
 * (objects / arrays / strings / numbers), `type` is a string the producer
 * agrees on with the consumer, and routes are registered explicitly.
 *
 * @example
 * ```ts
 * import { Worker, Router } from "@zizq-labs/zizq";
 *
 * const router = new Router()
 *   .route("send_email", async (payload, job) => {
 *     await mailer.send(payload.to);
 *   })
 *   .route("generate_report", async (payload) => {
 *     await reports.generate(payload.id);
 *   })
 *   .fallback(async (job) => {
 *     console.warn(`Unhandled job type: ${job.type}`);
 *   });
 *
 * const worker = new Worker({ client, handler: router.build() });
 * ```
 *
 * If no route matches and no fallback is registered, the dispatcher throws
 * `UnknownJobTypeError`, which the worker treats as a normal job failure
 * (retried per the backoff policy, eventually dead-lettered).
 */
export class Router {
  private readonly routes = new Map<string, RouteHandler>();
  private fallbackHandler: JobHandler | null = null;

  /**
   * Register `handler` for jobs whose `type` matches.
   *
   * Returns `this` for chaining.
   *
   * Re-registering a type replaces the previous handler. This supports
   * builder-style composition — e.g. starting from a router that supplies
   * defaults and selectively overriding individual routes.
   */
  route(type: string, handler: RouteHandler): this {
    this.routes.set(type, handler);
    return this;
  }

  /**
   * Register a fallback handler invoked when no route matches.
   *
   * Receives the full `Job` (not split into a payload/job pair). Since a
   * fallback has the same signature as a `JobHandler`, you can delegate
   * straight to another router's compiled handler:
   *
   * ```ts
   * router.fallback(otherRouter.build());
   * ```
   *
   * Returns `this` for chaining. Calling `fallback` again replaces the
   * previous handler.
   */
  fallback(handler: JobHandler): this {
    this.fallbackHandler = handler;
    return this;
  }

  /**
   * Compile this router into a `JobHandler` suitable for the worker.
   *
   * The returned function dispatches each incoming job: routes match by
   * `job.type`, then the fallback (if any), otherwise throws
   * `UnknownJobTypeError`.
   */
  build(): JobHandler {
    const routes = this.routes;
    const fallback = this.fallbackHandler;
    return async (job: Job) => {
      const handler = routes.get(job.type);
      if (handler) {
        await handler(job.payload, job);
        return;
      }
      if (fallback) {
        await fallback(job);
        return;
      }
      throw new UnknownJobTypeError(job.type);
    };
  }
}
