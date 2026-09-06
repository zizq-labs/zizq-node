// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * In-memory test double for the {@link Client}.
 *
 * `TestClient` extends `Client` and overrides the enqueue methods to
 * buffer submissions in memory instead of sending them to the server.
 * Read/mutation/streaming methods raise `NotSupportedError`.
 *
 * Designed for tests that assert what a region of code enqueued, and
 * for tests that want to drain the buffered jobs through their real
 * handler to exercise side effects end-to-end without a live queue.
 *
 * @example Basic assertion
 * ```ts
 * const client = new TestClient();
 * await someService.doThing(client);
 * assert.ok(client.enqueued("send_email"));
 * assert.equal(client.enqueuedCount("send_email"), 1);
 * ```
 *
 * @example Drain through a handler
 * ```ts
 * const client = new TestClient();
 * const router = new Router().route("send_email", async (payload) => { ... });
 *
 * await client.enqueue({ type: "send_email", queue: "emails", payload: { ... } });
 * await client.dispatch(router.build());
 *
 * assert.equal(client.completedJobs().length, 1);
 * ```
 *
 * @module
 */

import type { Dispatcher } from "undici";
import { isDeepStrictEqual } from "node:util";

import {
  Client,
  ZizqError,
  Job,
  type EnqueueInput,
  type EnqueueOptions,
  type JobStatus,
} from "./client.ts";
import type { JobHandler } from "./handler.ts";
import { resolveInput } from "./enqueue.ts";

/** Thrown when test-mode code reaches an operation that isn't supported. */
export class NotSupportedError extends ZizqError {
  constructor(method: string) {
    super(
      `TestClient.${method} is not supported. TestClient buffers ` +
        `enqueues only — point at a real server (or stub the call) if ` +
        `you need read/streaming operations in tests.`,
    );
    this.name = "NotSupportedError";
  }
}

/**
 * Filters applied to buffer accessors and {@link TestClient.dispatch}.
 *
 * All filter fields are ANDed together. Scalars are normalised to
 * one-element arrays. `filter` is a predicate over the `Job`.
 */
export interface TestJobFilters {
  /** Only include jobs on these queues. */
  onlyQueues?: string | string[];
  /** Exclude jobs on these queues. */
  exceptQueues?: string | string[];
  /** Only include jobs whose type matches one of these. */
  onlyTypes?: string | string[];
  /** Exclude jobs whose type matches one of these. */
  exceptTypes?: string | string[];
  /** Custom predicate; return true to keep. */
  filter?: (job: Job) => boolean;
}

/**
 * Extra options accepted by {@link TestClient.dispatch} on top of
 * the shared filter fields.
 */
export interface TestDispatchOptions extends TestJobFilters {
  /**
   * When `true`, keep looping until no more entries match the filters
   * — so handlers that re-enqueue continue to drain in the same call.
   *
   * When `false` (default), process only the entries that are already
   * runnable at the moment `dispatch` is called; anything enqueued
   * during dispatch stays buffered for the next call.
   */
  recursive?: boolean;

  /**
   * Cap on the number of snapshot iterations when `recursive: true`.
   * Guards against handlers that unconditionally re-enqueue, which
   * would otherwise loop forever and hang the test suite. Raise the
   * cap for legitimate fan-out cases, or drop `recursive` and call
   * `dispatch()` yourself in a loop for unbounded processing.
   *
   * Ignored when `recursive` is `false`. Default: `1000`.
   */
  maxIterations?: number;
}

/**
 * `Client` subclass that buffers enqueues in memory and disables all
 * server-touching operations. Construct with no arguments.
 *
 * See the module-level docs for usage patterns.
 */
export class TestClient extends Client {
  private entries: Entry[] = [];
  private idCounter = 0;

