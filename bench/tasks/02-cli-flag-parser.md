# Task 02: add `--key=value` support to a tiny CLI flag parser

**Expected difficulty:** easy

## Goal

The flag parser in a small CLI helper only understands `--key value`. Add support for `--key=value` and for the end-of-options marker `--`.

## Starting state

A zero-dependency package `miniflags` with `src/parse.js` exporting `parse(argv, spec)`, where `spec` lists known flags as `{ name: { type: "string" | "boolean" | "number" } }`. It returns `{ flags, positionals }`. 9 visible tests pass. Unknown flags currently throw an `Error` with the message `unknown flag: --name`.

## Acceptance criteria

1. `--key=value` sets the flag exactly as `--key value` does, for string and number flags.
2. A value may itself contain `=` (`--url=a=b` gives `a=b`).
3. `--flag=true` and `--flag=false` work for boolean flags. Any other value for a boolean flag throws an `Error` whose message starts with `invalid value`.
4. Everything after a bare `--` is a positional, even if it starts with `-`.
5. The unknown flag error message is unchanged.
6. New visible tests cover points 1 to 4. Only `src/` and `test/` change.

## Hidden test

`hidden/parse.hidden.test.js` runs about 25 cases, including an empty value (`--name=`), a number flag with a negative value (`--n=-3`), `--` followed by a flag-looking token, a repeated flag (last one wins), a boolean flag given as `--flag=` (must throw `invalid value`), and the unchanged unknown flag message. It also checks that `parse` does not mutate the `argv` array passed in.
