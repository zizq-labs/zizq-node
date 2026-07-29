# Enqueuing Jobs

The Zizq Node client exposes two enqueue methods:

- `client.enqueue(input)` — enqueue a single job.
- `client.enqueueBulk(inputs)` — enqueue many jobs in a single HTTP request.

> JS:
>
> ```ts
> await client.enqueue({
>   type: "send_email",
>   queue: "emails",
>   payload: { userId: 42, template: "welcome" },
> });
> 
> await client.enqueueBulk([
>   { type: "send_email", queue: "emails", payload: { userId: 1 } },
>   { type: "send_email", queue: "emails", payload: { userId: 2 } },
> ]);
> ```

Both accept enqueue inputs in the same shape.

## Single enqueue

When enqueueing a single job, the `enqueue()` method returns the `Job`
from the Zizq server, which provides all its metadata, such as `id`, `status`,
`readyAt` etc. Note that `payload` is *not* part of the response.

> JS:
>
> ```ts
> const result = await client.enqueue({
>   type: "send_email",
>   queue: "emails",
>   payload: { userId: 42, template: "welcome" },
> });
> result.id // "03fu0wm75gxgmfyfplwvazhex"
> ```

## Bulk enqueue

Bulk enqueue works exactly the same as a single job enqueue, except that an
array of inputs are provided, and an array of `Job` instances is returned in
the order matching the inputs.

> JS:
>
> ```ts
> const results = await client.enqueueBulk([
>   { type: "send_email", queue: "emails", payload: { userId: 1 } },
>   { type: "send_email", queue: "emails", payload: { userId: 2 } },
> ]);
> results.length // 2
> ```

## Enqueue options

The following options are available on the inputs to `client.enqueue()` and
`client.enqueueBulk()`. All of `type`, `queue` and `payload` are _required_
inputs.

