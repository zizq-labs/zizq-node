// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Typed wrappers over API responses.
 *
 * These classes wrap raw API data with a Client reference, providing
 * action methods and pagination helpers.
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

// --- JobData ---

/** Raw job data shape (camelCase, as returned by the API translation layer). */
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

// --- Job ---

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

// --- JobPage ---

/**
 * A page of jobs returned by `Client.listJobs()`.
 *
 * Contains the jobs on this page and methods to navigate to adjacent pages.
 *
 * @example
 * ```ts
 * let page = await client.listJobs({ queue: ["emails"], limit: 10 });
 *
 * while (page) {
 *   for (const job of page) {
 *     console.log(job.id, job.status);
 *   }
 *   page = await page.nextPage();
 * }
 * ```
 */
export class JobPage {
  /** The jobs on this page. */
  readonly jobs: Job[];

  /** @internal */
  private client: Client;
  private nextUrl: string | null;
  private prevUrl: string | null;

  /** @internal */
  constructor(client: Client, jobs: Job[], pages: { next?: string | null; prev?: string | null }) {
    this.client = client;
    this.jobs = jobs;
    this.nextUrl = pages.next ?? null;
    this.prevUrl = pages.prev ?? null;
  }

  /** Whether there is a next page. */
  get hasNext(): boolean {
    return this.nextUrl !== null;
  }

  /** Whether there is a previous page. */
  get hasPrev(): boolean {
    return this.prevUrl !== null;
  }

  /** Iterate over the jobs on this page. */
  [Symbol.iterator](): IterableIterator<Job> {
    return this.jobs[Symbol.iterator]();
  }

  /**
   * Fetch the next page, or `null` if this is the last page.
   */
  async nextPage(): Promise<JobPage | null> {
    if (!this.nextUrl) return null;
    return this.client.listJobsByPath(this.nextUrl);
  }

  /**
   * Fetch the previous page, or `null` if this is the first page.
   */
  async prevPage(): Promise<JobPage | null> {
    if (!this.prevUrl) return null;
    return this.client.listJobsByPath(this.prevUrl);
  }
}

// --- ErrorRecord ---

/** Raw error record data (camelCase). */
export interface ErrorRecordData {
  /** Which attempt this error corresponds to (1-based). */
  attempt: number;
  /** Error message from the worker. */
  message: string;
  /** Error class, e.g. "TimeoutError". */
  errorType?: string;
  /** Stack trace / backtrace. */
  backtrace?: string;
  /** When the job was dequeued for this attempt (ms since Unix epoch). */
  dequeuedAt: number;
  /** When the job failed (ms since Unix epoch). */
  failedAt: number;
}

/**
 * An error record for a failed job attempt.
 */
export class ErrorRecord {
  /** Which attempt this error corresponds to (1-based). */
  readonly attempt: number;
  /** Error message from the worker. */
  readonly message: string;
  /** Error class, e.g. "TimeoutError". */
  readonly errorType?: string;
  /** Stack trace / backtrace. */
  readonly backtrace?: string;
  /** When the job was dequeued for this attempt (ms since Unix epoch). */
  readonly dequeuedAt: number;
  /** When the job failed (ms since Unix epoch). */
  readonly failedAt: number;

  /** @internal */
  constructor(data: ErrorRecordData) {
    this.attempt = data.attempt;
    this.message = data.message;
    this.errorType = data.errorType;
    this.backtrace = data.backtrace;
    this.dequeuedAt = data.dequeuedAt;
    this.failedAt = data.failedAt;
  }
}

// --- ErrorPage ---

/**
 * A page of error records returned by `Client.listErrors()`.
 *
 * @example
 * ```ts
 * let page = await client.listErrors("job-id");
 *
 * for (const error of page) {
 *   console.log(`Attempt ${error.attempt}: ${error.message}`);
 * }
 * ```
 */
export class ErrorPage {
  /** The error records on this page. */
  readonly errors: ErrorRecord[];

  /** @internal */
  private client: Client;
  private nextUrl: string | null;
  private prevUrl: string | null;

  /** @internal */
  constructor(client: Client, errors: ErrorRecord[], pages: { next?: string | null; prev?: string | null }) {
    this.client = client;
    this.errors = errors;
    this.nextUrl = pages.next ?? null;
    this.prevUrl = pages.prev ?? null;
  }

  /** Whether there is a next page. */
  get hasNext(): boolean {
    return this.nextUrl !== null;
  }

  /** Whether there is a previous page. */
  get hasPrev(): boolean {
    return this.prevUrl !== null;
  }

  /** Iterate over the error records on this page. */
  [Symbol.iterator](): IterableIterator<ErrorRecord> {
    return this.errors[Symbol.iterator]();
  }

  /**
   * Fetch the next page, or `null` if this is the last page.
   */
  async nextPage(): Promise<ErrorPage | null> {
    if (!this.nextUrl) return null;
    return this.client.listErrorsByPath(this.nextUrl);
  }

  /**
   * Fetch the previous page, or `null` if this is the first page.
   */
  async prevPage(): Promise<ErrorPage | null> {
    if (!this.prevUrl) return null;
    return this.client.listErrorsByPath(this.prevUrl);
  }
}
