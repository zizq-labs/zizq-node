# Uptime Monitor (Node example)

Example producer-consumer app that monitors URLs for uptime (including
traversing sitemaps), reports transitions to a webhook, and re-checks
on a cron schedule. Touches most of Zizq's surface area: enqueue, bulk
enqueue, cron, retry/backoff.

* **Express** + `node:sqlite` for web and storage.
* **`Router`** with four string-typed job handlers under
  `src/jobs/`. Enqueues via plain `client.enqueue({type, queue, payload})`.
* **Embedded `Worker`** running inside the web process. `stop()` on
  SIGINT/SIGTERM lets in-flight jobs drain before exit.

## Prerequisites

* Node **22.19 or newer** (for `node:sqlite` and
  `--experimental-strip-types`).
* A running Zizq server on `ZIZQ_URL` (default
  `http://127.0.0.1:7890`).
* A Pro license on the server for the periodic sweep (cron).
  Without one the app still works for manually-triggered checks;
  cron registration logs a warning and continues.

## First-time setup

```sh
npm install
npm run migrate
```

## Running

```sh
npm run dev
```

Boots the web server at `http://127.0.0.1:3000` with the Zizq worker
embedded in the same process. Submit a URL to watch. The row updates
every 2s via a polled partial as the worker probes it.

To run just the worker (e.g. for a multi-process production deploy):

```sh
npm run worker
```

## Job types

| Type                                     | Trigger                         | What it does                                                                        |
| ---------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `uptime_monitor.check_url`               | Form submission, cron sweep     | Probes one URL, records a `Check`, fires webhook / sitemap-discovery on transitions |
| `uptime_monitor.discover_sitemap_urls`   | Probing a sitemap-y response    | Fetches the sitemap, reconciles children, bulk-enqueues immediate checks            |
| `uptime_monitor.notify_webhook`          | Status transition               | POSTs the event as JSON to `WEBHOOK_URL`; retries on 5xx / network errors           |
| `uptime_monitor.schedule_checks`         | Cron (every 5s)                 | Bulk-enqueues `check_url` for every enabled URL with a stale last check             |

## Audit events

The app also enqueues `audit.create` jobs into the `audit` queue for
consumption by the [audit_log example](../audit_log/). Emitted from
`src/lib/audit.ts` at three points:

* `url.added` — a new URL is submitted from the form.
* `url.status.changed` — a probe records a different status than the
  previous check.
* `sitemap.scanned` — a sitemap has been re-fetched and reconciled.

Run both apps side-by-side to see events land in the audit feed as
the uptime monitor works. Override the target queue name with the
`AUDIT_QUEUE` env var; disable by pointing it at a queue nothing
consumes.

## Tests

```sh
npm test
```
