// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * In-process worker that takes jobs from the Zizq server and dispatches
 * them to a single handler function.
 *
 * The handler can either route jobs manually (e.g. via a `switch` on
 * `job.type`) or use `buildHandler([...])` to build a dispatcher
 * from an array of named `JobFunction`s.
 *
 * @example Function-based dispatch
 * ```ts
 * import { Client, Worker, buildHandler } from "@zizq-labs/zizq";
 *
 * async function sendEmail(payload) { ... }
 * sendEmail.zizqOptions = { queue: "emails" };
 *
 * async function generateReport(payload) { ... }
 * generateReport.zizqOptions = { queue: "reports" };
 *
 * const client = new Client({ url: "http://localhost:7890" });
 * const worker = new Worker({
 *   client,
 *   concurrency: 10,
 *   handler: buildHandler([sendEmail, generateReport]),
 * });
 *
 * // Blocks until stopped.
 * await worker.run();
 * ```
 *
 * @example Manual dispatch (low-level / cross-language)
 * ```ts
 * const worker = new Worker({
 *   client,
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
  Job,
  type TakeOptions,
  type FailureOptions,
} from "./client.ts";

import type { JobHandler } from "./handler.ts";

/**
 * Options for constructing a {@link Worker}.
 */
export interface WorkerOptions {
  /** Zizq client instance to use for all server communication. */
  client: Client;

  /**
   * Handler function called for every job received.
   *
   * For function-based dispatch (looking up handlers by job type), use
   * `buildHandler([...])` to build a dispatcher from an array
   * of `JobFunction`s.
   *
   * @example Manual dispatch
   * ```ts
   * new Worker({
   *   client,
   *   handler: async (job) => {
   *     switch (job.type) {
   *       case "charge_card": return chargeCard(job.payload);
   *     }
   *   },
   * });
   * ```
   *
   * @example Function-based dispatch
   * ```ts
   * import { buildHandler } from "@zizq-labs/zizq";
   *
   * new Worker({
   *   client,
   *   handler: buildHandler([sendEmail, generateReport]),
   * });
   * ```
   */
  handler: JobHandler;

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
   * Logger for worker diagnostics (retry warnings, unrecoverable errors).
   *
   * Must implement at least an `error` method. Any logger that satisfies
   * this (console, pino, winston, etc.) works out of the box.
   *
   * Default: `console`.
   */
  logger?: Logger;

  /**
   * Retry configuration for transient HTTP failures (connection drops,
   * server errors). Applies to both the take stream (reconnection) and
   * ack/nack requests.
   *
   * This is unrelated to Zizq's job-level retry/backoff — it controls
   * how the worker retries its own communication with the server.
   *
   * Client errors (4xx) are never retried.
   */
  requestRetry?: RequestRetryOptions;
}

/**
 * Configuration for ack/nack retry backoff.
 *
 * The delay between retries follows: `min(initialDelay * multiplier^(attempt-1), maxDelay)`.
 */
export interface RequestRetryOptions {
  /**
   * Initial delay in milliseconds before the first retry.
   *
   * Default: 500.
   */
  initialDelay?: number;

  /**
   * Maximum delay in milliseconds between retries.
   *
   * Default: 30000 (30 seconds).
   */
  maxDelay?: number;

  /**
   * Multiplier applied to the delay after each failed attempt.
   *
   * Default: 2.
   */
  multiplier?: number;
}

/** Minimal logger interface used by the worker. */
export interface Logger {
  info(...args: unknown[]): void;
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
  private retryInitialDelay: number;
  private retryMaxDelay: number;
  private retryMultiplier: number;
  private handler: JobHandler;
  private abortController: AbortController | null = null;

  // Bulk ack batching buffer.
  // Success acks are buffered and flushed in a single bulk request.
  // The bulk ack is scheduled via queueMicrotask and only one bulk ack runs at
  // a time. While a bulk ack request is in flight, new acks accumulate and
  // are sent in the next batch.
  private pendingAcks: string[] = [];
  private ackFlushInFlight = false;
  private ackFlushPromise: Promise<void> = Promise.resolve();

  constructor(options: WorkerOptions) {
    this.client = options.client;
    this.handler = options.handler;
    this.concurrency = options.concurrency ?? 1;
    this.prefetch = options.prefetch ?? this.concurrency;
    this.logger = options.logger ?? console;
    this.retryInitialDelay = options.requestRetry?.initialDelay ?? 500;
    this.retryMaxDelay = options.requestRetry?.maxDelay ?? 30_000;
    this.retryMultiplier = options.requestRetry?.multiplier ?? 2;
    this.queues = options.queues ?? [];
  }

  /**
   * Start processing jobs. Blocks until {@link stop} is called.
   *
   * Opens a streaming connection to the server's take endpoint and
   * dispatches incoming jobs to the registered handlers concurrently.
   *
   * Automatically reconnects with exponential backoff if the connection
   * drops or the server is unreachable. The backoff is reset after a
   * successful connection. Uses the `requestRetry` configuration.
   *
   * On shutdown, waits for all in-flight jobs to complete and flushes
   * pending acks before returning.
   *
   * @example
   * ```ts
   * const worker = new Worker({ client, jobs: [sendEmail] });
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
    let attempt = 0;

    while (!this.abortController.signal.aborted) {
      const inFlight = new Set<Promise<void>>();

      try {
        const takeOpts: TakeOptions = {
          prefetch: this.prefetch,
          queues: this.queues.length > 0 ? this.queues : undefined,
          signal: this.abortController.signal,
        };

        const stream = await this.client.take(takeOpts);

        if (attempt > 0) {
          this.logger.info(`[zizq] reconnected to ${this.client.url}`);
        } else {
          this.logger.info(`[zizq] connected to ${this.client.url}`);
        }
        attempt = 0;

        for await (const job of stream) {
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
        } else if (err instanceof ClientError) {
          // Client errors are not transient — don't reconnect.
          throw err;
        } else {
          attempt++;
          const delay = Math.min(
            this.retryInitialDelay * Math.pow(this.retryMultiplier, attempt - 1),
            this.retryMaxDelay,
          );
          this.logger.error(
            `[zizq] disconnected from ${this.client.url} (attempt ${attempt}, reconnecting in ${delay}ms):`,
            err instanceof Error ? err.message : err,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      // Drain remaining in-flight jobs from this connection.
      if (inFlight.size > 0) {
        await Promise.allSettled(inFlight);
      }
    }

    // Wait for any in-flight ack flush to complete, then flush any
    // remaining acks that accumulated during the drain.
    await this.ackFlushPromise;
    await this.flushAcks();
    this.logger.info("[zizq] worker stopped");
  }

  /**
   * Signal the worker to stop processing.
   *
   * Aborts the take stream so no new jobs are received. The {@link run}
   * method will wait for any in-flight jobs to finish before returning.
   */
  stop(): void {
    this.logger.info("[zizq] stopping worker...");
    this.abortController?.abort();
  }

  /**
   * Process a single job: dispatch to the handler, then ack or fail.
   *
   * Success acks are batched — the job ID is buffered and a flush is
   * scheduled via `setImmediate`. This means the worker moves on to
   * the next job immediately without waiting for the ack round-trip.
   *
   * Failures are reported individually (they carry per-job error details)
   * and are retried on transient errors.
   */
  private async processJob(job: Job): Promise<void> {
    try {
      await this.handler(job);
      this.scheduleAck(job.id);
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
   * Buffer a success ack and schedule a flush.
   *
   * If a flush is already in flight, the ack simply accumulates in the
   * buffer; it will be picked up when the current flush completes and
   * schedules the next one.
   */
  private scheduleAck(id: string): void {
    this.pendingAcks.push(id);
    if (!this.ackFlushInFlight) {
      this.ackFlushInFlight = true;
      this.ackFlushPromise = new Promise<void>((resolve) => {
        setImmediate(() => this.flushAcks().then(resolve));
      });
    }
  }

  /**
   * Send all buffered acks in a single bulk request.
   *
   * After the request completes (or fails with retry), if more acks have
   * accumulated during the flush, schedule another flush immediately.
   */
  private async flushAcks(): Promise<void> {
    while (this.pendingAcks.length > 0) {
      const batch = this.pendingAcks;
      this.pendingAcks = [];
      await this.withRetry(() => this.client.reportSuccessBulk(batch));
    }
    this.ackFlushInFlight = false;
  }

  /**
   * Retry an async operation with exponential backoff for transient errors.
   *
   * Client errors (4xx) are not retried — they indicate a permanent problem
   * with the request. Connection errors and server errors (5xx) are retried
   * indefinitely with exponential backoff. Retry timing is configured via
   * `requestRetry` in `WorkerOptions`.
   */
  private async withRetry(fn: () => Promise<unknown>): Promise<void> {
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
        const delay = Math.min(
          this.retryInitialDelay * Math.pow(this.retryMultiplier, attempt - 1),
          this.retryMaxDelay,
        );
        this.logger.error(
          `[zizq] ack/nack failed (attempt ${attempt}, retrying in ${delay}ms):`,
          err instanceof Error ? err.message : err
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
