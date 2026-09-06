# Changelog

## 0.7.0

- **Budgets** (Pro) — server-side concurrency control and rate limiting.
  A budget is a named token bucket that jobs draw from, and a job that
  cannot afford its cost waits rather than dispatching. Two strategies
  are defined for managing tokens owned by a budget:
  * `while_in_flight` — concurrency control, managing the number of jobs
    that can be running at any given time
  * `time_based` — continuous drip rate limiting, managing the number of
    jobs that can be dispatched over a given period of time

  See https://zizq.io/docs/clients/node/budgets.html for full details.

- **`ConflictError`** — a `409` now arrives as this rather than a plain
  `ClientError`. It is thrown where something already exists (a budget
  key, a cron entry name, a budget binding a job already has) and where
  something is still referenced (a budget a job or cron entry still
  draws on).

  It extends `ClientError`, so an existing `instanceof ClientError`
  check keeps working. Catching it on its own is what declare-on-boot
  code wants, so that "another instance got there first" reads as
  success:

      try {
        await client.defineBudget({ key: "emails", allocation: 100, strategy });
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
      }

- **Schedule-level cron timezones are now stored on the server.** The
  `timezone` passed to `cron(name).register()` is sent as the group's
  own timezone instead of being copied onto every entry as it was
  before. The server applies it to each entry that does not specify one
  of its own, so what actually runs is unchanged — but the timezone now
  survives a read of the schedule:

      await client.cron("my-cron").register({
        timezone: "Europe/London",
        entries: [
          { name: "digest", expression: "0 9 * * *", type: sendDigest, payload: {} },
        ],
      });

      (await client.cron("my-cron").get()).timezone; // "Europe/London"

  An entry with its own `timezone` still overrides the group's.
  `CronGroup.timezone` is new, as is `timezone` on
  `ReplaceCronGroupOptions` for the low-level `replaceCronGroup()`.

  This requires **Zizq 0.7.0 or newer** on the server, which a 0.7.0
  client already does. Note that registering a schedule from a 0.7.0
  client over one written by an older client clears the per-entry
  timezone copies the older client wrote — the effective timezone is
  unchanged, but an *older* client reading that schedule back will no
  longer see a timezone anywhere, since it does not know about the
  group-level field.

## 0.6.1

- **`TestClient`** — new drop-in subclass of `Client` for tests.
  Buffers `enqueue` / `enqueueBulk` / `enqueueRaw` / `enqueueBulkRaw`
  calls in memory instead of hitting the server. Read/mutation/
  streaming methods raise `NotSupportedError`. Construct with no
  args:

      import { TestClient } from "@zizq-labs/zizq";
      const client = new TestClient();
      await someService.run(client);
      assert.ok(client.enqueued("send_email"));

  Status-filtered accessors (`enqueuedJobs`, `pendingJobs`,
  `inFlightJobs`, `completedJobs`, `deadJobs`) and predicates
  (`enqueued(type, payload?)`, `enqueuedCount(type, payload?)`)
  return the buffer contents. `enqueuedOptions()` surfaces the
  resolved `EnqueueOptions` for tests that need metadata like
  `uniqueKey` or `readyAt`. `clear()` resets between test cases.

- **`TestClient.dispatch(handler, options?)`** — drain runnable
  buffered jobs through a `JobHandler` (typically a `Router.build()`
  result). Defaults to a single-snapshot pass: entries enqueued from
  within a handler stay buffered for the next call. `recursive: true`
  loops until nothing matches, with `maxIterations` (default `1000`)
  guarding against unconditional re-enqueue. Handler exceptions move
  the entry to `dead` and re-throw.

- **`TestJobFilters`** — the shared filter shape used by every buffer
  accessor and `dispatch`. Fields: `onlyQueues`, `exceptQueues`,
  `onlyTypes`, `exceptTypes`, `filter` (a predicate over `Job`). All
  ANDed. `TestDispatchOptions extends TestJobFilters` adds
  `recursive` and `maxIterations`.

- **`NotSupportedError`** — thrown when test code reaches a method
  that isn't buffered (server reads, streaming, cron, etc.). Includes
  the method name in the message so failures point at the caller.

- **`Client` extraction hook** — the request/stream dispatcher setup
  moved from the constructor into a `protected buildDispatchers()`
  method so `TestClient` can supply its own transport without
  duplicating the pool construction logic. No behaviour change for
  direct `Client` users.

