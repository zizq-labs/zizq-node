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

import { type Hash } from "node:crypto";

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

/**
 * Stream a JSON-compatible value into a crypto hash as canonical JSON:
 * object keys sorted, arrays in order, primitives emitted via `JSON.stringify`.
 *
 * The resulting byte stream is unambiguous because strings are quoted,
 * `null`/`true`/`false` are fixed tokens, and commas separate items within
 * containers (so `[1,2]` and `[12]` hash differently).
 *
 * The input must already be normalised JSON data, as from
 * `JSON.parse(JSON.stringify(x))`.
 */
export function hashInto(hash: Hash, value: unknown): void {
  // Bare number, string, boolean or null. Use JSON repr.
  if (value === null || typeof value !== "object") {
    hash.update(JSON.stringify(value));
    return;
  }

  // Arrays hash in the original order, with "[" and "]" markers.
  // We don't worry about the trailing comma; we just need a stable digest.
  if (Array.isArray(value)) {
    hash.update("[");
    for (const item of value) {
      hashInto(hash, item);
      hash.update(",");
    }
    hash.update("]");
    return;
  }

  // Objects hash in key-sorted order, with "{" and "}" markers.
  // We don't worry about the trailing comma; we just need a stable digest.
  hash.update("{");
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    hash.update(JSON.stringify(key));
    hash.update(":");
    hashInto(hash, obj[key]);
    hash.update(",");
  }
  hash.update("}");
}
