// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * In-process worker that takes jobs from the Zizq server and dispatches them.
 *
 * Supports two mutually exclusive modes:
 *
 * - **Function-based**: pass an array of named functions via `jobs`. The worker
 *   builds a dispatch table from each function's name (or `zizqOptions.type`)
 *   and automatically routes incoming jobs to the correct handler.
 *
 * - **Handler-based**: pass a single function via `handler`. The worker calls
 *   it for every job, leaving dispatch to the caller (e.g. via a `switch` on
 *   `job.type`).
 *
 * @example Function-based worker
 * ```ts
 * import { Worker } from "@zizq-labs/zizq";
 *
 * async function sendEmail(payload) { ... }
 * sendEmail.zizqOptions = { queue: "emails" };
 *
 * async function generateReport(payload) { ... }
 * generateReport.zizqOptions = { queue: "reports" };
 *
 * const worker = new Worker({
 *   url: "http://localhost:7890",
 *   concurrency: 10,
 *   jobs: [sendEmail, generateReport],
 * });
 *
 * // Blocks until stopped.
 * await worker.run();
 * ```
 *
 * @example Handler-based worker (low-level / cross-language)
 * ```ts
 * const worker = new Worker({
 *   url: "http://localhost:7890",
 *   queues: ["payments"],
 *   concurrency: 5,
 *   handler: async (job) => {
 *     switch (job.type) {
 *       case "charge_card": return chargeCard(job.payload);
 *       case "send_receipt": return sendReceipt(job.payload);
 *       default: throw new Error(`Unknown job type: ${job.type}`);
 *     }
 *   },
 * });
 *
 * await worker.run();
 * ```
 *
 * @example Graceful shutdown
 * ```ts
 * process.on("SIGTERM", () => worker.stop());
 * ```
 *
 * @module
 */

import {
  Client,
  ClientError,
  type JobData,
  type TakeOptions,
  type FailureOptions,
} from "./client.ts";

import type { JobFunction, JobHandler } from "./handler.ts";
import type { Dispatcher } from "undici";

/**
 * Options for constructing a {@link Worker}.
 *
 * Provide either `jobs` (function-based dispatch) or `handler` (manual
 * dispatch), but not both.
 */
export interface WorkerOptions {
  /** Base URL of the Zizq server, e.g. "http://localhost:7890". */
  url: string;

  /**
   * Maximum number of jobs to process concurrently.
   *
   * Default: 1 (sequential processing).
   */
  concurrency?: number;

  /**
   * Maximum number of unacknowledged jobs the server will send ahead.
   *
   * A higher prefetch than concurrency keeps jobs buffered in the stream
   * so there's always work ready when a processing slot opens, avoiding
   * a round-trip delay between finishing a job and starting the next.
   *
   * Default: same as `concurrency`.
   */
  prefetch?: number;

  /**
   * Queues to take jobs from.
   *
   * When omitted, the worker takes from all queues.
   */
  queues?: string[];

  /**
   * Array of job functions for automatic dispatch.
   *
   * Each function must have a `.name` or `zizqOptions.type` so the worker
   * can build a dispatch table mapping job types to handlers.
   *
   * Mutually exclusive with `handler`.
   */
  jobs?: JobFunction[];

  /**
   * Single handler function for manual dispatch.
   *
   * Called for every job received. The caller is responsible for routing
   * based on `job.type`.
   *
   * Mutually exclusive with `jobs`.
   */
  handler?: (job: JobData) => Promise<void> | void;

  /**
   * Logger for worker diagnostics (retry warnings, unrecoverable errors).
   *
   * Must implement at least an `error` method. Any logger that satisfies
   * this (console, pino, winston, etc.) works out of the box.
   *
   * Default: `console`.
   */
  logger?: Logger;

  /** @internal For testing — override the HTTP dispatcher. */
  dispatcher?: Dispatcher;
}

/** Minimal logger interface used by the worker. */
export interface Logger {
  error(...args: unknown[]): void;
}

/**
 * In-process worker that takes jobs from the Zizq server and dispatches them
 * to registered handlers.
 *
 * Manages concurrency via a prefetch-based flow control model: the server
 * sends up to `prefetch` unacknowledged jobs, and the worker processes
 * up to `concurrency` of them concurrently using `Promise.race` to stay
 * within the limit.
 *
 * Jobs that complete successfully are acknowledged automatically. Jobs that
 * throw are reported as failures (with error message, type, and stack trace),
 * and the server handles retry scheduling based on the backoff policy.
 */
export class Worker {
  private client: Client;
  private concurrency: number;
  private prefetch: number;
  private queues: string[];
  private logger: Logger;
  private dispatch: (job: JobData) => Promise<void>;
  private abortController: AbortController | null = null;

