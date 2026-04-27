// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Low-level HTTP client for the Zizq job queue server.
 *
 * @example Basic usage
 * ```ts
 * import { Client } from "@zizq-labs/zizq";
 *
 * const client = new Client({ url: "http://localhost:7890" });
 *
 * // Enqueue a job
 * const job = await client.enqueue({
 *   type: "send_email",
 *   queue: "emails",
 *   payload: { to: "user@example.com", subject: "Hello" },
 * });
 * console.log(job.id); // "03fvqh..."
 *
 * // Take and process jobs (streaming)
 * for await (const job of client.take({ prefetch: 5, queues: ["emails"] })) {
 *   try {
 *     await processJob(job);
 *     await client.reportSuccess(job.id);
 *   } catch (err) {
 *     await client.reportFailure(job.id, { message: err.message });
 *   }
 * }
 *
 * await client.close();
 * ```
 *
 * @module
 */

import { Pool, type Dispatcher } from "undici";
import type { Readable } from "node:stream";
import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";
import { Job, JobPage, ErrorRecord, ErrorPage, type JobData, type ErrorRecordData } from "./resources.ts";
import { JobQuery, type JobQueryOptions } from "./query.ts";

/** Lifecycle status of a job. */
export type JobStatus = "ready" | "in_flight" | "scheduled" | "completed" | "dead";

/** Sort direction for paginated listings. */
export type SortDirection = "asc" | "desc";

/** Uniqueness scope for deduplication. */
export type UniqueScope = "queued" | "active" | "exists";

// Re-export resource types so consumers can import from client.ts.
export { Job, JobPage, ErrorRecord, ErrorPage, type JobData, type ErrorRecordData } from "./resources.ts";

/**
 * Backoff configuration for retry delays.
 *
 * This is used in the following formula:
 *
 * ```
 * t = baseMs + (attempts ** exponent) + (attempts * random() * jitterMs)
 * ```
 *
 * The random jitter is designed to ensure clusters of failed jobs do not all
 * retry at the same time but are instead randomly spread out.
 */
export interface BackoffConfig {
  /** Base delay in milliseconds, applied to all retries. */
  baseMs: number;

  /** Backoff curve steepness (attempts ** exponent). */
  exponent: number;

  /** Maximum random jitter in milliseconds per attempt multiplier. */
  jitterMs: number;
}

/**
 * Retention configuration controlling how long jobs in terminal statuses are kept.
 *
 * The terminal statuses are "completed" and "dead".
 */
export interface RetentionConfig {
  /** How long completed jobs remain visible (ms). `null` clears to server default. */
  completedMs?: number | null;

  /** How long dead jobs remain visible (ms). `null` clears to server default. */
  deadMs?: number | null;
}

/**
 * Options for enqueueing a single job.
 *
 * @example
 * ```ts
 * await client.enqueue({
 *   type: "generate_report",
 *   queue: "reports",
 *   payload: { reportId: 42 },
 *   priority: 100,            // optional, lower = higher priority
 *   readyAt: Date.now() + 60000, // optional, delay by 1 minute
 * });
 * ```
 */
export interface EnqueueOptions {
  /** Job type identifier. */
  type: string;

  /**
   * Target queue name.
   *
   * Must be valid UTF-8 and must not contain any of the following reserved
   * characters: ",", "?", "*", "[", "]", "{", "}", "!".
   */
  queue: string;

  /**
   * Arbitrary payload delivered to the worker.
   */
  payload: unknown;

  /**
   * Optional priority (lower = higher priority).
   *
   * Valid range is 0 to 65536. Default: 32768.
   */
  priority?: number;

  /**
   * Optional timestamp (ms since epoch) when the job becomes eligible.
   *
   * When set to a future timestamp the job is created in the "scheduled"
   * status. Otherwise the job is created in the "ready" status.
   */
  readyAt?: number;

  /**
   * Optional per-job retry limit.
   *
   * When not set the server default value applies.
   */
  retryLimit?: number;

  /** Optional per-job backoff configuration. */
  backoff?: BackoffConfig;

  /** Optional per-job retention configuration. */
  retention?: RetentionConfig;

  /**
   * Optional unique key for enqueue-time deduplication.
   *
   * Requires a pro license on the server.
   *
   * The key is global across all queues and job types. Prefix with the job
   * type to make it unique per job type.
   */
  uniqueKey?: string;

  /**
   * Uniqueness scope. Only valid when `uniqueKey` is set.
   *
   * When set to "queued" other jobs with the same key will not be enqueued as
   * long as this job is in the "scheduled" or "ready" statuses.
   *
   * When set to "active" other jobs with the same key will not be enqueued
   * while this job is in the "scheduled", "ready" or "in_flight" statuses.
   *
   * When set to "exists" other jobs with the same key will not be enqueued
   * for as long as this job remains on the server (i.e. until it is eventually
   * reaped, based on the retention policy).
   */
  uniqueWhile?: UniqueScope;
}

/** Options for reporting a job failure. */
export interface FailureOptions {
  /** Error message describing what went wrong. */
  message: string;

  /** Optional error class name, e.g. "TimeoutError". */
  errorType?: string;

  /** Optional stack trace from the worker. */
  backtrace?: string;

  /** Optional forced retry time (ms since epoch), bypassing backoff. */
  retryAt?: number;

