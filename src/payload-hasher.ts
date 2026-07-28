// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Builds a function that derives a stable key from an enqueue input's
 * payload. Used for both batched-job keys (via `batchConfig`) and as
 * a first-class option for `uniqueKey`.
 *
 * @module
 */

import { createHash, type Hash } from "node:crypto";

import type { EnqueueInput } from "./types.ts";

/** Options for {@link payloadHasher}. */
export interface PayloadHasherOptions {
  /**
   * jq paths whose values participate in the hash. When multiple paths
   * are supplied their sub-values are hashed together, keyed by path
   * so ordering doesn't matter. Defaults to `['.']` (whole payload).
   *
   * Accepts a single path or an array. Cannot be combined with `except`.
   */
  only?: string | string[];

  /**
   * jq paths whose values are excluded from the hash. The payload is
   * deep-cloned and each path is deleted before hashing. Missing paths
   * are silently ignored.
   *
   * Accepts a single path or an array. Cannot be combined with `only`.
   */
  except?: string | string[];

  /**
   * When `true` (default), the returned key is prefixed with the job
   * type and a `:`. When `false`, only the raw hex digest is returned.
   */
  prefix?: boolean;
}

/**
 * Build a function that hashes some or all of an enqueue's payload
 * into a stable key string.
 *
 * The returned function takes the whole `EnqueueInput` so it can read
 * both the payload (for hashing) and the type (for the optional
 * prefix). Suitable for assignment to `uniqueKey` or `batch.key` on
 * `client.enqueue({...})` inputs.
 *
 * @example Full-payload hash with type prefix
 * ```ts
 * uniqueKey: payloadHasher()
 * // => "sendEmail:<sha256>"
 * ```
 *
 * @example Batch by tenant only
 * ```ts
 * batch: {
 *   key: payloadHasher({ except: '.notifications' }),
 *   when: "...",
 *   fold: "...",
 * }
 * ```
 */
export function payloadHasher(
  options: PayloadHasherOptions = {},
): (input: EnqueueInput) => string {
  const prefix = options.prefix ?? true;
  const only = options.only !== undefined ? asArray(options.only) : undefined;
  const except =
    options.except !== undefined ? asArray(options.except) : undefined;

  if (only && except) {
    throw new Error(
      "payloadHasher: `only` and `except` cannot be combined",
    );
  }

  // Parse paths once at construction so the returned function has no
  // parse overhead per call.
  const onlyPaths = only?.map(parsePath);
  const exceptPaths = except?.map(parsePath);

  return (input: EnqueueInput): string => {
    const value = deriveHashable(input.payload, onlyPaths, exceptPaths);

    const hash = createHash("sha256");
    hashInto(hash, value);
    const digest = hash.digest("hex");

    if (!prefix) return digest;
    return `${typeName(input)}:${digest}`;
  };
}

// --- Internal helpers ---

function asArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

/**
 * Return the value that should participate in the hash, given the
 * caller's `only`/`except` config.
 */
function deriveHashable(
  payload: unknown,
  onlyPaths: PathStep[][] | undefined,
  exceptPaths: PathStep[][] | undefined,
): unknown {
  // Normalise via JSON round-trip so exotic values (Dates, undefined,
  // functions, etc.) become the plain JSON representation the server
  // would see. Also detects circular references early.
  const normalised = JSON.parse(JSON.stringify(payload));

  if (onlyPaths) {
    return pickPaths(normalised, onlyPaths);
  }

  if (exceptPaths) {
    let out: unknown = normalised;
    for (const steps of exceptPaths) {
      out = deletePath(out, steps);
    }
    return out;
  }

  return normalised;
}

/** Sentinel returned by `walk` to distinguish "missing" from "value is null". */
const MISSING: unique symbol = Symbol("missing");

/**
 * Reconstruct a subset of the payload containing only the requested
 * paths, preserving the original nesting structure. Missing paths are
 * silently skipped so hashes remain stable across payloads that omit
 * optional fields.
 *
 * `only: ['.a', '.b']` on `{a: 1, b: 2, c: 3}` returns `{a: 1, b: 2}`.
 * `only: ['.user.id']` on `{user: {id: 42, name: 'x'}}` returns
 * `{user: {id: 42}}`.
 */
function pickPaths(source: unknown, paths: PathStep[][]): unknown {
  let target: unknown = undefined;
  for (const steps of paths) {
    if (steps.length === 0) return source; // '.' short-circuits to full payload.
    const value = walk(source, steps);
    if (value === MISSING) continue;
    target = setPath(target, steps, value);
  }
  // Never-matched: fall back to an empty object so the hash is total
  // and matches what an empty pick would produce.
  return target ?? {};
}

/**
 * Write `value` into `target` at `steps`, creating intermediate
 * objects/arrays as needed. Returns the (possibly newly-created)
 * root. The choice between object/array at each level is driven by
 * whether the *next* step is a key or an index.
 */
