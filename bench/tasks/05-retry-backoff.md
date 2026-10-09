# Task 05: retry helper with backoff, jitter and abort

**Expected difficulty:** medium

## Goal

Replace three copy-pasted retry loops in a small HTTP client library with one shared `retry` helper that supports exponential backoff, jitter and `AbortSignal`, and use it in all three places.

## Starting state

A zero-dependency package `fetchlite` with `src/client.js` containing three functions (`getJson`, `postJson`, `head`), each with its own `for` loop that retries up to 3 times with a fixed 100 ms sleep on a thrown error or a 5xx status. There is no abort support. 14 visible tests pass, using an injected `fetch` stub.

## Acceptance criteria

1. A new `src/retry.js` exports `retry(fn, options)` with `retries`, `baseMs`, `factor`, `maxMs`, `jitter` (a function returning a number in [0, 1), injectable), `sleep` (injectable) and `signal`.
2. The delay before retry `k`, with `k` starting at 0 for the first retry, is exactly `min(maxMs, baseMs * factor ** k) * (1 - jitter())`. `jitter()` is called once per sleep. The formula is documented in the file header.
3. `fn` receives the attempt number, starting at 0. It may throw or return a value. A thrown error or a rejected promise is retried until `retries` is used up, then the last error is rethrown unchanged.
4. If the signal aborts, the helper stops immediately, including during a sleep, and rejects with the signal's reason.
5. The three client functions use the helper, keep their current retry on 5xx and thrown errors, and do not retry 4xx.
6. Client functions accept an optional `signal`. Default behavior (3 retries) is preserved.
7. Only `src/` and `test/` change. No new dependency.

## Hidden test

`hidden/retry.hidden.test.js` uses injected `sleep` and `jitter` and checks the exact sequence of delays for three jitter values, that `retries: 0` calls `fn` once, that the last error object is identical (same reference) to the one thrown, that an abort during a sleep rejects without a further attempt and without leaving the sleep pending, that an already-aborted signal never calls `fn`, and through the client functions that a 404 is returned on the first attempt and a 503 followed by a 200 returns the 200. A trap test fails if the helper leaves a pending timer after success (checked with `process.getActiveResourcesInfo()`).
