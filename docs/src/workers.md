# Running Workers

> [!NOTE]
> See [Handler Functions](./handlers.md) for details on the `handler` provided
> to the `Worker`.

The `Worker` class streams jobs from the server, dispatches them to a
handler function, and reports sucess of failure (ack/nack) to the server. A
single `Worker` runs a specified number of concurrent handlers on a single
Node event loop.

> JS:
>
> ```ts
> import { Client, Worker } from "@zizq-labs/zizq";
> 
> const client = new Client({ url: "http://localhost:7890" });
> 
> const worker = new Worker({
>   client,
>   concurrency: 25,
>   queues: ["emails"],
>   handler: async (job) => {
>     // your application logic here
>   },
> });
> 
> process.on("SIGINT",  () => worker.stop());
> process.on("SIGTERM", () => worker.stop());
> 
> await worker.run();  // blocks until stopped
> ```

## Specifying the number of concurrent jobs

Pass `concurrency` to the `Worker` to specify how many jobs are permitted to
run concurrently. The default value is `1`, which means that worker is purely
sequential.

> JS:
>
> ```ts
> const worker = new Worker({
>   client,
>   concurrency: 100,
>   handler,
> });
> ```

## Specifying which queues to process

Pass an array of `queues` to specify one or more queues to listen for work on.
Queues do not need to be explicitly created on the server. They implicitly come
into existence when jobs are enqueued to them.

An empty array means _all queues_. The default value when not specified is `[]`
(all queues).

> JS:
>
> ```ts
> const worker = new Worker({
>   client,
>   queues: ["emails", "invoicing"],
>   handler,
> });
> ```

### Specifying a prefetch limit

By default the worker will fetch the same number of jobs as the total
concurrency. Throughput can be increased significantly by prefetching _more_
jobs than the total concurrency, ensuring there is always work sitting in the
buffer, with more jobs received while the worker is busy processing the current
jobs.

This default can be changed by specifying a `prefetch` limit. Just make sure
not to set this value lower than `concurrency` as doing so will act as a
concurrency limiter (there will not be enough jobs available to meet the
desired concurrency).

> JS:
>
> ```ts
> const worker = new Worker({
>   client,
>   concurrency: 50,
>   prefetch: 60, // 50 jobs being worked, 10 ready to go
>   handler,
> });
> ```

### Specifying a logger instance

The `Worker`'s default logger is simply the `console` instance. Any other
compatible logger can be specified by providing the `logger` to the worker.

## Graceful shutdown

`worker.stop()` implements a patient graceful shutdown: it waits for all
in-flight job handlers to resolve or reject, flushes any pending acks, then
closes the take-jobs stream. `worker.run()` returns once all of that has
drained.

If you want a deadline on graceful shutdown, escalate to `worker.kill()`
after a timeout:

> JS:
>
> ```ts
> process.on("SIGINT", () => {
>   worker.stop();
>   setTimeout(() => worker.kill(), 30_000);
> });
> ```

`kill()` closes the stream immediately and skips the drain + flush. Any
in-flight job handlers that are already running continue to completion —
Node can't cancel promises — but their acks will not be flushed, so the
server will re-dispatch the corresponding jobs to another worker upon detecting
that the worker has disconnected. No jobs are lost in the process.
