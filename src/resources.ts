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

import type { Client } from "./client.ts";
import type {
  JobStatus,
  UniqueScope,
  BackoffConfig,
  BatchConfig,
  RetentionConfig,
  EnqueueOptions,
  FailureOptions,
  UpdateJobOptions,
} from "./types.ts";

import { ErrorQuery, type ErrorQueryOptions } from "./query.ts";

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

  /**
   * True if this enqueue was folded into an existing pending batched
   * job (enqueue responses only).
   */
  folded?: boolean;

  /**
   * Batching configuration stored on this job. Present only for
   * batched jobs.
   */
  batch?: BatchConfig;
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

  /**
   * True if this enqueue was folded into an existing pending batched
   * job (enqueue responses only).
   */
  readonly folded?: boolean;

  /**
   * Batching configuration stored on this job. Present only for
   * batched jobs. The first enqueue's `when`/`fold` are the ones
   * that apply for the life of the batch, so this is the source of
   * truth for what's being evaluated on subsequent folds.
   */
  readonly batch?: BatchConfig;

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
    this.folded = data.folded;
    this.batch = data.batch;
  }

  /**
   * Return a lazy async iterator over error records for this job.
   *
   * Supports chainable builder methods for configuring order, limit,
   * and page size.
   *
   * @example
   * ```ts
   * for await (const error of job.errors()) {
   *   console.log(`Attempt ${error.attempt}: ${error.message}`);
   * }
   *
   * // Last 5 errors
   * const recent = await job.errors({ order: "desc", limit: 5 }).toArray();
   * ```
   */
  errors(options?: ErrorQueryOptions): ErrorQuery {
    return new ErrorQuery(this.client, this.id, options);
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

  /** Delete this job. */
  async delete(): Promise<void> {
    return this.client.deleteJob(this.id);
  }

  /**
   * Update this job's mutable fields.
   *
   * @param options - Fields to update. See `UpdateJobOptions` for null/undefined semantics.
   * @returns The updated job.
   */
  async update(options: UpdateJobOptions): Promise<Job> {
    return this.client.updateJob(this.id, options);
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
      folded: this.folded,
      batch: this.batch,
    };
  }
}

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
   * Delete all jobs on this page.
   *
   * @returns The number of deleted jobs.
   */
  async deleteAll(): Promise<number> {
    const ids = this.jobs.map((j) => j.id);
    if (ids.length === 0) return 0;
    return this.client.deleteAllJobs({ where: { id: ids } });
  }

  /**
   * Update all jobs on this page.
   *
   * @param apply - Fields to update. See `UpdateJobOptions` for null/undefined semantics.
   * @returns The number of updated jobs.
   */
  async updateAll(apply: UpdateJobOptions): Promise<number> {
    const ids = this.jobs.map((j) => j.id);
    if (ids.length === 0) return 0;
    return this.client.updateAllJobs({ where: { id: ids }, apply });
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

/** Camel-case data shape for a cron entry. */
export interface CronEntryData {
  /** Entry name (unique within the group). */
  name: string;

  /** Cron expression. */
  expression: string;

  /** IANA timezone name, or undefined for server default. */
  timezone?: string;

  /** Whether this entry is paused. */
  paused: boolean;

  /** When this entry was last paused (ms since epoch). */
  pausedAt?: number;

  /** When this entry was last resumed (ms since epoch). */
  resumedAt?: number;

  /** Job template that is enqueued on each tick. */
  job: EnqueueOptions;

  /** Next scheduled enqueue time (ms since epoch). */
  nextEnqueueAt?: number;

  /** Last enqueue time (ms since epoch). */
  lastEnqueueAt?: number;
}

/** Camel-case data shape for a cron group. */
export interface CronGroupData {
  /** Group name. */
  name: string;

  /** Whether the group is paused. */
  paused: boolean;

  /** Time zone applied to entries that do not specify one of their own. */
  timezone?: string;

  /** When the group was last paused (ms since epoch). */
  pausedAt?: number;

  /** When the group was last resumed (ms since epoch). */
  resumedAt?: number;

  /** Entries in this group. */
  entries: CronEntryData[];
}

/**
 * A cron entry returned by the Zizq server.
 *
 * Provides readonly access to all entry fields plus action methods.
 */
export class CronEntry {
  /** Entry name (unique within the group). */
  readonly name: string;

  /** Cron expression. */
  readonly expression: string;

  /** IANA timezone name, or undefined for server default. */
  readonly timezone?: string;

  /** Whether this entry is paused. */
  readonly paused: boolean;

  /** When this entry was last paused (ms since epoch). */
  readonly pausedAt?: number;

  /** When this entry was last resumed (ms since epoch). */
  readonly resumedAt?: number;

  /** Job template that is enqueued on each tick. */
  readonly job: EnqueueOptions;

  /** Next scheduled enqueue time (ms since epoch). */
  readonly nextEnqueueAt?: number;

  /** Last enqueue time (ms since epoch). */
  readonly lastEnqueueAt?: number;

  /** @internal */
  private client: Client;
  private group: string;

  /** @internal */
  constructor(client: Client, group: string, data: CronEntryData) {
    this.client = client;
    this.group = group;
    this.name = data.name;
    this.expression = data.expression;
    this.timezone = data.timezone;
    this.paused = data.paused;
    this.pausedAt = data.pausedAt;
    this.resumedAt = data.resumedAt;
    this.job = data.job;
    this.nextEnqueueAt = data.nextEnqueueAt;
    this.lastEnqueueAt = data.lastEnqueueAt;
  }

  /**
   * Pause this entry.
   *
   * When paused, the Zizq server sets `pausedAt` and stops enqueueing jobs for
   * the entry.
   */
  async pause(): Promise<CronEntry> {
    const data = await this.client.updateCronEntry(this.group, this.name, { paused: true });
    return new CronEntry(this.client, this.group, data);
  }

  /**
   * Resume this entry.
   *
   * When resumed, the Zizq server sets `resumedAt` and recommences enqueueing
   * jobs for the entry.
   */
  async resume(): Promise<CronEntry> {
    const data = await this.client.updateCronEntry(this.group, this.name, { paused: false });
    return new CronEntry(this.client, this.group, data);
  }

  /** Delete this entry from the group. */
  async delete(): Promise<void> {
    return this.client.deleteCronEntry(this.group, this.name);
  }
}

/**
 * A cron group returned by the Zizq server.
 *
 * Provides readonly access to group fields and its entries, plus action
 * methods for pausing, resuming, and deleting the group.
 */
export class CronGroup {
  /** Group name. */
  readonly name: string;

  /** Whether the group is paused. */
  readonly paused: boolean;

  /**
   * Time zone applied to entries that do not specify one of their own.
   *
   * Undefined when the group does not specify one, in which case those
   * entries are evaluated in the server's system time zone.
   */
  readonly timezone?: string;

  /** When the group was last paused (ms since epoch). */
  readonly pausedAt?: number;

  /** When the group was last resumed (ms since epoch). */
  readonly resumedAt?: number;

  /** Entries in this group. */
  readonly entries: CronEntry[];

  /** @internal */
  private client: Client;

  /** @internal */
  constructor(client: Client, data: CronGroupData) {
    this.client = client;
    this.name = data.name;
    this.paused = data.paused;
    this.timezone = data.timezone;
    this.pausedAt = data.pausedAt;
    this.resumedAt = data.resumedAt;
    this.entries = data.entries.map(e => new CronEntry(client, data.name, e));
  }

  /**
   * Pause this cron group.
   *
   * When paused the Zizq server sets `pausedAt` and stops enqueueing jobs for
   * all entries in the group, even if those entries are not paused.
   */
  async pause(): Promise<CronGroup> {
    const data = await this.client.updateCronGroup(this.name, { paused: true });
    return new CronGroup(this.client, data);
  }

  /**
   * Resume this cron group.
   *
   * When resumed the Zizq server sets `resumedAt` and recommences enqueueing
   * jobs for all unpaused entries in the group. Paused entries remain paused.
   */
  async resume(): Promise<CronGroup> {
    const data = await this.client.updateCronGroup(this.name, { paused: false });
    return new CronGroup(this.client, data);
  }

  /** Delete this cron group and all its entries. */
  async delete(): Promise<void> {
    return this.client.deleteCronGroup(this.name);
  }
}
