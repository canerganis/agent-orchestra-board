# Measurements, 2026-10-07: one meeting before and after the token-lean pass

The raw data behind the "1.69M -> 0.46M tokens (-73%)" figure in the main README. **It is a single before/after observation, not a benchmark.** Read the caveats before quoting it.

Run `node summarize.mjs` in this folder (Node >= 20, no dependencies) to recompute every number below from the JSON files. Pass other room files as arguments to summarize any Agent Orchestra Board room.

| File | Room | Created (UTC) | What it is |
| --- | --- | --- | --- |
| `before.json` | `muyg1acci3m6` | 2026-10-07 18:31 | the planning meeting on the **pre-redesign** board |
| `after.json` | `muyggnnorpwk` | 2026-10-07 18:43 | the **same topic, same 4 seats, same 2 rounds + synthesis** on the token-lean board, 12 minutes later |

## Caveats, up front

- **n = 1 per arm.** One run each, on one machine. Agents are non-deterministic; a second run would give different numbers.
- **The "before" ran on older code.** It is the board as it was before the token-lean pass, which no longer exists in this repository (the first commit is already post-redesign) and which also had bugs that were fixed afterwards. The difference therefore mixes the token levers with every other change between the two runs. No lever can be credited with its own share, and the scout brief being the largest saving is an impression, not a measurement.
- **The metric is total tokens**: every input token the CLIs reported, **cache reads included**, plus output tokens. It is the only figure both runs have, because the old board stored one undivided token count per turn (there is no `cached` field anywhere in `before.json`). Today's board splits that into uncached (`tokens`, shown as "net" in the UI) and cached; only the after run has the split.
- **Early stop did not fire** in the after run: both planned rounds ran and no turn was skipped. The saving came from the other levers, and the after run paid for one extra turn (the scout).
- **Quality was not measured.** Nothing here shows the after run's output is as good as the before run's. The meeting text was read once, unblinded, with no rubric.
- **Cost covers Claude turns only.** Codex CLI reports no cost. The Claude seat's model is not stored per message, so the dollar figures are indicative, not a priced comparison.
- **Default seats**: 1 Claude + 3 Codex. The scout and the facilitator are two of those four seats, not extra agents. Because only one seat is Claude, per-call savings that apply to Claude apply to that seat's turns only.

## The metric, defined once

- **Total tokens** = uncached + cached (before: the single recorded count). **1,686,111 -> 461,540 (-72.6%, rounded to -73%).**
- **Uncached tokens** (`tokens`) = Claude `input + cache_creation + output`; Codex `(input - cached_input) + output`. After run: **204,374**.
- **Cached tokens** (`cached`) = cache reads. After run: **257,166**. Whether the cached share rose or fell between the runs is **unknown**.
- **Cost** = Claude Code's `total_cost_usd` summed over Claude turns: **$1.02 -> $0.16** (3 Claude turns in each run).

## What the two runs did

| | before | after |
| --- | --- | --- |
| Seats | Claude, Luna / Sol / Astra (Codex) | same ids, same roles |
| Rounds planned / run | 2 / 2 | 2 / 2 |
| Scout | none; every seat read the code itself in round 1 | Luna (Codex), 1 extra turn |
| Early stop | not available | did not fire |
| Turns | 9 (0 failed) | 10 (0 failed) |
| Total tokens | 1,686,111 | 461,540 (204,374 uncached + 257,166 cached) |
| Claude-reported cost | $1.02 | $0.16 |

Per phase (total tokens):

| Phase | before | after | after, uncached + cached |
| --- | --- | --- | --- |
| scout | - | 71,762 | 34,386 + 37,376 |
| round 1 (4 turns) | 739,970 | 148,421 | 79,026 + 69,395 |
| round 2 (4 turns) | 878,030 | 229,130 | 87,805 + 141,325 |
| synthesis (1 turn) | 68,111 | 12,227 | 3,157 + 9,070 |

Per seat (total tokens): Claude 225,235 -> 28,087; Luna 809,204 -> 322,615 (includes the scout turn in the after run); Sol 287,051 -> 55,631; Astra 364,621 -> 55,207.

## Environment

Windows 11, Claude Code CLI 2.1.291, Codex CLI 0.160.0, Node 24. **Caveat on the after run:** in `after.json`, Sol's round-2 discussion turn records effort `high`, but the current code caps discussion-round effort at `medium` (`capEffort` in `src/workflows/meeting.js`). So the after run predates the effort cap, and its exact code is not in this repository either. The effort cap is therefore not one of the levers behind the 1.69M -> 0.46M figure. Seats at the time of the after run: the Claude seat at effort `medium`; Luna `gpt-6-luna`/medium, Sol `gpt-6.1-sol`/high, Astra `gpt-6-astra`/medium.

## How the files were prepared

`before.json` and `after.json` are copies of the two room files from the board's `.orchestra/rooms/` directory, sanitized before publishing:

- absolute local paths (inside agent text of the after run, 18 occurrences) were replaced by `<project>/...`;
- the CLI thread ids (`threads` in the after room) were dropped;
- messages, tokens, cached, cost, rounds, labels and timestamps are unchanged; the JSON was re-serialized with two-space indentation.

The topic and agent replies are in Turkish, because that was the board's reply language at the time. The meeting is about an earlier version of this very project.

## Replacing this observation

`../../../bench/token-bench.mjs` runs the same Debate on a lean board and on a naive baseline board started from the same commit with `ORCHESTRA_NAIVE=1`, and reports mean and min-max over repeated runs. No result from it has been published yet.
