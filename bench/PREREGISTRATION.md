# OrchestraBench pilot: preregistration

Status: draft for the E3 freeze. This file is committed together with the harness (`run.mjs`, `grade.mjs`, `report.mjs`), the 8 task files in `bench/tasks/` and their hidden tests. The freeze commit records the `v0.3.0-rc1` tag hash, the hash of every task file and the hash of every hidden test file, and is then tagged. The report cites that tag. Any later change is listed in the report as a deviation.

This is a pilot with 8 tasks. It is not a benchmark in the statistical sense, and it supports no significance claim.

## 1. Question

Per accepted change, does the board use fewer tokens and less human time than the setup a user would otherwise run, and does the Router add anything on top of the board with static tiers?

## 2. Hypotheses

Stated so that each can fail.

* **H1 (whole system, A against B).** The current board (static tiers) needs no more than 1.5 times the single agent's tokens per accepted change at an equal or higher hidden test pass rate. This is the kill threshold from the master plan, not a prediction that the board wins.
* **H2 (Router effect, B against C).** The board with the Router switched on uses fewer tokens per accepted change than the board with static tiers, at a hidden test pass rate that is not lower.
* **H3 (review quality).** On the board arms the first pass rate is at least 60% and the median wall time per attempt is at most 7 minutes. These are targets read from the pilot. They gate nothing.
* **H4 (human time).** Board arms need at most 2 active human minutes per accepted change, counting the final diff reading charge and every decision minute (section 5). Automatic approval opens no decisions, so for the board arms the decision part is expected to be near 0 and H4 mostly tests the diff reading charge. A against B human minutes are compared on the same basis.

Null reading: if none of these hold, the report says so with the same prominence as a win.

## 3. Arms

All arms use pinned CLI versions, the same isolation flags (Claude `--strict-mcp-config --setting-sources ""`, Codex `--ignore-user-config`), a fresh clone per run, the same task prompt text and the same 30 minute timeout. Arm configs are published with the report.

| Arm | Name | What runs |
|---|---|---|
| A | `single` | One strong single agent: a Claude Code session (Sonnet 5.5, medium effort) in a worktree with Read, Edit, Write, acceptEdits and the same Bash allowance the board builders get (`node --test` and the other test and lint commands, inside the worktree only). This is the setup a user would otherwise run, and it can run the visible tests as often as it likes. |
| B | `board-current` | The board as at the rc1 tag, which already contains the W0 fixes, with static tiers: plan, automatic approval, cross-vendor review, apply. The Router is off. |
| C | `board-router` | Exactly the same rc1 build and the same W0 fixes as B, with the static Router switched on. The Router setting is the only difference between B and C. |

A against B is a whole system comparison with different model mixes by design. It is reported as such and never as a model comparison. B against C is the Router effect alone, since both run the same build and differ only in the Router setting. There is no AO arm, so AO is not named in any result.

Automatic approval is a benchmark setting. The report says so.

## 4. Tasks

8 own tasks in `bench/tasks/01-*.md` to `08-*.md`, mixed difficulty (2 easy, 3 medium, 3 hard, one of them trap focused). Each has a goal, a starting state, acceptance criteria and a hidden test description. Hidden tests are copied in only at grading. Agents never see them. Each task is run once per arm (one repeat), because task count narrows the intervals more than repeats do.

## 5. Metrics

Per run, all recorded by the harness from the ledger and the CLI reports. The agent's own report is ignored.

| Metric | Definition |
|---|---|
| Tokens per accepted change (primary) | All runner tokens for the run, with uncached input, cached input and output kept apart, divided by the number of accepted changes. A run that is not accepted still adds its tokens to the numerator for the arm. The headline figure is total tokens including cached reads, to stay comparable with the 570k baseline. |
| Wall time | Seconds from task start to the final patch or the timeout. Human wait time inside the run is not removed. |
| First pass rate | Share of runs where all gates are green and review round 1 is PASS. For arm A, where no review round exists, it is the share of runs whose first final patch passes the visible acceptance checks. |
| Hidden test pass rate (primary) | Share of runs where the hidden tests pass on the base commit plus the final patch in a fresh clone. |
| Human minutes | Active owner minutes per accepted change, using the definition in MASTER-PLAN section 1: decision opened to answered, idle gaps over 2 minutes cut. Every arm is charged the same diff reading time, because the owner reads the final diff in all arms: a fixed rule of 1 minute per 40 changed lines in the final patch, rounded up. On top of that, the board arms add the measured decision minutes (zero when automatic approval opens no decision). Arm A has no decisions, so it carries only the diff charge. The report shows the two parts separately and states that the diff charge is an estimate. |

