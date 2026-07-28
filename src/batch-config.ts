// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Helper for building batched-job configuration objects. See
 * {@link batchConfig}.
 *
 * @module
 */

import { payloadHasher } from "./payload-hasher.ts";
import type { EnqueueInput } from "./types.ts";

/** Options for the third argument of {@link batchConfig}. */
export interface BatchConfigOptions {
  /**
   * Append `| unique` to the fold expression to deduplicate entries
   * within the batch. `unique` in jq also sorts, so it subsumes
   * `sorted:` when both are set.
   */
  dedup?: boolean;

  /**
   * Append `| sort` to the fold expression to sort entries within
   * the batch. Ignored when `dedup:` is also set.
   */
  sorted?: boolean;
}

/**
 * Build a batched-job configuration for a specific target path.
 *
 * Returns the `{key, when, fold}` shape expected by
 * `client.enqueue({batch: ...})`, with `key` as a function that
 * derives a stable batch key from the enqueue input at call time
 * (hashing everything *except* the batch target path).
 *
 * @param limit  Maximum combined length of the batched value at
 *   `path` before the current batch is sealed and a new one starts.
 * @param path  jq path to the batch target within the payload.
 *   Defaults to `.` (the whole payload is the batch target, assumed
 *   to be an array).
 * @param options  `dedup: true` deduplicates via `| unique`;
 *   `sorted: true` sorts via `| sort`. `dedup:` subsumes `sorted:`.
 *
 * @example Whole-payload batch (payload is an array)
 * ```ts
 * await client.enqueue({
 *   type: "audit.events",
 *   queue: "audit",
 *   payload: [{ actor: "u1", action: "login" }],
 *   batch: batchConfig(1000),
 * });
 * ```
 *
 * @example Batch a specific field
 * ```ts
 * await client.enqueue({
 *   type: "push",
 *   queue: "push",
 *   payload: { deviceIds: [id], platform: "apple" },
 *   batch: batchConfig(100, ".deviceIds"),
 * });
 * ```
 *
 * @example Custom key (spread + override)
 * ```ts
 * batch: {
 *   ...batchConfig(100, ".deviceIds"),
 *   key: (input) => `push:tenant-${input.payload.tenantId}`,
 * }
 * ```
 */
export function batchConfig(
  limit: number,
  path: string = ".",
  options: BatchConfigOptions = {},
): {
  key: (input: EnqueueInput) => string;
  when: string;
  fold: string;
} {
  // `payloadHasher` validates `path` via its jq-path parser and
  // throws on invalid syntax at construction time — surfacing typos
  // before any enqueue happens.
  const key = payloadHasher({ except: [path] });

  // Pipe-form access (`$var | <path>`) is the uniform shape that
  // works for every path we accept, including the root `.` case
  // where `$existing<path>` would otherwise be a syntax error.
  const when =
    `(($existing | ${path}) + ($new | ${path})) | length <= ${limit}`;

  let fold: string;
  if (options.dedup) {
    fold =
      `$existing | ${path} = ((${path}) + ($new | ${path}) | unique)`;
  } else if (options.sorted) {
    fold =
      `$existing | ${path} = ((${path}) + ($new | ${path}) | sort)`;
  } else {
    fold = `$existing | ${path} += ($new | ${path})`;
  }

  return { key, when, fold };
}
