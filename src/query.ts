// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Composable, lazy query builders.
 *
 * Exposes two chainable, immutable builders:
 *
 * - {@link JobQuery} — for filtering, iterating, updating, and deleting
 *   jobs. Created via `client.jobs()`.
 * - {@link ErrorQuery} — for iterating error records attached to a job.
 *   Created via `job.errors()`.
 *
 * Both share the same iteration shape (`Symbol.asyncIterator`, `pages()`,
 * `first()`, `last()`, `toArray()`) and honour `limit` and `inPagesOf`.
 *
 * Every builder method returns a new instance, so queries are safe to
 * share and compose.
 *
 * Iteration is lazy: no HTTP requests are made until the async iterator is
 * consumed or a terminal method is called.
 *
 * @module
 */

import type {
  Client,
  JobFilter,
  BudgetBindingInput,
  BudgetChange,
  JobStatus,
  RangeFilter,
  SortDirection,
  UpdateJobOptions,
} from "./client.ts";
import type { Job, JobPage, ErrorRecord, ErrorPage } from "./resources.ts";

/** Maximum page size the server will accept. */
const MAX_PAGE_SIZE = 2000;

// ---------------------------------------------------------------------------
// Lazy<T>
// ---------------------------------------------------------------------------

/**
 * Base class for lazy, async-iterable collections.
 *
 * Subclasses only need to implement `[Symbol.asyncIterator]`. All of the
 * terminal helpers (`toArray`, `count`, `first`, `isEmpty`, `forEach`) and
 * the lazy transforms (`map`, `filter`) are provided and work against the
 * iterator.
 *
 * `map` and `filter` return a fresh `Lazy<U>` wrapper so that callers can
 * continue chaining helpers (e.g. `query.map(...).filter(...).toArray()`)
 * without having to reach for `[Symbol.asyncIterator]()` or `Array.fromAsync`
 * manually.
 */
export abstract class Lazy<T> implements AsyncIterable<T> {
  abstract [Symbol.asyncIterator](): AsyncGenerator<T>;

  /**
   * Collect all items into an array.
   *
   * Delegates to the built-in `Array.fromAsync()` helper.
   */
  async toArray(): Promise<T[]> {
    return Array.fromAsync(this);
  }

  /**
   * Count all items.
   *
   * Iterates lazily, holding only one item at a time in memory. The
   * underlying iterator is responsible for doing this efficiently — for
   * paginated queries this means `ceil(N / pageSize)` HTTP requests.
   */
  async count(): Promise<number> {
    let n = 0;
    for await (const _ of this) n++;
    return n;
  }

  /** Return the first item, or `undefined` if the collection is empty. */
  async first(): Promise<T | undefined> {
    for await (const item of this) return item;
    return undefined;
  }

  /** Return `true` if there are no items. */
  async isEmpty(): Promise<boolean> {
    return (await this.first()) === undefined;
  }

  /** Invoke `fn` for each item, awaiting async results sequentially. */
  async forEach(fn: (item: T) => void | Promise<void>): Promise<void> {
    for await (const item of this) {
      await fn(item);
    }
  }

  /** Lazily transform each item. Returns a new `Lazy`. */
  map<U>(fn: (item: T) => U | Promise<U>): Lazy<U> {
    return new MappedLazy(this, fn);
  }

  /** Lazily keep only items for which `fn` returns a truthy value. */
  filter(fn: (item: T) => boolean | Promise<boolean>): Lazy<T> {
    return new FilteredLazy(this, fn);
  }
}

/** @internal */
class MappedLazy<T, U> extends Lazy<U> {
  private readonly source: AsyncIterable<T>;
  private readonly fn: (item: T) => U | Promise<U>;

  constructor(source: AsyncIterable<T>, fn: (item: T) => U | Promise<U>) {
    super();
    this.source = source;
    this.fn = fn;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<U> {
    for await (const item of this.source) {
      yield await this.fn(item);
    }
  }
}

/** @internal */
class FilteredLazy<T> extends Lazy<T> {
  private readonly source: AsyncIterable<T>;
  private readonly fn: (item: T) => boolean | Promise<boolean>;

