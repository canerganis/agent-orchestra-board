# Task 03: add per-entry TTL to an LRU cache

**Expected difficulty:** medium

## Goal

Add optional time-to-live support to an existing LRU cache without changing the behavior of callers that do not use it.

## Starting state

A zero-dependency package `lrucache` with `src/lru.js` exporting a class `LRU` built on a `Map`. API: `new LRU(maxSize)`, `get(key)`, `set(key, value)`, `has(key)`, `delete(key)`, `size`. 12 visible tests pass. There is no clock abstraction; the code does not call `Date.now()` anywhere.

## Acceptance criteria

1. `new LRU(maxSize, { ttlMs, now })` accepts an optional default TTL and an optional injectable clock function `now()` that defaults to `Date.now`.
2. `set(key, value, { ttlMs })` may override the default TTL for one entry. `ttlMs: 0` or a missing TTL means the entry never expires.
3. An expired entry is treated as absent by `get`, `has` and `size`, and is removed when seen.
4. Reading an entry with `get` refreshes its LRU position but does not extend its TTL.
5. When the cache is full, expired entries are evicted before any live entry is.
6. Without any TTL option the behavior is identical to before.
7. New visible tests use a fake clock. Only `src/` and `test/` change.

## Hidden test

`hidden/lru-ttl.hidden.test.js` uses a fake clock and checks: expiry at exactly `ttlMs` (an entry is expired when `now - setAt >= ttlMs`), `size` excluding expired entries without any call to `get`, eviction order when the cache holds a mix of live and expired entries, a `set` on an existing key resetting its TTL, a per-entry TTL of 0 overriding a non-zero default, and the full set of old visible tests unchanged. A trap test asserts that `get` on a live entry returns the same value object (no copying).