  constructor() {
    // The dispatcher is never used — every API-reaching method is
    // either overridden below (to buffer) or intercepted by the
    // NotImplementedProxy (to throw). The stub is only here to
    // satisfy `Client.constructor`.
    super({ url: "http://test.local", dispatcher: stubDispatcher() });

    // Return a Proxy so any method inherited from `Client` that
    // isn't explicitly implemented on `TestClient` throws
    // `NotSupportedError` instead of silently hitting the network.
    // See `notImplementedProxy` for the rules.
    //
    // Interim measure — v1 will lift this into a proper
    // `Client` interface with `LiveClient` + `TestClient`
    // implementations, at which point the proxy goes away.
    return notImplementedProxy(this);
  }

  // --- Buffered enqueue paths --------------------------------------

  override async enqueue(input: EnqueueInput): Promise<Job> {
    return this.record(resolveInput(input));
  }

  override async enqueueBulk(inputs: EnqueueInput[]): Promise<Job[]> {
    return inputs.map((i) => this.record(resolveInput(i)));
  }

  override async enqueueRaw(options: EnqueueOptions): Promise<Job> {
    return this.record(options);
  }

  override async enqueueBulkRaw(jobs: EnqueueOptions[]): Promise<Job[]> {
    return jobs.map((o) => this.record(o));
  }

  // --- Buffer accessors --------------------------------------------

  /** Reset the buffer. Call from your test setup between cases. */
  clear(): void {
    this.entries = [];
    this.idCounter = 0;
  }

  /** All buffered jobs, in submission order, regardless of status. */
  enqueuedJobs(filters: TestJobFilters = {}): Job[] {
    return applyFilters(this.entries, filters).map((e) => e.job);
  }

  /**
   * The fully-resolved {@link EnqueueOptions} used at buffer time.
   * Useful when tests need metadata that isn't reflected on `Job`
   * (e.g. `uniqueKey`, `uniqueWhile`, `readyAt`).
   */
  enqueuedOptions(filters: TestJobFilters = {}): EnqueueOptions[] {
    return applyFilters(this.entries, filters).map((e) => e.options);
  }

  /** Jobs waiting to run — `ready` plus `scheduled` (regardless of `readyAt`). */
  pendingJobs(filters: TestJobFilters = {}): Job[] {
    return this.byStatus(["ready", "scheduled"], filters);
  }

  /** Jobs currently mid-dispatch (only present during {@link dispatch}). */
  inFlightJobs(filters: TestJobFilters = {}): Job[] {
    return this.byStatus(["in_flight"], filters);
  }

  /** Jobs whose handler returned successfully. */
  completedJobs(filters: TestJobFilters = {}): Job[] {
    return this.byStatus(["completed"], filters);
  }

  /**
   * Jobs whose handler threw. TestClient never retries — a raised
   * exception during {@link dispatch} moves the job straight to `dead`
   * and the exception re-raises to the caller.
   */
  deadJobs(filters: TestJobFilters = {}): Job[] {
    return this.byStatus(["dead"], filters);
  }

  // --- Predicates ---------------------------------------------------

  /**
   * True when at least one buffered job matches `type` (and, if
   * supplied, `payload` after JSON round-trip normalisation).
   */
  enqueued(type: string, payload?: unknown): boolean {
    return this.enqueuedCount(type, payload) > 0;
  }

  /**
   * Count of buffered jobs matching `type` (and optionally the given
   * `payload`, using {@link isDeepStrictEqual} after both sides are
   * normalised through JSON to flatten Date/Symbol values into their
   * wire form).
   */
  enqueuedCount(type: string, payload?: unknown): number {
    const jobs = this.enqueuedJobs({ onlyTypes: type });
    if (payload === undefined) return jobs.length;

    const normalised = normalisePayload(payload);
    return jobs.filter((j) => isDeepStrictEqual(j.payload, normalised)).length;
  }

  // --- Dispatch -----------------------------------------------------