> [!TIP]
> For more details on the `jq` query language, read the language specification
> on the [jaq website](https://gedenkt.at/jaq/manual/#corelang) or on
> [jq](https://jqlang.org/manual/#basic-filters).

<table>
    <thead>
        <tr>
            <th>Option</th>
            <th>Description</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td>
                <div><code>type</code></div>
                <div><pre>string</pre></div>
            </td>
            <td>
                The type that identifies this job.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>queue</code></div>
                <div><pre>string</pre></div>
            </td>
            <td>The name of the queue onto which this job is enqueued.</td>
        </tr>
        <tr>
            <td>
                <div><code>payload</code></div>
                <div><pre>object</pre></div>
            </td>
            <td>
                Any valid JSON-serializable type understood by the handler that
                will run this job.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>priority</code></div>
                <div><pre>number?</pre></div>
            </td>
            <td>
                Optional priority value between <code>0</code> and
                <code>65536</code>. When not specified, the default priority
                from the server applies.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>readyAt</code></div>
                <div><pre>number?</pre></div>
            </td>
            <td>
                Optional milliseconds since the Unix epoch at which this job
                becomes ready for processing. When set at a future time, the
                job is enqueued with the <code>scheduled</code> status.
                Otherwise the job is <code>ready</code> immediately.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>retryLimit</code></div>
                <div><pre>number?</pre></div>
            </td>
            <td>
                Optional retry limit override, which defines the number of
                retries that can occur before the Zizq server marks the job
                <code>dead</code> and stops retrying. When not specified, the
                server's default retry limit applies.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>backoff</code></div>
                <div><pre>BackoffConfig?</pre></div>
            </td>
            <td>
                Optional backoff policy specific to this job. When not
                specified the server's default backoff policy applies. When
                specified, all fields must be present as they form a single
                backoff curve formula.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>backoff.baseMs</code></div>
                <div><pre>number</pre></div>
            </td>
            <td>
                Number of milliseconds used at the mimimum delay in all
                exponential backoff calculations.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>backoff.exponent</code></div>
                <div><pre>number</pre></div>
            </td>
            <td>
                The power curve steepness of the exponential backoff formula.
                The number of job attempts is raised to this power and added
                onto the <code>baseMs</code>. Floating point values are
                acceptable.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>backoff.jitterMs</code></div>
                <div><pre>number</pre></div>
            </td>
            <td>
                A random jitter delay used to avoid cascades of failures all
                retrying at the same time. A random number between
                <code>0</code> and <code>jitterMs</code> is picked, then
                multiplied by the number of job attempts. The result is then
                added onto the total delay which creates a natural spread.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>retention</code></div>
                <div><pre>RetentionConfig?</pre></div>
            </td>
            <td>
                Optional retention policy specific to this job. When not
                specified the server's default retention policy applies.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>retention.deadMs</code></div>
                <div><pre>number?</pre></div>
            </td>
            <td>
                Number of milliseconds for which this job should be retained
                after entering the <code>dead</code> status. When not specified
                the server's default applies.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>retention.completedMs</code></div>
                <div><pre>number?</pre></div>
            </td>
            <td>
                Number of milliseconds for which this job should be retained
                after entering the <code>completed</code> status. When not
                specified the server's default applies.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>uniqueKey</code></div>
                <div><pre>(string | (EnqueueInput) => string)?</pre></div>
            </td>
            <td>
                Optional unique key used to handle enqueue-time de-duplication
                of jobs. Can be a function receiving the full enqueue input
                object and returning a string. Generally applications will use
                <code>payloadHasher()</code> to produce a configurable hash
                function here. A job that is unique across all of its payload
                uses simply <code>{ uniqueKey: payloadHasher() }</code>.
                <em>requires a pro license on the server</em>.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>uniqueWhile</code></div>
                <div><pre>("queued" | "active" | "exists")?</pre></div>
            </td>
            <td>
                Optional unique scope for which uniqueness is enforced on this
                job after it is enqueued. One of:
                <ul>
                    <li>
                        <code>queued</code> — duplicates will be prevented
                        while this job is in the <code>scheduled</code> or
                        <code>ready</code> states.
                    </li>
                    <li>
                        <code>active</code> — duplicates will be prevented
                        while this job is in the <code>scheduled</code>,
                        <code>ready</code> or <code>in_flight</code> states.
                    </li>
                    <li>
                        <code>exists</code> — duplicates will be prevented
                        for as long as this job is present on the server.
                    </li>
                </ul>
            </td>
        </tr>
        <tr>
            <td>
                <div><code>batch</code></div>
                <div><pre>BatchConfig?</pre></div>
            </td>
            <td>
                Optional batched jobs configuration for this job. Batched jobs
                allow multiple jobs to be folded/coalesced together into a
                larger batch job. Generally applications will use the
                <code>batchConfig()</code> helper rather than construct this
                object manually. For example, a job that holds an array in its
                <code>items</code> key could be configured to accumulate
                batches of up to 1000 items using
                <code>{ batch: batchConfig(1000, '.items') }</code>.
                <em>requires a pro license on the server</em>.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>batch.key</code></div>
                <div><pre>string | (EnqueueInput) => string</pre></div>
            </td>
            <td>
                Shared batch key used to identify jobs that can be folded
                together. Can be a function receiving the full enqueue input
                object and returning a string. Generally applications will use
                <code>payloadHasher()</code> to produce a configurable hash
                function here.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>batch.when</code></div>
                <div><pre>string</pre></div>
            </td>
            <td>
                A <code>jq</code> expression evaluated whenever a subsequent
                enqueue occurs using the same <code>batch.key</code>. This acts
                as a predicate returning a boolean-ish result indicating
                whether the new job can be folded into the existing job, or a
                new job should be enqueued, starting a new batch and sealing
                the existing batch. The expression has two implicitly bound
                variables <code>$existing</code> and <code>$new</code>. These
                are bound to the existing job's payload, and the incoming job's
                payload. The typical use case is to return true if the combined
                payload length is below a desired threshold. If the expression
                returns a truthy value, Zizq evaluates the
                <code>batch.fold</code> expression to derive the folded
                payload. For example, a job that holds an array in its
                <code>items</code> key could be configured to accumulate up to
                1000 items before being sealed and starting a new batch by
                using the expression
                <code>($existing.items + $new.items) | length &lt;= 1000</code>.
                As a defensive measure against writing an invalid
                <code>jq</code> expression, this expression is validated by
                binding both <code>$existing</code> and <code>$new</code> to
                the incoming payload before the job is enqueued.
            </td>
        </tr>
        <tr>
            <td>
                <div><code>batch.fold</code></div>
                <div><pre>string</pre></div>
            </td>
            <td>
                A <code>jq</code> expression evaluated whenever a subsequent
                enqueue occurs using the same <code>batch.key</code> and
                <code>batch.when</code> evaluates to a truthy value. This acts
                as a reducer expression combining the existing job's payload
                with the new payload. The expression has two implicitly bound
                variables <code>$existing</code> and <code>$new</code>. These
                are bound to the existing job's payload, and the incoming job's
                payload. The typical use case is to concatenate two arrays
                together, either for the entire payload, or at a sub-path of
                the payload, though any reasonably complex logic may be applied
                here. For example, a job that holds an array in its
                <code>items</code> key could be configured to fold new items
                into itself using the expression
                <code>$existing | .items + $new.items</code>. As a defensive
                measure against writing an invalid <code>jq</code> expression,
                this expression is validated by binding both
                <code>$existing</code> and <code>$new</code> to the incoming
                payload before the job is enqueued.
            </td>
        </tr>
    </tbody>
</table>

## Dynamic Job Configuration

The inputs to enqueue jobs are plain JavaScript objects. Applications can
implement helper functions to provide enqueue inputs for jobs dynamically. For
example changing the priority based on the time of day, or based on details in
the job payload.

> JS:
> ```ts
> import type { EnqueueInput } from "@zizq-labs/zizq";
> 
> export type SendEmailPayload = {
>   to: string;
>   subject: string;
> };
> 
> export function sendEmailJob(payload: SendEmailPayload): EnqueueInput {
>   return {
>     type: "send_email",
>     queue: "emails",
>     priority: payload.to.endsWith("@important.com") ? 10 : 100,
>     payload,
>   };
> }
> ```

Just wrap the payload with the job of the appropriate type.

> JS:
> ```ts
> import { Client } from "@zizq-labs/zizq";
> import { sendEmailJob } from "./jobs";
> 
> const client = new Client({ url: "http://localhost:7890" });
> 
> await client.enqueue(sendEmailJob({
>   to: "example@important.com",
>   subject: "Important email",
> }));
> ```
