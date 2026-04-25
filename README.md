# Zizq — Official Node.js Client

Zizq is a simple, zero dependency, single binary job queue system that is both
fast and durable. It is designed to work in any stack through a simple HTTP
API.

This is the official Zizq client library for Node.js, written in TypeScript.

[![CI](https://github.com/zizq-labs/zizq-node/actions/workflows/ci.yml/badge.svg)](https://github.com/zizq-labs/zizq-node/actions/workflows/ci.yml)

## Features

* Concurrent async-based worker
* Enqueue and process jobs from one language to another
* Arbitrary named queues
* Granular job priorities
* Scheduled jobs
* Configurable backoff policies
* Configurable job retention policies
* Job introspection and management APIs, with support for `jq` query filters
* Unique jobs

## Example

> [!TIP]
> There is also a composable function-based convenience wrapper available. Read
> the documentation on
> [Handler Functions](https://zizq.io/docs/clients/node/handlers.html) for more
> info

Enqueueing a job.

```ts
import { Client, enqueue } from "@zizq-labs/zizq";

const client = new Client({ url: "http://localhost:7890" });

await enqueue(client, {
  type: "send_email",
  queue: "emails",
  payload: { to: "user@example.com" },
});
```

A very basic worker with a custom handler.

```ts
import { Client, Worker } from "@zizq-labs/zizq";

const client = new Client({ url: "http://localhost:7890" });

const worker = new Worker({
  client,
  concurrency: 25,
  queues: ["emails"],
  handler: async (job) => {
    switch (job.type) {
      case "send_email":
        console.log(`sending email using payload ${JSON.stringify(job.payload)}`);
        break;
      default:
        throw new Error(`unknown job type: ${job.type}`);
    }
  },
});

process.on("SIGINT",  () => worker.stop());
process.on("SIGTERM", () => worker.stop());

await worker.run();
```

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
