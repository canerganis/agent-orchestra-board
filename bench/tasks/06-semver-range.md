# Task 06: caret and tilde ranges in a mini semver library

**Expected difficulty:** hard

## Goal

Extend `satisfies(version, range)` in a mini semver library from exact and comparator ranges to caret (`^`) and tilde (`~`) ranges, including the `0.x` special cases and prerelease handling.

## Starting state

A zero-dependency package `minisemver` with `src/parse.js` (version parser), `src/compare.js` (precedence comparison including prerelease rules) and `src/range.js` exporting `satisfies`. The range grammar supports exact versions, `>`, `>=`, `<`, `<=`, `=` and space-separated AND sets, plus `||`. 40 visible tests pass. Caret and tilde currently throw `invalid range`.

## Acceptance criteria

1. `~1.2.3` means `>=1.2.3 <1.3.0`. `~1.2` means `>=1.2.0 <1.3.0`. `~1` means `>=1.0.0 <2.0.0`.
2. `^1.2.3` means `>=1.2.3 <2.0.0`. `^0.2.3` means `>=0.2.3 <0.3.0`. `^0.0.3` means `>=0.0.3 <0.0.4`. Partial forms follow npm semantics: `^1.2` means `>=1.2.0 <2.0.0`, `^0.0` means `>=0.0.0 <0.1.0` and `^0` means `>=0.0.0 <1.0.0`. The upper bound is set by the first non-zero part among the parts that are present, and when every present part is zero it is the next increment of the last present part.
3. A prerelease version satisfies a range only if some comparator in the same AND set has the same `major.minor.patch` and itself carries a prerelease tag, as in the existing exact-range rule.
4. Caret and tilde compose with `||` and with other comparators in an AND set.
5. Malformed input (`^`, `~~1`, `^1.x.2`) still throws an `Error` whose message starts with `invalid range`.
6. The parser and comparison modules keep their public signatures.
7. New visible tests cover each rule. Only `src/` and `test/` change.

## Hidden test

`hidden/range.hidden.test.js` has a table of about 80 `(version, range, expected)` rows taken from the documented semantics of the npm `semver` package (rows written by hand, no dependency). It covers all partial forms, `0.0.x` boundaries, prerelease versions against ranges with and without prerelease comparators, build metadata being ignored, `||` unions, and the malformed inputs above. A trap test checks that the existing comparator tests are unchanged and that `satisfies("1.2.3-beta.1", "^1.2.3")` is false.