  /**
   * Kill the job immediately regardless of retry limit.
   *
   * Note: passing false does nothing.
   */
  kill?: boolean;
}

/**
 * Options for the streaming take endpoint.
 *
 * Returns an async generator which never terminates as long as the connection
 * to the server remains open. Clients should use `break` to explicitly
 * disconnect from the endpoint and stop receiving jobs.
 *
 * When no jobs are available, the generator waits until new jobs are enqueued.
 *
 * @example
 * ```ts
 * // Take up to 10 jobs at a time from specific queues
 * for await (const job of client.take({ prefetch: 10, queues: ["emails", "webhooks"] })) {
 *   // process job...
 * }
 * ```
 */
export interface TakeOptions {
  /**
   * Maximum number of "in_flight", unacknowledged jobs the server will send.
   *
   * The default is 1, meaning the client must acknowledge or fail the job
   * before the server sends the next, and so on.
   */
  prefetch?: number;

  /** Only take jobs from these queues. Empty means all queues. */
  queues?: string[];

  /** AbortSignal to cancel the streaming connection. */
  signal?: AbortSignal;
}

/**
 * Options for listing jobs with cursor-based pagination.
 *
 * @example
 * ```ts
 * const page = await client.listJobs({
 *   queue: "emails",
 *   status: ["ready", "in_flight"],
 *   limit: 20,
 * });
 * ```
 */
export interface ListJobsOptions {
  /** Cursor: start after this job ID (exclusive). */
  from?: string;

  /** Sort order. Default: "asc" (oldest first). */
  order?: SortDirection;

  /** Maximum number of jobs per page (1–2000, default 50). */
  limit?: number;

  /** Filter by status. Accepts a single value or an array. */
  status?: JobStatus | JobStatus[];

  /** Filter by queue name. Accepts a single value or an array. */
  queue?: string | string[];

  /** Filter by job type. Accepts a single value or an array. */
  type?: string | string[];

  /** Filter by job ID. Accepts a single value or an array. */
  id?: string | string[];

  /** jq expression to filter jobs by payload. */
  filter?: string;
}

/**
 * Options for listing error records for a job.
 *
 * @example
 * ```ts
 * const page = await client.listErrors("job-id", { order: "desc", limit: 10 });
 * ```
 */
export interface ListErrorsOptions {
  /** Cursor: start after this attempt number (exclusive). */
  from?: number;

  /** Sort order. Default: "asc" (oldest first). */
  order?: SortDirection;

  /** Maximum number of error records per page (1–2000, default 50). */
  limit?: number;
}

/**
 * Mutable fields for updating a job.
 *
 * Field semantics:
 * - **omitted or `undefined`** — leave unchanged
 * - **`null`** — clear the field (only valid for nullable fields)
 * - **a value** — update to that value
 *
 * Nullable fields: `readyAt`, `retryLimit`, `backoff`, `retention`.
 * Non-nullable fields: `queue`, `priority`.
 *
 * @example
 * ```ts
 * // Change priority and clear retry limit (use server default)
 * await client.updateJob("job-id", {
 *   priority: 100,
 *   retryLimit: null,
 * });
 * ```
 */
export interface UpdateJobOptions {
  /** Move the job to a different queue. */
  queue?: string;

  /** Change the job's priority. */
  priority?: number;

  /** Change when the job becomes ready (ms since epoch). `null` clears to immediately ready. */
  readyAt?: number | null;

  /** Override the retry limit. `null` clears to server default. */
  retryLimit?: number | null;

  /** Override the backoff config. `null` clears to server default. */
  backoff?: BackoffConfig | null;

  /** Override the retention config. `null` clears to server default. */
  retention?: RetentionConfig | null;
}

/**
 * Options for bulk-updating jobs.
 *
 * Has two parts:
 * - `where` — filter selecting which jobs to update (same as `deleteAllJobs`)
 * - `apply` — fields to update on the matching jobs (same as `updateJob`)
 *
 * An empty array filter (e.g. `where.id: []`) short-circuits to 0 jobs updated.
 *
 * @example
 * ```ts
 * // Lower the priority of all dead jobs in the emails queue
 * const count = await client.updateAllJobs({
 *   where: { queue: "emails", status: "dead" },
 *   apply: { priority: 1000 },
 * });
 * ```
 */
export interface UpdateAllJobsOptions {
  /** Filter selecting which jobs to update. */
  where?: JobFilter;

  /** Fields to update on the matching jobs. */
  apply: UpdateJobOptions;
}

/**
 * Filter for selecting jobs in bulk operations.
 *
 * Used by `deleteAllJobs` and `updateAllJobs` to scope which jobs are
 * affected. An empty filter selects all jobs.
 *
 * Multi-value fields accept either a single value or an array.
 */
export interface JobFilter {
  /** Filter by job ID. Accepts a single value or an array. */
  id?: string | string[];

  /** Filter by status. Accepts a single value or an array. */
  status?: JobStatus | JobStatus[];

  /** Filter by queue name. Accepts a single value or an array. */
  queue?: string | string[];

  /** Filter by job type. Accepts a single value or an array. */
  type?: string | string[];

  /** jq expression to filter jobs by payload. */
  filter?: string;
}

/**
 * Options for bulk-deleting jobs.
 *
 * An empty `where` filter deletes all jobs.
 *
 * @example
 * ```ts
 * // Delete all dead jobs in the emails queue
 * const count = await client.deleteAllJobs({
 *   where: { queue: "emails", status: "dead" },
 * });
 * ```
 */
