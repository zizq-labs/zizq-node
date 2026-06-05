# Handler Functions

Jobs in the Zizq Node client are dispatched by the `Worker` to a single handler
function. A handler function is an `async` function that accepts a job instance
argument, which provides the job's data such as its `queue`, `type`, `attempts`
and `payload`. The handler uses this data to decide how to process the job and
either resolves (returns) or rejects (throws).

If the handler resolves successfully, the worker automatically acknowledges the
job by marking it successful. If the handler rejects, the worker reports the
failure to the Zizq server, which automatically retries the job at a later time
according to the backoff policy.

## Direct Implementation

There are many ways to implement a handler function directly, but one obvious
approach is with a simple `switch` statement based on the job `type`.

```ts
async function myHandler(job) {
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

We can enqueue jobs intended for such a handler like this:

```ts
await client.enqueue({
  type: "send_email",
  queue: "emails",
  payload: { to: "user@example.com" },
});
```

## Router

For more explicit dispatch — particularly in cross-language workflows
where jobs are enqueued by another service that agrees on a `type` string
with the consumer — the client ships a `Router`. Routes are registered
explicitly against a type name, with a chainable builder API.

```ts
import { Router } from "@zizq-labs/zizq";

const router = new Router()
  .route("send_email", async (payload, job) => {
    await mailer.send(payload.to, payload.subject);
  })
  .route("generate_report", async (payload) => {
    await reports.generate(payload.id);
  });

const handler = router.build();
```

Handlers receive the unwrapped `payload` and the full `job` for cases where
they need metadata. Most handlers only need the payload — JavaScript lets
you ignore the second argument.

We can enqueue jobs intended for the router like this:

```ts
await client.enqueue({
  type: "send_email",
  queue: "emails",
  payload: { to: "user@example.com" },
});
```

### Fallback handler

If you want a catch-all for unknown job types — for example to delegate to
another dispatcher, or to log unsupported types — register a `fallback`.
Unlike route handlers, it receives the full `job` (not split into a
payload/job pair) just like a top-level handler:

```ts
const router = new Router()
  .route("send_email", async (payload) => { /* ... */ })
  .fallback(async (job) => {
    console.warn(`Unhandled job type: ${job.type}`);
    throw new Error(`unsupported: ${job.type}`);
  });
```

If no route matches and no fallback is registered, the router throws
`UnknownJobTypeError`. The worker treats this like any other handler
failure: the job is nacked, retried per the backoff policy, and eventually
dead-lettered once the retry limit is hit.

Fallbacks have the same signature as a compiled router, so you can delegate
one router to another:

```ts
mainRouter.fallback(legacyRouter.build());
```

### Overriding routes

Re-registering a type replaces the previous handler. This is convenient
for composing routers — for example, starting from a base router and
selectively overriding individual routes for a particular environment:

```ts
function baseRouter() {
  return new Router()
    .route("send_email", emailJob)
    .route("generate_report", reportJob);
}

const router = baseRouter()
  .route("send_email", async (payload) => {
    // env-specific override
  });
```

## Job Functions

The Node client also allows using the function name as an implicit `type` and
building a handler function from such functions. These are called Job
Functions.

```ts
import { buildHandler } from "@zizq-labs/zizq";

async function sendEmail(payload, job) {
  // ...
}

async function generateReport(payload) {
  // ...
}

const handler = buildHandler([
  sendEmail,
  generateReport,
])
```

This simply returns a function that takes `job` and internally calls
`sendEmail` when `job.type` is `"sendEmail"` or calls `generateReport` when
`job.type` is `"generateReport"`.

The functions themselves need only accept a `payload`, which is the JSON object
provided when the job was enqueued. The second argument is the job object
itself for cases where your job function needs access to it.

We can enqueue jobs intended for such a handler like this:

```ts
await client.enqueue({
  type: sendEmail,
  queue: "emails",
  payload: { to: "user@example.com" },
});
```

> [!NOTE]
> Using the actual `type` string `"sendEmail"` also works. We'll see why
> enqueueing by the job function directly can be convenient later.

### Attaching options to job functions

Job functions defined in this way can also have associated `zizqOptions`
defined on them. This can be used to explicitly set the `type` that the
function handles, along with other options used at enqueue-time such as `queue`
and `priority`.

```ts
import { buildHandler } from "@zizq-labs/zizq";

async function sendEmail(payload, job) {
  // ...
}
sendEmail.zizqOptions = {
  queue: "emails",
  type: "send_email",
};

async function generateReport(payload) {
  // ...
}

