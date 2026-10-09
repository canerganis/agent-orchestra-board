# Task 07: concurrency limit and cancellation in a job queue

**Expected difficulty:** hard

## Goal

An in-memory async job queue runs every job immediately. Add a concurrency limit, FIFO ordering, per-job cancellation and a `drain()` promise, without introducing races or unhandled rejections.

## Starting state

A zero-dependency package `taskq` with `src/queue.js` exporting `class Queue`. `add(fn)` starts `fn()` at once and returns a promise for its result. `size` counts running jobs. 10 visible tests pass. There is no limit, no cancellation and no way to wait for all jobs.

## Acceptance criteria

1. `new Queue({ concurrency })` runs at most `concurrency` jobs at the same time (default `Infinity`, which keeps today's behavior). Excess jobs wait in FIFO order.
2. `add(fn, { signal })` returns a promise for the job's result. If the signal aborts while the job is still waiting, `fn` is never called and the promise rejects with the signal's reason. If it aborts while running, the queue passes the signal to `fn(signal)` and does not start a replacement early.
3. A job that throws or rejects frees its slot and rejects only its own promise. It does not stop other jobs and it does not cause an unhandled rejection in the queue.
4. `drain()` returns a promise that resolves when no job is running or waiting, resolves immediately if the queue is idle, and is safe to call several times at once. Jobs added after `drain()` was called but before it resolved are included.
5. `size` counts running plus waiting jobs, and a new `pending` getter counts waiting only.
6. Slots are released exactly once per job, including when `fn` throws synchronously and when abort and completion race.
7. Only `src/` and `test/` change. No new dependency.

## Hidden test

`hidden/queue.hidden.test.js` uses controllable promises (no real timers) and checks the maximum observed concurrency across 50 jobs at limits 1, 3 and `Infinity`, strict FIFO start order, a synchronous throw, cancellation of a waiting job and of a running job, an abort that arrives in the same tick as completion (the slot count must never go negative or above the limit), `drain()` called three times at once, `drain()` on an idle queue, jobs added during a drain, and that the process emits no `unhandledRejection` event during the whole file. A trap test asserts that the queue does not catch and swallow errors from jobs whose promise the caller awaits.