export interface DeleteAllJobsOptions {
  /** Filter selecting which jobs to delete. */
  where?: JobFilter;
}


// --- API response shapes (used internally for type-safe casting) ---

/** Response shape for `GET /jobs`. */
interface ListJobsResponse {
  jobs: unknown[];
  pages: { self?: string; next?: string; prev?: string };
}

/** Response shape for `GET /health`. */
interface HealthResponse {
  status: string;
}

/** Response shape for `GET /version`. */
interface VersionResponse {
  version: string;
}

/** Response shape for `GET /queues`. */
interface QueuesResponse {
  queues: string[];
}

/** Response shape for `DELETE /jobs`. */
interface DeleteJobsResponse {
  deleted: number;
}

/** Response shape for `GET /jobs/count`. */
interface CountJobsResponse {
  count: number;
}

/** Response shape for `PATCH /jobs`. */
interface PatchJobsResponse {
  patched: number;
}

/** Response shape for `GET /jobs/{id}/errors` */
interface ListErrorsResponse {
  errors: unknown[];
  pages: { self?: string; next?: string; prev?: string };
}


/**
 * TLS configuration for connecting to the Zizq server over HTTPS.
 *
 * Values are PEM-encoded strings or Buffers. If loading from files,
 * use `fs.readFileSync()`.
 *
 * @example
 * ```ts
 * import fs from "node:fs";
 *
 * const client = new Client({
 *   url: "https://localhost:7890",
 *   tls: {
 *     ca: fs.readFileSync("/path/to/ca.pem"),
 *     cert: fs.readFileSync("/path/to/client.pem"),
 *     key: fs.readFileSync("/path/to/client-key.pem"),
 *   },
 * });
 * ```
 */
export interface TlsOptions {
  /** PEM-encoded CA certificate(s) for verifying the server. */
  ca?: string | Buffer;

  /** PEM-encoded client certificate for mTLS. Must be paired with `key`. */
  cert?: string | Buffer;

  /** PEM-encoded client private key for mTLS. Must be paired with `cert`. */
  key?: string | Buffer;
}

/** Serialization format for client-server communication. */
export type Format = "json" | "msgpack";

/** Options for constructing a {@link Client}. */
export interface ClientOptions {
  /** Base URL of the Zizq server, e.g. "http://localhost:7890". */
  url: string;

  /**
   * Serialization format for request and response bodies.
   *
   * Default: "json".
   */
  format?: Format;

  /** TLS configuration for HTTPS connections. */
  tls?: TlsOptions;

  /** @internal For testing — override the HTTP dispatcher. */
  dispatcher?: Dispatcher;
}

/** Base error class for all Zizq errors. */
export class ZizqError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZizqError";
  }
}

/**
 * Network-level failure (connection refused, DNS, timeout, etc.).
 *
 * These are always transient and safe to retry.
 */
export class ConnectionError extends ZizqError {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

/**
 * HTTP error — the server returned a non-success status code.
 *
 * Carries the HTTP status code and (when available) the parsed response
 * body, which typically contains an `error` field with a human-readable
 * message from the server.
 */
export class ResponseError extends ZizqError {
  /** HTTP status code from the server. */
  status: number;

  /** Parsed response body, if available. */
  body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ResponseError";
    this.status = status;
    this.body = body;
  }
}

/** 4xx client error — the request was invalid. Not retryable. */
export class ClientError extends ResponseError {
  constructor(message: string, status: number, body?: unknown) {
    super(message, status, body);
    this.name = "ClientError";
  }
}

/** 404 specifically — job not found, etc. */
export class NotFoundError extends ClientError {
  constructor(message: string, body?: unknown) {
    super(message, 404, body);
    this.name = "NotFoundError";
  }
}

/** 5xx server error — something went wrong on the server. Retryable. */
export class ServerError extends ResponseError {
  constructor(message: string, status: number, body?: unknown) {
    super(message, status, body);
    this.name = "ServerError";
  }
}

/** Content-type headers for each format. */
const CONTENT_TYPES: Record<Format, string> = {
  json: "application/json",
  msgpack: "application/msgpack",
};

/** Accept headers for the streaming take endpoint. */
const STREAM_ACCEPT: Record<Format, string> = {
  json: "application/x-ndjson",
  msgpack: "application/vnd.zizq.msgpack-stream",
};

/**
 * Low-level HTTP client for the Zizq job queue server.
 *
 * Maintains a persistent connection (HTTP/2 when available) for efficient
 * request multiplexing. All methods map directly to server API endpoints.
 *
 * Call {@link close} when done to wait for in-flight requests to complete and
 * release the underlying connection.
 *
 * @example
 * ```ts
 * const client = new Client({ url: "http://localhost:7890" });
 *
 * const job = await client.enqueue({
 *   type: "send_email",
 *   queue: "emails",
 *   payload: { to: "user@example.com" },
 * });
 *
 * await client.close();
 * ```
 */
export class Client {
  /** Pool for request/response traffic (enqueue, ack, failure, get). */
  private http: Dispatcher;
  /** Separate pool for long-lived streaming connections (take). */
  private streamHttp: Dispatcher;
  /** The base URL of the Zizq server. */
  readonly url: string;
  /** Serialization format. */
  private format: Format;
  /** Content-type for requests. */
  private contentType: string;
  /** Accept header for request/response endpoints. */
  private accept: string;
  /** Accept header for the streaming take endpoint. */
  private streamAccept: string;

