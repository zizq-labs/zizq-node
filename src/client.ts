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

import { Client as UndiciClient, type Dispatcher } from "undici";
import type { Readable } from "node:stream";

/** Lifecycle status of a job. */
export type JobStatus = "ready" | "in_flight" | "scheduled" | "completed" | "dead";

/** Uniqueness scope for deduplication. */
export type UniqueScope = "queued" | "active" | "exists";

/** A job as returned by the Zizq server. */
export interface JobData {
  /** Unique job identifier. */
  id: string;

  /** Job type, e.g. "send_email". */
  type: string;

  /** Queue this job belongs to. */
  queue: string;

  /** Priority (lower number = higher priority). */
  priority: number;

  /** Lifecycle status. */
  status: JobStatus;

  /**
   * Arbitrary payload provided by the enqueuer.
   *
   * Present on take/get, omitted on some responses where only job metadata
   * is required.
   */
  payload?: unknown;

  /** When the job becomes eligible to run (ms since Unix epoch). */
  ready_at: number;

  /** Number of times this job has been previously attempted. */
  attempts: number;

  /**
   * Maximum retries before the job is killed.
   *
   * Absent means server default applies.
   */
  retry_limit?: number;

  /**
   * Per-job backoff configuration.
   *
   * Absent means server default applies.
   */
  backoff?: BackoffConfig;

  /** When the job was last dequeued (ms since Unix epoch). */
  dequeued_at?: number;

  /** When the job last failed (ms since Unix epoch). */
  failed_at?: number;

  /** When the job was completed (ms since Unix epoch). */
  completed_at?: number;

  /**
   * Per-job retention configuration.
   *
   * Absent means server default.
   */
  retention?: RetentionConfig;

  /** When the reaper will hard-delete this job (ms since Unix epoch). */
  purge_at?: number;

  /**
   * Unique key used for deduplication.
   *
   * Requires a pro license.
   */
  unique_key?: string;

  /** Uniqueness scope. */
  unique_while?: UniqueScope;

  /**
   * True if this job was returned as a duplicate of an existing job.
   *
   * Present on enqueue responses only.
   */
  duplicate?: boolean;
}

/**
 * Backoff configuration for retry delays.
 *
 * This is used in the following formula:
 *
 * ```
 * t = base_ms + (attempts ** exponent) + (attempts * random() * jitter_ms)
 * ```
 *
 * The random jitter is designed to ensure clusters of failed jobs do nit all
 * retry at the same time but are instead randomly spread out.
 */
export interface BackoffConfig {
  /** Base delay in milliseconds, applied to all retries. */
  base_ms: number;

  /** Backoff curve steepness (attempts ** exponent). */
  exponent: number;

  /** Maximum random jitter in milliseconds per attempt multiplier. */
  jitter_ms: number;
}

/**
 * Retention configuration controlling how long jobs in terminal statuses are kept.
 *
 * The terminal statuses are "completed" and "dead".
 */
export interface RetentionConfig {
  /** How long completed jobs remain visible (ms). */
  completed_ms?: number;

  /** How long dead jobs remain visible (ms). */
  dead_ms?: number;
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
 *   ready_at: Date.now() + 60000, // optional, delay by 1 minute
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
   *
   * Must be valid UTF-8 and must not contain any of the following reserved
   * characters: ",", "?", "*", "[", "]", "{", "}", "!".
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
  ready_at?: number;

  /**
   * Optional per-job retry limit.
   *
   * When not set the server default value applies.
   */
  retry_limit?: number;

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
  unique_key?: string;

  /**
   * Uniqueness scope. Only valid when `unique_key` is set.
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
  unique_while?: UniqueScope;
}

/** Options for reporting a job failure. */
export interface FailureOptions {
  /** Error message describing what went wrong. */
  message: string;

  /** Optional error class name, e.g. "TimeoutError". */
  error_type?: string;

  /** Optional stack trace from the worker. */
  backtrace?: string;

  /** Optional forced retry time (ms since epoch), bypassing backoff. */
  retry_at?: number;

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
 * When no jobs are available, the generator waits until new jobs are enqeued.
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

/** Options for constructing a {@link Client}. */
export interface ClientOptions {
  /** Base URL of the Zizq server, e.g. "http://localhost:7890". */
  url: string;

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
  private http: Dispatcher;
  private origin: string;