  constructor(
    source: AsyncIterable<T>,
    fn: (item: T) => boolean | Promise<boolean>,
  ) {
    super();
    this.source = source;
    this.fn = fn;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for await (const item of this.source) {
      if (await this.fn(item)) yield item;
    }
  }
}

// ---------------------------------------------------------------------------
// JobQuery
// ---------------------------------------------------------------------------

/** Options for configuring a {@link JobQuery}. */
export interface JobQueryOptions {
  /** Filter by job ID. */
  id?: string | string[];

  /** Filter by queue name. */
  queue?: string | string[];

  /** Filter by job type. */
  type?: string | string[];

  /** Filter by status. */
  status?: JobStatus | JobStatus[];

  /** Filter by the budgets a job draws on. */
  budgetsKey?: string | string[];

  /** jq expression applied to the payload. */
  jqFilter?: string;

  /** Priority filter — exact value or `{min, max}` inclusive range. */
  priority?: RangeFilter;

  /** `readyAt` filter (ms since epoch) — exact value or `{min, max}` range. */
  readyAt?: RangeFilter;

  /** Failure count filter — exact value or `{min, max}` inclusive range. */
  attempts?: RangeFilter;

  /** Sort order. Default: "asc" (oldest first). */
  order?: SortDirection;

  /** Maximum total number of jobs to return across all pages. */
  limit?: number;

  /** Number of jobs to fetch per page. */
  pageSize?: number;
}

/**
 * Lazy, paginating query builder for jobs.
 *
 * Created by `client.jobs()`. Each builder method returns a new instance
 * (immutable). Iteration is lazy — no HTTP requests are made until the
 * iterator is consumed or a terminal method is called.
 *
 * Implements `Symbol.asyncIterator`, so a `JobQuery` can be used directly
 * in `for await...of` loops, or handed to `Array.fromAsync()` (with an
 * optional mapper). To use the Node 22+ async iterator helpers
 * (`.map()`, `.filter()`, etc.), obtain the iterator explicitly with
 * `[Symbol.asyncIterator]()` first — those helpers live on
 * `AsyncIterator.prototype`, not on async iterables.
 *
 * @example Iterating, mapping, and collecting
 * ```ts
 * // Plain loop
 * for await (const job of client.jobs().byQueue("emails")) {
 *   console.log(job.id);
 * }
 *
 * // Array.fromAsync with a mapper
 * const ids = await Array.fromAsync(
 *   client.jobs().byQueue("emails"),
 *   (job) => job.id,
 * );
 *
 * // Iterator helpers via [Symbol.asyncIterator]()
 * const urgent = await client.jobs()
 *   .byQueue("emails")
 *   [Symbol.asyncIterator]()
 *   .filter((job) => (job.payload as any).urgent)
 *   .toArray();
 * ```
 *
 * @example
 * ```ts
 * // Count ready jobs on a queue (paginates server-side; O(1) memory)
 * const n = await client.jobs()
 *   .byQueue("emails")
 *   .byStatus("ready")
 *   .count();
 *
 * // Move all jobs from one queue to another
 * await client.jobs().byQueue("old").updateAll({ queue: "new" });
 *
 * // Delete dead jobs matching a payload subset
 * await client.jobs()
 *   .byStatus("dead")
 *   .withPayloadSubset({ userId: 42 })
 *   .deleteAll();
 *
 * // Iterate in batches
 * for await (const page of client.jobs().inPagesOf(100).pages()) {
 *   for (const job of page.jobs) console.log(job.id);
 * }
 * ```
 */
export class JobQuery extends Lazy<Job> {
  private client: Client;
  private _id?: string | string[];
  private _queue?: string | string[];
  private _type?: string | string[];
  private _budgetsKey?: string | string[];
  private _status?: JobStatus | JobStatus[];
  private _jqFilter?: string;
  private _priority?: RangeFilter;
  private _readyAt?: RangeFilter;
  private _attempts?: RangeFilter;
  private _order?: SortDirection;
  private _limit?: number;
  private _pageSize?: number;