- **`"development"` export condition** — `package.json` `exports`
  now includes a `development` condition pointing at `./src/index.ts`
  (in addition to the existing `import` → `./dist/index.js` and
  `types` conditions). Non-breaking: only fires when the consumer
  passes `--conditions=development` at runtime. Enables in-repo
  examples to resolve the client from source without a prior `dist/`
  build.

- **Examples** — new `examples/audit_log/` (consumer sink;
  Express + `node:sqlite` + `Router` with a standalone worker) and
  `examples/uptime_monitor/` (producer + consumer; embedded worker,
  cron sweep, sitemap discovery, `TestClient` in the suite). Each is
  self-contained with its own `package.json`, tests, and README.
  Covered by a new `examples` matrix job in CI.


## 0.6.0

- **Batched jobs** (Pro) — new `batch` field on the enqueue input for
  server-side folding of successive enqueues into a single pending
  job. The wire shape is `{key: string, when: string, fold: string}`
  (jq predicate + jq reducer running with `$existing` and `$new`
  bound to the current pending payload and the incoming payload
  respectively). `batch.key` on the client accepts either a string or
  a function `(input: EnqueueInput) => string`, resolved at enqueue
  time so callers can derive keys dynamically from the payload.

- **`batchConfig(limit, path?, opts?)`** — ergonomic helper returning
  the `{key, when, fold}` shape with all three fields pre-filled from
  a target jq path + limit. `path` defaults to `.` (whole payload is
  the batch target, assumed to be an array). `opts.dedup: true`
  appends `| unique`, `opts.sorted: true` appends `| sort`.
  `batch.key` becomes `payloadHasher({except: [path]})` — same
  non-batch args produce the same key so those enqueues fold
  together. Spread + override to substitute a custom key:

      await client.enqueue({
        type: "push",
        queue: "push",
        payload: { deviceIds: [id], platform: "apple" },
        batch: batchConfig(100, ".deviceIds"),
      });

  Path syntax is jq-compatible: `.`, `.foo`, `.foo.bar`, `.foo[0]`,
  `.[0]`, `.["dotted.key"]`. Invalid paths throw at construction time.

- **`payloadHasher(opts?)`** — first-class payload hasher, returns
  `(input: EnqueueInput) => string`. `only` and `except` accept a jq
  path or an array of them (single string is canonicalized).
  Missing paths are silently skipped; `only` reconstructs the picked
  subset preserving original nesting so the hash matches what a
  natively-smaller payload would produce. Prefix defaults to
  `${type}:${digest}`; `prefix: false` returns bare hex. Assignable
  directly to `uniqueKey` on `client.enqueue({...})` inputs:

      uniqueKey: payloadHasher({ only: [".userId", ".template"] })

- **`Client.enqueue({uniqueKey: fn})`** — `EnqueueInput.uniqueKey`
  now accepts a function `(input: EnqueueInput) => string` in
  addition to the existing string literal. Resolved client-side at
  enqueue time. The pre-existing `(fn, payload) => string` shape used
  by `zizqOptions.uniqueKey` on job functions continues to work
  unchanged.

- **`Job.folded`** and **`Job.batch`** on returned resources —
  `folded: true` on enqueue responses indicates the request was
  merged into an existing pending job; `batch` exposes the stored
  `{key, when, fold}` config on any job read so debugging "why isn't
  my batch behaving as I expect?" is a straightforward inspection.

- **Internal cleanup** — `uniqueKey(...fields)` now delegates to
  `payloadHasher({only: fields.map(f => '.' + f)})` behind a
  `(fn, payload)` shim, producing byte-identical hashes to the
  previous implementation. `hashInto` moved from `unique-key.ts` into
  `payload-hasher.ts` (private) so the two modules form a one-way
  dependency instead of a cycle.

- **Deprecated: job functions** (`fn.zizqOptions` + `buildHandler`).
  The direct-shape API (`client.enqueue({type: '...', ...})`,
  `payloadHasher`, `batchConfig`, `Router`) covers everything job
  functions did without the mixin. Job functions continue to work in
  0.6.x but emit a Node deprecation warning
  (`ZIZQ_JOB_FUNCTIONS_DEPRECATED`) — once per process for
  `buildHandler`, once per unique function for
  `client.enqueue({type: fn, ...})`. Filterable via
  `NODE_OPTIONS='--no-warnings-code=ZIZQ_JOB_FUNCTIONS_DEPRECATED'`
  if migration is deferred. Removal planned for v1.0.

- Requires Zizq server **0.6.0** or later.

## 0.5.0

