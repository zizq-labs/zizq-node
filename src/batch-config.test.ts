// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { batchConfig } from "./batch-config.ts";
import { payloadHasher } from "./payload-hasher.ts";
import type { EnqueueInput } from "./types.ts";

function input(payload: unknown, type = "push"): EnqueueInput {
  return { type, queue: "q", payload };
}

describe("batchConfig", () => {
  describe("expressions", () => {
    it("generates default expressions targeting the whole payload", () => {
      const cfg = batchConfig(100);
      assert.equal(
        cfg.when,
        "(($existing | .) + ($new | .)) | length <= 100",
      );
      assert.equal(cfg.fold, "$existing | . += ($new | .)");
    });

    it("targets a nested path when supplied", () => {
      const cfg = batchConfig(50, ".items");
      assert.equal(
        cfg.when,
        "(($existing | .items) + ($new | .items)) | length <= 50",
      );
      assert.equal(cfg.fold, "$existing | .items += ($new | .items)");
    });

    it("appends `| unique` when dedup: true", () => {
      const cfg = batchConfig(100, ".items", { dedup: true });
      assert.equal(
        cfg.fold,
        "$existing | .items = ((.items) + ($new | .items) | unique)",
      );
    });

    it("appends `| sort` when sorted: true", () => {
      const cfg = batchConfig(100, ".items", { sorted: true });
      assert.equal(
        cfg.fold,
        "$existing | .items = ((.items) + ($new | .items) | sort)",
      );
    });

    it("dedup subsumes sorted", () => {
      const cfg = batchConfig(100, ".items", { dedup: true, sorted: true });
      assert.equal(
        cfg.fold,
        "$existing | .items = ((.items) + ($new | .items) | unique)",
      );
    });

    it("supports nested paths in expressions", () => {
      const cfg = batchConfig(10, ".a.b");
      assert.equal(cfg.fold, "$existing | .a.b += ($new | .a.b)");
    });

    it("supports array-index paths in expressions", () => {
      const cfg = batchConfig(10, ".items[0]");
      assert.equal(
        cfg.fold,
        "$existing | .items[0] += ($new | .items[0])",
      );
    });
  });

  describe("key derivation", () => {
    it("hashes everything except the batch target path", () => {
      const cfg = batchConfig(100, ".notifications");
      const same = cfg.key(input({ notifications: [1], tenantId: 42 }));
      const alsoSame = cfg.key(input({ notifications: [99], tenantId: 42 }));
      const different = cfg.key(input({ notifications: [1], tenantId: 43 }));

      assert.equal(same, alsoSame, "differing batch target → same key");
      assert.notEqual(same, different, "differing non-target → different key");
    });

    it("collapses to a type-only key when path is '.'", () => {
      // With batch target = whole payload, nothing differentiates enqueues
      // of the same type — every one folds into the same batch.
      const cfg = batchConfig(100);
      const a = cfg.key(input([1, 2, 3]));
      const b = cfg.key(input([]));
      assert.equal(a, b);
    });

    it("still differentiates by type when path is '.'", () => {
      const cfg = batchConfig(100);
      const a = cfg.key(input([1], "A"));
      const b = cfg.key(input([1], "B"));
      assert.notEqual(a, b);
    });

    it("matches an equivalent hand-rolled payloadHasher", () => {
      const cfg = batchConfig(100, ".notifications");
      const manual = payloadHasher({ except: [".notifications"] });
      assert.equal(
        cfg.key(input({ notifications: [1], tenantId: 42 })),
        manual(input({ notifications: [1], tenantId: 42 })),
      );
    });

    it("supports spread + override to substitute a custom key", () => {
      const cfg = {
        ...batchConfig(100, ".notifications"),
        key: (input: EnqueueInput) =>
          `push:${(input.payload as any).tenantId}`,
      };
      assert.equal(
        cfg.key(input({ notifications: [1], tenantId: 42 })),
        "push:42",
      );
    });
  });

  describe("validation", () => {
    it("rejects paths that don't start with a dot", () => {
      assert.throws(() => batchConfig(100, "items"), /must start with '\.'/);
    });
  });
});
