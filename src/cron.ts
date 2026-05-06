// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * High-level cron scheduling helpers.
 *
 * Provides a fluent handle API for managing cron schedules, with support
 * for function references (same as the `enqueue()` helper).
 *
 * @module
 */

import type { Client, CronEntryInput, ReplaceCronGroupOptions } from "./client.ts";
import type { CronGroup, CronEntry } from "./resources.ts";
import type { EnqueueOptions } from "./types.ts";
import { type EnqueueInput, resolveInput } from "./enqueue.ts";

/**
 * A cron entry definition that accepts function references for the job type.
 *
 * The `type` field works the same as in `enqueue()` — it can be a string
 * type name or a function reference with attached `zizqOptions`.
 */
export interface CronEntryDefinition {
  /** Entry name (unique within the group). */
  name: string;

  /** Cron expression (e.g. "0 9 * * MON"). */
  expression: string;

  /** IANA timezone name (e.g. "Australia/Melbourne"). */
  timezone?: string;

  /** Whether this entry should be paused. */
  paused?: boolean;

  /** Job type — a function reference or a string type name. */
  type: EnqueueInput["type"];

  /** Arbitrary payload delivered to the worker. */
  payload: unknown;

  /** Target queue name (required when type is a string without zizqOptions). */
  queue?: string;

  /** Priority (lower = higher priority). */
  priority?: number;

  /** Per-job retry limit. */
  retryLimit?: number;

  /** Per-job backoff configuration. */
  backoff?: EnqueueOptions["backoff"];

  /** Per-job retention configuration. */
  retention?: EnqueueOptions["retention"];

  /** Unique key for deduplication. */
  uniqueKey?: string;

  /** Uniqueness scope. */
  uniqueWhile?: EnqueueOptions["uniqueWhile"];
}

/** Options for registering (replacing) a cron schedule. */
export interface RegisterCronOptions {
  /** Default timezone for all entries (can be overridden per entry). */
  timezone?: string;

  /** Whether the group should be paused. */
  paused?: boolean;

  /** The entries that define the schedule. */
  entries: CronEntryDefinition[];
}

/**
 * Resolve a CronEntryDefinition into a CronEntryInput by resolving
 * function references via the shared resolveInput logic.
 */
function resolveEntryDefinition(
  def: CronEntryDefinition,
  groupTimezone?: string,
): CronEntryInput {
  // Resolve the job template using the same logic as enqueue().
  const job = resolveInput({
    type: def.type,
    payload: def.payload,
    queue: def.queue,
    priority: def.priority,
    retryLimit: def.retryLimit,
    backoff: def.backoff,
    retention: def.retention,
    uniqueKey: def.uniqueKey,
    uniqueWhile: def.uniqueWhile,
  });

  if (job.readyAt) {
    throw new Error("readyAt is not supported for cron entries");
  }

  return {
    name: def.name,
    expression: def.expression,
    timezone: def.timezone ?? groupTimezone,
    paused: def.paused,
    job,
  };
}

/**
 * Handle for a single cron entry within a group.
 *
 * Returned by `cron.entry("name")`. Methods delegate to the low-level
 * client and are lazy — no API call until you invoke one.
 */
export class CronEntryHandle {
  /** @internal */
  private client: Client;
  /** @internal */
  private group: string;
  /** The entry name. */
  readonly name: string;

  /** @internal */
  constructor(client: Client, group: string, name: string) {
    this.client = client;
    this.group = group;
    this.name = name;
  }

  /** Fetch this entry from the server. */
  async get(): Promise<CronEntry> {
    return this.client.getCronEntry(this.group, this.name);
  }

  /** Pause this entry. */
  async pause(): Promise<CronEntry> {
    return this.client.updateCronEntry(this.group, this.name, { paused: true });
  }

  /** Resume this entry. */
  async resume(): Promise<CronEntry> {
    return this.client.updateCronEntry(this.group, this.name, { paused: false });
  }

  /** Delete this entry. */
  async delete(): Promise<void> {
    return this.client.deleteCronEntry(this.group, this.name);
  }

  /**
   * Create or replace this entry.
   *
   * Supports function references for the job type, same as `enqueue()`.
   *
   * @example
   * ```ts
   * await client.cron("default").entry("sync").register({
   *   expression: "0 9 * * *",
   *   type: syncAnalytics,
   *   payload: { incremental: true },
   * });
   * ```
   */
  async register(def: Omit<CronEntryDefinition, "name">): Promise<CronEntry> {
    const input = resolveEntryDefinition({ ...def, name: this.name });
    return this.client.replaceCronEntry(this.group, this.name, input);
  }
}

/**
 * Handle for a cron group (schedule).
 *
 * Returned by `client.cron("name")`. All methods are lazy — no API call
 * until you invoke one.
 *
 * @example
 * ```ts
 * const cron = client.cron("default");
 *
 * // Define the schedule
 * await cron.register({
 *   entries: [
 *     { name: "sync", expression: "0 9 * * *", type: syncFn, payload: {} },
 *   ],
 * });
 *
 * // Read / mutate
 * const schedule = await cron.get();
 * await cron.pause();
 * await cron.resume();
 * await cron.delete();
 *
 * // Entry-level
 * await cron.entry("sync").pause();
 * ```
 */
export class CronHandle {
  /** @internal */
  private client: Client;
  /** The group name. */
  readonly name: string;

  /** @internal */
  constructor(client: Client, name: string) {
    this.client = client;
    this.name = name;
  }

  /** Fetch this cron group and all its entries. */
  async get(): Promise<CronGroup> {
    return this.client.getCronGroup(this.name);
  }

  /**
   * Create or replace the entire cron schedule.
   *
   * Entries absent from the definition are removed. Entries with unchanged
   * expressions preserve their scheduling state.
   *
   * Supports function references for entry job types, same as `enqueue()`.
   *
   * @example
   * ```ts
   * await client.cron("default").register({
   *   timezone: "UTC",
   *   entries: [
   *     { name: "sync", expression: "0 9 * * *", type: syncFn, payload: {} },
   *     { name: "cleanup", expression: "0 0 * * *", type: "cleanup", queue: "ops", payload: {} },
   *   ],
   * });
   * ```
   */
  async register(options: RegisterCronOptions): Promise<CronGroup> {
    const opts: ReplaceCronGroupOptions = {
      paused: options.paused,
      entries: options.entries.map(e => resolveEntryDefinition(e, options.timezone)),
    };
    return this.client.replaceCronGroup(this.name, opts);
  }

  /** Pause this cron group. */
  async pause(): Promise<CronGroup> {
    return this.client.updateCronGroup(this.name, { paused: true });
  }

  /** Resume this cron group. */
  async resume(): Promise<CronGroup> {
    return this.client.updateCronGroup(this.name, { paused: false });
  }

  /** Delete this cron group and all its entries. */
  async delete(): Promise<void> {
    return this.client.deleteCronGroup(this.name);
  }

  /** Get a handle for a single entry within this group. */
  entry(name: string): CronEntryHandle {
    return new CronEntryHandle(this.client, this.name, name);
  }
}