  /**
   * Dispatch runnable buffered jobs (status `ready`, or `scheduled`
   * with a `readyAt` already elapsed) through `handler`.
   *
   * By default a single snapshot of currently-runnable entries is
   * drained — anything enqueued from within a handler stays buffered
   * for the next call. Pass `recursive: true` to keep looping until
   * no more entries match; `maxIterations` (default `1000`) caps the
   * loop so a handler that unconditionally re-enqueues throws instead
   * of hanging the test suite.
   *
   * On success the entry moves to `completed`. On a raised exception
   * the entry moves to `dead` and the exception re-throws.
   *
   * Returns the number of jobs dispatched.
   */
  async dispatch(
    handler: JobHandler,
    options: TestDispatchOptions = {},
  ): Promise<number> {
    const {
      recursive = false,
      maxIterations = 1000,
      ...filters
    } = options;

    let total = 0;
    let iterations = 0;

    while (true) {
      const snapshot = this.takeRunnableSnapshot(filters);
      if (snapshot.length === 0) break;

      for (const entry of snapshot) {
        try {
          await handler(entry.job);
          entry.status = "completed";
        } catch (err) {
          entry.status = "dead";
          throw err;
        }
      }
      total += snapshot.length;

      if (!recursive) break;

      if (++iterations >= maxIterations) {
        throw new Error(
          `TestClient.dispatch exceeded maxIterations (${maxIterations}) — ` +
            `a handler is likely re-enqueueing unconditionally. Raise the ` +
            `limit via { maxIterations: N }, or drop { recursive: true } ` +
            `to process only the current snapshot.`,
        );
      }
    }

    return total;
  }

  // --- Overridden no-ops -------------------------------------------

  override async close(): Promise<void> {}
  override async destroy(): Promise<void> {}

  // --- Internal ----------------------------------------------------

  private record(options: EnqueueOptions): Job {
    const now = Date.now();
    const readyAt = options.readyAt ?? now;
    const status: JobStatus = readyAt > now ? "scheduled" : "ready";

    const id = this.syntheticId(++this.idCounter);
    // Normalise the payload through JSON so the buffered representation
    // matches what a real server would see — symbol keys and Symbol
    // values become strings, Date instances become ISO strings, etc.
    const payload = normalisePayload(options.payload);

    const entry: Entry = {
      options: { ...options, payload },
      status,
      job: new Job(this, {
        id,
        type: options.type,
        queue: options.queue,
        priority: options.priority ?? 32_768,
        status,
        payload,
        readyAt,
        attempts: 0,
        retryLimit: options.retryLimit,
        backoff: options.backoff,
        retention: options.retention,
        uniqueKey: options.uniqueKey,
        uniqueWhile: options.uniqueWhile,
        batch: options.batch,
        // Resolved the way the server resolves them, so a recorded job
        // reports the cost that would actually apply rather than the
        // `undefined` the caller left. `as never` below defeats the
        // type check that would otherwise catch this field going
        // missing, so it is worth stating explicitly.
        budgets: (options.budgets ?? []).map((b) => ({
          key: b.key,
          cost: b.cost ?? 1,
        })),
      } as never),
    };

    // Keep the Job.status accessor in sync when we mutate the entry
    // status during dispatch. Job is a value class with `readonly`
    // fields; the underlying data is fixed at construction. To honour
    // that we replace the Job when the status changes.
    this.entries.push(entry);
    return entry.job;
  }

  private syntheticId(counter: number): string {
    // Same shape (length) as a real scru128 id so downstream code
    // that stores or logs the id sees consistent widths.
    return "test" + String(counter).padStart(21, "0");
  }

  private byStatus(statuses: JobStatus[], filters: TestJobFilters): Job[] {
    return applyFilters(this.entries, filters)
      .filter((e) => statuses.includes(e.status))
      .map((e) => e.job);
  }