  constructor(options: ClientOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.format = options.format ?? "json";
    this.contentType = CONTENT_TYPES[this.format];
    this.accept = CONTENT_TYPES[this.format];
    this.streamAccept = STREAM_ACCEPT[this.format];

    if (options.dispatcher) {
      // Testing: use the same dispatcher for both.
      this.http = options.dispatcher;
      this.streamHttp = options.dispatcher;
    } else {
      const connectOpts = options.tls ? {
        ca: options.tls.ca,
        cert: options.tls.cert,
        key: options.tls.key,
      } : undefined;

      // HTTP/2 for request/response traffic (multiplexed acks, enqueues).
      this.http = new Pool(this.url, {
        allowH2: true,
        connect: connectOpts,
      });

      // HTTP/1.1 for the long-lived take stream. HTTP/2 adds framing
      // overhead and flow control with no multiplexing benefit on a
      // single long-lived response, resulting in measurably lower
      // throughput compared to HTTP/1.1 chunked transfer.
      this.streamHttp = new Pool(this.url, {
        allowH2: false,
        connect: connectOpts,
      });
    }
  }

  /**
   * Enqueue a single job.
   *
   * @returns The created job, including its server-assigned `id` and `status`.
   * @throws {ZizqError} If the server rejects the request (e.g. invalid queue name).
   *
   * @example
   * ```ts
   * const job = await client.enqueue({
   *   type: "send_email",
   *   queue: "emails",
   *   payload: { to: "user@example.com" },
   * });
   * ```
   */
  async enqueue(options: EnqueueOptions): Promise<Job> {
    const api = enqueueToApi(options);
    return this.wrapJob(await this.handleResponse(await this.post("/jobs", api)));
  }

  /**
   * Enqueue multiple jobs in a single request.
   *
   * @returns An array of created jobs in the same order as the input.
   *
   * @example
   * ```ts
   * const jobs = await client.enqueueBulk([
   *   { type: "send_email", queue: "emails", payload: { to: "a@b.com" } },
   *   { type: "send_email", queue: "emails", payload: { to: "c@d.com" } },
   * ]);
   * ```
   */
  async enqueueBulk(jobs: EnqueueOptions[]): Promise<Job[]> {
    const api = { jobs: jobs.map(enqueueToApi) };
    const data = await this.handleResponse(await this.post("/jobs/bulk", api)) as { jobs: unknown[] };
    return data.jobs.map((j) => this.wrapJob(j));
  }

  /**
   * Acknowledge a job as successfully completed.
   *
   * @param id - The job ID to acknowledge.
   * @throws {ZizqError} If the job is not found or not in-flight.
   */
  async reportSuccess(id: string): Promise<void> {
    const res = await this.request("POST", `/jobs/${encodeURIComponent(id)}/success`);
    if (res.statusCode !== 204) {
      await this.throwOnError(res);
    }
  }

  /**
   * Acknowledge multiple jobs as successfully completed in a single request.
   *
   * Jobs that have already been acknowledged or that don't exist are
   * silently ignored (the server returns 422 but the client treats it
   * as success).
   *
   * @param ids - Array of job IDs to acknowledge.
   */
  async reportSuccessBulk(ids: string[]): Promise<void> {
    const res = await this.post("/jobs/success", { ids });
    // 204 = all found, 422 = some not found (still accepted).
    if (res.statusCode !== 204 && res.statusCode !== 422) {
      await this.throwOnError(res);
    }
  }

  /**
   * Report a job as failed.
   *
   * The server will either reschedule the job with backoff or move it to
   * the dead list if the retry limit has been exceeded.
   *
   * @param id - The job ID to report failure for.
   * @param options - Error details (message, stack trace, etc.).
   * @returns The updated job with its new status and attempt count.
   */
  async reportFailure(id: string, options: FailureOptions): Promise<Job> {
    const api = failureToApi(options);
    return this.wrapJob(await this.handleResponse(await this.post(`/jobs/${encodeURIComponent(id)}/failure`, api)));
  }

  /**
   * Fetch a single job by ID.
   *
   * @param id - The job ID to fetch.
   * @returns The full job data including payload.
   * @throws {ZizqError} If the job is not found (404).
   */
  async getJob(id: string): Promise<Job> {
    return this.wrapJob(await this.handleResponse(await this.request("GET", `/jobs/${encodeURIComponent(id)}`)));
  }

  /**
   * Delete a single job by ID.
   *
   * @param id - The job ID to delete.
   * @throws {NotFoundError} If the job is not found.
   */
  async deleteJob(id: string): Promise<void> {
    const res = await this.request("DELETE", `/jobs/${encodeURIComponent(id)}`);
    if (res.statusCode !== 204) {
      await this.throwOnError(res);
    }
  }