function setPath(
  target: unknown,
  steps: PathStep[],
  value: unknown,
): unknown {
  const first = steps[0];
  if (target === undefined) {
    target = first.kind === "key" ? {} : [];
  }

  let cur: any = target;
  for (let i = 0; i < steps.length - 1; i++) {
    const step = steps[i];
    const next = steps[i + 1];
    const childInit: unknown = next.kind === "key" ? {} : [];
    if (step.kind === "key") {
      if (cur[step.name] === undefined) cur[step.name] = childInit;
      cur = cur[step.name];
    } else {
      if (cur[step.index] === undefined) cur[step.index] = childInit;
      cur = cur[step.index];
    }
  }

  const last = steps[steps.length - 1];
  if (last.kind === "key") cur[last.name] = value;
  else cur[last.index] = value;

  return target;
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
function hashInto(hash: Hash, value: unknown): void {
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

function typeName(input: EnqueueInput): string {
  if (typeof input.type === "function") {
    const fn = input.type;
    const name = fn.zizqOptions?.type ?? fn.name;
    if (!name) {
      throw new Error(
        "payloadHasher: job function must have a name or zizqOptions.type",
      );
    }
    return name;
  }
  return input.type;
}

// --- Path parser + traversal ---

type PathStep = { kind: "key"; name: string } | { kind: "index"; index: number };

/**
 * Parse a jq-compatible dotted path into an ordered list of steps.
 *
 * Accepted forms:
 * - `.`               — root (no steps)
 * - `.foo`            — object key
 * - `.foo.bar`        — nested keys
 * - `.foo[0]`         — nth array element
 * - `.[0]`            — root array index
 * - `.["dotted.key"]` — quoted key (escape hatch for keys with dots)
 */
function parsePath(path: string): PathStep[] {
  if (path === ".") return [];
  if (path === "" || path[0] !== ".") {
    throw new Error(`payloadHasher: path must start with '.', got "${path}"`);
  }

  const steps: PathStep[] = [];
  let i = 1;
  const n = path.length;

  while (i < n) {
    if (path[i] === "[") {
      // `[N]` or `["quoted key"]`
      i += 1;
      if (path[i] === '"') {
        // Quoted key. Consume until the matching unescaped ".
        i += 1;
        let name = "";
        while (i < n && path[i] !== '"') {
          if (path[i] === "\\" && i + 1 < n) {
            name += path[i + 1];
            i += 2;
          } else {
            name += path[i];
            i += 1;
          }
        }
        if (path[i] !== '"') {
          throw new Error(`payloadHasher: unterminated quoted key in "${path}"`);
        }
        i += 1; // consume "
        if (path[i] !== "]") {
          throw new Error(`payloadHasher: expected ']' in "${path}"`);
        }
        i += 1;
        steps.push({ kind: "key", name });
      } else {
        // Numeric index.
        let digits = "";
        while (i < n && path[i] >= "0" && path[i] <= "9") {
          digits += path[i];
          i += 1;
        }
        if (digits.length === 0 || path[i] !== "]") {
          throw new Error(
            `payloadHasher: invalid array index in "${path}"`,
          );
        }
        i += 1;
        steps.push({ kind: "index", index: parseInt(digits, 10) });
      }
    } else if (path[i] === ".") {
      i += 1;
      // Follow-on dot before a name or bracket.
      continue;
    } else if (isNameChar(path[i], true)) {
      let name = "";
      while (i < n && isNameChar(path[i], false)) {
        name += path[i];
        i += 1;
      }
      steps.push({ kind: "key", name });
    } else {
      throw new Error(
        `payloadHasher: unexpected character '${path[i]}' in "${path}"`,
      );
    }
  }

  return steps;
}

function isNameChar(c: string, first: boolean): boolean {
  if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_") return true;
  if (!first && c >= "0" && c <= "9") return true;
  return false;
}

/**
 * Follow `steps` and return the sub-value. Returns the `MISSING`
 * sentinel when any hop is absent (as opposed to a legitimate `null`
 * at the terminal step). Callers use the sentinel to distinguish
 * "silently skip this path" from "hash a null here".
 */
function walk(value: unknown, steps: PathStep[]): unknown | typeof MISSING {
  let cur: unknown = value;
  for (const step of steps) {
    if (cur == null) return MISSING;
    if (step.kind === "key") {
      if (typeof cur !== "object" || Array.isArray(cur)) return MISSING;
      const obj = cur as Record<string, unknown>;
      if (!(step.name in obj)) return MISSING;
      cur = obj[step.name];
    } else {
      if (!Array.isArray(cur) || step.index >= cur.length) return MISSING;
      cur = cur[step.index];
    }
  }
  return cur;
}

/** Return a copy of `value` with the value at `steps` removed. */
function deletePath(value: unknown, steps: PathStep[]): unknown {
  if (steps.length === 0) {
    // `except: ['.']` — the entire payload is excluded. Nothing left
    // to hash; return null so we still produce a stable digest
    // (every call collapses to the same value).
    return null;
  }

  // Walk to the parent of the final step, cloning as we go.
  const cloned = structuredClone(value);
  let cur: unknown = cloned;
  for (let i = 0; i < steps.length - 1; i++) {
    const step = steps[i];
    if (cur == null) return cloned; // silent no-op
    if (step.kind === "key") {
      if (typeof cur !== "object" || Array.isArray(cur)) return cloned;
      cur = (cur as Record<string, unknown>)[step.name];
    } else {
      if (!Array.isArray(cur)) return cloned;
      cur = cur[step.index];
    }
  }

  if (cur == null || typeof cur !== "object") return cloned;

  const last = steps[steps.length - 1];
  if (last.kind === "key") {
    if (Array.isArray(cur)) return cloned;
    delete (cur as Record<string, unknown>)[last.name];
  } else {
    if (Array.isArray(cur)) {
      cur.splice(last.index, 1);
    }
  }
  return cloned;
}
