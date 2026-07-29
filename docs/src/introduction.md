# Introduction

Zizq is a simple single-binary persistent job queue server with clients in
various programming languages. All official Zizq clients are **MIT licensed**.

This documentation details how to use Zizq with Node.js by using the official
Zizq Node Client, which implemented in TypeScript and is available on npm as
[`@zizq-labs/zizq`](https://www.npmjs.com/package/@zizq-labs/zizq).

The Node client is fully asynchronous and uses
[undici](https://github.com/nodejs/undici) as its HTTP client with HTTP/2
support. A single `Worker` runs N concurrent job handlers on a single Node
event loop, which is very efficient for I/O-bound work.

> [!NOTE]
> If you have not yet installed the Zizq server, follow the
> [Getting Started](/docs/getting-started/) guide first.

## Issues & Source

All client source code is
[available on GitHub](https://github.com/zizq-labs/zizq-node). Issues can be
raised on the [issue tracker](https://github.com/zizq-labs/zizq-node/issues).

## High-Level Structure

The Node client has two main parts:

1. A `Client` class that wraps the Zizq server's HTTP API.
2. A `Worker` class that streams jobs from the server, dispatches them to
   a handler function, and reports acknowledgment or failure.

There is no _job class_ abstraction. The handler function is a simple `async`
function that accepts a job object and executes it as required. The client does
however provide a convenience through which such a handler can be composed from
a set of `async` route handlers that just take the `payload` (JSON) and process
it.

## Example

A minimal worker looks like this:

> JS:
>
> ```ts
> import { Client, Worker, Router } from "@zizq-labs/zizq";
> 
> const client = new Client({ url: "http://localhost:7890" });
> 
> const worker = new Worker({
>   client,
>   concurrency: 25,
>   queues: ["emails"],
>   handler: new Router()
>     .route("send_email", async (payload) => {
>       console.log("mailing", payload.to, payload.subject);
>     })
>     .build(),
> });
> 
> process.on("SIGINT",  () => worker.stop());
> process.on("SIGTERM", () => worker.stop());
> 
> await worker.run();  // blocks until stopped
> ```

The `Router` produces a [Handler Function](./handlers.md). The `Worker`
dequeues jobs from the server and calls your handler function for each one. If
the handler resolves successfully, the job is acknowledged. If the handler
throws or rejects, the failure is reported to the server, which will either
back off and retry or kill the job if it has exceeded its retry limit.

Enqueueing jobs is just as direct:

> JS:
>
> ```ts
> await client.enqueue({
>   type: "send_email",
>   queue: "emails",
>   payload: { to: "user@example.com" },
> });
> ```

When Zizq dispatches this job to a `Worker`, its handler uses the `type` of
`"send_email"` to determine how to process the job, such as in the example
above.