  /** @internal */
  constructor(client: Client, options: JobQueryOptions = {}) {
    super();
    this.client = client;
    this._id = options.id;
    this._queue = options.queue;
    this._type = options.type;
    this._status = options.status;
    this._budgetsKey = options.budgetsKey;
    this._jqFilter = options.jqFilter;
    this._priority = options.priority;
    this._readyAt = options.readyAt;
    this._attempts = options.attempts;
    this._order = options.order;
    this._limit = options.limit;
    this._pageSize = options.pageSize;
  }

  // --- Filter builders ---

  /** Filter by job ID. Replaces any existing ID filter. */
  byId(id: string | string[] | undefined): JobQuery {
    return this.rebuild({ id });
  }

  /** Add an ID to the existing ID filter (unions with existing). */
  addId(id: string | string[]): JobQuery {
    return this.rebuild({ id: concat(this._id, id) });
  }

  /** Filter by queue name. Replaces any existing queue filter. */
  byQueue(queue: string | string[] | undefined): JobQuery {
    return this.rebuild({ queue });
  }

  /** Add a queue to the existing queue filter. */
  addQueue(queue: string | string[]): JobQuery {
    return this.rebuild({ queue: concat(this._queue, queue) });
  }

  /**
   * Filter by the budgets a job draws on. Replaces any existing budget
   * filter.
   */
  byBudgetsKey(budgetsKey: string | string[] | undefined): JobQuery {
    return this.rebuild({ budgetsKey });
  }

  /** Add a budget to the existing budget filter. */
  addBudgetsKey(budgetsKey: string | string[]): JobQuery {
    return this.rebuild({ budgetsKey: concat(this._budgetsKey, budgetsKey) });
  }

  /** Filter by job type. Replaces any existing type filter. */
  byType(type: string | string[] | undefined): JobQuery {
    return this.rebuild({ type });
  }

  /** Add a type to the existing type filter. */
  addType(type: string | string[]): JobQuery {
    return this.rebuild({ type: concat(this._type, type) });
  }

  /** Filter by status. Replaces any existing status filter. */
  byStatus(status: JobStatus | JobStatus[] | undefined): JobQuery {
    return this.rebuild({ status });
  }

  /** Add a status to the existing status filter. */
  addStatus(status: JobStatus | JobStatus[]): JobQuery {
    return this.rebuild({ status: concat(this._status, status) });
  }

  /** Replace the jq payload filter expression. */
  byJqFilter(jqFilter: string | undefined): JobQuery {
    return this.rebuild({ jqFilter });
  }

  /**
   * Add a jq payload filter. Combines with any existing filter via `and`.
   */
  addJqFilter(jqFilter: string): JobQuery {
    return this.rebuild({
      jqFilter: concat(this._jqFilter, `(${jqFilter})`).join(" and "),
    });
  }

  /**
   * Filter by priority. Replaces any existing priority filter.
   *
   * Accepts an exact value (`50`) or a `{min, max}` range with inclusive
   * bounds. Omit either side for an unbounded end. Lower numbers are
   * higher priority.
   *
   * @example
   * client.jobs().byPriority(0);                  // exact match
   * client.jobs().byPriority({ min: 0, max: 100 }); // bounded range
   * client.jobs().byPriority({ min: 100 });        // 100 or higher
   * client.jobs().byPriority({ max: 100 });        // 100 or lower
   */
  byPriority(priority: RangeFilter | undefined): JobQuery {
    return this.rebuild({ priority });
  }

  /**
   * Filter by `readyAt` (ms since epoch). Replaces any existing filter.
   *
   * Accepts an exact value or a `{min, max}` range with inclusive bounds.
   * Use `Date.prototype.getTime()` to derive ms from a `Date` instance.
   *
   * @example
   * // Eligible to run by now.
   * client.jobs().byReadyAt({ max: Date.now() });
   *
   * // Within the next hour.
   * client.jobs().byReadyAt({ min: Date.now(), max: Date.now() + 3_600_000 });
   */
  byReadyAt(readyAt: RangeFilter | undefined): JobQuery {
    return this.rebuild({ readyAt });
  }

