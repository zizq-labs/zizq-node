// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Type-level tests.
 *
 * Checked by `npm run typecheck` and never executed: `tsconfig.json`
 * excludes `*.test.ts`, and this file does not match that pattern, so
 * it is compiled — while `npm test`'s `*.test.ts` glob skips it.
 *
 * Every `@ts-expect-error` below fails the build if the error it names
 * stops occurring, which is what makes these assertions rather than
 * comments. They guard the one thing no runtime test can reach: that
 * `BudgetStrategy` refuses a combination the server would reject.
 */

import type {
  BudgetBinding,
  BudgetBindingInput,
  BudgetStrategy,
  BudgetStrategyPatch,
} from "./types.ts";

// --- BudgetStrategy accepts exactly the two valid shapes ---

const rateLimit: BudgetStrategy = { type: "time_based", durationMs: 60_000 };
const paced: BudgetStrategy = { type: "time_based", durationMs: 60_000, burst: 5 };
const concurrency: BudgetStrategy = { type: "while_in_flight" };

// A clockless budget has no period: its tokens are released when a job
// stops running, so a duration would read as a refill rate that does
// not exist. The server rejects this too; the union means it never gets
// that far.
// @ts-expect-error
const clockWithDuration: BudgetStrategy = { type: "while_in_flight", durationMs: 60_000 };

// Nor a ceiling, for the same reason.
// @ts-expect-error
const clockWithBurst: BudgetStrategy = { type: "while_in_flight", burst: 5 };

// A rate limit without a period is not a rate limit.
// @ts-expect-error
const noPeriod: BudgetStrategy = { type: "time_based" };

// An unrecognised strategy. Note the cost of this strictness: a budget
// created by a *newer* server would violate the declared type at
// runtime. Narrowing is worth more than openness here, but it is a
// trade rather than a free win.
// @ts-expect-error
const unknownKind: BudgetStrategy = { type: "sliding_window", durationMs: 1 };

// The wire spelling is not the client spelling.
// @ts-expect-error
const wireSpelling: BudgetStrategy = { type: "time_based", duration_ms: 60_000 };

// --- The merge patch distinguishes "clear" from "leave alone" ---

// `null` clears the ceiling back to the allocation.
const clearBurst: BudgetStrategyPatch = { burst: null };

// A period cannot be cleared — a `time_based` budget without one is not
// a strategy at all.
// @ts-expect-error
const clearPeriod: BudgetStrategyPatch = { durationMs: null };

// --- Read and write bindings are deliberately different ---

// `cost` is optional going in and defaults on the server.
const write: BudgetBindingInput = { key: "emails" };

// Coming back it is always resolved, so no null check is needed.
declare const read: BudgetBinding;
const resolvedCost: number = read.cost;

// `createWith` is an instruction about a budget, not a property of a
// job, so it never appears on a read.
// @ts-expect-error
const readHasCreateWith = read.createWith;

void [
  rateLimit,
  paced,
  concurrency,
  clockWithDuration,
  clockWithBurst,
  noPeriod,
  unknownKind,
  wireSpelling,
  clearBurst,
  clearPeriod,
  write,
  resolvedCost,
  readHasCreateWith,
];
