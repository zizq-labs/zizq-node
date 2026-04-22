# Enqueuing Jobs

The Zizq Node client exposes two top-level enqueue functions:

- `enqueue(client, input)` — enqueue a single job.
- `enqueueBulk(client, inputs)` — enqueue many jobs in a single HTTP request.

> [!NOTE]
> Both [Job Functions](./handlers.md#job-functions) and raw job inputs use the
> same enqueue functions. The only difference is that Job Functions can be
> passed directly as the `type`, and any `zizqOptions` are automatically used
> as default options when enqueueing that job type.

```ts
import { enqueue, enqueueBulk } from "@zizq-labs/zizq";

await enqueue(client, {
  type: "send_email",
  queue: "emails",
  payload: { userId: 42, template: "welcome" },
});

await enqueueBulk(client, [
  { type: "send_email", queue: "emails", payload: { userId: 1 } },
  { type: "send_email", queue: "emails", payload: { userId: 2 } },
]);

await enqueue(client, {
  type: sendEmail,
  payload: { userId: 42, template: "welcome" },
});
```

Both accept either a string job `type` or a function reference with attached
`zizqOptions`, which lets the function itself carry its default `queue`,
`priority`, `backoff`, etc.

## Single enqueue

When enqueueing a single job, the `enqueue()` function returns the `Job`
from the Zizq server, which provides all its metadata, such as `id`, `status`,
`readyAt` etc. Note that `payload` is *not* part of the response.

```ts
const result = await enqueue(client, {
  type: "send_email",
  queue: "emails",
  payload: { userId: 42, template: "welcome" },
});
result.id // "03fu0wm75gxgmfyfplwvazhex"
```

## Bulk enqueue

Bulk enqueue works exactly the same as a single job enqueue, except that an
array of inputs are provided, and an array of `Job` instances is returned in
the order matching the inputs.

```ts
const results = await enqueueBulk(client, [
  { type: "send_email", queue: "emails", payload: { userId: 1 } },
  { type: "send_email", queue: "emails", payload: { userId: 2 } },
]);
results.length // 2
```

## Enqueue options

The following options are available on the inputs to `enqueue()` and
`enqueueBulk()`. All of `type`, `queue` and `payload` are _required_ inputs,
though [Job Functions](./handlers.md#job-functions) may specify their queue in
`zizqOptions` meaning it is implicitly provided to `enqueue()` and
`enqueueBulk()`.

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
                <div><pre>string | JobFunction</pre></div>
            </td>
            <td>
                The type that identifies this job. Either a string, or a
                named JavaScript function, with optional attached
                <code>zizqOptions</code>.
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
                <div><pre>string?</pre></div>
            </td>
            <td>
                Optional unique key used to handle enqueue-time de-duplication
                of jobs. <em>Requires a Pro license on the server</em>.
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
    </tbody>
</table>