  /**
   * Delete jobs matching the given filters.
   *
   * An empty options object deletes all jobs.
   *
   * @returns The number of deleted jobs.
   *
   * @example
   * ```ts
   * const count = await client.deleteAllJobs({ queue: "emails", status: "dead" });
   * ```
   */
  async deleteAllJobs(options: DeleteAllJobsOptions = {}): Promise<number> {
    assertOnlyKeys("deleteAllJobs", options, ["where"]);
    const where = options.where ?? {};
    assertOnlyKeys("deleteAllJobs.where", where, ["id", "status", "queue", "type", "filter"]);

    // Build the filter params, then short-circuit if any array filter resolved
    // to empty — an empty filter matches nothing, and we don't want to
    // accidentally delete everything.
    const params = buildJobFilter(where);
    if (isEmptyFilter(params)) return 0;

    const qs = params.toString();
    const path = `/jobs${qs ? "?" + qs : ""}`;

    const data = await this.handleResponse(
      await this.request("DELETE", path)
    ) as DeleteJobsResponse;

    return data.deleted;
  }

  /**
   * Count jobs matching the given filters.
   *
   * @example
   * ```ts
   * // Count all ready jobs in the emails queue
   * const count = await client.countJobs({ queue: "emails", status: "ready" });
   * ```
   */
  async countJobs(where: JobFilter = {}): Promise<number> {
    assertOnlyKeys("countJobs", where, ["id", "status", "queue", "type", "filter"]);

    const params = buildJobFilter(where);
    if (isEmptyFilter(params)) return 0;

    const qs = params.toString();
    const path = `/jobs/count${qs ? "?" + qs : ""}`;

    const data = await this.handleResponse(
      await this.request("GET", path)
    ) as CountJobsResponse;

    return data.count;
  }

  /**
   * Update a single job's mutable fields.
   *
   * Field semantics:
   * - **omitted or `undefined`** — leave unchanged
   * - **`null`** — clear the field (only valid for nullable fields)
   * - **a value** — update to that value
   *
   * @param id - The job ID to update.
   * @param options - Fields to update.
   * @returns The updated job.
   * @throws {NotFoundError} If the job is not found.
   *
   * @example
   * ```ts
   * // Change priority and clear the retry limit
   * await client.updateJob("job-id", {
   *   priority: 100,
   *   retryLimit: null,
   * });
   * ```
   */
  async updateJob(id: string, options: UpdateJobOptions): Promise<Job> {
    const api = updateToApi(options);
    return this.wrapJob(
      await this.handleResponse(await this.patch(`/jobs/${encodeURIComponent(id)}`, api))
    );
  }

  /**
   * Bulk update jobs matching a filter.
   *
   * @returns The number of updated jobs.
   *
   * @example
   * ```ts
   * const count = await client.updateAllJobs({
   *   where: { queue: "emails", status: "ready" },
   *   apply: { priority: 1000 },
   * });
   * ```
   */
  async updateAllJobs(options: UpdateAllJobsOptions): Promise<number> {
    assertOnlyKeys("updateAllJobs", options, ["where", "apply"]);
    const where = options.where ?? {};
    assertOnlyKeys("updateAllJobs.where", where, ["id", "status", "queue", "type", "filter"]);

    // Same empty-filter short-circuit as deleteAllJobs.
    const params = buildJobFilter(where);
    if (isEmptyFilter(params)) return 0;

    const qs = params.toString();
    const path = `/jobs${qs ? "?" + qs : ""}`;

    const api = updateToApi(options.apply);
    const data = await this.handleResponse(
      await this.patch(path, api)
    ) as PatchJobsResponse;

    return data.patched;
  }

  /**
   * List jobs with cursor-based pagination.
   *
   * Returns a single page of jobs. Use `page.nextPage()` and
   * `page.prevPage()` to navigate between pages.
   *
   * @example
   * ```ts
   * const page = await client.listJobs({ queue: ["emails"], limit: 10 });
   * for (const job of page.jobs) {
   *   console.log(job.id, job.status);
   * }
   * if (page.hasNext) {
   *   const next = await page.nextPage();
   * }
   * ```
   */
  async listJobs(options: ListJobsOptions = {}): Promise<JobPage> {
    const params = new URLSearchParams();
    if (options.from != null) params.set("from", options.from);
    if (options.order != null) params.set("order", options.order);
    if (options.limit != null) params.set("limit", String(options.limit));
    buildJobFilter(options, params);

    if (isEmptyFilter(params)) return new JobPage(this, [], {});

    const qs = params.toString();
    const path = `/jobs${qs ? "?" + qs : ""}`;

    return this.listJobsByPath(path);
  }

  /**
   * Fetch a page of jobs by a raw path (used internally for pagination links).
   *
   * @internal
   */
  async listJobsByPath(path: string): Promise<JobPage> {
    const data = await this.handleResponse(await this.request("GET", path)) as ListJobsResponse;
    const jobs = data.jobs.map((j) => this.wrapJob(j));
    return new JobPage(this, jobs, data.pages);
  }

  /**
   * Health check.
   *
   * @returns The parsed response body, e.g. `{ status: "ok" }`.
   */
  async health(): Promise<HealthResponse> {
    return await this.handleResponse(await this.request("GET", "/health")) as HealthResponse;
  }

  /**
   * Server version.
   *
   * @returns The server's version string.
   */
  async serverVersion(): Promise<string> {
    const data = await this.handleResponse(await this.request("GET", "/version")) as VersionResponse;
    return data.version;
  }