  /**
   * Filter by failure count. Replaces any existing attempts filter.
   *
   * Accepts an exact value or a `{min, max}` range with inclusive bounds.
   * `0` selects jobs that have never failed; `{ min: 1 }` selects anything
   * that has failed at least once.
   *
   * @example
   * client.jobs().byAttempts(0);                 // never failed
   * client.jobs().byAttempts({ min: 1 });        // has failed
   * client.jobs().byAttempts({ min: 1, max: 3 }); // 1, 2, or 3 failures
   */
  byAttempts(attempts: RangeFilter | undefined): JobQuery {
    return this.rebuild({ attempts });
  }

  /**
   * Constrain results by an exact payload match.
   *
   * Layers onto any existing jq filter via `and`. The emitted jq
   * expression is `. == <JSON>`, so matching is structural and
   * key-order independent (jq's object equality sorts keys).
   *
   * This is syntactic sugar around `addJqFilter()` so it can be combined with
   * other jq filter methods.
   */
  withPayload(payload: unknown): JobQuery {
    return this.addJqFilter(`. == ${JSON.stringify(payload)}`);
  }

  /**
   * Constrain results by a payload subset.
   *
   * Layers onto any existing jq filter via `and`. The emitted jq
   * expression depends on the shape of `payload`:
   *
   * - **Objects**: `. | contains(<JSON>)` — deep subset check; every key in
   *   `payload` must exist in the job payload with a contained value.
   * - **Arrays**: `.[0:N] == <JSON>` — prefix match against the first `N`
   *   elements of the job payload.
   * - **Scalars** (number, string, boolean, null): `. == <JSON>` — equality.
   *
   * This is syntactic sugar around `addJqFilter()` so it can be combined with
   * other jq filter methods.
   */
  withPayloadSubset(payload: unknown): JobQuery {
    return this.addJqFilter(payloadSubsetFilter(payload));
  }

  // --- Ordering, limiting, paging ---

  /** Set the sort order. */
  order(direction: SortDirection): JobQuery {
    return this.rebuild({ order: direction });
  }

  /** Reverse the sort order. Defaults to "desc" if no order was set. */
  reverseOrder(): JobQuery {
    return this.rebuild({ order: this._order === "desc" ? "asc" : "desc" });
  }

  /**
   * Set the maximum total number of jobs to return across all pages.
   *
   * Also caps page fetches and limits the number of jobs touched by
   * `updateAll` / `deleteAll`.
   */
  limit(n: number): JobQuery {
    return this.rebuild({ limit: n });
  }

  /**
   * Set the page size for pagination.
   *
   * Affects how many jobs are fetched per HTTP request during iteration,
   * and also causes `updateAll` / `deleteAll` to batch per page using
   * ID-scoped bulk operations.
   */
  inPagesOf(n: number): JobQuery {
    return this.rebuild({ pageSize: n });
  }

  // --- Terminal methods ---

  /**
   * Return the first matching job, or `undefined` if none.
   *
   * Optimised override: pushes `limit=1` to the server instead of
   * iterating a full default page.
   */
  override async first(): Promise<Job | undefined> {
    for await (const job of this.limit(1)) {
      return job;
    }
    return undefined;
  }

  /**
   * Return the last matching job, or `undefined` if none.
   *
   * Optimised: reverses the order and fetches a single job.
   */
  async last(): Promise<Job | undefined> {
    return this.reverseOrder().first();
  }

  /**
   * Update all matching jobs.
   *
   * Behaviour depends on whether `limit` or `pageSize` is set:
   *
   * - **Unbounded**: a single bulk update request is sent with the query
   *   filters as the scope.
   * - **Bounded**: pages are iterated and a separate bulk update is issued
   *   per page, scoped to both the query filters and the IDs on that page.
   *   This is safe against races with newly enqueued jobs and lets callers
   *   throttle large update operations via `inPagesOf`.
   *
   * Returns the total number of updated jobs.
   */
  async updateAll(apply: UpdateJobOptions): Promise<number> {
    const where = this.toWhere();

    if (this._limit == null && this._pageSize == null) {
      return this.client.updateAllJobs({ where, apply });
    }

    let remaining = this._limit;
    let updated = 0;

    for await (const page of this.pages()) {
      let ids = page.jobs.map((j) => j.id);
      if (remaining != null) {
        if (remaining <= 0) break;
        if (ids.length > remaining) ids = ids.slice(0, remaining);
      }
      if (ids.length === 0) continue;

      updated += await this.client.updateAllJobs({
        where: { ...where, id: ids },
        apply,
      });

      if (remaining != null) {
        remaining -= ids.length;
        if (remaining <= 0) break;
      }
    }

    return updated;
  }

