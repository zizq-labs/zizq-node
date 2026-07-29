# Unique Jobs

> [!NOTE]
> This feature requires a Zizq [pro license](https://zizq.io/pricing) on the
> server.

Unique jobs let you deduplicate enqueues by a key computed from the job's
inputs. The Zizq server enforces uniqueness within an optional lifecycle scope
(e.g. "while queued" or "while active"), so two identical jobs enqueued in
quick succession result in just a single job.

Jobs specify a `uniqueKey` and optionally `uniqueWhile` as part of the enqueue
inputs.

> JS:
>
> ```ts
> await client.enqueue({
>   type: "send_email",
>   queue: "emails",
>   payload: { userId: 42, template: "welcome" },
>   uniqueKey: "send_email:welcome:42",
>   uniqueWhile: "active",
> });
> ```

The `uniqueKey` typically is a function of the enqueue input, and so a function
is accepted in this position. When a function is provided for the `uniqueKey`,
it is invoked with the entire enqueue input and returns a string to be used as
the key.

> JS:
>
> ```ts
> await client.enqueue({
>   type: "send_email",
>   queue: "emails",
>   payload: { userId: 42, template: "welcome" },
>   uniqueKey: (input) => {
>     return `${input.type}:${input.payload.template}:${input.payload.userId}`;
>   },
>   uniqueWhile: "active",
> });
> ```

The Node client provides a `payloadHasher()` helper that returns a configured
hashing function you use as the `uniqueKey`.

> JS:
> ```ts
> import { payloadHasher } from "@zizq-labs/zizq";
> 
> await client.enqueue({
>   type: "send_email",
>   queue: "emails",
>   payload: { userId: 42, template: "welcome" },
>   uniqueKey: payloadHasher(),
>   uniqueWhile: "active",
> });
> ```

The helper deterministically hashes payload and prefixes the result with the
job type, producing a stable key regardless of object key order.

It is sometimes necessary to implement uniqueness based on a given subset of
the payload. For this, `payloadHasher()` accepts the `only` option, which takes
one or more jq-compatible (dotted path) expressions.

> JS:
> ```ts
> import { payloadHasher } from "@zizq-labs/zizq";
> 
> await client.enqueue({
>   type: "send_email",
>   queue: "emails",
>   payload: { userId: 42, template: "welcome" },
>   uniqueKey: payloadHasher({ only: ['.userId'] }),
>   uniqueWhile: "active",
> });
> ```

Likewise, it is sometimes necessary to exclude particular parts of the payload,
which can be done by providing the `except` option.

> JS:
> ```ts
> import { payloadHasher } from "@zizq-labs/zizq";
> 
> await client.enqueue({
>   type: "send_email",
>   queue: "emails",
>   payload: { userId: 42, template: "welcome" },
>   uniqueKey: payloadHasher({ except: ['.template'] }),
>   uniqueWhile: "active",
> });
> ```

In rare use cases (e.g. push notification vs email considered as equivalents)
the type prefix can be excluded from the key, making the `uniqueKey` apply
across all job types.

> JS:
> ```ts
> import { payloadHasher } from "@zizq-labs/zizq";
> 
> await client.enqueue({
>   type: "send_email",
>   queue: "emails",
>   payload: { userId: 42, template: "welcome" },
>   uniqueKey: payloadHasher({ prefix: false }),
>   uniqueWhile: "active",
> });
> ```

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

As mentioned, uniqueness is determined by a `uniqueKey` and a scope. When using
the `payloadHasher()` helper, by default the Node Zizq client will generate a
unique key using the full job payload within the given job type. Two jobs with
the same payload but different types have different `uniqueKey` values. Two
jobs with the same payload and the same type have the same `uniqueKey` values.
This is fully customizable.

While `payloadHasher()` generates unique keys specific to each job type, Zizq
treats uniqueness as purely _logical_. Your application could, for example
treat push notification jobs and email jobs as the same and give them the same
`uniqueKey` values at enqueue-time.

### Customizing the `payloadHasher()`

The Node client generates the `uniqueKey` value by calling
`hashFn(enqueueInput)`, passing in the entire input used to enqueue the job.
The default implementation of this function uses a normalized serialization
approach before digesting the result with a SHA256 hash.

You can easily see how this works and can easily write unit tests for it.

> JS:
>
> ```ts
> import { payloadHasher } from "@zizq-labs/zizq";
> 
> const hashFn = payloadHasher();
> 
> hashFn({
>   type: "example_job",
>   queue: "example",
>   payload: {
>     to: "test@test.com",
>     subject: "Example",
>   },
> });
> // "example_job:3c6da81af475f0b1ddeac43095199334b3ebfaafff9a7e6794b4d4e38122c597"
> 
> hashFn({
>   type: "example_job",
>   queue: "example",
>   payload: {
>     to: "test@test.com",
>     subject: "Example",
>   },
> });
> // "example_job:3c6da81af475f0b1ddeac43095199334b3ebfaafff9a7e6794b4d4e38122c597"
> 
> hashFn({
>   type: "example_job",
>   queue: "example",
>   payload: {
>     to: "other@test.com",
>     subject: "Example",
>   },
> });
> // "example_job:f702b3ff543464bb9bb1bc2e65734f6df07271baeca1a0452e67096ce71a86bb"
> ```

You could customize this function to either fully implement your own unique key
generation, or to _tweak_ the default implementation, for example to enforce
uniqueness only across a subset of keys, or within a bucketed time window.

### Examples

This example uses the default implementation, but applied only to a subset of
the job arguments:

> JS:
>
> ```ts
> import { payloadHasher } from "@zizq-labs/zizq";
> 
> const hashFn = payloadHasher({ only: ".to" });
> 
> hashFn({
>   type: "example_job",
>   queue: "example",
>   payload: {
>     to: "test@test.com",
>     subject: "Example",
>   },
> });
> // "example_job:b5c4c35eeacf8bbf2034b0ed8b0e2f9ac3e7da66b79b543e9c6c124d90c371a3"
> 
> hashFn({
>   type: "example_job",
>   queue: "example",
>   payload: {
>     to: "test@test.com",
>     subject: "Other",
>   },
> });
> // "example_job:b5c4c35eeacf8bbf2034b0ed8b0e2f9ac3e7da66b79b543e9c6c124d90c371a3"
> 
> hashFn({
>   type: "example_job",
>   queue: "example",
>   payload: {
>     to: "other@test.com",
>     subject: "Example",
>   },
> });
> // "example_job:fadcd704b379aa47dffc6aadd7d77bfd2a74baa9c1ee9a11913df6f85faa4bd6"
> ```

This just sugar for the equivalent composition:

> JS:
>
> ```ts
> import { payloadHasher } from "@zizq-labs/zizq";
> 
> const fullHashFn = payloadHasher();
> 
> function hashFn(input) {
>   return fullHashFn({
>     ...input,
>     payload: { to: input.payload.to },
>   });
> }
> ```

This example generates unique keys that fall into 5-minute time slots:

> JS:
>
> ```ts
> import { payloadHasher } from "@zizq-labs/zizq";
> 
> function bucketedHasher(hashFn) {
>   return (input) => {
>     return `${hashFn(input)}:${Math.floor(Date.now() / 300000)}`;
>   };
> }
> 
> const hashFn = bucketedHasher(payloadHasher());
> 
> // At 6:15pm
> hashFn({
>   type: "example_job",
>   queue: "example",
>   payload: {
>     to: "test@test.com",
>     subject: "Example",
>   },
> });
> // "example_job:3c6da81af475f0b1ddeac43095199334b3ebfaafff9a7e6794b4d4e38122c597:5951043"
> 
> // At 6:19pm
> hashFn({
>   type: "example_job",
>   queue: "example",
>   payload: {
>     to: "test@test.com",
>     subject: "Example",
>   },
> });
> // "example_job:3c6da81af475f0b1ddeac43095199334b3ebfaafff9a7e6794b4d4e38122c597:5951043"
> 
> // At 6:20pm
> hashFn({
>   type: "example_job",
>   queue: "example",
>   payload: {
>     to: "test@test.com",
>     subject: "Example",
>   },
> });
> // "example_job:3c6da81af475f0b1ddeac43095199334b3ebfaafff9a7e6794b4d4e38122c597:5951044"
> 
> // At 6:25pm
> hashFn({
>   type: "example_job",
>   queue: "example",
>   payload: {
>     to: "test@test.com",
>     subject: "Example",
>   },
> });
> // "example_job:3c6da81af475f0b1ddeac43095199334b3ebfaafff9a7e6794b4d4e38122c597:5951045"
> ```

## Enqueueing Unique Jobs

Where a unique scope violation was encountered, the returned `Job` instance
from `client.enqueue()` or `client.enqueueBulk()` will have the same `id` as
the existing job and the `duplicate` flag will be set to `true`.

> JS:
>
> ```ts
> const result1 = await client.enqueue({
>   type: "send_email",
>   queue: "emails",
>   payload: { userId: 42, template: "welcome" },
>   uniqueKey: "send_email:welcome:42",
>   uniqueWhile: "active",
> });
> result1.id // "03fu0wm75gxgmfyfplwvazhex"
> result1.duplicate // false
> 
> const result2 = await client.enqueue({
>   type: "send_email",
>   queue: "emails",
>   payload: { userId: 42, template: "welcome" },
>   uniqueKey: "send_email:welcome:42",
>   uniqueWhile: "active",
> });
> result2.id // "03fu0wm75gxgmfyfplwvazhex"
> result2.duplicate // true
> ```

The same is true for
[`client.enqueueBulk()`](./enqueueing-jobs.md#bulk-job-enqueueing).

This means your application generally does not need to treat duplicate enqueues
as errors and can instead handle them idempotently.