  private takeRunnableSnapshot(filters: TestJobFilters): Entry[] {
    const now = Date.now();
    const runnable = applyFilters(this.entries, filters).filter((e) => {
      if (e.status === "ready") return true;
      if (e.status === "scheduled") {
        return (e.options.readyAt ?? 0) <= now;
      }
      return false;
    });
    for (const entry of runnable) entry.status = "in_flight";
    return runnable;
  }
}

// --- Internal types & helpers -------------------------------------

interface Entry {
  /** The original enqueue options (payload already normalised). */
  options: EnqueueOptions;
  /** Mutable lifecycle status. */
  status: JobStatus;
  /** The `Job` returned to callers. `status` on Job is the initial one. */
  job: Job;
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function applyFilters(entries: Entry[], filters: TestJobFilters): Entry[] {
  const onlyQueues = toArray(filters.onlyQueues);
  const exceptQueues = toArray(filters.exceptQueues);
  const onlyTypes = toArray(filters.onlyTypes);
  const exceptTypes = toArray(filters.exceptTypes);
  const pred = filters.filter;

  return entries.filter((e) => {
    const queue = e.options.queue;
    const type = e.options.type;
    if (onlyQueues.length && !onlyQueues.includes(queue)) return false;
    if (exceptQueues.length && exceptQueues.includes(queue)) return false;
    if (onlyTypes.length && !onlyTypes.includes(type)) return false;
    if (exceptTypes.length && exceptTypes.includes(type)) return false;
    if (pred && !pred(e.job)) return false;
    return true;
  });
}

function normalisePayload(payload: unknown): unknown {
  if (payload === undefined) return undefined;
  return JSON.parse(JSON.stringify(payload));
}

/**
 * Wrap `client` in a Proxy that throws `NotSupportedError` for any
 * method inherited from {@link Client} but not implemented on
 * {@link TestClient}. Methods that TestClient does implement (either
 * `override`s of Client methods or its own additions) pass through
 * unchanged, as do non-function properties (`url`, instance fields,
 * etc.).
 *
 * This is a maintenance measure: as new methods are added to `Client`
 * over time, they auto-fail loudly in test code instead of silently
 * reaching the (stub) HTTP layer. It will go away when we split `Client`
 * into an interface + `LiveClient`/`TestClient` or similar in an eventual v1.
 */
function notImplementedProxy(client: TestClient): TestClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      // Only intercept string keys — Symbols (Symbol.iterator,
      // Symbol.toStringTag, well-knowns for async iteration, etc.)
      // must pass through so JS runtime protocols keep working.
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver);
      }

      // TestClient defines it → honour the implementation.
      if (
        Object.prototype.hasOwnProperty.call(TestClient.prototype, prop)
      ) {
        return Reflect.get(target, prop, receiver);
      }

      // Inherited from Client → auto-throw. Only guard functions;
      // non-function properties (readonly `url`, etc.) pass through.
      const descriptor = Object.getOwnPropertyDescriptor(
        Client.prototype,
        prop,
      );
      if (descriptor && typeof descriptor.value === "function") {
        // Async wrapper so `assert.rejects(client.method(), ...)` and
        // similar patterns work — every server-touching method on
        // Client is async, so returning a rejected promise matches
        // the shape callers expect.
        return async function unsupported(): Promise<never> {
          throw new NotSupportedError(prop);
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function stubDispatcher(): Dispatcher {
  // A proxy that returns no-ops for close/destroy (touched by
  // `Client.close`/`destroy`) and throws for everything else. TestClient
  // overrides both close/destroy anyway, but a defensive stub keeps
  // subclassers from being surprised if they call `super.close()`.
  const dispatcher = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "close" || prop === "destroy") {
          return () => Promise.resolve();
        }
        return () => {
          throw new Error(
            `TestClient.buildDispatchers stub was invoked (property "${String(prop)}"). ` +
              "This means an inherited method reached the HTTP layer — file a bug.",
          );
        };
      },
    },
  );
  return dispatcher as unknown as Dispatcher;
}

