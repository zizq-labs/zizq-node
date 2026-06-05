# Changelog

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
