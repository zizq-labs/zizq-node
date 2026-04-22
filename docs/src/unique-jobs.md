# Unique Jobs

> [!NOTE]
> This feature requires a Zizq [pro license](https://zizq.io/pricing) on the
> server.

Unique jobs let you deduplicate enqueues by a key computed from the job's
type and payload. The Zizq server enforces uniqueness within an optional
lifecycle scope (e.g. "while queued" or "while active"), so two identical jobs
enqueued in quick succession become a single job.

## Raw Job Enqueues

When enqueueing a job by its `type` string, the `uniqueKey` and optionally
`uniqueWhile` must be manually provided in the enqueue inputs.

```ts
await enqueue(client, {
  type: "send_email",
  queue: "emails",
  payload: { userId: 42, template: "welcome" },
  uniqueKey: "send_email:welcome:42",
  uniqueWhile: "active",
});
```

## Job Function Enqueues

> [!NOTE]
> See [Job Functions](./handlers.md#job-functions) for full details on using
> Job Functions.

Job Functions allow unique keys to be _generated_ based on the payload and the
job type.

The Node client provides a `uniqueKey(...fields)` helper that returns a
resolver you attach to your function's `zizqOptions.uniqueKey`:

```ts
import { uniqueKey } from "@zizq-labs/zizq";

async function sendEmail(payload) { /* ... */ }
sendEmail.zizqOptions = {
  queue: "emails",
  uniqueKey: uniqueKey("userId", "action"),
  uniqueWhile: "queued",
};
```

The helper deterministically hashes the selected payload fields and prefixes
the result with the job type, producing a stable key regardless of object key
order.

## Uniqueness Scopes

The lifecycle scope for which jobs are considered unique is specified through
the `uniqueWhile` option. When not specified, the default value of `"queued"`
is used

The scope defines which statuses the job can be in while Zizq validates
uniqueness of that job on the server. If any attempt is made to enqueue a job
with the same `uniqueKey` while the job is in any of the statuses defined by
this scope, Zizq returns the existing job instead enqueueing a new job.

If two jobs are enqueued concurrently with the same `uniqueKey`, one of those
jobs will be automatically de-duplicated by the server. This is a race-free
operation.

Valid scope options are: `"queued"` (default), `"active"` and `"exists"` and
behave as described below.

<table>
    <thead>
        <tr>
            <th>Scope</th>
            <th>Description</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td><code>"queued"</code></td>
            <td>
                Prevent duplicate enqueues while this job is still in the
                <code>"scheduled"</code> or <code>"ready"</code> statuses (i.e.
                until a worker takes the job)
            </td>
        </tr>
        <tr>
            <td><code>"active"</code></td>
            <td>
                Prevent duplicate enqueues while this job is still in the
                <code>"scheduled"</code>, <code>"ready"</code> or
                <code>"in_flight"</code> statuses (i.e. until this job
                successfully completes)
            </td>
        </tr>
        <tr>
            <td><code>"exists"</code></td>
            <td>
                Prevent duplicate enqueues for as long as the Zizq server still
                has a record of this job (according to its retention policy)
            </td>
        </tr>
    </tbody>
</table>

The default scope when not otherwise specified is `"queued"`. This means as
soon as a worker picks up that job and its status moves to `"in_flight"`, Zizq
will accept new job enqueues with the same `uniqueKey`, even if the job being
processed by the worker eventually fails and moves back to the queue for a
retry.

If a job is successfully enqueued with a `uniqueKey` in scope `"queued"` and a
subsequent enqueue is attempted with the same `uniqueKey` and a broader scope,
such as `"active"`, the second job does not replace the first. Whichever was
enqueued first is retained.

If a job is successfully enqueued with a `uniqueKey` in scope `"queued"` and
that job is now leaves the scope for which it is unique, a new can cab be
enqueued with the same `uniqueKey` even if that job has a broader scope, such
as `"active"`.

To make this expicit, uniquess refers to the behaviour applied to
_subsequent enqueues_ with the same key once this job is successfully enqueued.

## Unique Keys

As mentioned, uniquess is determined by a `uniqueKey` and a scope. When using
the `uniqueKey()` helper on a [Job Function](./handlers.md#job-functions), by
default the Node Zizq client will generate a unique key using the full job
payload within the given job type. Two jobs with the same payload but different
types have different `uniqueKey` values. Two jobs with the same payload and the
same type have the same `uniqueKey` values. This is fully customizable.

While `uniqueKey()` generates unique keys specific to each job type, Zizq
treats uniquess as _logical_ rather than _concrete_. Your application could,
for example treat push notification jobs and email jobs as the same and give
them the same `uniqueKey` values at enqueue-time.

### Overriding the `uniqueKey`

The Node client generates the `uniqueKey` value by calling
`uniqueKey(jobFn, payload)` from your Job Function's `zizqOptions`, passing in
the same payload as that used to enqueue the job. The default implementation of
this function uses a normalized serialization approach before digesting the
result with a SHA256 hash.

You can easily see how this works and can easily write unit tests for it.

```ts
import { uniqueKey } from "@zizq-labs/zizq";

async function exampleJob(payload) {
  // ...
}
exampleJob.zizqOptions = {
  type: "example_job",
  uniqueKey: uniqueKey(),
};

exampleJob.zizqOptions.uniqueKey(
  exampleJob,
  {to: "test@test.com", subject: "Example"},
);
// "example_job:3c6da81af475f0b1ddeac43095199334b3ebfaafff9a7e6794b4d4e38122c597"

exampleJob.zizqOptions.uniqueKey(
  exampleJob,
  {subject: "Example", to: "test@test.com"},
);
// "example_job:3c6da81af475f0b1ddeac43095199334b3ebfaafff9a7e6794b4d4e38122c597"

exampleJob.zizqOptions.uniqueKey(
  exampleJob,
  {to: "other@test.com", subject: "Example"},
);
// "example_job:f702b3ff543464bb9bb1bc2e65734f6df07271baeca1a0452e67096ce71a86bb"
```

You could customize this function in your Job Functions to either fully
implement your own unique key generation, or to _tweak_ the default
implementation, for example to enforce uniqueness only across a subset of keys,
or within a bucketed time window.

### Examples

This example uses the default implementation, but applied only to a subset of
the job arguments:

```ts
exampleJob.zizqOptions = {
  type: "example_job",
  uniqueKey: uniqueKey("to"),
};

exampleJob.zizqOptions.uniqueKey(
  exampleJob,
  {to: "test@test.com", subject: "Example"},
);
// "example_job:b5c4c35eeacf8bbf2034b0ed8b0e2f9ac3e7da66b79b543e9c6c124d90c371a3"

exampleJob.zizqOptions.uniqueKey(
  exampleJob,
  {to: "test@test.com", subject: "Other"},
);
// "example_job:b5c4c35eeacf8bbf2034b0ed8b0e2f9ac3e7da66b79b543e9c6c124d90c371a3"

exampleJob.zizqOptions.uniqueKey(
  exampleJob,
  {to: "other@test.com", subject: "Example"},
);
// "example_job:fadcd704b379aa47dffc6aadd7d77bfd2a74baa9c1ee9a11913df6f85faa4bd6"
```

This just sugar for the equivalent composition:

```ts
exampleJob.zizqOptions = {
  type: "example_job",
  uniqueKey: (fn, payload) => (uniqueKey()(fn, {to: payload.to})),
};
```

This example generates unique keys that fall into hourly time slots:

```ts
exampleJob.zizqOptions = {
  type: "example_job",
  uniqueKey: (fn, payload) => {
    return uniqueKey()(
      fn,
      {
        ...payload,
        bucket: Math.floor(Date.now() / 3600000) * 3600000,
      },
    );
  },
};

// At 1:30pm
exampleJob.zizqOptions.uniqueKey(
  exampleJob,
  {to: "test@test.com", subject: "Example"},
);
// "example_job:d59dfcd80066c8a8b55e0d8faa929a6074bdd1aa8b904349b0987a8048bf8d8a"

// At 1:59pm
exampleJob.zizqOptions.uniqueKey(
  exampleJob,
  {to: "test@test.com", subject: "Example"},
);
// "example_job:d59dfcd80066c8a8b55e0d8faa929a6074bdd1aa8b904349b0987a8048bf8d8a"

// At 2:00pm
exampleJob.zizqOptions.uniqueKey(
  exampleJob,
  {to: "test@test.com", subject: "Example"},
);
// "example_job:689a17f552bca147b28f39f8d909f02709738e23810cfaf633b221807498f59a"

// At 2:05pm
exampleJob.zizqOptions.uniqueKey(
  exampleJob,
  {to: "test@test.com", subject: "Example"},
);
// "example_job:689a17f552bca147b28f39f8d909f02709738e23810cfaf633b221807498f59a"
```

## Enqueueing Unique Jobs

Where a unique scope violation was encountered, the returned `Job` instance
from `enqueue()` or `enqueueBulk()` will have the same `id` as the existing job
and the `duplicate` flag will be set to `true`.

```ts
const result1 = await enqueue(client, {
  type: "send_email",
  queue: "emails",
  payload: { userId: 42, template: "welcome" },
  uniqueKey: "send_email:welcome:42",
  uniqueWhile: "active",
});
result1.id // "03fu0wm75gxgmfyfplwvazhex"
result1.duplicate // false

const result2 = await enqueue(client, {
  type: "send_email",
  queue: "emails",
  payload: { userId: 42, template: "welcome" },
  uniqueKey: "send_email:welcome:42",
  uniqueWhile: "active",
});
result2.id // "03fu0wm75gxgmfyfplwvazhex"
result2.duplicate // true
```

The same is true for
[`enqueueBulk()`](./enqueueing-jobs.md#bulk-job-enqueueing).

This means your application generally does not need to treat duplicate enqueues
as errors and can instead handle them idempotently.
