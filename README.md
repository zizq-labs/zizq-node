# Zizq — Official Node.js Client

Zizq is a simple, zero dependency, single binary job queue system that is both
fast and durable. It is designed to work in any stack through a simple HTTP
API.

This is the official Zizq client library for Node.js, written in TypeScript.

[![CI](https://github.com/zizq-labs/zizq-node/actions/workflows/ci.yml/badge.svg)](https://github.com/zizq-labs/zizq-node/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@zizq-labs/zizq.svg)](https://www.npmjs.com/package/@zizq-labs/zizq)

## Features

* Concurrent async-based worker
* Plain handler functions, or composable Job Functions with attached defaults
* Enqueue and process jobs from one language to another
* Arbitrary named queues
* Granular job priorities
* Scheduled jobs
* Configurable backoff policies
* Configurable job retention policies
* Recurring jobs (cron)
* Job introspection and management APIs, with support for `jq` query filters
* Unique jobs

## Installation

> [!NOTE]
> If you have not yet installed the Zizq server, follow the
> [Getting Started](https://zizq.io/docs/getting-started) guide first.

Install it with your package manager of choice:

```shell
npm install @zizq-labs/zizq
```

Or:

```shell
yarn add @zizq-labs/zizq
```

Node **22.19 or newer** is required. Client and server share version
numbers — keep the client's major/minor at or below the server's.

## Configuration

A `Client` instance is the configuration — there is no global object. The
defaults talk to a server at `http://localhost:7890`, which is fine for local
development. For anything else, pass the URL (and TLS, if needed) when
constructing the client:

```ts
import fs from "node:fs";
import { Client } from "@zizq-labs/zizq";

const client = new Client({
  url: "https://zizq.your.network:7890",
  tls: {
    ca: fs.readFileSync("/path/to/server-ca-cert.pem"),
  },
});
```

For mutual TLS, add `cert` and `key` to the `tls` object (both PEM-encoded
strings or `Buffer`s).

> [!CAUTION]
> If your server is exposed directly to the internet, it should require
> mutual TLS — otherwise anybody can talk to it.

## Usage

> [!TIP]
> This README is an overview. The
> [full documentation](https://zizq.io/docs/clients/node/) covers each
> feature in depth — handler patterns, job querying, unique jobs, and more.

### Enqueuing jobs

The simplest enqueue takes a `type`, `queue`, and `payload`. The Zizq server
returns the created job, with its `id`, `status`, `readyAt` and other
metadata:

```ts
const job = await client.enqueue({
  type: "send_email",
  queue: "emails",
  payload: { userId: 42, template: "welcome" },
});
job.id; // "03fu0wm75gxgmfyfplwvazhex"
```

Per-call options override server defaults — set `priority`, `readyAt` (to
schedule a job in the future), `retryLimit`, `backoff`, or `retention`
inline. `client.enqueueBulk(inputs)` submits many jobs atomically in a
single HTTP request, across queues and types:

```ts
await client.enqueueBulk([
  { type: "send_email", queue: "emails", payload: { userId: 1 } },
  { type: "send_email", queue: "emails", payload: { userId: 2 } },
]);
```

### Defining handlers

A handler is an `async` function that accepts a `job` and either resolves
(the worker acks it as successful) or throws (the worker reports a failure
and the server retries per the backoff policy). The simplest version is a
`switch` on `job.type`:

```ts
async function handler(job) {
  switch (job.type) {
    case "send_email":
      return sendEmail(job.payload);
    case "generate_report":
      return generateReport(job.payload);
    default:
      throw new Error(`unexpected job type: ${job.type}`);
  }
}
```

For a more composable style, the client ships `buildHandler` — pass in your
job functions and you get back a handler that dispatches on the function
name. Each function can also carry `zizqOptions` with its own defaults
(queue, priority, backoff, retention, uniqueness), so enqueuing later only
needs the payload:

```ts
import { buildHandler } from "@zizq-labs/zizq";

async function sendEmail(payload, job) {
  // ...
}
sendEmail.zizqOptions = { queue: "emails", priority: 100 };

async function generateReport(payload) {
  // ...
}
generateReport.zizqOptions = { queue: "reports" };

const handler = buildHandler([sendEmail, generateReport]);

// Job functions can be enqueued directly — the queue and other defaults
// come from the function's zizqOptions.
await client.enqueue({
  type: sendEmail,
  payload: { userId: 42, template: "welcome" },
});
```

For cross-language workflows or when you want explicit `type -> handler`
registration with optional fallback, use `Router`. Routes match by job
type (a string the producer agrees on with the consumer), and an
optional `fallback` catches anything unmatched:

```ts
import { Router } from "@zizq-labs/zizq";

const router = new Router()
  .route("send_email", async (payload, job) => {
    await mailer.send(payload.to, payload.subject);
  })
  .route("generate_report", async (payload) => {
    await reports.generate(payload.id);
  })
  .fallback(async (job) => {
    console.warn(`Unhandled job type: ${job.type}`);
  });

const worker = new Worker({ client, handler: router.build() });
```

Routes overwrite on re-registration, which makes it natural to compose
routers — e.g. start from one that supplies defaults and selectively
override individual routes. If no route matches and no fallback is
registered, the router throws `UnknownJobTypeError`, which the worker
treats like any other handler failure (retries, eventually dead-lettered).

### Running a worker

A `Worker` streams jobs from the server, dispatches them through your
handler with bounded concurrency, batches acks, and reconnects on transient
failures. `worker.run()` blocks until the worker stops:

```ts
import { Client, Worker } from "@zizq-labs/zizq";

const client = new Client({ url: "http://localhost:7890" });

const worker = new Worker({
  client,
  concurrency: 25,
  queues: ["emails", "payments"],
  handler,
});

process.on("SIGINT",  () => worker.stop());
process.on("SIGTERM", () => worker.stop());

await worker.run();
```

`worker.stop()` waits for in-flight handlers to settle and flushes pending
acks before returning. To put a deadline on shutdown, schedule
`worker.kill()` after a timeout — any handlers still running continue to
completion (Node can't cancel promises), but their acks are not flushed, so
the server re-dispatches those jobs to another worker. No jobs are lost.

### Recurring jobs (cron)

Define a cron schedule somewhere in your application startup.
Registrations are idempotent — every process can safely call the same
`register()`, and Zizq keeps the server-side schedule in sync by adding,
replacing, and removing entries as the definition changes. Cron requires
a Pro license on the server.

```ts
import { sendDailyDigest } from "./handlers";

await client.cron("maintenance").register({
  timezone: "Europe/London",
  entries: [
    {
      name: "refresh_warehouse",
      expression: "*/15 * * * *",
      type: "refresh_warehouse",
      queue: "data_warehouse",
      payload: { incremental: true },
    },
    {
      name: "daily_digest",
      expression: "0 9 * * *",
      type: sendDailyDigest, // Job Functions are accepted directly
      payload: {},
    },
  ],
});
```

Once defined, schedules can be inspected and managed via
`client.cron("maintenance")` — `get()` to read the current state,
`pause()`/`resume()` at the schedule or per-entry level, and `delete()`
to remove a schedule entirely.

## Resources

* [Node.js Client Docs](https://zizq.io/docs/clients/node/)
* [Getting Started Docs](https://zizq.io/docs/getting-started/)
* [Zizq Command Reference](https://zizq.io/docs/cli/)
* [Zizq Node.js Client Source](https://github.com/zizq-labs/zizq-node)
* [Zizq Source](https://github.com/zizq-labs/zizq)

## Support & Feedback

If you need help using Zizq,
[create an issue](https://github.com/zizq-labs/zizq-node/issues) on the
[zizq-node](https://github.com/zizq-labs/zizq-node) repo. Feedback is very
welcome.

## License

MIT — see [LICENSE](LICENSE).
