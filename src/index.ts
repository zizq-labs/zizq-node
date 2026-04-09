// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

export {
  Client,
  Job,
  JobPage,
  ErrorRecord,
  ErrorPage,
  ZizqError,
  ConnectionError,
  ResponseError,
  ClientError,
  NotFoundError,
  ServerError,
} from "./client.ts";

export type {
  ClientOptions,
  JobData,
  EnqueueOptions,
  ListJobsOptions,
  ListErrorsOptions,
  ErrorRecordData,
  FailureOptions,
  TakeOptions,
  BackoffConfig,
  RetentionConfig,
  JobStatus,
  UniqueScope,
  SortDirection,
  TlsOptions,
  Format,
} from "./client.ts";

export { Worker } from "./worker.ts";

export type { WorkerOptions, Logger, RequestRetryOptions } from "./worker.ts";

export type {
  JobFunction,
  JobHandler,
  ZizqOptions,
} from "./handler.ts";

export { ErrorQuery } from "./error-query.ts";
export type { ErrorQueryOptions } from "./error-query.ts";

export { enqueue, enqueueBulk } from "./enqueue.ts";

export type { EnqueueInput } from "./enqueue.ts";