  constructor(options: ClientOptions) {
    this.origin = options.url.replace(/\/+$/, "");
    this.http = options.dispatcher ?? new UndiciClient(this.origin, {
      allowH2: true,
      pipelining: 1,
    });
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
  async enqueue(options: EnqueueOptions): Promise<JobData> {
    return this.handleResponse(await this.post("/jobs", options)) as Promise<JobData>;
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
  async enqueueBulk(jobs: EnqueueOptions[]): Promise<JobData[]> {
    const data = await this.handleResponse(await this.post("/jobs/bulk", { jobs })) as { jobs: JobData[] };
    return data.jobs;
  }

  /**
   * Acknowledge a job as successfully completed.
   *
   * 4xx errors can generally be ignored as the job is no longer in-flight.
   *
   * @param id - The job ID to acknowledge.
   * @throws {ZizqError} If the job is not found or not in-flight.
   */
  async reportSuccess(id: string): Promise<void> {
    const res = await this.request("POST", `/jobs/${id}/success`);
    if (res.statusCode !== 204) {
      await this.throwOnError(res);
    }
  }

  /**
   * Acknowledge multiple jobs as successfully completed in a single request.
   *
   * When lots of acknowledgments occur close together, this can significantly
   * improve throughput compared with 1:1 requests.
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
  async reportFailure(id: string, options: FailureOptions): Promise<JobData> {
    return this.handleResponse(await this.post(`/jobs/${id}/failure`, options)) as Promise<JobData>;
  }

  /**
   * Fetch a single job by ID.
   *
   * @param id - The job ID to fetch.
   * @returns The full job data including payload.
   * @throws {ZizqError} If the job is not found (404).
   */
  async getJob(id: string): Promise<JobData> {
    return this.handleResponse(await this.request("GET", `/jobs/${id}`)) as Promise<JobData>;
  }

  /**
   * Stream jobs from the server via the take endpoint.
   *
   * Opens a long-lived streaming connection. The server pushes jobs as
   * they become available, up to the `prefetch` limit of unacknowledged
   * jobs. Empty lines in the stream are heartbeats and are silently
   * skipped.
   *
   * The generator completes when the server closes the connection. The caller
   * may also break out of the loop explicitly to end the stream, or provide an
   * AbortSignal to explicitly signal cancellation.
   *
   * @example
   * ```ts
   * for await (const job of client.take({ prefetch: 5, queues: ["emails"] })) {
   *   await processJob(job.payload);
   *   await client.reportSuccess(job.id);
   * }
   * ```
   */
  async *take(options: TakeOptions = {}): AsyncGenerator<JobData> {
    const params = new URLSearchParams();
    if (options.prefetch != null) {
      params.set("prefetch", String(options.prefetch));
    }
    if (options.queues?.length) {
      params.set("queue", options.queues.join(","));
    }

    const qs = params.toString();
    const path = `/jobs/take${qs ? "?" + qs : ""}`;

    const res = await this.http.request({
      method: "GET",
      path,
      headers: { accept: "application/x-ndjson" },
      signal: options.signal ?? null,
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      await this.throwOnError(res);
    }

    const decoder = new TextDecoder();
    let buffer = "";

    const body = res.body as Readable;

    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);

          // Empty lines are heartbeats.
          if (line.length === 0) continue;

          yield JSON.parse(line) as JobData;
        }
      }
    } finally {
      // Ensure the response body is destroyed when the generator exits,
      // whether by completion, break, throw, or abandonment. This closes
      // the HTTP stream so the server knows the client disconnected and
      // can requeue any in-flight jobs.
      body.destroy();
    }
  }

  /**
   * Gracefully close the underlying HTTP connection.
   *
   * Waits for in-flight requests to complete. If a streaming `take()`
   * connection is open, this will block until it ends — use
   * {@link destroy} for hard immediate shutdown.
   */
  async close(): Promise<void> {
    await this.http.close();
  }

  /**
   * Forcefully destroy the underlying HTTP connection.
   *
   * Immediately terminates all in-flight requests including any open
   * `take()` stream. Use this when `close()` would block (e.g. after
   * an unclean interruption in the REPL).
   */
  async destroy(): Promise<void> {
    await this.http.destroy();
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
          accept: "application/json",
          ...extraHeaders,
        },
      });
    } catch (err) {
      throw toConnectionError(err);
    }
  }

  private async post(path: string, body: unknown): Promise<Dispatcher.ResponseData> {
    try {
      return await this.http.request({
        method: "POST",
        path,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw toConnectionError(err);
    }
  }

  private async handleResponse(res: Dispatcher.ResponseData): Promise<unknown> {
    if (res.statusCode === 204) {
      // Drain the body to release the connection.
      for await (const _ of res.body as Readable) {}
      return undefined;
    }

    const body = await readJson(res.body);

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw buildResponseError(res.statusCode, body);
    }

    return body;
  }

  private async throwOnError(res: Dispatcher.ResponseData): Promise<never> {
    let body: unknown;
    try {
      body = await readJson(res.body);
    } catch {
      body = undefined;
    }
    throw buildResponseError(res.statusCode, body);
  }
}

/** Build the appropriate ResponseError subclass for an HTTP status code. */
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

/** Read and parse a JSON response body from an undici stream. */
async function readJson(body: Dispatcher.ResponseData["body"]): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as Readable) {
    chunks.push(chunk as Uint8Array);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  return JSON.parse(text);
}
