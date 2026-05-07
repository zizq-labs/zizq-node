// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// High-level enqueue helpers.
//
// The resolveInput function and EnqueueInput type are the core of this
// module. The free enqueue/enqueueBulk functions are deprecated wrappers
// around client.enqueue()/client.enqueueBulk().

import type { EnqueueOptions, EnqueueInput } from "./types.ts";
import type { JobFunction, ZizqOptions } from "./handler.ts";
import type { Client } from "./client.ts";
import type { Job } from "./resources.ts";

export type { EnqueueInput } from "./types.ts";

/**
 * Enqueue a single job.
 *
 * @deprecated Use `client.enqueue()` instead.
 *
 * @param client - The Zizq client to use for the HTTP request.
 * @param input - Job type, payload, and optional configuration.
 * @returns The created job, including its server-assigned `id` and `status`.
 */
export async function enqueue(
  client: Client,
  input: EnqueueInput,
): Promise<Job> {
  return client.enqueue(input);
}

/**
 * Enqueue multiple jobs in a single request.
 *
 * @deprecated Use `client.enqueueBulk()` instead.
 *
 * @param client - The Zizq client to use for the HTTP request.
 * @param inputs - Array of job inputs.
 * @returns An array of created jobs in the same order as the input.
 */
export async function enqueueBulk(
  client: Client,
  inputs: EnqueueInput[],
): Promise<Job[]> {
  return client.enqueueBulk(inputs);
}

// --- Internal ---

// Compute the unique key from a job function's ZizqOptions + payload.
//
// The function form is called with `(jobFn, payload)` so resolvers
// can read metadata (like the type name) from the job function itself.
function computeUniqueKey(
  jobFn: JobFunction,
  payload: unknown,
): string | undefined {
  const uniqueKey = jobFn.zizqOptions?.uniqueKey;
  if (!uniqueKey) return undefined;
  if (typeof uniqueKey === "function") return uniqueKey(jobFn, payload);
  return uniqueKey;
}

/**
 * Resolve an EnqueueInput into a low-level EnqueueOptions.
 *
 * Takes the result of zizqOptions (if provided), optionally transformed,
 * and then merges over the top any overrides present in the input.
 *
 * @internal Exported for use by the cron scheduling module.
 */
export function resolveInput(input: EnqueueInput): EnqueueOptions {
  let jobType: string;
  let defaults: ZizqOptions | undefined;

  if (typeof input.type === "function") {
    defaults = input.type.zizqOptions;
    jobType = defaults?.type ?? input.type.name;

    if (!jobType) {
      throw new Error(
        "Job function must have a name or zizqOptions.type"
      );
    }
  } else {
    jobType = input.type;
  }

  const queue = input.queue ?? defaults?.queue;

  if (!queue) {
    throw new Error(`No queue specified for job type "${jobType}"`);
  }

  const uniqueKey =
    input.uniqueKey ??
    (typeof input.type === "function"
      ? computeUniqueKey(input.type, input.payload)
      : undefined);

  const uniqueWhile =
    input.uniqueWhile ?? defaults?.uniqueWhile;

  const opts: EnqueueOptions = {
    type: jobType,
    queue,
    payload: input.payload,
    priority: input.priority ?? defaults?.priority,
    readyAt: input.readyAt,
    retryLimit: input.retryLimit ?? defaults?.retryLimit,
    backoff: input.backoff ?? defaults?.backoff,
    retention: input.retention,
    uniqueKey,
    uniqueWhile: uniqueKey ? uniqueWhile : undefined,
  };

  // Apply the transform hook (if any). Transforms can change the options based
  // on the payload or other factors, and can mutate `opts` in place, or return
  // a new object to use instead.
  if (defaults?.transform) {
    const result = defaults.transform(opts, input.payload);
    return result ?? opts;
  }

  return opts;
}
