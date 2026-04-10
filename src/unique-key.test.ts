// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { uniqueKey } from "./unique-key.ts";
import type { JobFunction } from "./handler.ts";

function makeJob(name: string, type?: string): JobFunction {
  const fn = async () => {};
  Object.defineProperty(fn, "name", { value: name });
  if (type) (fn as JobFunction).zizqOptions = { type };
  return fn as JobFunction;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

describe("uniqueKey", () => {
  it("prefixes the result with the job type and a sha256 hex digest", () => {
    const key = uniqueKey("userId", "action");
    const fn = makeJob("sendEmail");
    const result = key(fn, { userId: 42, action: "notify", other: "ignored" });
    const [prefix, digest] = result.split(":");
    assert.equal(prefix, "sendEmail");
    assert.match(digest!, SHA256_HEX);
  });

  it("ignores fields not listed when computing the digest", () => {
    const key = uniqueKey("userId", "action");
    const fn = makeJob("sendEmail");
    assert.equal(
      key(fn, { userId: 42, action: "notify", other: "ignored" }),
      key(fn, { userId: 42, action: "notify", other: "different" }),
    );
  });

  it("produces different digests for different field values", () => {
    const key = uniqueKey("userId");
    const fn = makeJob("sendEmail");
    assert.notEqual(key(fn, { userId: 1 }), key(fn, { userId: 2 }));
  });

  it("hashes the full payload when no fields specified", () => {
    const key = uniqueKey();
    const fn = makeJob("myJob");
    const result = key(fn, { a: 1, b: 2 });
    const [prefix, digest] = result.split(":");
    assert.equal(prefix, "myJob");
    assert.match(digest!, SHA256_HEX);
  });

  it("produces the same result regardless of key order in payload", () => {
    const key = uniqueKey("a", "b");
    const fn = makeJob("myJob");
    assert.equal(
      key(fn, { a: 1, b: 2 }),
      key(fn, { b: 2, a: 1 }),
    );
  });

  it("produces the same result regardless of key order in nested objects", () => {
    const key = uniqueKey();
    const fn = makeJob("myJob");
    assert.equal(
      key(fn, { outer: { a: 1, b: 2 } }),
      key(fn, { outer: { b: 2, a: 1 } }),
    );
  });

  it("distinguishes types that would otherwise collide", () => {
    const key = uniqueKey();
    const fn = makeJob("myJob");
    // String "true" vs boolean true, number 1 vs string "1", etc.
    assert.notEqual(key(fn, "true"), key(fn, true));
    assert.notEqual(key(fn, 1), key(fn, "1"));
    assert.notEqual(key(fn, null), key(fn, "null"));
  });

  it("uses zizqOptions.type over fn.name for the prefix", () => {
    const key = uniqueKey("userId");
    const fn = makeJob("original", "explicitType");
    const result = key(fn, { userId: 42 });
    assert.ok(result.startsWith("explicitType:"));
  });

  it("throws when job function has no name or zizqOptions.type", () => {
    const key = uniqueKey("userId");
    const fn = makeJob(""); // no name
    assert.throws(
      () => key(fn, { userId: 42 }),
      /job function must have a name or zizqOptions\.type/,
    );
  });

  it("handles missing fields gracefully", () => {
    const key = uniqueKey("userId", "missing");
    const fn = makeJob("myJob");
    // Should not throw, and should differ from a payload with the field present.
    const result = key(fn, { userId: 42 });
    assert.ok(result.startsWith("myJob:"));
    assert.match(result.split(":")[1]!, SHA256_HEX);
  });

  it("normalises exotic values via JSON round-trip", () => {
    const key = uniqueKey();
    const fn = makeJob("myJob");
    // Date → ISO string, undefined dropped, functions dropped.
    const d = new Date("2026-01-01T00:00:00.000Z");
    assert.equal(
      key(fn, { when: d, skip: undefined }),
      key(fn, { when: "2026-01-01T00:00:00.000Z" }),
    );
  });

  it("throws when fields are specified but the payload is not an object", () => {
    const key = uniqueKey("userId");
    const fn = makeJob("myJob");
    assert.throws(() => key(fn, null), /non-object payload.*null/);
    assert.throws(() => key(fn, 42), /non-object payload.*number/);
    assert.throws(() => key(fn, "hi"), /non-object payload.*string/);
    assert.throws(() => key(fn, [1, 2, 3]), /non-object payload.*array/);
  });

  it("hashes a non-object payload when no fields are specified", () => {
    const key = uniqueKey();
    const fn = makeJob("myJob");
    for (const payload of [42, [1, 2, 3], null, "hello", true]) {
      const result = key(fn, payload);
      assert.ok(result.startsWith("myJob:"));
      assert.match(result.split(":")[1]!, SHA256_HEX);
    }
  });
});
