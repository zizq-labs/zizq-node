# Querying & Managing Jobs

Zizq makes _vivibility_ and _control_ key design focuses. The server provides
a number of endpoints for querying and managing job data, which are all
packaged up in the `client.jobs()` query builder in the Node client.

Queries are initiated with `client.jobs()` and built by chaining methods onto
that query. All queries are lazy (they don't execute until async iterated), and
each builder method returns a _new instance_ of the query, so intermediate
queries can be passed around without worrying about mutability.

## `Client.jobs()` { #client.jobs }

Methods starting with `by` _replace_ the current condition, while methods
starting with `add` append to the condition. These methods also all accept
arrays which form `IN (...)` style conditions.

* [`byId()`](#client.jobs-byId)
* [`addId()`](#client.jobs-byId)
* [`byQueue()`](#client.jobs-byQueue)
* [`addQueue()`](#client.jobs-byQueue)
* [`byType()`](#client.jobs-byType)
* [`addType()`](#client.jobs-byType)
* [`byStatus()`](#client.jobs-byStatus)
* [`addStatus()`](#client.jobs-byStatus)

These methods only accept strings and combine to narrow down the current
filter (using the `and` operator):

* [`byJqFilter()`](#client.jobs-byJqFilter)
* [`addJqFilter()`](#client.jobs-byJqFilter)

These methods wrap `addJqFilter()` to find jobs enqueued with the specified
payloads, or payload subsets.

* [`withPayload()`](#client.jobs-withPayload)
* [`withPayloadSubset()`](#client.jobs-withPayloadSubset)

These methods have special meaning (see docs):

* [`order()`](#client.jobs-order)
* [`limit()`](#client.jobs-limit)
* [`inPagesOf()`](#client.jobs-inPagesOf)

These methods enumerate the results of the query:

* [`*[Symbol.asyncIterator]()`](#client.jobs-asyncIterator)
* [`*pages()`](#client.jobs-pages)

These methods apply a delete or update to the entire scope of the query.

* [`deleteAll()`](#client.jobs-deleteAll)
* [`updateAll()`](#client.jobs-updateAll)

These methods apply a delete or update to the first result of the query (if
any):

* [`deleteOne()`](#client.jobs-deleteOne)
* [`updateOne()`](#client.jobs-updateOne)

Additionally, and importantly, `client.jobs()` is also `AsyncIterable` so its
results can be iterated and wrapped with helpers like `iter-tools`. Some basic
helpers are also included and chainable directly onto the query (`toArray()`,
`map()`, `filter()`, `forEach`, `count()`, `first()`, `isEmpty()`).

### `byId()`, `addId` { #client.jobs-byId }

Narrows the query down to a given `id` or set of `id`s.

```ts
for await (job of client.jobs().byId("03fvmay0zcoskwdf2sm0u94aw")) {
  console.log(`${job.id}: ${JSON.stringify(job.payload)}`);
}
// 03fvmay0zcoskwdf2sm0u94aw: {"greet":"World"}

for await (const job of client.jobs()
    .byId("03fvmay0zcoskwdf2sm0u94aw")
    .addId("03fvqg68ra0od9u1b8m0txgka")) {
  console.log(`${job.id}: ${JSON.stringify(job.payload)}`);
}
// 03fvmay0zcoskwdf2sm0u94aw: {"greet":"World"}
// 03fvqg68ra0od9u1b8m0txgka: {"greet":"Moon"}

await client
  .jobs()
  .byId("03fvmay0zcoskwdf2sm0u94aw")
  .addId("03fvqg68ra0od9u1b8m0txgka")
  .count(); // 2
```

### `byQueue()`, `addQueue()` { #client.jobs-byQueue }

Narrows the query down to a given `queue` or set of `queue`s.

```ts
await client.jobs().byQueue("analytics").count();
// 90

await client.jobs().byQueue(["analytics", "example"]).count();
// 93

await client.jobs().byQueue(["analytics", "example"]).addQueue("comms").count();
// 3631
```

### `byType()`, `addType()` { #client.jobs-byType }

Narrows the query down to a given `type` or set of `type`s.

```ts
await client.jobs().byQueue("default").byType("process_video").count();
// 401

await client.jobs()
  .byQueue("default")
  .byType("process_video")
  .addType("clear_notes")
  .count();
// 491
```

### `byStatus()`, `addStatus()` { #client.jobs-byStatus }

Narrows the query down to a given `status` or set of `status`es.

Valid statuses are:

* `scheduled`
* `ready`
* `in_flight`
* `completed`
* `dead`

```ts
await client.jobs().byStatus(["scheduled", "ready"]).count();
// 5003

await client.jobs().byStatus("ready").count();
// 4993

await client.jobs().byQueue("default").byStatus("ready").addStatus("scheduled").count();
// 491
```

### `byJqFilter()`, `addJqFilter()` { #client.jobs-byJqFilter }

Narrows the query down by matching on the `payload`. Since payloads are
arbitrary and known only to your application, filtering is done by using `jq`
expressions.

> [!TIP]
> For more details on the `jq` query language, read the language specification
> on the [jaq website](https://gedenkt.at/jaq/manual/#corelang) or on
> [jq](https://jqlang.org/manual/#basic-filters).

```ts
for await (const job of client.jobs()
    .byType("hello_world")
    .byJqFilter('.greet == "Moon"')) {
  console.log(`${job.id}: ${JSON.stringify(job.payload)}`);
}
// 03fvqg68ra0od9u1b8m0txgka: {"greet":"Moon"}

for await (const job of client.jobs()
    .byType("hello_world")
    .byJqFilter('.greet | contains("o")')) {
  console.log(`${job.id}: ${JSON.stringify(job.payload)}`);
}
// 03fvmay0zcoskwdf2sm0u94aw: {"greet":"World"}
// 03fvqg68ra0od9u1b8m0txgka: {"greet":"Moon"}

for await (const job of client.jobs()
    .byType("process_video")
    .byJqFilter('.dimensions.width <= 600')) {
  console.log(`${job.id}: ${JSON.stringify(job.payload)}`);
}
// 03fvqm2ejnbjahvhayikrkltr: {"dimensions":{"width":600,"height":400}}
// 03fvqm2ejnbjahvhayk0y3i9k: {"dimensions":{"width":599,"height":399}}
// 03fvqm2ejnbjahvhaykq7d4fh: {"dimensions":{"width":598,"height":398}}
// 03fvqm2ejnbjahvhaynwu2ije: {"dimensions":{"width":597,"height":397}}
// 03fvqm2ejnbjahvhaypw8nkng: {"dimensions":{"width":596,"height":396}}
// 03fvqm2ejnbjahvhayr7ytglw: {"dimensions":{"width":595,"height":395}}
// 03fvqm2ejnbjahvhaysw8ggq1: {"dimensions":{"width":594,"height":394}}
// 03fvqm2ejnbjahvhayvtolt8p: {"dimensions":{"width":593,"height":393}}
// 03fvqm2ejnbjahvhayx9j2rmx: {"dimensions":{"width":592,"height":392}}
```

### `withPayload()`, `withPayloadSubset()` { #client.jobs-withPayload }

These methods  match jobs on the queue by wrapping `addJqFilter` internally.
You can match either using exact payloads, or on just a subset of the payload (N positional array elements for arrays, partial object match for objects).

```ts
for await (const job of client.jobs()
    .withPayload({dimensions: {width: 223, height: 180}})) {
  console.log(`${job.id}: ${JSON.stringify(job.payload)}`);
}
// 03fvqm2ejnbjahvhbao96krod: {"dimensions":{"width":223,"height":180}}

for await (const job of client.jobs()
    .withPayload({dimensions: {width: 2, height: 1}})) {
  console.log(`${job.id}: ${JSON.stringify(job.payload)}`);
}
// (no output)

for await (const job of client.jobs()
    .withPayloadSubset({dimensions: {width: 223}})) {
  console.log(`${job.id}: ${JSON.stringify(job.payload)}`);
}
// 03fvqm2ejnbjahvhbao96krod: {"dimensions":{"width":223,"height":180}}
```

### `order()` { #client.jobs-order }

Changes the sort order in which results are returned. Use either  `"asc"` or
`"desc"`. The default is `"asc"`.

```ts
for await (const job of client.jobs().byStatus("scheduled")) {
  console.log(job.id);
}
// 03fvmay0zcoskwdf2sm0u94aw
// 03fvqg4qxj39zecl43gnwwh04
// 03fvqg68ra0od9u1b8m0txgka
// 03fvqhdcqsftfxrzb6xc8acjy
// 03fvqhdcqsftfxrzb6zq57rqs
// 03fvqhdcqsftfxrzb71cxvk13
// 03fvqhdcqsftfxrzb74afpg6x
// 03fvqhdcqsftfxrzb75rabbrt
// 03fvqhdcqsftfxrzb78any8s1
// 03fvqhdcqsftfxrzb7a5g3hpm

for await (const job of client.jobs().byStatus("scheduled").order("desc")) {
  console.log(job.id);
}
// 03fvqhdcqsftfxrzb7a5g3hpm
// 03fvqhdcqsftfxrzb78any8s1
// 03fvqhdcqsftfxrzb75rabbrt
// 03fvqhdcqsftfxrzb74afpg6x
// 03fvqhdcqsftfxrzb71cxvk13
// 03fvqhdcqsftfxrzb6zq57rqs
// 03fvqhdcqsftfxrzb6xc8acjy
// 03fvqg68ra0od9u1b8m0txgka
// 03fvqg4qxj39zecl43gnwwh04
// 03fvmay0zcoskwdf2sm0u94aw
```

### `limit()` { #client.jobs-limit }

Changes the maximum number of total results returned by the query.

```ts
for await (const job of client.jobs()
    .byStatus("scheduled")
    .order("desc")
    .limit(3)) {
  console.log(job.id);
}
// 03fvqhdcqsftfxrzb7a5g3hpm
// 03fvqhdcqsftfxrzb78any8s1
// 03fvqhdcqsftfxrzb75rabbrt
```

### `inPagesOf()` { #client.jobs-inPagesOf }

Changes the number of results fetched in a single page as the client iterates
jobs. When not specified, the server's default page size applies.

This also affects how `updateAll()` and `deleteAll()` are applied. Without
specifying `inPagesOf()`, these operations apply to the entire result set in a
single transaction. When `inPagesOf()` is specified, the bulk delete or update
is done in a batched manner.

```ts
for await (const job of client.jobs().byStatus("scheduled").inPagesOf(2)) {
  console.log(job.id);
}
// 03fvmay0zcoskwdf2sm0u94aw
// 03fvqg4qxj39zecl43gnwwh04
// 03fvqg68ra0od9u1b8m0txgka
// 03fvqhdcqsftfxrzb6xc8acjy
// 03fvqhdcqsftfxrzb6zq57rqs
// 03fvqhdcqsftfxrzb71cxvk13
// 03fvqhdcqsftfxrzb74afpg6x
// 03fvqhdcqsftfxrzb75rabbrt
// 03fvqhdcqsftfxrzb78any8s1
// 03fvqhdcqsftfxrzb7a5g3hpm

let pageNum = 1;
for await (const page of client.jobs()
    .byStatus("scheduled")
    .inPagesOf(2)
    .pages()) {
  console.log(`Page ${pageNum}`);
  for (const job of page.jobs) {
    console.log(job.id);
  }
  pageNum++;
}
// Page 1
// 03fvmay0zcoskwdf2sm0u94aw
// 03fvqg4qxj39zecl43gnwwh04
// Page 2
// 03fvqg68ra0od9u1b8m0txgka
// 03fvqhdcqsftfxrzb6xc8acjy
// Page 3
// 03fvqhdcqsftfxrzb6zq57rqs
// 03fvqhdcqsftfxrzb71cxvk13
// Page 4
// 03fvqhdcqsftfxrzb74afpg6x
// 03fvqhdcqsftfxrzb75rabbrt
// Page 5
// 03fvqhdcqsftfxrzb78any8s1
// 03fvqhdcqsftfxrzb7a5g3hpm
```

### `*[Symbol.asyncIterator]()` { #client.jobs-asyncIterator }

> [!NOTE]
> This method is automatically called by the JavaScript runtime whenever
> `for await` is used on the query. It is not called explicitly.

Iterates over each `Job` in the query result. Until this method, is called, the
query is not yet executed.

```ts
for await (const job of client.joibs().byStatus("scheduled")) {
  console.log(job.id);
}
// 03fvmay0zcoskwdf2sm0u94aw
// 03fvqg4qxj39zecl43gnwwh04
// 03fvqg68ra0od9u1b8m0txgka
// 03fvqhdcqsftfxrzb6xc8acjy
// 03fvqhdcqsftfxrzb6zq57rqs
// 03fvqhdcqsftfxrzb71cxvk13
// 03fvqhdcqsftfxrzb74afpg6x
// 03fvqhdcqsftfxrzb75rabbrt
// 03fvqhdcqsftfxrzb78any8s1
// 03fvqhdcqsftfxrzb7a5g3hpm
```

### `*pages()` { #client.jobs-pages }

Iterates over each `JobPage` in the query result.

> [!NOTE]
> When combined with `limit()`, `*pages()` stops at the page boundary but the
> entire last page is returned even if the jobs it contains exceeds the limit.

```ts
let pageNum = 1;
for await (const page of client.jobs()
    .byStatus("scheduled")
    .inPagesOf(2)
    .pages()) {
  console.log(`Page ${pageNum}`);
  for (const job of page.jobs) {
    console.log(job.id);
  }
  pageNum++;
}
// Page 1
// 03fvmay0zcoskwdf2sm0u94aw
// 03fvqg4qxj39zecl43gnwwh04
// Page 2
// 03fvqg68ra0od9u1b8m0txgka
// 03fvqhdcqsftfxrzb6xc8acjy
// Page 3
// 03fvqhdcqsftfxrzb6zq57rqs
// 03fvqhdcqsftfxrzb71cxvk13
// Page 4
// 03fvqhdcqsftfxrzb74afpg6x
// 03fvqhdcqsftfxrzb75rabbrt
// Page 5
// 03fvqhdcqsftfxrzb78any8s1
// 03fvqhdcqsftfxrzb7a5g3hpm
```

### `deleteAll()` { #client.jobs-deleteAll }

Deletes all jobs from the server that match the given query and returns the
number of deleted jobs. When the query is unfiltered, deletes _all jobs_ from
the server. This can be useful in tests.

When combined with `inPagesOf`, jobs are deleted in a batch-wise manner,
otherwise all jobs are deleted in a single transaction.

This method also combines safely with `limit()` in order to explicitly prevent
deleting more than a specified number of jobs (implies batch-wise deletion).

```ts
await client.jobs().byQueue("analytics").count();
// 90

await client.jobs().byQueue("analytics").deleteAll();
// 90

await client.jobs().byQueue("analytics").count();
// 0

await client.joibs().byQueue("comms").count();
// 3538

await client.jobs().byQueue("comms").inPagesOf(20).limit(30).order("desc").deleteAll();
// 30

await client.jobs().byQueue("comms").count();
// 3528
```

### `updateAll()` { #client.jobs-updateAll }

Updates all jobs from the server that match the given query and returns the
number of updated jobs. When the query is unfiltered, updates _all jobs_ on the
server.

The following job fields are mutable:

* `queue`
* `priority`
* `readyAt`
* `retryLimit`
* `backoff`
* `retention`

Only the fields specified in the input are updated. Fields that are not
specified, or are `undefined`, are left unchanged.

This method can be used for example to re-assign/rename `queue`s or to change
`priority`.

Setting an optional field to `null` tells the server to restore that field back
to its default value, so for example to un-schedule a job and make it
immediately `ready` you can set `readyAt` to `null` and the server will make
it `ready` immediately.

When combined with `inPagesOf()`, jobs are updated in a batch-wise manner,
otherwise all jobs are updated in a single transaction.

This method also combines safely with `limit()` in order to explicitly prevent
updating more than a specified number of jobs (implies batch-wise update).

```ts
await client.jobs().byQueue("default").count();
// 15491

await client.jobs().byQueue("analytics").count();
// 90

await client.jobs().byQueue("analytics").updateAll({queue: "default"});
// 90

await client.jobs().byQueue("default").count();
// 15581

await client.jobs().byQueue("analytics").count();
// 0

await client.jobs().byQueue("payments").byStatus("scheduled").count();
// 3

await client.jobs().byQueue("payments").byStatus("scheduled").updateAll({readyAt: null});
// 3

await client.jobs().byQueue("payments").byStatus("scheduled").count();
// 0
```

### `deleteOne()` { #client.jobs-deleteOne }

Deletes at most the first matching result from the query.

```ts
await client.jobs().byQueue("payments").count();
// 881

await client.jobs().byQueue("payments").order("desc").deleteOne();
// 1

await client.jobs().byQueue("payments").count();
// 880
```

### `updateOne()` { #client.jobs-updateOne }

Updates at most the first matching result from the query.

```ts
await client.jobs().byQueue("comms").byStatus("scheduled").count();
// 2

await client.jobs().byQueue("comms").byStatus("scheduled").updateOne({readyAt: null});
// 1

await client.jobs().byQueue("comms").byStatus("scheduled").count();
// 1
```

## `Job` Resource Helpers

Each job in the result of `client.jobs()` also implements methods to inspect
errors and manage the job.

The following method provides access to the job's errors:

* [`*errors()`](#job-resource-errors)

The following methods allow deleting or updating the job's properties:

* [`delete()`](#job-resource-delete)
* [`update()`](#job-resource-update)

### `*errors()` { #job-resource-errors }

Iterates over the errors on this job, either in reverse or ascending order.
This can also be done in pages.

```ts
const job = await client.jobs().byId("03fvqhdcqsftfxrzb7m9owqsf").first();
for await (const err of job.errors().inPagesOf(20).order("desc")) {
  console.log(`Attempt: ${err.attempt}, Message: ${err.message}`);
}
// Attempt: 2, Message: Something went wrong
// Attempt: 1, Message: Something went wrong
```

### `delete()`

Permanently deletes this job from the server. Returns `undefined` on success.
Rejects on failure (e.g. 404 - job not found).

```ts
const job = await client.jobs().byQueue("comms").first();

job.id
// 03fvqhdcqsftfxrzb7hekw4if

await client.jobs().byId("03fvqhdcqsftfxrzb7hekw4if").count();
// 1

await job.delete();
// undefined

await client.jobs().byId("03fvqhdcqsftfxrzb7hekw4if").count();
// 0

await job.delete();
//! job not found (NotFoundError)
```

### `update()`

Updates mutable properties on this job. Returns the updated job metadata on
success. Rejects with a `ClientError` on failure.

Jobs in the `completed` or `dead` statuses are immutable and cannot be updated.

```ts
const job = await client.jobs().byQueue("comms").first();

job.id
// 03fvqhdcqsftfxrzb7nn5h57r

for await (const job of client.jobs().byId("03fvqhdcqsftfxrzb7nn5h57r")) {
  console.log(job.queue);
}
// comms

await job.update({queue: "default"});

for await (const job of client.jobs().byId("03fvqhdcqsftfxrzb7nn5h57r")) {
  console.log(job.queue);
}
// default
```

## `JobPage` Resource Helpers

The pages of jobs yielded by `client.jobs().pages()` also provide some helper
methods that operate across the whole page.

* [`deleteAll()`](#jobpage-resource-deleteAll)
* [`updateAll()`](#jobpage-resource-updateAll)

The page itself is also an `Iterable` so it can be iterated over using
`for .. of`.

### `deleteAll()` { #jobpage-resource-deleteAll }

Delete all jobs on the current page by their IDs.

> [!WARNING]
> This method behaves differently to `client.jobs().deleteAll()` which respects
> the original query filters. This method deletes every record on the page
> unconditionally, even if it may have since been updated and does not match
> the filters.

The example here deletes all jobs on the first 5 pages where the queue is
`example`.

```ts
let pageNum = 1;
for await (const page of client.jobs().byQueue("example").pages()) {
  if (pageNum > 5) break;
  await page.deleteAll();
  pageNum++;
}
```

### `updateAll()` { #jobpage-resource-updateAll }

Update all jobs on the current page by their IDs.

> [!WARNING]
> This method behaves differently to `client.jobs().updateAll()` which respects
> the original query filters. This method updates every record on the page
> unconditionally, even if it may have since been updated and does not match
> the filters.

The example here update all jobs on the first 2 pages where the queue is
`example`.

```ts
let pageNum = 1;
for await (const page of client.jobs().byQueue("example").pages()) {
  if (pageNum > 5) break;
  await page.updateAll({queue: "other"});
  pageNum++;
}
```
