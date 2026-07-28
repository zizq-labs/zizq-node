// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Helpers for building unique keys from job payloads.
 *
 * The returned functions are suitable for assigning to `zizqOptions.uniqueKey`
 * on a job function.
 *
 * @module
 */

import type { JobFunction } from "./handler.ts";
import { payloadHasher } from "./payload-hasher.ts";

/**
 * Build a function that computes a unique key from a subset of the payload.
 *
 * At enqueue time, the named fields are picked from the payload,
 * round-tripped through `JSON` to normalise any exotic values, hashed
 * with SHA-256, and prefixed with the job type.
 *
 * When no fields are passed, the entire payload is hashed.
 *
 * The returned function is assigned to `zizqOptions.uniqueKey` on a job
 * function. The resolver is called with `(fn, payload)` at enqueue time.
 *
 * For cross-type deduplication (e.g. a push notification and an email
 * that represent the same logical event), write your own plain function
 * with whatever key format you want; it will pass through unchanged.
 *
 * For the newer `(input) => string` shape used by `client.enqueue({...})`
 * directly, use {@link payloadHasher} instead — this function is a
 * `(fn, payload)`-signature adapter around it that fits the
 * `zizqOptions.uniqueKey` slot on job functions.
 *
 * @example Unique by specific payload fields
 * ```ts
 * import { uniqueKey } from "@zizq-labs/zizq";
 *
 * async function sendEmail(payload) { ... }
 * sendEmail.zizqOptions = {
 *   queue: "emails",
 *   uniqueKey: uniqueKey("userId", "action"),
 *   uniqueWhile: "queued",
 * };
 * ```
 *
 * @example Unique by the entire payload
 * ```ts
 * sendEmail.zizqOptions = {
 *   uniqueKey: uniqueKey(),
 * };
 * ```
 */
export function uniqueKey(
  ...fields: string[]
): (fn: JobFunction, payload: unknown) => string {
  const only = fields.length === 0 ? undefined : fields.map((f) => `.${f}`);
  const hasher = payloadHasher({ only });

  return (fn, payload) => {
    const jobType = fn.zizqOptions?.type ?? fn.name;
    if (!jobType) {
      throw new Error(
        "uniqueKey: job function must have a name or zizqOptions.type",
      );
    }
    if (fields.length > 0) {
      if (
        payload === null ||
        typeof payload !== "object" ||
        Array.isArray(payload)
      ) {
        throw new Error(
          `uniqueKey: cannot pick fields from a non-object payload (got ${
            payload === null
              ? "null"
              : Array.isArray(payload)
                ? "array"
                : typeof payload
          }). Use uniqueKey() with no fields to hash the whole payload, or write a custom resolver.`,
        );
      }
    }

    return hasher({ type: fn, queue: "", payload });
  };
}