  constructor(options: WorkerOptions) {
    if (options.jobs && options.handler) {
      throw new Error("Provide either `jobs` or `handler`, not both.");
    }

    if (!options.jobs && !options.handler) {
      throw new Error("Provide either `jobs` or `handler`.");
    }

    this.client = new Client({
      url: options.url,
      dispatcher: options.dispatcher,
    });

    this.concurrency = options.concurrency ?? 1;
    this.prefetch = options.prefetch ?? this.concurrency;
    this.logger = options.logger ?? console;

    this.queues = options.queues ?? [];

    if (options.jobs) {
      const handlers = new Map<string, JobHandler>();

      for (const fn of options.jobs) {
        const typeName = fn.zizqOptions?.type ?? fn.name;

        if (!typeName) {
          throw new Error(
            "Job function must have a name or zizqOptions.type"
          );
        }

        handlers.set(typeName, fn);
      }

      this.dispatch = async (job: JobData) => {
        const handler = handlers.get(job.type);

        if (!handler) {
          throw new Error(`No handler registered for job type: ${job.type}`);
        }

        await handler(job.payload, job);
      };
    } else {
      this.dispatch = async (job: JobData) => {
        await options.handler!(job);
      };
    }
  }

  /**
   * Start processing jobs. Blocks until {@link stop} is called or the
   * connection is lost.
   *
   * Opens a streaming connection to the server's take endpoint and
   * dispatches incoming jobs to the registered handlers concurrently.
   * On shutdown, waits for all in-flight jobs to complete before returning.
   *
   * @example
   * ```ts
   * const worker = new Worker({ url: "http://localhost:7890", jobs: [sendEmail] });
   *
   * // In another context (e.g. signal handler):
   * process.on("SIGTERM", () => worker.stop());
   *
   * // Blocks here until stopped.
   * await worker.run();
   * ```
   */
  async run(): Promise<void> {
    this.abortController = new AbortController();
    const inFlight = new Set<Promise<void>>();

    const takeOpts: TakeOptions = {
      prefetch: this.prefetch,
      queues: this.queues.length > 0 ? this.queues : undefined,
      signal: this.abortController.signal,
    };

    try {
      for await (const job of this.client.take(takeOpts)) {
        if (this.abortController.signal.aborted) break;

        const task = this.processJob(job).finally(() => {
          inFlight.delete(task);
        });

        inFlight.add(task);

        // If we've hit concurrency limit, wait for one to finish.
        if (inFlight.size >= this.concurrency) {
          await Promise.race(inFlight);
        }
      }
    } catch (err) {
      if (this.abortController.signal.aborted) {
        // Expected — stop() was called.
      } else {
        throw err;
      }
    }

    // Drain remaining in-flight jobs.
    if (inFlight.size > 0) {
      await Promise.allSettled(inFlight);
    }
  }

  /**
   * Signal the worker to stop processing.
   *
   * Aborts the take stream so no new jobs are received. The {@link run}
   * method will wait for any in-flight jobs to finish before returning.
   */
  stop(): void {
    this.abortController?.abort();
  }

  /**
   * Process a single job: dispatch to the handler, then ack or fail.
   *
   * Both the success ack and the failure report are retried on transient
   * errors, since a lost ack leaves the job stuck in-flight permanently.
   */
  private async processJob(job: JobData): Promise<void> {
    try {
      await this.dispatch(job);
      await this.withRetry(() => this.client.reportSuccess(job.id));
    } catch (err) {
      const failure: FailureOptions = {
        message: err instanceof Error ? err.message : String(err),
        errorType: err instanceof Error ? err.constructor.name : undefined,
        backtrace: err instanceof Error ? err.stack : undefined,
      };
      await this.withRetry(() => this.client.reportFailure(job.id, failure));
    }
  }

  /**
   * Retry an async operation with exponential backoff for transient errors.
   *
   * Client errors (4xx) are not retried — they indicate a permanent problem
   * with the request. Connection errors and server errors (5xx) are retried
   * indefinitely with exponential backoff capped at 30 seconds.
   */
  private async withRetry(fn: () => Promise<unknown>): Promise<void> {
    const baseDelay = 500;
    const maxDelay = 30_000;
    let attempt = 0;

    while (true) {
      try {
        await fn();
        return;
      } catch (err) {
        // Client errors (4xx) are not transient — don't retry.
        if (err instanceof ClientError) {
          this.logger.error("[zizq] ack/nack rejected:", err.message);
          return;
        }

        attempt++;
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
        this.logger.error(
          `[zizq] ack/nack failed (attempt ${attempt}, retrying in ${delay}ms):`,
          err instanceof Error ? err.message : err
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
