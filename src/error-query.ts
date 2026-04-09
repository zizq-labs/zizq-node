// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Lazy, paginating async iterator over error records for a job.
 *
 * Provides a chainable builder API for configuring page size, order, and
 * limit, then implements `Symbol.asyncIterator` so it can be used with
 * `for await...of` and Node 22+ async iterator helpers (`.map()`,
 * `.filter()`, `.toArray()`, etc.).
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
 *
 * @module
 */

import type { Client, SortDirection } from "./client.ts";
import type { ErrorRecord, ErrorPage } from "./resources.ts";

const MAX_PAGE_SIZE = 2000;

/** Options for configuring an error query. */
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
 * (immutable). Iteration is lazy — no HTTP requests are made until
 * the iterator is consumed.
 */
export class ErrorQuery {
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
   * Collect all matching errors into an array.
   *
   * Respects `limit` if set, otherwise fetches all errors.
   */
  async toArray(): Promise<ErrorRecord[]> {
    const results: ErrorRecord[] = [];
    for await (const error of this) {
      results.push(error);
    }
    return results;
  }

  /**
   * Return the first error, or `undefined` if none.
   *
   * Optimised: fetches a single error from the server.
   */
  async first(): Promise<ErrorRecord | undefined> {
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
   * Enables `for await...of` and all Node 22+ async iterator helpers.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<ErrorRecord> {
    let remaining = this._limit;
    const effectivePageSize = this.effectivePageSize();

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
    const effectivePageSize = this.effectivePageSize();

    let page: ErrorPage | null =
      await this.client.listErrors(this.jobId, {
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

  private effectivePageSize(): number {
    const candidates = [this._pageSize, this._limit, MAX_PAGE_SIZE].filter(
      (v): v is number => v != null
    );
    return Math.min(...candidates);
  }

  private rebuild(overrides: ErrorQueryOptions): ErrorQuery {
    return new ErrorQuery(this.client, this.jobId, {
      order: overrides.order ?? this._order,
      limit: overrides.limit ?? this._limit,
      pageSize: overrides.pageSize ?? this._pageSize,
    });
  }
}