const handler = buildHandler([
  sendEmail,
  generateReport,
])
```

Now this `handler` calls `sendEmail` for any jobs with `job.type` equal to
`"send_email"` instead of using the function name directly.

Because `queue` is present in `zizqOptions` we do not need to specify it at
enqueue-time, unless we want to explicitly override the queue:

```ts
await client.enqueue({
  type: sendEmail,
  payload: { to: "user@example.com" },
});
```

Zizq knows to put this job on the `emails` queue. All such options are
described in the following sections.

#### Setting the Type

Set `type` to in `zizqOptions` set the job `type` used at enqueue-time and by
`buildHandler()`. Types must be valid UTF-8 and cannot contain any of the
following reserved characters:

`,`, `*`, `?`, `[`, `]`, `{`, `}`, `\`

When not specified, the function name is used as the `type`.

```ts
jobFn.zizqOptions = { type: "send_email" };
```

#### Setting the Queue

Set `queue` to in `zizqOptions` set the `queue`. Queue names must be valid
UTF-8 and cannot contain any of the following reserved characters:

`,`, `*`, `?`, `[`, `]`, `{`, `}`, `\`

There is no default queue name. When not specified in `zizqOptions` it *must*
be specified at enqueue-time.

```ts
jobFn.zizqOptions = { queue: "emails" };
```

#### Setting the Priority

Set `priority` in `zizqOptions` to set the `priority` of the job. Valid values range
between `0` and `65536`. The default priority is not specified by the client,
but by the Zizq server (generally `32768`).

``` ruby
jobFn.zizqOptions = { priority: 500 };
```

#### Setting the Backoff Policy

Set `retryLimit` to set the maximum number of retries before a job is
marked `"dead"`, and the `backoff` object to set the backoff formula
parameters. The defaults are managed by the server (generally the default
`retryLimit` is 25 and the `backoff` parameters are
`baseMs: 10000, exponent: 4, jitterMs: 30000`).

Backoff parameters are in milliseconds. All three `backoff` arguments must be
provided together.

The values are used in the following formula:

```
delayMs = baseMs + (attempts ** exponent) + (jitterMs * Math.random() * attempts)
```

The randomness in the jitter component is designed to avoid situations where a
cascade of failures all retry at the same time. They naturally spread out.

```ts
jobFn.zizqOptions = {
  retryLimit: 50,
  backoff: {
    baseMs: 5000,
    exponent: 2,
    jitterMs: 10000,
  },
};
```

#### Setting the Retention Policy

Set `retention` in `zizqOptions` to set the duration for which dead and
completed jobs are retained by the server before being reaped (hard deleted).
Values are in milliseconds. Thd defaults are managed by the server but are
generally set at 7 days for dead jobs, and zero for completed jobs, meaning
only dead jobs are kept.

Both arguments are optional.

```ts
jobFn.zizqOptions = {
  retention: {
    deadMs: 86400 * 30 * 1000,
    completedMs: 86400 * 2 * 1000,
  },
};
```

#### Specifying Job Uniqueness

> [!TIP]
> This section of the documentation deals mostly with how to define unique jobs
> using Job Functions with `zizqOptions`. See [Unique Jobs](./unique-jobs.md)
> for more detailed documentation on using this feature.

Unique jobs requires a pro license on the server. Zizq is able to prevent
duplicate enqueues of the same job within a specified job lifecycle scope. Use
`uniqueKey` and `uniqueWhile` to enable or disable uniqueness for a job.

When using Job Functions withn `zizqOptions`, the `uniqueKey` can either be a
raw string, or a function that accepts the job function itself and the payload,
returning a unique key string. The Zizq Node client provides a `uniqueKey()`
helper function to make generating a unique key straightforward.

The `uniqueWhile` setting specifies for which part of the job's lifecycle it is
considered unique. Options are:

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

The default scope is `"queued"`. Zizq does not force you to select an arbitrary
expiry deadline for unique jobs. The implementation is _purely_ lifecycle
based.

```ts
jobFn.zizqOptions = {
  uniqueKey: (jobFn, payload) => `send_email:${payload.to}`,
  uniqueWhile: "active",
};
```

##### Unique Keys

Identity is based on the generation of a `uniqueKey` for a job, which is
handled through the `uniqueKey()` function on the job. This function takes the
underlying Job Function object, and the payload for which a unique key is
needed.

Unique keys are intentionally _global_, so jobs of different types but
logically equivalent (e.g. push notification vs email) can be considered
equivalent and duplicates of one another at your application's discretion.
Prefix your unique key with the job type to make it unique within that job
type.

```ts
jobFn.zizqOptions = {
  uniqueKey: (jobFn, payload) => `send_email:${payload.to}`,
};
```

There is also a helper higher-order function, `uniqueKey()` that generates a
unique key function for you, prefixed with the job type.

```ts
import { uniqueKey } from "@zizq-labs/zizq";

jobFn.zizqOptions = {
  uniqueKey: uniqueKey(), // Produces something like `sendEmail:{sha256hash}`
};
```

The default implementation is a function of the job type and its entire payload
and is deterministic for equal inputs regardless of key-value ordering.

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

We can also provide a subset of keys on which to produce the unique hash by
providing the list of keys as varargs to the `uniqueKey()` helper.

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

### Dynamic Job Configuration { #dynamic-config }

> [!TIP]
> All `zizqOptions` settings, except `type`, can also be overridden explicitly
> by passing any overrides directly to `client.enqueue()`, such as
> `client.enqueue({type: fn, queue: "other", payload: {hello: "world"}})`.

When the client generates parameters to send to the Zizq server, it reads the
`zizqOptions` from the Job Function, resolves the result, and optionally passes
that result through a `transform()` function attached to `zizqOptions`. The
`transform()` function takes the resolved `options` and the `payload`.

If you need to do any kind of dynamic configuration in your job functions, such
as assigning a different priority based on time of day, or based on features
in the payload, you can hook into this function.

```ts
jobFn.zizqOptions = {
  priority: 500,
  transform: (opts, payload) => {
    if (payload.to.endsWith("@important.com")) {
      return {...opts, priority: opts.priority / 2};
    }
  },
};
```

If the function returns `undefined`, the original options are used. If the
function returns a new `options` object, that object is used. It is permissible
to mutate `options` in place.

```ts
jobFn.zizqOptions = {
  priority: 500,
  transform: (opts, payload) => {
    if (payload.to.endsWith("@important.com")) opts.priority /= 2;
  },
};
```
