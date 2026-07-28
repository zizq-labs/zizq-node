// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { payloadHasher } from "./payload-hasher.ts";
import type { EnqueueInput } from "./types.ts";

const SHA256_HEX = /^[a-f0-9]{64}$/;

function input(payload: unknown, type = "sendEmail"): EnqueueInput {
  return { type, queue: "q", payload };
}

describe("payloadHasher", () => {
  describe("basic", () => {
    it("prefixes with the job type and produces a hex digest", () => {
      const key = payloadHasher()(input({ userId: 42 }));
      const [prefix, digest] = key.split(":");
      assert.equal(prefix, "sendEmail");
      assert.match(digest!, SHA256_HEX);
    });

    it("is deterministic for the same payload", () => {
      const hasher = payloadHasher();
      assert.equal(
        hasher(input({ userId: 42 })),
        hasher(input({ userId: 42 })),
      );
    });

    it("differs for different payloads", () => {
      const hasher = payloadHasher();
      assert.notEqual(
        hasher(input({ userId: 42 })),
        hasher(input({ userId: 43 })),
      );
    });

    it("differs across job types", () => {
      const hasher = payloadHasher();
      assert.notEqual(
        hasher(input({ x: 1 }, "sendEmail")),
        hasher(input({ x: 1 }, "sendSms")),
      );
    });

    it("omits the prefix when prefix: false", () => {
      const key = payloadHasher({ prefix: false })(input({ userId: 42 }));
      assert.match(key, SHA256_HEX);
      assert.equal(key.includes(":"), false);
    });

    it("is stable across object-key insertion order", () => {
      const hasher = payloadHasher();
      assert.equal(
        hasher(input({ a: 1, b: 2 })),
        hasher(input({ b: 2, a: 1 })),
      );
    });
  });

  describe("only", () => {
    it("hashes just the selected path", () => {
      const hasher = payloadHasher({ only: ".userId" });
      assert.equal(
        hasher(input({ userId: 42, ignored: "yes" })),
        hasher(input({ userId: 42, ignored: "no" })),
      );
      assert.notEqual(
        hasher(input({ userId: 42, other: 1 })),
        hasher(input({ userId: 43, other: 1 })),
      );
    });

    it("accepts a string shorthand equivalent to a single-element array", () => {
      const a = payloadHasher({ only: ".userId" })(input({ userId: 42 }));
      const b = payloadHasher({ only: [".userId"] })(input({ userId: 42 }));
      assert.equal(a, b);
    });

    it("hashes multiple paths together, keyed by path", () => {
      const hasher = payloadHasher({ only: [".a", ".b"] });
      assert.equal(
        hasher(input({ a: 1, b: 2, c: 999 })),
        hasher(input({ a: 1, b: 2, c: 0 })),
      );
      assert.notEqual(
        hasher(input({ a: 1, b: 2 })),
        hasher(input({ a: 1, b: 3 })),
      );
    });

    it("supports nested keys", () => {
      const hasher = payloadHasher({ only: ".user.email" });
      assert.equal(
        hasher(input({ user: { email: "a@b.com", name: "Alice" } })),
        hasher(input({ user: { email: "a@b.com", name: "Bob" } })),
      );
    });

    it("supports array indexing", () => {
      const hasher = payloadHasher({ only: ".items[0]" });
      assert.equal(
        hasher(input({ items: [1, 999] })),
        hasher(input({ items: [1, 0] })),
      );
      assert.notEqual(
        hasher(input({ items: [1] })),
        hasher(input({ items: [2] })),
      );
    });

    it("supports root array indexing (.[0])", () => {
      const hasher = payloadHasher({ only: ".[0]" });
      assert.equal(
        hasher(input([1, 999])),
        hasher(input([1, 0])),
      );
    });

    it("supports bracket-quoted keys with literal dots", () => {
      const hasher = payloadHasher({ only: '.["this.example"]' });
      assert.equal(
        hasher(input({ "this.example": 42, other: 99 })),
        hasher(input({ "this.example": 42, other: 1 })),
      );
    });

    it("silently drops missing paths", () => {
      const hasher = payloadHasher({ only: ".missing" });
      // Two payloads that both lack `.missing` produce the same hash.
      assert.equal(
        hasher(input({ a: 1 })),
        hasher(input({ b: 2 })),
      );
    });

    it("only: ['.'] behaves like the default full-payload hash", () => {
      assert.equal(
        payloadHasher({ only: "." })(input({ x: 1 })),
        payloadHasher()(input({ x: 1 })),
      );
    });

    it("picked subset hashes the same as an equivalent smaller payload", () => {
      // The reconstructed structure {a: 1, b: 2} that `only` builds
      // from {a: 1, b: 2, c: 3} must hash identically to the default
      // hasher run against a payload that literally is {a: 1, b: 2}.
      // If this ever drifts, subsetted hashes would diverge from raw
      // ones and callers would get surprising key collisions/misses.
      assert.equal(
        payloadHasher({ only: [".a", ".b"] })(input({ a: 1, b: 2, c: 3 })),
        payloadHasher()(input({ a: 1, b: 2 })),
      );
    });

    it("nested picked subset hashes the same as an equivalent smaller payload", () => {
      assert.equal(
        payloadHasher({ only: [".user.id"] })(
          input({ user: { id: 42, name: "Alice" }, other: 99 }),
        ),
        payloadHasher()(input({ user: { id: 42 } })),
      );
    });
  });

  describe("except", () => {
    it("hashes the payload with the excluded path removed", () => {
      const hasher = payloadHasher({ except: ".notifications" });
      assert.equal(
        hasher(input({ notifications: [1, 2], tenant: "a" })),
        hasher(input({ notifications: [9], tenant: "a" })),
      );
      assert.notEqual(
        hasher(input({ notifications: [1], tenant: "a" })),
        hasher(input({ notifications: [1], tenant: "b" })),
      );
    });

    it("accepts a string shorthand", () => {
      const a = payloadHasher({ except: ".x" })(input({ x: 1, y: 2 }));
      const b = payloadHasher({ except: [".x"] })(input({ x: 1, y: 2 }));
      assert.equal(a, b);
    });

    it("silently drops missing paths", () => {
      const hasher = payloadHasher({ except: ".missing" });
      // Removal is a no-op; still hashes the whole payload.
      assert.equal(
        hasher(input({ a: 1 })),
        payloadHasher()(input({ a: 1 })),
      );
    });

    it("except: ['.'] collapses everything to the type prefix", () => {
      const hasher = payloadHasher({ except: "." });
      // Different payloads produce the same key when everything is excluded.
      assert.equal(
        hasher(input({ x: 1 })),
        hasher(input({ y: 999, z: "anything" })),
      );
      // But different types differentiate via the prefix.
      assert.notEqual(
        hasher(input({}, "A")),
        hasher(input({}, "B")),
      );
    });

    it("supports nested key deletion", () => {
      const hasher = payloadHasher({ except: ".user.name" });
      assert.equal(
        hasher(input({ user: { name: "Alice", id: 1 } })),
        hasher(input({ user: { name: "Bob", id: 1 } })),
      );
    });

    it("supports array index deletion (splice)", () => {
      const hasher = payloadHasher({ except: ".items[0]" });
      assert.equal(
        hasher(input({ items: [999, "keep"] })),
        hasher(input({ items: [42, "keep"] })),
      );
    });

    it("supports multiple exclusions", () => {
      const hasher = payloadHasher({ except: [".a", ".b"] });
      assert.equal(
        hasher(input({ a: 1, b: 2, c: 3 })),
        hasher(input({ a: 99, b: 88, c: 3 })),
      );
      assert.notEqual(
        hasher(input({ a: 1, b: 2, c: 3 })),
        hasher(input({ a: 1, b: 2, c: 4 })),
      );
    });

    it("excluded payload hashes the same as the equivalent smaller payload", () => {
      // Symmetric with the `only` invariant: after removing `.c`, the
      // hash must match one taken directly against {a, b}.
      assert.equal(
        payloadHasher({ except: [".c"] })(input({ a: 1, b: 2, c: 3 })),
        payloadHasher()(input({ a: 1, b: 2 })),
      );
    });
  });

  describe("errors", () => {
    it("rejects combining only and except", () => {
      assert.throws(
        () => payloadHasher({ only: ".a", except: ".b" }),
        /cannot be combined/,
      );
    });

    it("rejects paths that don't start with a dot", () => {
      assert.throws(() => payloadHasher({ only: "foo" }), /must start with '\.'/);
    });

    it("rejects unterminated bracket-quoted keys", () => {
      assert.throws(
        () => payloadHasher({ only: '.["unterminated' }),
        /unterminated/,
      );
    });

    it("throws when a job function has no name or zizqOptions.type", () => {
      const fn = Object.assign(async () => {}, {});
      Object.defineProperty(fn, "name", { value: "" });
      assert.throws(
        () => payloadHasher()({ type: fn as any, queue: "q", payload: {} }),
        /must have a name or zizqOptions\.type/,
      );
    });
  });
});
