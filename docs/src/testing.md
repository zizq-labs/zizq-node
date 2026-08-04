# Testing

The Node client ships a `TestClient` — a drop-in subclass of `Client`
that buffers enqueues in memory instead of sending them to the server.
Tests can then assert on what was enqueued and, optionally, drain the
buffer through the real handler to exercise side effects end-to-end
without a running Zizq instance.

The intended scope is purely **enqueue paths**: "did this job get
enqueued with these args?" and "run the buffered jobs through my
handler." Read operations (`take`, `getJob`, `listJobs`,
`countJobs`, `queues`, …) deliberately raise `NotSupportedError`
rather than silently returning empty results.

## Using TestClient

Node applications construct a `Client` explicitly and pass it where it's
used. Tests follow the same shape:

``` ts
import { TestClient } from "@zizq-labs/zizq";

const client = new TestClient();

// Pass `client` to your service under test wherever you'd normally
// pass a real `Client`.
await someService.doThing(client);
```

For clean isolation between test cases, `TestClient` exposes `clear()`
to reset the buffer. Typical setup with `node:test`:

``` ts
import { beforeEach, describe, it } from "node:test";
import { TestClient } from "@zizq-labs/zizq";

describe("SignupService", () => {
  let client: TestClient;

  beforeEach(() => {
    client = new TestClient();
  });

  it("enqueues a welcome email", async () => {
    await SignupService.run(client, "alice@example.com");
    assert.ok(client.enqueued("send_email"));
  });
});
```

## Inspecting the buffer

`TestClient` exposes status-filtered views over the buffer. Each
accepts a common set of filter options (see [Filters](#filters)
below).

| Method                                | Returns                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `client.enqueuedJobs(filters?)`       | All buffered jobs, in submission order, regardless of status.               |
| `client.enqueuedOptions(filters?)`    | The resolved `EnqueueOptions` — useful for `uniqueKey`, `readyAt`, etc.     |
| `client.pendingJobs(filters?)`        | `ready` + `scheduled` (waiting on `readyAt`).                               |
| `client.inFlightJobs(filters?)`       | Jobs currently mid-dispatch. Only visible from inside a handler.            |
| `client.completedJobs(filters?)`      | Jobs whose handler returned successfully.                                   |
| `client.deadJobs(filters?)`           | Jobs whose handler threw. TestClient never retries.                         |

## Asserting enqueues

For the common "was this job enqueued?" check, use the predicates.
Optionally pass a payload to require an exact match (after JSON
round-trip normalisation):

``` ts
// Any payload
assert.ok(client.enqueued("send_email"));

// Exact payload match
assert.ok(client.enqueued("send_email", { to: "alice@example.com" }));

// Count how many were enqueued
assert.equal(client.enqueuedCount("send_email"), 3);
assert.equal(client.enqueuedCount("send_email", { to: "alice@example.com" }), 1);
```

For fuzzier matching, drop down to `enqueuedJobs` with a `filter`
predicate:

``` ts
const emailsToBob = client.enqueuedJobs({
  onlyTypes: "send_email",
  filter: (job) => (job.payload as any).to.endsWith("@bob.com"),
});
assert.equal(emailsToBob.length, 1);
```

## Running buffered jobs

`client.dispatch(handler, options?)` dispatches each entry that is
runnable at call time through `handler` (typically a `Router.build()`
result). By default a single snapshot is drained — anything enqueued
from within a handler stays buffered for the next call.

``` ts
import { Router } from "@zizq-labs/zizq";

const router = new Router()
  .route("send_email", async (payload) => {
    await mailer.send((payload as any).to);
  })
  .build();

// Run the code that enqueues, then drain.
await SignupService.run(client, "alice@example.com");
await client.dispatch(router);

// Optionally scope the drain to a subset of the buffer.
await client.dispatch(router, { onlyTypes: "send_email" });
```

Pass `recursive: true` to keep looping until nothing matches the
filters — useful when a handler legitimately fans out into further
jobs you want dispatched in the same call. `maxIterations` (default
`1000`) caps the loop so an unconditional re-enqueue throws instead
of hanging the test suite:

``` ts
// Drain jobs and any they enqueue, up to the default cap.
await client.dispatch(router, { recursive: true });

// Raise the cap for legitimate fan-out.
await client.dispatch(router, { recursive: true, maxIterations: 50_000 });
```

Handler exceptions transition the entry's status to `dead` and re-throw
from `dispatch`. Scheduled jobs (`readyAt` in the future) are skipped
until due; combine with a fake clock library or `node:test`'s
`MockTimers` to advance time and drain them.

## Filters

Every accessor and `dispatch` accepts the same filter options:

| Option             | Type                                    | Meaning                                          |
| ------------------ | --------------------------------------- | ------------------------------------------------ |
| `onlyQueues`       | `string` or `string[]`                  | Restrict to these queue names.                   |
| `exceptQueues`     | `string` or `string[]`                  | Exclude these queue names.                       |
| `onlyTypes`        | `string` or `string[]`                  | Restrict to these types.                         |
| `exceptTypes`      | `string` or `string[]`                  | Exclude these types.                             |
| `filter`           | `(job: Job) => boolean`                 | Arbitrary predicate. Defaults to "pass all".     |

Filters compose via AND. Nonsensical combinations (e.g. `onlyQueues:
"a", exceptQueues: "a"`) naturally produce no matches — there's no
validation.

## Lifecycle states

Buffered jobs have a valid Zizq status. `TestClient` mirrors the real
lifecycle, but without retries — `in_flight` only ever transitions to
`completed` or `dead`:

| Status        | Meaning                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| `scheduled`   | `readyAt` is in the future. Skipped by `dispatch` until due.                            |
| `ready`       | Runnable now. Drained on the next `dispatch` call.                                      |
| `in_flight`   | Currently being dispatched. You usually only see this from inside a handler.            |
| `completed`   | Handler returned cleanly.                                                               |
| `dead`        | Handler threw. The exception is re-thrown from `dispatch`.                              |

## Limitations

* **Read APIs raise.** `getJob`, `listJobs`, `countJobs`, `queues`,
  `take`, the whole cron API, etc. all raise `NotSupportedError` in
  `TestClient`. Use the buffer accessors for assertions, or stub the
  call explicitly if your code under test needs one.

* **`Worker` is not stubbed.** TestClient buffers enqueues; if you
  need to test a worker handler in isolation, call it directly (or a
  `Router.build()` handler) via `client.dispatch(handler)`.

* **No automatic retries.** A handler that throws is recorded as
  `dead` and the exception re-throws from `dispatch`. If you want to
  test retry behaviour, point at a real Zizq server.

* **Pro-only features (cron, unique jobs) are not enforced.** The
  `uniqueKey` / `uniqueWhile` fields are preserved on the buffered
  `EnqueueOptions` for assertion purposes, but the test client
  doesn't actually deduplicate.
