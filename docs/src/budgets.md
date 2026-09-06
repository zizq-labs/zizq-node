# Concurrency & Rate Limiting

> [!NOTE]
> This feature requires a Zizq [pro license](https://zizq.io/pricing) on the
> server.

Applications enqueue jobs to move expensive work off the request path, but some
of that work may put pressure on systems that cannot absorb it. An image
service may cap you at 10,000 requests an hour. A surge of push notifications
may dominate the queue and starve everything else of workers. Both are solved
by a feature Zizq calls **budgets**.

A budget is a named pool of _tokens_ managed under a _strategy_. Jobs bind to
one or more budgets, each with a _cost_ that defaults to `1`, and a job must
debit that cost from every budget it is bound to before it can be dispatched.

Crucially this happens on the server, before a worker ever sees the job.
Workers stay naive: they receive jobs and run them, with no waiting, no
sleeping, and no re-queueing something that arrived too early. A job at the
front of the queue that cannot yet debit its cost is _parked_ — it stays in the
queue and is dispatched the moment its budgets allow. Everything else keeps
flowing past it.

> ```ts
> // At most 3 of these run at once. Typically done once at startup.
> await client.defineBudget({
>   key: "stripe",
>   allocation: 3,
>   strategy: { type: "while_in_flight" },
> });
>
> await client.enqueue({
>   type: "charge_card",
>   queue: "billing",
>   payload: { invoiceId },
>   budgets: [{ key: "stripe" }],
> });
> ```

That is the whole integration. The handler that eventually runs the job knows
nothing about the limit.

> [!NOTE]
> Budgets are a shared resource, and the server caps how many distinct ones can
> exist — `8192` by default, configurable with `--max-budgets`
> (`$ZIZQ_MAX_BUDGETS`) when launching `zizq serve`. That is far more than most
> applications need. A future release will add sub-buckets for dynamically
> allocated scenarios.

## Strategies

Two strategies exist. Both take an `allocation`, the number of tokens in the
pool. A job may bind to several budgets freely mixing both, in which case _all_
of them must be satisfied before it is dispatched.

`BudgetStrategy` is a discriminated union, so TypeScript rejects a combination
the server would refuse:

> ```ts
> // Error: Object literal may only specify known properties
> const bad: BudgetStrategy = { type: "while_in_flight", durationMs: 60_000 };
> ```

### `while_in_flight`

Pure concurrency control: at most `N` of these jobs run at once.

> ```ts
> await client.defineBudget({
>   key: "image-service",
>   allocation: 20,
>   strategy: { type: "while_in_flight" },
> });
> ```

Tokens are debited when the job is dispatched and released when it stops
running — on success or on failure. There is no clock involved. With an
allocation of `20` you get 20 concurrent jobs at the default cost, or 10 at a
cost of `2`, or any mix that fits:

- `20 × cost=1`
- `10 × cost=2`
- `(5 × cost=2) + (10 × cost=1)`
- `(3 × cost=5) + (2 × cost=2)`

### `time_based`

A rate limit: at most `N` jobs _dispatched_ over a period, set by
`durationMs`.

> ```ts
> await client.defineBudget({
>   key: "image-service",
>   allocation: 10_000,
>   strategy: { type: "time_based", durationMs: 60 * 60 * 1000 },
> });
> ```

Unlike `while_in_flight`, tokens are _not_ returned when a job finishes. They
return on the cadence the duration sets. So a `time_based` budget governs how
often work **starts**, and says nothing about how much runs at once — jobs
slower than the duration will overlap, by design.

The server implements this lazily. It does not scan for work that has become
affordable; it knows when the next token is due and sleeps until then, or until
something else wakes it.

#### Implementation note

`time_based` is a _continuous_ (drip) rate limiter — a
[leaky bucket](https://en.wikipedia.org/wiki/Leaky_bucket) — rather than one
that buckets tokens into fixed windows. With 100 tokens over 5 minutes and an
empty pool, you have 20 tokens after a minute, 80 after four, and all 100 after
five. Work spreads out evenly instead of arriving in a spike at each window
boundary and then stalling until the next one.

A full pool is a different matter. 100 tokens available means 100 jobs can go
at once, after which the pace settles to roughly one every three seconds. This
is usually desirable — it absorbs short-lived spikes — but not always, so this
strategy also provides the `burst` field.

### `burst`

`burst` caps how full the pool may get at any moment.

> ```ts
> await client.defineBudget({
>   key: "image-service",
>   allocation: 10_000,
>   strategy: { type: "time_based", durationMs: 60 * 60 * 1000, burst: 500 },
> });
> ```

At most 500 jobs go at once, then 10,000/hour at a steady pace. A `burst` of
`1` removes the spike entirely and paces dispatches evenly at all times.

A burst _above_ the allocation is meaningful too: `20_000` on a 10,000/hour
budget permits a deliberate spike beyond the rate limit, but only if the budget
went unused long enough to accrue it.

The opening burst only happens when the pool is genuinely full — either nothing
has been dispatched for a whole duration, or the budget is newly created (or
the server was restarted).

> [!NOTE]
> Every job's cost must fit inside the budget's capacity — the burst where one
> is set, and the allocation otherwise — or the job could never be dispatched.
> The server refuses to accept a binding that cannot fit, and refuses a change
> to a budget that would strand a job already bound to it. With a `burst` set
> it is the _smaller_ number that decides, so a cost well within the allocation
> may still be refused.

## Binding jobs to budgets

Bindings are attached per enqueue, via the `budgets` field:

> ```ts
> await client.enqueue({
>   type: "send_email",
>   queue: "emails",
>   payload: { to: "user@example.com" },
>   budgets: [{ key: "emails", cost: 2 }],
> });
> ```

With no budgets a job is unthrottled and dispatches as soon as it reaches the
front of the queue. With several, it must satisfy all of them. A job bound to a
`while_in_flight` limit of 10 and a `time_based` limit of 1000/hour honours
both: never more than 10 at once, never more than 1000 an hour.

Use `cost` to make jobs weigh differently against the same pool. A bulk send
costing `10` against an allocation of `100` leaves room for 90 more single
sends.

Since bindings live on the enqueue input, an application that wants a default
per job type can simply spread its own object:

> ```ts
> const emailJob = {
>   queue: "emails",
>   budgets: [{ key: "emails", cost: 2 }],
> };
>
> await client.enqueue({ ...emailJob, type: "send_email", payload });
> await client.enqueue({ ...emailJob, type: "send_receipt", payload });
> ```

### Automatically creating a budget on enqueue

A budget normally exists before anything binds to it. `createWith` lets a
single enqueue operation create both the budget and the job atomically:

> ```ts
> await client.enqueue({
>   type: "send_email",
>   queue: "emails",
>   payload,
>   budgets: [
>     {
>       key: "emails",
>       cost: 2,
>       createWith: {
>         allocation: 100,
>         strategy: { type: "time_based", durationMs: 60_000 },
>       },
>     },
>   ],
> });
> ```

The key comes from the binding, so it is not repeated. If the budget already
exists the policy is **ignored** and the stored one stays authoritative, so an
enqueue cannot accidentally clobber an existing budget.

Cron entries carry budgets the same way, since a cron entry's `job` is an
enqueue input.

## Managing budgets

> ```ts
> await client.listBudgets();
> await client.getBudget("emails");
> await client.defineBudget({ key: "emails", allocation: 100, strategy });
> await client.updateBudget("emails", { strategy: { burst: 5 } });
> await client.deleteBudget("emails");
> ```

`defineBudget()` refuses an existing key with `ConflictError` and leaves the
stored policy alone. That is deliberate: it means every instance of an
application can declare its budgets on boot without coordinating, and the one
that loses the race treats the conflict as success.

> ```ts
> try {
>   await client.defineBudget({ key: "emails", allocation: 100, strategy });
> } catch (err) {
>   if (!(err instanceof ConflictError)) throw err;
> }
> ```

Pass `replace: true` to overwrite instead. A replace changes the policy, not the
budget's identity, so `createdAt` survives it.

`updateBudget()` is a recursive merge patch, so one field within the `strategy`
can be changed without repeating the others. `burst: null` is the one
meaningful `null` — it clears the ceiling back to the allocation. An omitted
field is left unchanged.

## Modifying budget bindings

Bindings are mutable even after jobs are enqueued. This is useful when tuning a
budget or responding to an incident that requires making changes to budgets,
such as splitting one shared budget in two, or removing a budget from a job
that is delayed and needs to run immediately.

> ```ts
> const job = await client.getJob(id);
>
> await job.bindBudget({ key: "emails", cost: 2 });
> await job.rebindBudget({ key: "emails" });
> await job.setBudgetCost("emails", 5);
> await job.unbindBudget("emails");
> await job.unbindAllBudgets();
> await job.replaceBudgets([{ key: "emails", cost: 2 }]);
> ```

Each returns the updated job. `Job` is a value class, so the instance you called
on is unchanged — use the one you get back. `bindBudget()` throws
`ConflictError` if the job already draws on that budget; `rebindBudget()`
replaces the binding whole.

The same operations run over a selection:

> ```ts
> await client.jobs().byQueue("emails").bindBudget({ key: "stripe", cost: 2 });
> ```

> [!IMPORTANT]
> Only queued (`scheduled`, `ready`) jobs can be rebound. An in-flight job has
> already debited its tokens, and jobs in a terminal status are always
> immutable. The bulk forms report the ones they could not change rather than
> skipping them silently:
>
> ```ts
> { changed: 12, blocked: ["01K9...", "01KA..."] }
> ```
>
> `blocked` is always in-flight jobs, so it is essentially a retry list — they
> eventually drain on their own, and the same call afterwards picks them up.

## Finding what is bound to a budget

A budget cannot be deleted while anything remains bound to it. The `budgetsKey`
filter selects exactly what is in the way, and works anywhere jobs are
filtered:

> ```ts
> await client.countJobs({ budgetsKey: "emails" });
>
> await client.jobs().byBudgetsKey("emails").unbindBudget("emails");
> await client.deleteBudget("emails");
> ```

`Job.budgets` reports what a job is bound to.

> ```ts
> (await client.getJob(id)).budgets;
> // [{ key: "emails", cost: 2 }]
> ```
