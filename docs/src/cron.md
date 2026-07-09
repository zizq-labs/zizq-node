# Cron Scheduling

> [!NOTE]
> This feature requires a Zizq [pro license](https://zizq.io/pricing) on the
> server.

Zizq supports running jobs periodically, using a cron scheduling system that is
managed atomically by the Zizq server. Multiple schedules can be defined, and
any number of entries can exist on each schedule. Both schedules and individual
entries within a schedule can be paused and resumed. Explicit time zones are
supported.

The official Zizq Node client exposes this functionality through
`client.cron()`.

## Defining a Schedule

Schedules are defined by your application, not by configuration files on the
Zizq server. Your application includes a `client.cron("name").register({...})`
call somewhere in its startup code.

Schedule registrations are idempotent. There is no requirement to designate one
particular process as the process that defines the schedule. If you have 50
application processes and they all define the same schedule on startup, that is
fine and expected.

Schedule defintions are also mutable. If you change a schedule between
application versions, Zizq is smart enough to retain existing entries, replace
modified entries, and delete removed entries.

The `register()` method takes an array of entries, each of which defines a cron
expression (and optionally a timezone) and details of the job to be executed at
that time. Each entry is assigned a name known to your application, which
uniquely identifies that entry within the schedule.

Both 6-field (with seconds) and standard 5-field cron expressions are accepted.

> JS:
>
> ``` ts
> import { Client } from "@zizq-labs/zizq";
> import { sendDailyDigest } from "./handlers";
> 
> const client = new Client({url: "http://localhost:7890"});
> 
> await client.cron("my-cron").register({
>   timezone: "Europe/London",
>   entries: [
>     {
>       name: "refresh_data_warehouse",
>       expression: "*/15 * * * *",
>       type: "refresh_data_warehouse",
>       queue: "data_warehouse",
>       payload: { incremental: true },
>     },
>     {
>       name: "send_daily_digest",
>       expression: "0 9 * * *",
>       type: sendDailyDigest, // function handlers are supported
>       payload: {},
>     },
>     {
>       name: "rotate_logs",
>       expression: "0 0 * * *",
>       timezone: "UTC",
>       type: "rotate_logs",
>       queue: "system/maintenance",
>       priority: 100,
>       payload: {},
>     }
>   ],
> });
> ```

The Zizq server will push jobs to the queue and advance the schedule
atomically. There is no risk that a job will be enqueued twice for the same
schedule tick. However, because Zizq simply enqueues the job without waiting
for completion, you _could_ end up with overlapping jobs if they are scheduled
too close together and take a long time to run. If this is a concern for your
application, you should combine cron scheduling with
[Unique Jobs](./unique-jobs.md) in order to prevent duplicate enqueues.

## Inspecting Existing Schedules

Once defined, cron schedules can be fetched and inspected by your application
by using `client.cron("name").get()`. Some management operations such as
pause/resume are also available on the returned schedule.

> [!NOTE]
> `client.cron()` is lazy. Requests to fetch the schedule data are only sent to
> Zizq server when one of the access methods (e.g. `get()`, `pause()`,
> `resume()` is called on it.

> JS:
>
> ``` ts
> const schedule = await client.cron("my-cron").get();
> 
> schedule.paused; // false
> 
> for (const entry of schedule.entries) {
>   console.log(`${entry.name}: ${entry.expression} (${entry.job.type}) last enqueued ${entry.lastEnqueueAt}`);
> }
> ```

## Pausing & Resuming Schedules

Schedules can be paused and resumed at two distinct levels:

1. At the outer cron group/schedule level.
2. Per-entry within the schedule.

If the group itself is paused, no entries within that schedule will execute
even if they are not paused.

> JS:
>
> ``` ts
> // Pause/resume entire schedule
> let schedule = await client.cron("my-cron").pause();
> console.log(schedule.paused); // true
> console.log(schedule.pausedAt); // ~ now
> 
> schedule = await client.cron("my-cron").resume();
> console.log(schedule.paused); // false
> console.log(schedule.pausedAt); // ~ before
> console.log(schedule.resumedAt); // ~ now
> 
> // Pause/resume individual entry
> let entry = await client.cron("my-cron").entry("refresh_data_warehouse").get();
> console.log(entry.paused); // false
> 
> entry = await client.cron("my-cron").entry("refresh_data_warehouse").pause();
> console.log(entry.paused); // true
> console.log(entry.pausedAt); // ~ now
> 
> entry = await entry.resume();
> console.log(entry.paused); // false
> console.log(entry.pausedAt); // ~ before
> console.log(entry.resumedAt); // ~ now
> ```

When paused, Zizq stops enqeueing jobs but continues to advance the schedule.

It is also possible for the paused state to be specified within the schedule
definition itself, which is useful e.g. if schedule pausing needs to be coupled
to app deployments (e.g. as part of a phased rollout of a complex change).

> JS:
>
> ``` ts
> await client.cron("my-cron").register({
>   paused: true,
>   ...
> });
> ```

> [!TIP]
> Each entry in the array also accepts `paused: true` or `paused: false`.

## Deleting a Schedule

Entire cron group schedules can be deleted, along with all of their entries by
calling `delete()` on the handle.

> JS:
>
> ``` ts
> await client.cron("my-cron").delete();
> ```

## Adding, Replacing or Deleting Entries within a Schedule

In general you should just define your schedule(s) in your application startup
code using `client.cron("...").register({...})` and let Zizq keep that schedule
in sync. However it is also possible to add/replace entries dynamically by
calling `entry("name").register({...})` directly on the cron handle.

> JS:
>
> ``` ts
> await client.cron("my-cron").entry("example").register({
>   expression: "* * * * ",
>   queue: "example-queue",
>   type: "example_job",
>   payload: {},
> });
> ```

If `"example"` already exists on this schedule, it is replaced with the new
entry, otherwise the new entry is appended to the schedule.

Call `delete()` on an entry to remove it from the schedule.

> JS:
>
> ``` ts
> await client.cron("my-cron").entry("example").delete();
> ```
