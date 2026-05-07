# Changelog

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