  /**
   * Start a composable, lazy query over jobs.
   *
   * Returns a {@link JobQuery} that can be chained with filter and
   * ordering methods, then iterated or used with terminal methods like
   * `first()`, `toArray()`, `updateAll()`, and `deleteAll()`.
   *
   * No HTTP request is made until the query is consumed.
   *
   * Accepts an optional {@link JobQueryOptions} to seed the query's initial
   * filter, order, limit, and page size — handy as a shorthand for
   * `client.jobs().byQueue(...).limit(...)` etc.
   *
   * @example
   * ```ts
   * const dead = await client.jobs()
   *   .byQueue("emails")
   *   .byStatus("dead")
   *   .toArray();
   *
   * // Shorthand with seeded options
   * const ready = await client.jobs({ queue: "emails", status: "ready" }).toArray();
   *
   * for await (const job of client.jobs().byStatus("ready")) {
   *   console.log(job.id);
   * }
   * ```
   */
  jobs(options?: JobQueryOptions): JobQuery {
    return new JobQuery(this, options);
  }

  /**
   * List all distinct queue names on the server.
   *
   * @returns An array of queue name strings, sorted alphabetically.
   */
  async queues(): Promise<string[]> {
    const data = await this.handleResponse(await this.request("GET", "/queues")) as QueuesResponse;
    return data.queues;
  }

  /**
   * List error records for a job with cursor-based pagination.
   *
   * @param id - The job ID to list errors for.
   * @param options - Pagination and ordering options.
   *
   * @example
   * ```ts
   * const page = await client.listErrors("job-id", { order: "desc" });
   * for (const error of page) {
   *   console.log(`Attempt ${error.attempt}: ${error.message}`);
   * }
   * ```
   */
  async listErrors(id: string, options: ListErrorsOptions = {}): Promise<ErrorPage> {
    const params = new URLSearchParams();
    if (options.from != null) params.set("from", String(options.from));
    if (options.order != null) params.set("order", options.order);
    if (options.limit != null) params.set("limit", String(options.limit));

    const qs = params.toString();
    const path = `/jobs/${encodeURIComponent(id)}/errors${qs ? "?" + qs : ""}`;

    return this.listErrorsByPath(path);
  }

  /**
   * Fetch a page of errors by a raw path (used internally for pagination links).
   *
   * @internal
   */
  async listErrorsByPath(path: string): Promise<ErrorPage> {
    const data = await this.handleResponse(await this.request("GET", path)) as ListErrorsResponse;
    const errors = data.errors.map((e) => this.wrapError(e));
    return new ErrorPage(this, errors, data.pages);
  }

  /**
   * Fetch a single error record for a job by attempt number.
   *
   * @param id - The job ID.
   * @param attempt - The attempt number (1-based).
   * @returns The error record for that attempt.
   * @throws {NotFoundError} If the job or attempt is not found.
   */
  async getError(id: string, attempt: number): Promise<ErrorRecord> {
    const raw = await this.handleResponse(
      await this.request("GET", `/jobs/${encodeURIComponent(id)}/errors/${encodeURIComponent(String(attempt))}`)
    );
    return this.wrapError(raw);
  }