  /**
   * Update the first matching job.
   *
   * Returns 1 if a job was updated, 0 if no jobs matched.
   */
  async updateOne(apply: UpdateJobOptions): Promise<number> {
    return this.limit(1).updateAll(apply);
  }

  /**
   * Delete all matching jobs.
   *
   * Behaviour depends on whether `limit` or `pageSize` is set:
   *
   * - **Unbounded**: a single bulk delete request is sent with the query
   *   filters as the scope. A query with no filters will delete *all* jobs
   *   on the server — useful in tests, dangerous in production.
   * - **Bounded**: pages are iterated and a separate bulk delete is issued
   *   per page, scoped to both the query filters and the IDs on that page.
   *
   * Returns the total number of deleted jobs.
   */
  async deleteAll(): Promise<number> {
    const where = this.toWhere();

    if (this._limit == null && this._pageSize == null) {
      return this.client.deleteAllJobs({ where });
    }

    let remaining = this._limit;
    let deleted = 0;

    for await (const page of this.pages()) {
      let ids = page.jobs.map((j) => j.id);
      if (remaining != null) {
        if (remaining <= 0) break;
        if (ids.length > remaining) ids = ids.slice(0, remaining);
      }
      if (ids.length === 0) continue;

      deleted += await this.client.deleteAllJobs({
        where: { ...where, id: ids },
      });

      if (remaining != null) {
        remaining -= ids.length;
        if (remaining <= 0) break;
      }
    }

    return deleted;
  }

  /**
   * Delete the first matching job.
   *
   * Returns 1 if a job was deleted, 0 if no jobs matched.
   */
  async deleteOne(): Promise<number> {
    return this.limit(1).deleteAll();
  }

  /**
   * Count matching jobs using the server-side count endpoint.
   *
   * This overrides the base `Lazy.count()` with a single HTTP request to
   * `GET /jobs/count` instead of paginating through all results.
   *
   * When a `limit` is set, caps the server-side count locally with
   * `Math.min()` rather than paginating.
   */
  override async count(): Promise<number> {
    const total = await this.client.countJobs(this.toWhere());
    return this._limit != null ? Math.min(total, this._limit) : total;
  }

  // --- Iteration ---

  /**
   * Async iterator over individual jobs.
   *
   * Lazily paginates through results, respecting `limit` if set. Enables
   * `for await...of` loops and is also consumable by `Array.fromAsync()`.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<Job> {
    let remaining = this._limit;

    for await (const page of this.pages()) {
      for (const job of page.jobs) {
        if (remaining != null) {
          if (remaining <= 0) return;
          remaining--;
        }
        yield job;
      }
      if (remaining != null && remaining <= 0) return;
    }
  }

  /**
   * Async iterator over pages of jobs.
   *
   * Each yielded value is a `JobPage`. Useful when you want to process jobs
   * in batches. Terminates once the query's `limit` has been reached (does
   * not truncate the final page).
   */
  async *pages(): AsyncGenerator<JobPage> {
    const effectivePageSize = clampPageSize(this._pageSize, this._limit);
    let remaining = this._limit;

    let page: JobPage | null = await this.client.listJobs({
      id: this._id,
      queue: this._queue,
      type: this._type,
      status: this._status,
      budgetsKey: this._budgetsKey,
      filter: this._jqFilter,
      priority: this._priority,
      readyAt: this._readyAt,
      attempts: this._attempts,
      order: this._order,
      limit: effectivePageSize,
    });

    while (page) {
      yield page;

      if (remaining != null) {
        remaining -= page.jobs.length;
        if (remaining <= 0) return;
      }

      page = await page.nextPage();
    }
  }

