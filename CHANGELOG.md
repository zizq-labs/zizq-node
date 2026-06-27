# Changelog

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
