# Batched Jobs

> [!NOTE]
> This feature requires a Zizq [pro license](https://zizq.io/pricing) on the
> server.

Batched jobs let you accumulate many enqueue calls into a single pending job.
This is useful when your application enqueues one work unit at a time, but the
downstream service you're calling accepts (or prefers) batches — for example,
push notification providers that accept up to 1000 device tokens per request,
or bulk email APIs that accept many recipients per call.

Rather than each enqueue creating its own job, subsequent enqueues that share
a batch key are _folded_ into the pending job's payload. When a worker
eventually claims the job, it sees a single job with a combined payload and
makes a single downstream call.

Once claimed, a batched job is just a normal job — the worker sees one merged
payload and acks once.

## The `batch` field

Batching is enabled per-enqueue by attaching a `batch` field to the enqueue
input. In the Zizq API, `batch` is an object with three fields:

<table>
  <thead>
    <tr>
      <th>Field</th>
      <th>Description</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>key</code></td>
      <td>
        Identifies the batch. Only one unsealed batch exists per key at a time.
      </td>
    </tr>
    <tr>
      <td><code>when</code></td>
      <td>
        A <code>jq</code> predicate that decides whether to fold the incoming
        payload into the existing job. A truthy result means fold/merge instead
        of enqueueing a new job; a falsy result means seal the existing batch
        and enqueue a new job to start a new batch from this enqueue.
      </td>
    </tr>
    <tr>
      <td><code>fold</code></td>
      <td>
        A <code>jq</code> expression that produces the merged payload. Both
        expressions run with <code>$existing</code> bound to the current
        pending payload and <code>$new</code> bound to the incoming payload.
      </td>
    </tr>
  </tbody>
</table>

You _can_ construct this object by hand, but for the common case the Node
client ships a `batchConfig()` helper that produces the right shape from a
target path and a limit.

## Configuring batches with `batchConfig()`

Import `batchConfig` and use it in the `batch` field. The simplest form
targets the whole payload, which is appropriate when the payload itself is the
array being accumulated.

> JS:
>
> ```ts
> import { batchConfig } from "@zizq-labs/zizq";
>
> await client.enqueue({
>   type: "audit.events",
>   queue: "audit",
>   payload: [{ actor: "user_1234", action: "login" }],
>   batch: batchConfig(1000),
> });
> ```

The `1000` is the maximum combined length of the accumulated payload before
the batch is sealed and a new one starts.

When the payload is an object with a specific field to accumulate, pass the
`jq` path as the second argument.

> JS:
>
> ```ts
> await client.enqueue({
>   type: "push.notifications",
>   queue: "push",
>   payload: {
>     deviceIds: ["abc123"],
>     platform: "apple",
>   },
>   batch: batchConfig(100, ".deviceIds"),
> });
> ```

Path syntax is jq-compatible: `.`, `.foo`, `.foo.bar`, `.foo[0]`, `.[0]`, and
`.["key.with.dots"]` for keys that themselves contain literal dots. Invalid
paths throw at `batchConfig()` construction time.

### Options

The third argument accepts an options object:

<table>
    <thead>
        <tr>
            <th>Option</th>
            <th>Description</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td><code>dedup</code></td>
            <td>
                Append <code>| unique</code> to the fold expression so
                duplicate entries within the batch collapse. Note: <code>unique</code>
                in jq sorts as a side effect, so this subsumes
                <code>sorted</code> when both are set.
            </td>
        </tr>
        <tr>
            <td><code>sorted</code></td>
            <td>
                Append <code>| sort</code> to the fold expression so entries
                are sorted within the batch. Ignored when <code>dedup</code>
                is also set.
            </td>
        </tr>
    </tbody>
</table>

> JS:
>
> ```ts
> batch: batchConfig(100, ".deviceIds", { dedup: true })
> ```

### Batch semantics

For a job with `batchConfig(100, ".deviceIds")`, the client emits:

* `when` = `(($existing | .deviceIds) + ($new | .deviceIds)) | length <= 100`
* `fold` = `$existing | .deviceIds += ($new | .deviceIds)`

The `when` predicate returns true when the combined length would still fit
within the limit — in which case the new payload is folded in. When it returns
false, the existing batch is _sealed_ (no more folds against it) and a fresh
pending job is created with just the new payload.

This is _all-or-nothing_: an incoming payload of 20 elements against an
existing batch of 90 does not partially fill the batch to 100 and overflow the
remaining 10 into a new one — it seals the existing batch at 90 and starts a
new one with all 20. Applications that need strict per-batch caps should size
their enqueues to avoid overshoot.

## Batch keys

Enqueues that share a batch key fold into the same pending job. `batchConfig()`
generates the key with `payloadHasher({ except: [path] })` under the hood —
every field in the payload _except_ the batch target contributes to the hash,
prefixed with the job type.

The upshot: two enqueues with the same non-batch fields produce the same batch
key and fold together; enqueues that differ in any non-batch field end up in
separate batches.

> JS:
>
> ```ts
> // These two enqueues fold together (same platform, different deviceIds).
> await client.enqueue({
>   type: "push.notifications",
>   queue: "push",
>   payload: { deviceIds: ["abc"], platform: "apple" },
>   batch: batchConfig(100, ".deviceIds"),
> });
> await client.enqueue({
>   type: "push.notifications",
>   queue: "push",
>   payload: { deviceIds: ["def", "ghi"], platform: "apple" },
>   batch: batchConfig(100, ".deviceIds"),
> });
>
> // This enqueue starts a separate batch (different platform).
> await client.enqueue({
>   type: "push.notifications",
>   queue: "push",
>   payload: { deviceIds: ["jkl"], platform: "android" },
>   batch: batchConfig(100, ".deviceIds"),
> });
> ```

### Inspecting the generated key

`batch.key` is a function of the enqueue input. You can call it directly to
see what the client would send:

> JS:
>
> ```ts
> const cfg = batchConfig(100, ".deviceIds");
> cfg.key({
>   type: "push.notifications",
>   queue: "push",
>   payload: { deviceIds: ["abc"], platform: "apple" },
> });
> // "push.notifications:8f0c...b3"
> ```

## Customizing the batch key

The default key from `batchConfig()` fits the common case where "batch by the
non-target fields of this payload" is exactly what you want. Sometimes you
need something different — batch by a specific field only, batch across
otherwise-different payloads, or apply a bucketing scheme.

### Overriding via spread

The most common pattern: spread `batchConfig()` and replace `key` with your
own derivation. `key` accepts either a literal string or a function that
receives the entire enqueue input.

Batch by tenant regardless of the other payload fields:

> JS:
>
> ```ts
> await client.enqueue({
>   type: "push.notifications",
>   queue: "push",
>   payload: { deviceIds: ["abc"], platform: "apple", tenantId: 42 },
>   batch: {
>     ...batchConfig(100, ".deviceIds"),
>     key: (input) => `push:tenant-${input.payload.tenantId}`,
>   },
> });
> ```

Since `input` is the whole enqueue input, you can reach anything on the input
— `input.type`, `input.queue`, `input.payload`, custom options. Return
whatever string uniquely identifies the batch you want.

### Combining with `payloadHasher()`

For finer control while keeping the stability guarantees of the default hash,
compose `payloadHasher()` with a hand-rolled prefix or suffix. This example
buckets enqueues into 5-minute windows so long-running batches don't stay
open indefinitely:

> JS:
>
> ```ts
> import { batchConfig, payloadHasher } from "@zizq-labs/zizq";
>
> const baseHash = payloadHasher({ except: [".deviceIds"] });
>
> await client.enqueue({
>   type: "push.notifications",
>   queue: "push",
>   payload: { deviceIds: ["abc"], platform: "apple" },
>   batch: {
>     ...batchConfig(100, ".deviceIds"),
>     key: (input) => {
>       const bucket = Math.floor(Date.now() / 300000);
>       return `${baseHash(input)}:${bucket}`;
>     },
>   },
> });
> ```

Enqueues within the same 5-minute window fold together; the next window
starts a fresh batch even if the batch would otherwise still have room.

### Fully custom `batch`

Nothing about `batchConfig()` is magic or required. The `batch` field is a
plain object, and you can construct it end-to-end when required. Both
`when` and `fold` are `jq` expressions; both run with `$existing` bound to the
current job's payload and `$new` bound to the incoming payload.

Here's an audit-log example that batches events by tenant, caps at 50 events
per batch, and includes a "did we already see this event id?" dedup step
within the fold that goes beyond what `dedup: true` would do:

> JS:
>
> ```ts
> await client.enqueue({
>   type: "audit.events",
>   queue: "audit",
>   payload: {
>     tenantId: "acme",
>     events: [{ id: "evt_1", actor: "u1", action: "login" }],
>   },
>   batch: {
>     key: (input) => `audit:${input.payload.tenantId}`,
>     when: "($existing.events + $new.events | length) <= 50",
>     fold: `
>       $existing
>       | .events = (
>           .events
>           + ($new.events | map(select(. as $n | ($existing.events | any(.id == $n.id)) | not)))
>         )
>     `,
>   },
> });
> ```

Bring your own jq — the server evaluates it against the payloads.

## The returned `Job`

`client.enqueue()` returns a `Job` instance whose `folded` flag tells you
whether this enqueue was folded into an existing pending job or created a new
one.

> JS:
>
> ```ts
> // First enqueue creates the batch.
> const first = await client.enqueue({
>   type: "push.notifications",
>   queue: "push",
>   payload: { deviceIds: ["abc"], platform: "apple" },
>   batch: batchConfig(100, ".deviceIds"),
> });
> first.folded // false
>
> // Second enqueue with the same non-batch fields folds into the existing job.
> const second = await client.enqueue({
>   type: "push.notifications",
>   queue: "push",
>   payload: { deviceIds: ["def"], platform: "apple" },
>   batch: batchConfig(100, ".deviceIds"),
> });
> second.folded // true
> second.id === first.id // true — same job
> ```

The same is true for
[`client.enqueueBulk()`](./enqueuing-jobs.md#bulk-job-enqueueing) — items
within the same bulk call that share a batch key fold together.

## Inspecting a batched job

The stored `when` / `fold` / `key` on the pending job are readable through the
normal job-read APIs. Because the [first enqueue's config wins for the life
of the batch](#first-enqueue-config-wins), this is the source of truth for
what the server is actually evaluating on subsequent folds — useful when a
fold isn't behaving as expected.

> JS:
>
> ```ts
> const job = await client.getJob(first.id);
> job.batch
> // {
> //   key: "push.notifications:8f0c...b3",
> //   when: "(($existing | .deviceIds) + ($new | .deviceIds)) | length <= 100",
> //   fold: "$existing | .deviceIds += ($new | .deviceIds)",
> // }
> ```

## First-enqueue config wins {#first-enqueue-config-wins}

The `when` and `fold` expressions stored on the first pending job are used
for every subsequent fold against it. Follow-up enqueues that would produce
different expressions (perhaps because you changed the batch config in code
and redeployed) don't take effect until the current batch is sealed and a
new one starts.

If you need new expressions to take immediate effect, changing the batch key
— for example by version-suffixing it — forces a fresh batch.

## Incompatibility with `uniqueKey`

`uniqueKey` and `batch` are mutually exclusive on the same enqueue. The
server rejects the combination with `400 Bad Request`. If your job needs both
uniqueness and batching semantics, model them separately (e.g. use `uniqueKey`
on a "schedule" job that then enqueues a batched "process" job).

## Interaction with scheduling

Scheduled batched enqueues (`readyAt` in the future) opt out of the fold
path entirely. They persist as normal scheduled jobs with a `batch` config
stored on them for observability, but no fold happens across a `readyAt`
boundary in either direction. Folding is strictly `ready` -> `ready`.

Rationale: fold preserves the existing job's `readyAt` and discards the
incoming job’s `readyAt` — either promoting a scheduled job to immediate or
delaying an immediate one into the future, both surprising. Disallowing the
crossing is easier to explain than either.

For "delay some work then batch it" workflows, schedule a job that _enqueues_
the batched job at fire time.

## Enqueue-time validation

Both `when` and `fold` are compiled and dry-run against the incoming
payload on every batched enqueue. Bad expressions (syntax errors, undefined
variables, or shape errors that only manifest against actual data) surface
as `422 Unprocessable Entity` up front rather than at first fold.

The dry-run catches common mistakes but can't detect logic errors that only
appear on data your first enqueue didn't include, so test your expressions
in development with realistic payloads.
