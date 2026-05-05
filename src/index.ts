// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

export {
  Client,
  Job,
  JobPage,
  ErrorRecord,
  ErrorPage,
  CronGroup,
  CronEntry,
  ZizqError,
  ConnectionError,
  ResponseError,
  ClientError,
  NotFoundError,
  ServerError,
} from "./client.ts";

export type {
  ClientOptions,
  TlsOptions,
} from "./client.ts";

export type {
  JobStatus,
  SortDirection,
  UniqueScope,
  Format,
  BackoffConfig,
  RetentionConfig,
  EnqueueOptions,
  FailureOptions,
  UpdateJobOptions,
  TakeOptions,
  ListJobsOptions,
  ListErrorsOptions,
  UpdateAllJobsOptions,
  JobFilter,
  DeleteAllJobsOptions,
  CronEntryInput,
  ReplaceCronGroupOptions,
} from "./types.ts";

export type {
  JobData,
  ErrorRecordData,
  CronEntryData,
  CronGroupData,
} from "./resources.ts";

export { Worker } from "./worker.ts";

export type { WorkerOptions, Logger, RequestRetryOptions } from "./worker.ts";

export { buildHandler } from "./handler.ts";

export type {
  JobFunction,
  JobHandler,
  ZizqOptions,
  EnqueueTransform,
} from "./handler.ts";

export { Lazy, ErrorQuery, JobQuery } from "./query.ts";
export type { ErrorQueryOptions, JobQueryOptions } from "./query.ts";

export { enqueue, enqueueBulk } from "./enqueue.ts";

export type { EnqueueInput } from "./enqueue.ts";

export { uniqueKey } from "./unique-key.ts";
