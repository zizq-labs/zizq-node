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
  readyAt: number;

  /** Number of times this job has been previously attempted. */
  attempts: number;

  /**
   * Maximum retries before the job is killed.
   *
   * Absent means server default applies.
   */
  retryLimit?: number;

  /**
   * Per-job backoff configuration.
   *
   * Absent means server default applies.
   */
  backoff?: BackoffConfig;

  /** When the job was last dequeued (ms since Unix epoch). */
  dequeuedAt?: number;

  /** When the job last failed (ms since Unix epoch). */
  failedAt?: number;

  /** When the job was completed (ms since Unix epoch). */
  completedAt?: number;

  /**
   * Per-job retention configuration.
   *
   * Absent means server default.
   */
  retention?: RetentionConfig;

  /** When the reaper will hard-delete this job (ms since Unix epoch). */
  purgeAt?: number;

  /**
   * Unique key used for deduplication.
   *
   * Requires a pro license.
   */
  uniqueKey?: string;

  /** Uniqueness scope. */
  uniqueWhile?: UniqueScope;

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
  /** How long completed jobs remain visible (ms). */
  completedMs?: number;

  /** How long dead jobs remain visible (ms). */
  deadMs?: number;
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
  async enqueue(options: EnqueueOptions): Promise<JobData> {
    const api = enqueueToApi(options);
    return jobFromApi(await this.handleResponse(await this.post("/jobs", api)));
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
    const api = { jobs: jobs.map(enqueueToApi) };
    const data = await this.handleResponse(await this.post("/jobs/bulk", api)) as { jobs: unknown[] };
    return data.jobs.map(jobFromApi);
  }

  /**
   * Acknowledge a job as successfully completed.
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
    const api = failureToApi(options);
    return jobFromApi(await this.handleResponse(await this.post(`/jobs/${id}/failure`, api)));
  }

  /**
   * Fetch a single job by ID.
   *
   * @param id - The job ID to fetch.
   * @returns The full job data including payload.
   * @throws {ZizqError} If the job is not found (404).
   */
  async getJob(id: string): Promise<JobData> {
    return jobFromApi(await this.handleResponse(await this.request("GET", `/jobs/${id}`)));
  }

  /**
   * Health check.
   *
   * @returns The parsed response body, e.g. `{ status: "ok" }`.
   */
  async health(): Promise<{ status: string }> {
    return await this.handleResponse(await this.request("GET", "/health")) as { status: string };
  }

  /**
   * Server version.
   *
   * @returns The server's version string.
   */
  async serverVersion(): Promise<string> {
    const data = await this.handleResponse(await this.request("GET", "/version")) as { version: string };
    return data.version;
  }

  /**
   * List all distinct queue names on the server.
   *
   * @returns An array of queue name strings, sorted alphabetically.
   */
  async queues(): Promise<string[]> {
    const data = await this.handleResponse(await this.request("GET", "/queues")) as { queues: string[] };
    return data.queues;
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
  async take(options: TakeOptions = {}): Promise<AsyncGenerator<JobData>> {
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
  private async *iterateNdjson(body: Readable): AsyncGenerator<JobData> {
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

          yield jobFromApi(JSON.parse(line));
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
  private async *iterateMsgpackStream(body: Readable): AsyncGenerator<JobData> {
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

          yield jobFromApi(msgpackDecode(payload));
        }
      }
    } finally {
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
    try {
      return await this.http.request({
        method: "POST",
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

