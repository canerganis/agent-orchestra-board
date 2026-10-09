# Task 01: slugify drops accented letters

**Expected difficulty:** easy

## Goal

Fix `slugify(text)` in a small string utility package so that accented Latin letters are transliterated instead of removed. For example `"Crème Brûlée"` must become `"creme-brulee"`, not `"cr-me-br-l-e"`.

## Starting state

A zero-dependency Node.js package `strutil` with `src/slugify.js` (about 25 lines), `src/index.js` re-exporting it, and `test/slugify.test.js` using `node:test`. The current implementation lowercases the input and replaces every run of characters outside `[a-z0-9]` with a single hyphen, then trims leading and trailing hyphens. 6 visible tests pass.

## Acceptance criteria

1. Accented Latin letters are reduced to their base letter (use Unicode normalization, no new dependency).
2. Existing behavior is unchanged: runs of other characters become one hyphen, no leading or trailing hyphen, empty input returns an empty string.
3. Input that has no Latin letters (for example only emoji) returns an empty string and does not throw.
4. At least one new visible test covers an accented input.
5. Only files under `src/` and `test/` change.

## Hidden test

`hidden/slugify.hidden.test.js` checks a table of about 20 inputs. It covers accented words, ligature-free decomposable letters, mixed case, repeated separators, a string of only combining marks, a string of only emoji, and a 10,000 character input that must finish in under 200 ms. It also asserts that `slugify(slugify(x)) === slugify(x)` for every table input.