  /**
   * Connect to the streaming take endpoint and return an async generator
   * of jobs.
   *
   * The returned promise resolves once the HTTP connection is established.
   * The async generator then yields jobs as they arrive. Heartbeats in
   * the stream are silently skipped.
   *
   * The generator completes when the server closes the connection. The
   * caller may also break out of the loop explicitly to end the stream,
   * or provide an AbortSignal to explicitly signal cancellation.
   *
   * @example
   * ```ts
   * for await (const job of await client.take({ prefetch: 5, queues: ["emails"] })) {
   *   await processJob(job.payload);
   *   await client.reportSuccess(job.id);
   * }
   * ```
   */
  async take(options: TakeOptions = {}): Promise<AsyncGenerator<Job>> {
    const params = new URLSearchParams();
    if (options.prefetch != null) {
      params.set("prefetch", String(options.prefetch));
    }
    if (options.queues?.length) {
      params.set("queue", options.queues.join(","));
    }

    const qs = params.toString();
    const path = `/jobs/take${qs ? "?" + qs : ""}`;

    const res = await this.streamHttp.request({
      method: "GET",
      path,
      headers: { accept: this.streamAccept },
      signal: options.signal ?? null,
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      await this.throwOnError(res);
    }

    const body = res.body as Readable;

    // Use the response content-type to pick the stream parser, not the
    // requested format — the server may respond differently (e.g. 406).
    const contentType = String(res.headers["content-type"] ?? "");
    if (contentType.includes("msgpack")) {
      return this.iterateMsgpackStream(body);
    }
    return this.iterateNdjson(body);
  }

  /** Parse an NDJSON stream, yielding jobs. Empty lines are heartbeats. */
  private async *iterateNdjson(body: Readable): AsyncGenerator<Job> {
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);

          if (line.length === 0) continue;

          yield this.wrapJob(JSON.parse(line));
        }
      }
    } finally {
      body.destroy();
    }
  }

  /**
   * Parse a length-prefixed MessagePack stream, yielding jobs.
   *
   * Frame format: [4-byte big-endian length][MessagePack payload].
   * A zero-length frame is a heartbeat and is silently skipped.
   */
  private async *iterateMsgpackStream(body: Readable): AsyncGenerator<Job> {
    let buffer = Buffer.alloc(0);

    try {
      for await (const chunk of body) {
        buffer = Buffer.concat([buffer, chunk as Uint8Array]);

        while (buffer.length >= 4) {
          const frameLen = buffer.readUInt32BE(0);

          // Zero-length frame is a heartbeat.
          if (frameLen === 0) {
            buffer = buffer.subarray(4);
            continue;
          }

          // Wait for the full frame.
          if (buffer.length < 4 + frameLen) break;

          const payload = buffer.subarray(4, 4 + frameLen);
          buffer = buffer.subarray(4 + frameLen);

          yield this.wrapJob(msgpackDecode(payload));
        }
      }
    } finally {
      body.destroy();
    }
  }

  /** Wrap raw API data as a Job instance. */
  private wrapJob(raw: unknown): Job {
    return new Job(this, jobFromApi(raw));
  }

  /** Wrap raw API data as an ErrorRecord instance. */
  private wrapError(raw: unknown): ErrorRecord {
    return new ErrorRecord(errorFromApi(raw));
  }

  /**
   * Gracefully close the underlying HTTP connection.
   *
   * Waits for in-flight requests to complete. If a streaming `take()`
   * connection is open, this will block until it ends — use
   * {@link destroy} for hard immediate shutdown.
   */
  async close(): Promise<void> {
    await Promise.all([this.http.close(), this.streamHttp.close()]);
  }

  /**
   * Forcefully destroy the underlying HTTP connection.
   *
   * Immediately terminates all in-flight requests including any open
   * `take()` stream. Use this when `close()` would block (e.g. after
   * an unclean interruption in the REPL).
   */
  async destroy(): Promise<void> {
    await Promise.all([this.http.destroy(), this.streamHttp.destroy()]);
  }

  private async request(
    method: string,
    path: string,
    extraHeaders?: Record<string, string>
  ): Promise<Dispatcher.ResponseData> {
    try {
      return await this.http.request({
        method: method as Dispatcher.HttpMethod,
        path,
        headers: {
          accept: this.accept,
          ...extraHeaders,
        },
      });
    } catch (err) {
      throw toConnectionError(err);
    }
  }

  private async post(path: string, body: unknown): Promise<Dispatcher.ResponseData> {
    return this.requestWithBody("POST", path, body);
  }

  private async patch(path: string, body: unknown): Promise<Dispatcher.ResponseData> {
    return this.requestWithBody("PATCH", path, body);
  }

  private async requestWithBody(
    method: "POST" | "PATCH",
    path: string,
    body: unknown
  ): Promise<Dispatcher.ResponseData> {
    try {
      return await this.http.request({
        method,
        path,
        headers: {
          "content-type": this.contentType,
          accept: this.accept,
        },
        body: this.encode(body),
      });
    } catch (err) {
      throw toConnectionError(err);
    }
  }

  /** Encode a value in the configured format. */
  private encode(value: unknown): string | Buffer {
    if (this.format === "msgpack") {
      return Buffer.from(msgpackEncode(value));
    }
    return JSON.stringify(value);
  }

  private async handleResponse(res: Dispatcher.ResponseData): Promise<unknown> {
    if (res.statusCode === 204) {
      // Drain the body to release the connection.
      for await (const _ of res.body as Readable) {}
      return undefined;
    }

    const body = await this.readBody(res);

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw buildResponseError(res.statusCode, body);
    }

    return body;
  }

  private async throwOnError(res: Dispatcher.ResponseData): Promise<never> {
    let body: unknown;
    try {
      body = await this.readBody(res);
    } catch {
      body = undefined;
    }
    throw buildResponseError(res.statusCode, body);
  }

  /** Read and decode a response body, using the content-type header to
   *  pick the correct decoder rather than assuming the requested format. */
  private async readBody(res: Dispatcher.ResponseData): Promise<unknown> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.body as Readable) {
      chunks.push(chunk as Uint8Array);
    }
    const data = Buffer.concat(chunks);

    const contentType = String(res.headers["content-type"] ?? "");
    if (contentType.includes("msgpack")) {
      return msgpackDecode(data);
    }
    return JSON.parse(new TextDecoder().decode(data));
  }
}

// --- API format translation ---
//
// The server uses snake_case keys. The client exposes camelCase. These
// helpers translate at the boundary. `undefined` values are stripped via
// delete so they don't appear as keys in the JSON body, while `null`
// values are preserved (needed for PATCH resets).

/** Normalize a scalar or array to a comma-separated string. */
function toCommaList(value: string | string[]): string {
  return Array.isArray(value) ? value.join(",") : value;
}

/**
 * Returns `true` when any array filter field resolved to an empty comma list,
 * meaning the filter matches nothing and the caller can short-circuit.
 *
 * Call after {@link buildJobFilter} has populated the params.
 */
function isEmptyFilter(params: URLSearchParams): boolean {
  return (
    params.get("id") === "" ||
    params.get("status") === "" ||
    params.get("queue") === "" ||
    params.get("type") === ""
  );
}

/**
 * Populate a {@link URLSearchParams} with the standard job filter fields.
 */
function buildJobFilter(
  where: JobFilter,
  params: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  if (where.id != null) params.set("id", toCommaList(where.id));
  if (where.status != null) params.set("status", toCommaList(where.status));
  if (where.queue != null) params.set("queue", toCommaList(where.queue));
  if (where.type != null) params.set("type", toCommaList(where.type));
  if (where.filter != null) params.set("filter", where.filter);

  return params;
}