- Added three new range filters on `Client.listJobs`,
  `Client.countJobs`, `Client.deleteAllJobs`, and
  `Client.updateAllJobs`: `priority`, `readyAt`, and `attempts`. Each
  field accepts either a bare `number` for an exact match, or a
  `{ min, max }` object for an **inclusive** range. Either side of the
  range can be omitted for an unbounded end:

      // Exact match
      client.listJobs({ priority: 50 });

      // Bounded range
      client.listJobs({ priority: { min: 0, max: 100 } });

      // Open-ended
      client.listJobs({ readyAt: { max: Date.now() } });
      client.listJobs({ attempts: { min: 1 } });

  Non-finite numbers and non-object bound shapes throw `TypeError`
  before any HTTP request is issued.

- `JobQuery` gained matching builders: `byPriority`, `byReadyAt`,
  `byAttempts`. They follow the existing `by*` convention (replace
  rather than union) and integrate with `count`, `updateAll`,
  `deleteAll`, and the pages iterator.

- Added `RangeFilter` and `RangeBounds` types, exported from
  `@zizq-labs/zizq`, for typing the new filter fields in user code.

- Requires Zizq server **0.5.0** or later. Older servers will reject
  requests that include any of the new query parameters with
  `400 Bad Request`.

## 0.4.2

- Added HTTP/2 over cleartext (h2c) support for `http://` URLs via
  undici's `useH2c` option, bringing Node up to parity with the Ruby
  and Rust clients. Previously HTTP/2 multiplexing required TLS; now
  any URL benefits from stream multiplexing over a single connection.
  No server-side change required — the Zizq server's HTTP stack
  already accepts HTTP/2 prior-knowledge on any connection.
- Added `maxConcurrentStreams` option on `Client` (default 1024).
  Sets the per-connection HTTP/2 stream concurrency the client
  requests from the server via the `SETTINGS_MAX_CONCURRENT_STREAMS`
  frame. The effective ceiling is `min(client, server)` — raising
  this client-side only matters once the server is also configured
  to allow more streams. Useful for high-concurrency workloads with
  many in-flight enqueue/ack requests sharing one connection.

## 0.4.1

- Added `Router` class for type-based job dispatch, mirroring the Ruby
  and Rust clients. Builder API with chainable `.route(type, handler)`
  and `.fallback(handler)`, plus `.build()` returning a `JobHandler`
  ready to pass to `Worker`. Routes overwrite on duplicate registration
  to support builder-style composition (e.g. starting from a defaults
  router and selectively overriding individual routes).
- Added `UnknownJobTypeError`, thrown by the compiled handler when a
  job arrives with no matching route and no fallback. Caught by the
  worker's normal failure path: the job is nacked for retry, and
  eventually dead-lettered once the retry limit is hit.
- `buildHandler([...])` is now implemented on top of `Router`
  internally; behaviour is unchanged.

## 0.4.0

- Added `Client.deleteAllCrons()` (`DELETE /crons`) — wipes every cron
  group on the server in a single call, returning the deleted-group
  count. Pro-only.
- Added `Client.reset()` (`POST /reset`) — wipes every cron group and
  every job in one request. Primarily intended as a setup/teardown
  step for test suites that want a known-empty server between
  scenarios. Also available as `Client.eraseAllData()`.
- Requires Zizq server **0.4.0** or later for the new endpoints.

## 0.3.2

- Added `connectTimeout`, `readTimeout`, and `streamIdleTimeout` options
  on the `Client`. `connectTimeout` (default 10000ms) bounds the TCP/TLS
  handshake; `readTimeout` (default 30000ms) bounds per-read inactivity
  for RPC traffic; `streamIdleTimeout` (default 30000ms) bounds per-read
  inactivity on the long-lived `/jobs/take` stream so dead connections
  are detected and the `Worker` reconnects instead of waiting forever on
  a zombie socket.

## 0.3.1

- Support `client.enqueue()` directly and deprecate top-level `enqueue()`

## 0.3.0

- Added support for cron scheduling

## 0.2.0

- Add `Client.countJobs()` using new Zizq server endpoint
- Optimise `Client.jobs().count()`

## 0.1.1

- Package metadata additions

## 0.1.0

- Initial release
- HTTP/2 client based on undici with optional MessagePack support
- Worker with concurrent handler dispatch
- Bulk acknowledgement batching
- Enqueue using function references with zizqOptions defaults
- Enqueue using low-level primitives
- Bulk enqueue
- Transform hooks for dynamic enqueue options
- Unique jobs support
- Lazy query builder
- TLS and mutual TLS support