  /**
   * Bind every job this query matches to a budget, skipping over those
   * already bound to it.
   *
   * Named for the binding rather than the budget: this changes what
   * these jobs draw on, and creates or deletes no budget.
   */
  async bindBudget(binding: BudgetBindingInput): Promise<BudgetChange> {
    return this.client.bindAllJobsBudget(binding, this.toWhere());
  }

  /**
   * Bind every matching job to a budget, replacing any existing binding
   * to it.
   */
  async rebindBudget(binding: BudgetBindingInput): Promise<BudgetChange> {
    return this.client.rebindAllJobsBudget(binding, this.toWhere());
  }

  /**
   * Change what an existing binding costs, leaving the binding alone.
   * Matching jobs not bound to the budget are passed over.
   */
  async setBudgetCost(key: string, cost: number): Promise<BudgetChange> {
    return this.client.setAllJobsBudgetCost(key, cost, this.toWhere());
  }

  /**
   * Unbind one budget from every matching job, leaving their others
   * alone.
   *
   * ```ts
   * await client.jobs().byBudgetsKey("emails").unbindBudget("emails");
   * await client.deleteBudget("emails");
   * ```
   */
  async unbindBudget(key: string): Promise<BudgetChange> {
    return this.client.unbindAllJobsBudget(key, this.toWhere());
  }

  /**
   * Unbind *every* budget from every matching job.
   *
   * Beware: on an unfiltered query this strips every job on the server
   * of its budgets.
   */
  async clearBudgets(): Promise<BudgetChange> {
    return this.client.clearAllJobsBudgets(this.toWhere());
  }

  // --- Internal helpers ---

  private toWhere(): JobFilter {
    return {
      id: this._id,
      queue: this._queue,
      type: this._type,
      status: this._status,
      budgetsKey: this._budgetsKey,
      filter: this._jqFilter,
      priority: this._priority,
      readyAt: this._readyAt,
      attempts: this._attempts,
    };
  }

  private rebuild(overrides: Partial<JobQueryOptions>): JobQuery {
    return new JobQuery(this.client, {
      id: this._id,
      queue: this._queue,
      type: this._type,
      status: this._status,
      budgetsKey: this._budgetsKey,
      jqFilter: this._jqFilter,
      priority: this._priority,
      readyAt: this._readyAt,
      attempts: this._attempts,
      order: this._order,
      limit: this._limit,
      pageSize: this._pageSize,
      ...overrides,
    });
  }
}

// ---------------------------------------------------------------------------
// ErrorQuery
// ---------------------------------------------------------------------------

/** Options for configuring an {@link ErrorQuery}. */
export interface ErrorQueryOptions {
  /** Sort order. Default: "asc" (oldest first). */
  order?: SortDirection;

  /** Maximum total number of errors to return across all pages. */
  limit?: number;

  /** Number of errors to fetch per page. */
  pageSize?: number;
}

/**
 * Lazy async iterator over error records with a chainable builder API.
 *
 * Created by `Job.errors()`. Each builder method returns a new instance
 * (immutable). Iteration is lazy — no HTTP requests are made until the
 * iterator is consumed.
 *
 * @example
 * ```ts
 * // Iterate all errors
 * for await (const error of job.errors()) {
 *   console.log(`Attempt ${error.attempt}: ${error.message}`);
 * }
 *
 * // With builder options
 * const recent = await job.errors()
 *   .order("desc")
 *   .limit(5)
 *   .toArray();
 * ```
 */
export class ErrorQuery extends Lazy<ErrorRecord> {
  private client: Client;
  private jobId: string;
  private _order?: SortDirection;
  private _limit?: number;
  private _pageSize?: number;

  /** @internal */
  constructor(
    client: Client,
    jobId: string,
    options?: ErrorQueryOptions,
  ) {
    super();
    this.client = client;
    this.jobId = jobId;
    this._order = options?.order;
    this._limit = options?.limit;
    this._pageSize = options?.pageSize;
  }

  /** Set the sort order. Returns a new query. */
  order(direction: SortDirection): ErrorQuery {
    return this.rebuild({ order: direction });
  }