/**
 * Throw if `obj` contains keys not in the allowed list.
 *
 * Catches typos and structural mistakes in options objects (e.g. passing
 * `{ status: "ready" }` to `deleteAllJobs` instead of `{ where: { status: "ready" } }`)
 * which would otherwise silently delete or update everything.
 */
function assertOnlyKeys(
  context: string,
  obj: object,
  allowed: string[]
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `${context}: unknown option "${key}". Allowed: ${allowed.join(", ")}`
      );
    }
  }
}

/** Strip keys whose value is `undefined` from an object (in place). */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  for (const k in obj) if (obj[k] === undefined) delete obj[k];
  return obj;
}

/** Convert an EnqueueOptions to the server's snake_case API format. */
function enqueueToApi(opts: EnqueueOptions): Record<string, unknown> {
  return stripUndefined({
    type: opts.type,
    queue: opts.queue,
    payload: opts.payload,
    priority: opts.priority,
    ready_at: opts.readyAt,
    retry_limit: opts.retryLimit,
    backoff: opts.backoff && backoffToApi(opts.backoff),
    retention: opts.retention && retentionToApi(opts.retention),
    unique_key: opts.uniqueKey,
    unique_while: opts.uniqueWhile,
  });
}

/**
 * Convert an UpdateJobOptions to the server's snake_case patch format.
 *
 * `undefined` values are stripped (leave field unchanged), `null` values
 * are preserved (clear field on the server). Nested backoff and retention
 * objects are translated when present, passed through as `null` when null.
 */
function updateToApi(opts: UpdateJobOptions): Record<string, unknown> {
  return stripUndefined({
    queue: opts.queue,
    priority: opts.priority,
    ready_at: opts.readyAt,
    retry_limit: opts.retryLimit,
    backoff: opts.backoff && backoffToApi(opts.backoff),
    retention: opts.retention && retentionToApi(opts.retention),
  });
}

/** Convert a FailureOptions to the server's snake_case API format. */
function failureToApi(opts: FailureOptions): Record<string, unknown> {
  return stripUndefined({
    message: opts.message,
    error_type: opts.errorType,
    backtrace: opts.backtrace,
    retry_at: opts.retryAt,
    kill: opts.kill,
  });
}

/** Convert a BackoffConfig to API format. */
function backoffToApi(b: BackoffConfig): Record<string, unknown> {
  return { base_ms: b.baseMs, exponent: b.exponent, jitter_ms: b.jitterMs };
}

/** Convert a RetentionConfig to API format. */
function retentionToApi(r: RetentionConfig): Record<string, unknown> {
  return stripUndefined({
    completed_ms: r.completedMs,
    dead_ms: r.deadMs,
  });
}

/** Convert an API-format job object to a camelCase JobData. */
function jobFromApi(raw: unknown): JobData {
  const r = raw as Record<string, unknown>;
  return stripUndefined({
    id: r.id,
    type: r.type,
    queue: r.queue,
    priority: r.priority,
    status: r.status,
    payload: r.payload,
    readyAt: r.ready_at,
    attempts: r.attempts,
    retryLimit: r.retry_limit,
    backoff: r.backoff != null ? backoffFromApi(r.backoff) : undefined,
    dequeuedAt: r.dequeued_at,
    failedAt: r.failed_at,
    completedAt: r.completed_at,
    retention: r.retention != null ? retentionFromApi(r.retention) : undefined,
    purgeAt: r.purge_at,
    uniqueKey: r.unique_key,
    uniqueWhile: r.unique_while,
    duplicate: r.duplicate,
  }) as unknown as JobData;
}

/** Convert an API-format backoff to camelCase. */
function backoffFromApi(raw: unknown): BackoffConfig {
  const r = raw as Record<string, unknown>;
  return {
    baseMs: r.base_ms as number,
    exponent: r.exponent as number,
    jitterMs: r.jitter_ms as number,
  };
}

/** Convert an API-format retention to camelCase. */
function retentionFromApi(raw: unknown): RetentionConfig {
  const r = raw as Record<string, unknown>;
  return stripUndefined({
    completedMs: r.completed_ms,
    deadMs: r.dead_ms,
  }) as RetentionConfig;
}

/** Build the appropriate ResponseError subclass for an HTTP status code. */
/** Convert an API-format error record to camelCase. */
function errorFromApi(raw: unknown): ErrorRecordData {
  const r = raw as Record<string, unknown>;
  return stripUndefined({
    attempt: r.attempt,
    message: r.message,
    errorType: r.error_type,
    backtrace: r.backtrace,
    dequeuedAt: r.dequeued_at,
    failedAt: r.failed_at,
  }) as unknown as ErrorRecordData;
}

function buildResponseError(status: number, body: unknown): ResponseError {
  const message = (body as { error?: string } | undefined)?.error ?? `HTTP ${status}`;
  if (status === 404) return new NotFoundError(message, body);
  if (status >= 400 && status < 500) return new ClientError(message, status, body);
  if (status >= 500) return new ServerError(message, status, body);
  return new ResponseError(message, status, body);
}

/** Wrap a low-level error (from undici) as a ConnectionError. */
function toConnectionError(err: unknown): ConnectionError {
  const message = err instanceof Error ? err.message : String(err);
  return new ConnectionError(message);
}

