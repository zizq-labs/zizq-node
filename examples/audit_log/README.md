# Audit Log (Node example)

A central audit-log sink. Other systems enqueue `audit.create` jobs
to its queue; this app drains them, stores them, and shows them in
a paginated feed.

Deliberately low-level: the point is to demonstrate the
cross-language / producer-decoupled shape — any service in any
language can drop an event in this queue without sharing code with
the audit app.

* **Express** for the (read-only) web UI.
* **`node:sqlite`** (Node built-in) + a ~40 line migration runner
  for storage. No ORM.
* **`Router`** as the dispatcher — one route, `audit.create`.
* **Standalone worker process** (`npm run worker`) running the
  Zizq client's default N-concurrent handler dispatch. The web
  process never runs jobs. This is the more production-realistic
  shape (web and worker scaled independently).

## Prerequisites

* Node **22.19 or newer** (for `--experimental-strip-types` on `.ts`
  entry points, plus `node:sqlite`).
* A running Zizq server on `ZIZQ_URL` (default
  `http://127.0.0.1:7890`).

## First-time setup

```sh
npm install
npm run migrate
```

## Running

```sh
npm run dev
```

Boots the web server at `http://127.0.0.1:3000` *and* a separate
worker process via `concurrently`.

To run just the worker:

```sh
npm run worker
```

## Emitting an event

The audit app is a *consumer* — it doesn't produce events. The
quickest way to see something on the dashboard is `npm run simulate`,
which enqueues fake-but-plausible events drawn from a small catalog
of source systems (billing, auth, admin console, CRM):

```sh
npm run simulate            # one event
npm run simulate 50         # fifty events
```

To stream events at variable intervals:

```sh
while true; do npm run simulate; sleep $((RANDOM % 3 + 1)); done
```

`bin/simulate.ts` is just a producer that shares no code with the
audit app — it imports `@zizq-labs/zizq` and calls
`client.enqueue({type: "audit.create", queue: "audit", payload: {...}})`.
The same shape works from any language with a Zizq client. For example
Ruby:

```ruby
require "zizq"

Zizq.configure { |c| c.url = "http://127.0.0.1:7890" }
Zizq.enqueue_raw(
  type:  "audit.create",
  queue: "audit",
  payload: {
    "occurred_at" => Time.now.utc.iso8601,
    "source"      => "billing_api",
    "event_type"  => "invoice.refunded",
    "text"        => "Refunded $24.00",
    "data"        => { "amount_cents" => 2400 }
  }
)
```

The audit app's `Router` matches on `"audit.create"`, calls
`save(db, fromPayload(...))`, and the row appears in the feed at `/`.

## Tests

```sh
npm test
```