  /**
   * Set the maximum total number of errors to return across all pages.
   *
   * Also used to optimise the page size — if the limit is smaller than
   * the page size, only the needed amount is fetched.
   */
  limit(n: number): ErrorQuery {
    return this.rebuild({ limit: n });
  }

  /** Set the page size for pagination. Returns a new query. */
  inPagesOf(n: number): ErrorQuery {
    return this.rebuild({ pageSize: n });
  }

  /** Reverse the sort order. Returns a new query. */
  reverseOrder(): ErrorQuery {
    return this.rebuild({ order: this._order === "desc" ? "asc" : "desc" });
  }

  /**
   * Return the first error, or `undefined` if none.
   *
   * Optimised override: pushes `limit=1` to the server instead of
   * iterating a full default page.
   */
  override async first(): Promise<ErrorRecord | undefined> {
    for await (const error of this.limit(1)) {
      return error;
    }
    return undefined;
  }

  /**
   * Return the last error, or `undefined` if none.
   *
   * Optimised: reverses the order and fetches a single error.
   */
  async last(): Promise<ErrorRecord | undefined> {
    return this.reverseOrder().first();
  }

  /**
   * Async iterator over individual error records.
   *
   * Lazily paginates through results, respecting `limit` if set.
   * Enables `for await...of` loops and is consumable by `Array.fromAsync()`.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<ErrorRecord> {
    let remaining = this._limit;
    const effectivePageSize = clampPageSize(this._pageSize, this._limit);

    let page = await this.client.listErrors(this.jobId, {
      order: this._order,
      limit: effectivePageSize,
    });

    while (true) {
      for (const error of page) {
        if (remaining != null) {
          if (remaining <= 0) return;
          remaining--;
        }
        yield error;
      }

      if (!page.hasNext) return;
      if (remaining != null && remaining <= 0) return;

      page = (await page.nextPage())!;
    }
  }

  /**
   * Async iterator over pages of error records.
   *
   * Each yielded value is an `ErrorPage`. Useful when you want to
   * process errors in batches.
   */
  async *pages(): AsyncGenerator<ErrorPage> {
    let remaining = this._limit;
    const effectivePageSize = clampPageSize(this._pageSize, this._limit);

    let page: ErrorPage | null = await this.client.listErrors(this.jobId, {
      order: this._order,
      limit: effectivePageSize,
    });

    while (page) {
      yield page;

      if (remaining != null) {
        remaining -= page.errors.length;
        if (remaining <= 0) return;
      }

      page = await page.nextPage();
    }
  }

  private rebuild(overrides: ErrorQueryOptions): ErrorQuery {
    return new ErrorQuery(this.client, this.jobId, {
      order: this._order,
      limit: this._limit,
      pageSize: this._pageSize,
      ...overrides,
    });
  }
}

// ---------------------------------------------------------------------------
// Module-local helpers
// ---------------------------------------------------------------------------

/**
 * Compute the effective per-request page size.
 *
 * Takes the smallest of the caller-provided `pageSize`, the overall
 * `limit`, and `MAX_PAGE_SIZE`. Returns `undefined` when none are set,
 * which lets the server apply its own default.
 */
function clampPageSize(
  pageSize: number | undefined,
  limit: number | undefined,
): number | undefined {
  const candidates = [pageSize, limit, MAX_PAGE_SIZE].filter(
    (v): v is number => v != null,
  );
  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}

/** Combine two scalar-or-array values into a single flattened array. */
function concat<T>(
  existing: T | T[] | undefined,
  next: T | T[] | undefined,
): T[] {
  return ([] as T[]).concat(existing ?? []).concat(next ?? []);
}

/**
 * Build a jq subset filter for a payload value.
 *
 * - Object → `. | contains(<JSON>)`
 * - Array  → `.[0:N] == <JSON>` (prefix match)
 * - Scalar → `. == <JSON>`
 */
function payloadSubsetFilter(payload: unknown): string {
  if (payload === null || typeof payload !== "object") {
    return `. == ${JSON.stringify(payload)}`;
  }
  if (Array.isArray(payload)) {
    return `.[0:${payload.length}] == ${JSON.stringify(payload)}`;
  }
  return `. | contains(${JSON.stringify(payload)})`;
}
