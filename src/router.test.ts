// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Router, UnknownJobTypeError } from "./router.ts";
import type { Job } from "./resources.ts";

// Stand-in for a real `Job` — the router only touches `type` and `payload`,
// plus whatever the fallback chooses to use.
const job = (type: string, payload: unknown = {}): Job =>
  ({ type, payload }) as unknown as Job;

describe("Router", () => {
  // --- Basic dispatch ---------------------------------------------------

  it("dispatches a job to the matching route", async () => {
    let received: unknown;
    const handler = new Router()
      .route("send_email", async (payload) => {
        received = payload;
      })
      .build();

    await handler(job("send_email", { to: "a@b.com" }));

    assert.deepEqual(received, { to: "a@b.com" });
  });

  it("passes both payload and job to route handlers", async () => {
    let captured: { payload: unknown; jobRef: Job } | undefined;
    const handler = new Router()
      .route("audit", async (payload, jobRef) => {
        captured = { payload, jobRef };
      })
      .build();

    const j = job("audit", { id: 1 });
    await handler(j);

    assert.deepEqual(captured!.payload, { id: 1 });
    assert.equal(captured!.jobRef, j);
  });

  it("supports sync (non-async) handlers", async () => {
    let fired = false;
    const handler = new Router()
      .route("ping", () => {
        fired = true;
      })
      .build();

    await handler(job("ping"));

    assert.ok(fired);
  });

  // --- Unknown types ---------------------------------------------------

  it("throws UnknownJobTypeError when no route matches and no fallback", async () => {
    const handler = new Router()
      .route("known", async () => {})
      .build();

    await assert.rejects(
      () => handler(job("missing")),
      (err: unknown) =>
        err instanceof UnknownJobTypeError && err.type === "missing",
    );
  });

  // --- Fallback ---------------------------------------------------------

  it("invokes the fallback when no route matches", async () => {
    let captured: string | undefined;
    const handler = new Router()
      .route("known", async () => {})
      .fallback(async (j) => {
        captured = j.type;
      })
      .build();

    await handler(job("missing"));

    assert.equal(captured, "missing");
  });

  it("passes the full job to the fallback (not a payload pair)", async () => {
    let captured: Job | undefined;
    const handler = new Router()
      .fallback(async (j) => {
        captured = j;
      })
      .build();

    const j = job("anything", { k: "v" });
    await handler(j);

    assert.equal(captured, j);
  });

  it("routes win over fallback when both are registered", async () => {
    let routeFired = false;
    let fallbackFired = false;
    const handler = new Router()
      .route("send_email", async () => {
        routeFired = true;
      })
      .fallback(async () => {
        fallbackFired = true;
      })
      .build();

    await handler(job("send_email"));

    assert.ok(routeFired);
    assert.ok(!fallbackFired);
  });

  it("fallback can compose another dispatcher", async () => {
    const captured: Job[] = [];
    const otherDispatcher = async (j: Job) => {
      captured.push(j);
    };
    const handler = new Router()
      .fallback(async (j) => otherDispatcher(j))
      .build();

    const j = job("unhandled");
    await handler(j);

    assert.deepEqual(captured, [j]);
  });

  it("calling fallback() again replaces the previous handler", async () => {
    let firstCalled = false;
    let secondCalled = false;
    const handler = new Router()
      .fallback(async () => {
        firstCalled = true;
      })
      .fallback(async () => {
        secondCalled = true;
      })
      .build();

    await handler(job("missing"));

    assert.ok(!firstCalled);
    assert.ok(secondCalled);
  });

  // --- Builder semantics ----------------------------------------------

  it("returns the router from chainable methods (this)", () => {
    const router = new Router();
    assert.equal(
      router.route("a", async () => {}),
      router,
    );
    assert.equal(
      router.fallback(async () => {}),
      router,
    );
  });

  it("re-registering a route replaces the previous handler", async () => {
    let firstCalled = false;
    let secondCalled = false;
    const handler = new Router()
      .route("shared", async () => {
        firstCalled = true;
      })
      .route("shared", async () => {
        secondCalled = true;
      })
      .build();

    await handler(job("shared"));

    assert.ok(!firstCalled);
    assert.ok(secondCalled);
  });
});