Secondary, reported but not tested: cash (marginal spend and list price equivalent, labelled as an estimate), provider quota meter movement per block, files touched outside allowed paths, writes outside the worktree.

Cash, quota and tokens are never converted into each other.

## 6. What counts as accepted

A run is accepted if and only if all of these hold:

1. `grade.mjs` applies the final patch to a fresh clone of the base commit without error.
2. The patch touches no hidden test path and no file outside the task's allowed paths.
3. No existing visible test is deleted, skipped or weakened (checked by comparing test counts and assertion lines against the base).
4. All hidden tests pass.
5. The run finished inside the timeout.

A run that fails any condition is a failure and counts in every denominator. There are no exclusions for model errors. The only permitted exclusion is a harness fault (crash of `run.mjs`, a network outage proven in the logs, quota exhaustion that kills the CLI), and the run is then repeated once. Both runs are listed in the raw data.

## 7. Randomization and blocking

The pilot runs in task blocks. One block is one task with all three arms. Task order is a seeded shuffle (seed fixed in the freeze commit). Arm order inside a block is a seeded random permutation. Fresh clone per run. No two runs share a worktree, a port or a ledger. Nothing that changes `src/` merges between the rc1 tag and the last run.

## 8. Budget and stop rule

The cap is 8M tokens in total. At the baseline of about 570k tokens per run, 24 runs would need about 13.7M, so the pilot will probably complete only part of the task set.

Before each block, the harness projects the cost of the block from the mean tokens per run observed so far for each arm (for the first block it uses 570k per run). The pilot stops at the block boundary, never inside a block, if:

1. the projection exceeds what is left of the cap, or
2. a provider quota window would pass 60% before its reset.

On stop, `report.mjs` emits the predefined partial report: completed blocks only, all three arms per task, raw numbers, the line "partial, n of 8 tasks", the stop reason, and descriptives only. A partial report makes no aggregate claim.

## 9. Analysis rules

Fixed before any run.

1. Per task results for every arm are shown in full, with every raw run.
2. Tokens per accepted change: paired by task, compared as the ratio B to A, C to B and C to A. Summaries are the median ratio and the min to max over tasks. A 95% bootstrap interval over tasks is added only when at least 6 tasks completed, and is labelled as very wide.
3. Pass rates are shown as k of n with Wilson 95% intervals.
4. Wall time and human minutes are shown as median, p90 and n.
5. No p values and no statements of significance.
6. The report states the smallest difference the pilot could detect. For the token ratio, assuming a standard deviation of 0.5 for the log ratio between arms across tasks (an assumption, replaced by the observed value in the report), n tasks give a detectable log ratio of about 1.96 times 0.5 divided by the square root of n. For n = 8 that is a ratio of about 1.4. For pass rates, with one run per arm per task, a difference of fewer than 3 tasks of 8 is not distinguishable from noise.
7. Escaped defects (a hidden test failure on an otherwise gate-green run) are reported per arm.
8. Cost claims are made only for the exact tasks, models and versions of the pilot.

## 10. What would falsify our claims

Applied after the report, from `report.json`, without discretion.

| Observation | Consequence |
|---|---|
| Arm B or C uses more than 1.5 times arm A's tokens per accepted change at an equal pass count | No cost claim. The plan and Council stay optional for easy tasks. |
| Arm B or C has a lower hidden test pass count than arm A | No cost claim and the loss is reported first. |
| Arm C is not better than arm B on tokens per accepted change at a pass count that is not lower | The Router stays a manual default and Automatic is labelled experimental. |
| Any arm run writes outside its worktree | The containment claim is withdrawn for that arm and the incident is reported. |
| The pilot stops early | The partial report is published as is, with no cost claim. |
| Hidden test failures appear on runs that the board marked as accepted | The review claim is limited to what the failures show, and the affected tasks are named. |

A win in the pilot supports "in this pilot, on these 8 tasks". It does not support "faster" or "cheaper" in general.

## 11. Threats stated in advance

* 8 tasks and one repeat give wide intervals. Task difficulty is unevenly spread on purpose, so per task reading matters more than the aggregate.
* The tasks are small and in the style of open source Node.js changes. They say little about large repositories.
* Some task shapes may be familiar to the models from training data. The tasks are our own and unpublished until the freeze, which limits but does not remove this.
* Arm A and the board arms use different model mixes. Differences mix the system and the models.
* Quota noise: the account runs only the pilot, and meter readings are reported with a noise note.
* The experimenter wrote the tasks and the hidden tests. A second reviewer reads each hidden test before the freeze.

## 12. Deviations

The report contains a section "Deviations from this preregistration". If it is empty, the report says "none".
