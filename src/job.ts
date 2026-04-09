// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Rich job object returned by all Client methods.
 *
 * Wraps the raw job data with a reference to the Client, enabling
 * action methods like `delete()` and `complete()` directly on the job.
 *
 * All job fields are exposed as readonly properties.
 *
 * @module
 */

import type {
  Client,
  JobStatus,
  UniqueScope,
  BackoffConfig,
  RetentionConfig,
  FailureOptions,
} from "./client.ts";

/** Internal raw job data shape (camelCase, as returned by the API translation layer). */
export interface JobData {
  /** Unique job identifier. */
  id: string;

  /** Job type, e.g. "send_email". */
  type: string;

  /** Queue this job belongs to. */
  queue: string;

  /** Priority (0 - 65536, lower number = higher priority). */
  priority: number;

  /** Lifecycle status. */
  status: JobStatus;

  /**
   * Arbitrary payload provided by the enqueuer.
   *
   * Not present on metadata-only requests.
   */
  payload?: unknown;

  /** When the job becomes eligible to run (ms since Unix epoch). */
  readyAt: number;

  /** Number of times this job has been previously attempted. */
  attempts: number;

  /** Maximum retries before the job is killed. */
  retryLimit?: number;

  /** Per-job backoff configuration. */
  backoff?: BackoffConfig;

  /** When the job was last dequeued (ms since Unix epoch). */
  dequeuedAt?: number;

  /** When the job last failed (ms since Unix epoch). */
  failedAt?: number;

  /** When the job was completed (ms since Unix epoch). */
  completedAt?: number;

  /** Per-job retention configuration. */
  retention?: RetentionConfig;

  /** When the reaper will hard-delete this job (ms since Unix epoch). */
  purgeAt?: number;

  /** Unique key used for enqueue-time deduplication. */
  uniqueKey?: string;

  /** Uniqueness scope. */
  uniqueWhile?: UniqueScope;

  /** True if this job was returned as a duplicate (enqueue responses only). */
  duplicate?: boolean;
}

/**
 * A job returned by the Zizq server.
 *
 * Provides readonly access to all job fields plus action methods that
 * operate on this job via the Client.
 *
 * @example
 * ```ts
 * const job = await client.enqueue({ type: "send_email", queue: "emails", payload: {} });
 * console.log(job.id, job.status);
 *
 * // Mark as complete
 * await job.complete();
 * ```
 */
export class Job {
  /** Unique job identifier. */
  readonly id: string;

  /** Job type, e.g. "send_email". */
  readonly type: string;

  /** Queue this job belongs to. */
  readonly queue: string;

  /** Priority (0 - 65536, lower number = higher priority). */
  readonly priority: number;

  /** Lifecycle status. */
  readonly status: JobStatus;

  /**
   * Arbitrary payload provided by the enqueuer.
   *
   * Not present on metadata-only requests.
   */
  readonly payload?: unknown;

  /** When the job becomes eligible to run (ms since Unix epoch). */
  readonly readyAt: number;

  /** Number of times this job has been previously attempted. */
  readonly attempts: number;

  /** Maximum retries before the job is killed. */
  readonly retryLimit?: number;

  /** Per-job backoff configuration. */
  readonly backoff?: BackoffConfig;

  /** When the job was last dequeued (ms since Unix epoch). */
  readonly dequeuedAt?: number;

  /** When the job last failed (ms since Unix epoch). */
  readonly failedAt?: number;

  /** When the job was completed (ms since Unix epoch). */
  readonly completedAt?: number;

  /** Per-job retention configuration. */
  readonly retention?: RetentionConfig;

  /** When the reaper will hard-delete this job (ms since Unix epoch). */
  readonly purgeAt?: number;

  /** Unique key used for enqueue-time deduplication. */
  readonly uniqueKey?: string;

  /** Uniqueness scope. */
  readonly uniqueWhile?: UniqueScope;

  /** True if this job was returned as a duplicate (enqueue responses only). */
  readonly duplicate?: boolean;

  /** @internal */
  private client: Client;

  /** @internal */
  constructor(client: Client, data: JobData) {
    this.client = client;
    this.id = data.id;
    this.type = data.type;
    this.queue = data.queue;
    this.priority = data.priority;
    this.status = data.status;
    this.payload = data.payload;
    this.readyAt = data.readyAt;
    this.attempts = data.attempts;
    this.retryLimit = data.retryLimit;
    this.backoff = data.backoff;
    this.dequeuedAt = data.dequeuedAt;
    this.failedAt = data.failedAt;
    this.completedAt = data.completedAt;
    this.retention = data.retention;
    this.purgeAt = data.purgeAt;
    this.uniqueKey = data.uniqueKey;
    this.uniqueWhile = data.uniqueWhile;
    this.duplicate = data.duplicate;
  }

  /** Mark this job as successfully completed. */
  async complete(): Promise<void> {
    return this.client.reportSuccess(this.id);
  }

  /**
   * Report this job as failed.
   *
   * @param options - Error details (message, stack trace, etc.).
   * @returns The updated job with new status and attempt count.
   */
  async fail(options: FailureOptions): Promise<Job> {
    return this.client.reportFailure(this.id, options);
  }

  /** Return the raw job data as a plain object. */
  toJSON(): JobData {
    return {
      id: this.id,
      type: this.type,
      queue: this.queue,
      priority: this.priority,
      status: this.status,
      payload: this.payload,
      readyAt: this.readyAt,
      attempts: this.attempts,
      retryLimit: this.retryLimit,
      backoff: this.backoff,
      dequeuedAt: this.dequeuedAt,
      failedAt: this.failedAt,
      completedAt: this.completedAt,
      retention: this.retention,
      purgeAt: this.purgeAt,
      uniqueKey: this.uniqueKey,
      uniqueWhile: this.uniqueWhile,
      duplicate: this.duplicate,
    };
  }
}
