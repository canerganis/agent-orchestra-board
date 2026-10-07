# ADR 0002: Scout brief and unseen-only transcripts

| | |
| --- | --- |
| Status | Accepted (v0.1.0) |
| Recorded | 2026-10-07, **retroactively**, by AI agents drafting from the commit history, `.orchestra/LOG.md` and the code; not written when the decision was made |
| Decision made | approx. 2026-10-07, in the token-lean pass that followed the first measured 4-agent meeting (`.orchestra/LOG.md` entry: "Token-lean orchestra: lean CLI flags, scout brief, no-tool rounds, per-room threads, early stop, net/cached accounting. A/B on same meeting: 1.69M -> 0.46M tokens (-73%)") |
| Decided by | Can Erganis (project owner). The record was drafted by agents; the decision was the owner's. The bugs listed under Consequences were found by an independent review pass run as a separate model session, then fixed |
| Evidence | the two room JSON files of the before and after run, sanitized copies in [`docs/measurements/2026-10-07/`](../measurements/2026-10-07/README.md) (`before.json`, `after.json`, `summarize.mjs`); `src/workflows/meeting.js`; tests listed below |
| Revisit when | a blind comparison with the rubric below shows the lean arm losing on citation accuracy or recommendation survival; early stop stops triggering in practice (meetings run every round); or the planned `TOOLS: READ` request line lands and changes who may read code |

## Context

The first Debate gave every seat read tools in every round and re-sent the full transcript each turn. Four agents read the same files, and each prompt grew with the meeting. The measured 4-agent planning meeting (default seats: 1 Claude + 3 Codex, 2 rounds + synthesis) cost ~1.69M **total tokens**: every input token the CLIs reported, cache reads included, plus output. That board recorded one undivided token count per turn (no `cached` field in `before.json`), so total tokens is the only like-for-like figure; the after run splits into 204,374 uncached + 257,166 cached = 461,540.

Per phase, from the two room files (`measurements/2026-10-07/`, `node summarize.mjs`):

| Phase | Before, total tokens (turns) | After, total tokens (turns) | After, uncached + cached |
| --- | --- | --- | --- |
| scout brief | none (no scout) | 71,762 (1) | 34,386 + 37,376 |
| round 1 | 739,970 (4) | 148,421 (4) | 79,026 + 69,395 |
| round 2 | 878,030 (4) | 229,130 (4) | 87,805 + 141,325 |
| synthesis | 68,111 (1) | 12,227 (1) | 3,157 + 9,070 |
| total | 1,686,111 (9) | 461,540 (10) | 204,374 + 257,166 |

The statement "mostly repeated input" that earlier drafts made was an impression from reading the per-turn numbers on screen, not a recorded breakdown. The scout brief was, by that same impression, the biggest saving; the other levers contributed but were not measured separately. **Early stop did not fire in the after run**: both planned rounds ran and no turn was skipped (the after run has one turn more than the before run, the scout), so early stop has no share in this number. Claude-reported cost for the three Claude turns went $1.02 -> $0.16 (Codex reports no cost; the Claude model is not recorded per message).

## Decision

`src/workflows/meeting.js` shares facts once, then sends deltas:

1. **Scout brief.** One optional seat runs first with `tools: 'read'` and writes a 350-word factual brief (file:line, constraints, unknowns, no opinions) on its own thread (`threadKey: scoutId + ':scout'`, `meeting.js`), so the files it read never ride along later.
2. **Round 1 without tools.** Every seat gets topic plus brief with `tools: 'none'` (`meeting.js`); Codex no-tools turns run in an empty cwd (`.orchestra/empty`, `src/runner.js`) so its shell tool has nothing to read. Without a scout, round 1 keeps `tools: 'read'`.
3. **Unseen-only rounds.** A per-seat `Set` of seen message ids (`meeting.js`). A resumed thread receives only `unseen(id)`; a seat without a thread (failed turn, facilitator) gets `background()` again (`meeting.js`). Ids are marked seen only after the turn returns `ok` (`meeting.js`).
4. **Early stop.** Replies end with `STANCE: CONVERGED|OPEN`; the check runs on `lastLine()` (`meeting.js`, `src/util.js`). When all seats converge, remaining rounds are skipped (`meeting.js`), and a converged seat whose unseen messages all converged skips its turn ("agreed silently", `meeting.js`). Discussion rounds cap effort at `medium` (added after the measured run; not part of the 1.69M -> 0.46M figure) (`meeting.js`).

## Consequences

Positive:

- Same meeting, one before/after run on one machine (Windows 11, Claude Code 2.1.291, Codex CLI 0.160.0, 2026-10-07), 12 minutes apart: ~1.69M -> ~0.46M total tokens (-73%); a single observation, not a benchmark. Whether the cached share moved is unknown (the before board did not record it); the dollar figure is Claude-only ($1.02 -> $0.16).
- Per-turn context is bounded by what is new, not by meeting length.

Quality, stated precisely:

- **One unblinded reading, n=1, no rubric.** Both outputs were read once. The lean run cited file:line and marked unverified claims; the original did not do so consistently. Nobody else scored them and no criteria were fixed in advance. Read this as "not visibly worse", not as a measured improvement.
- The citation evidence is weaker than it looks: round 1 and the discussion rounds run with `tools: 'none'` (`meeting.js`), so a seat's `file:line` reference is copied from the scout brief, not checked by that seat. It shows format discipline, not independent verification.
- Rubric for the next comparison, so the claim can become a measurement. Score both arms on the same meeting topic:
  1. **Citation accuracy**: share of `file:line` references in round-1 messages and the synthesis that resolve to the claimed content at the measured commit.
  2. **Factual errors**: wrong claims about the code found when spot-checking the same number of claims per arm.
  3. **Unverified marking**: share of code claims without a citation that are marked "unverified".
  4. **Recommendation survives review**: whether the synthesis recommendation is accepted, revised or rejected by a reviewer who reads it cold.
  Strip seat names and arm labels, shuffle, score blind, preferably by someone who did not run the meetings; report each score with its n. `bench/token-bench.mjs` collects tokens, not quality; the rubric is applied by hand to the room JSON it saves.

Negative (accepted):

- **The brief is a single point of failure.** Only the scout reads code; a shallow or wrong brief misleads every seat, and because the other seats have no tools they cannot verify it. Accepted for v0.1 because: the alternative (every seat with read tools, every round) is the design that cost 1.69M; the brief must cite file:line and list unknowns (`meeting.js`), which lets the human spot-check it; it is posted in the room before round 1 starts and the user can interject; and a scout-less Debate still gives every seat read tools in round 1 (`meeting.js`) for users who prefer verification over cost. Planned mitigation for v0.2: a seat may request read tools for its next turn with a protocol line (`TOOLS: READ`, same mechanism as `STANCE:`), charged to that seat's budget.
- **Early stop hangs on a fragile protocol line.** The review found markdown-wrapped stance lines (`**STANCE: CONVERGED**`) failing the regex; fixed by `lastLine()` stripping `*`, `` ` `` and `_` (`src/util.js`). A model that ignores the format silently disables the saving: the meeting simply runs every round. Tests: `test/util.test.js` (`lastLine` with a backtick-wrapped stance line, and the strict stance/verdict regexes); end to end, the test 'full debate: scout brief -> parallel round 1 ...' in `test/meeting.test.js` has Bob reply `**STANCE: CONVERGED**` and asserts that round 3 never runs. There is no end-to-end test for the backtick-wrapped form.
- **Lost context on failed turns.** The review found a failed turn marking its messages as seen, so the seat never received them. Fixed: ids join `seen` only when `res.ok` (`meeting.js`), and a seat without a thread gets `background()` again (`meeting.js`). Test: 'unseen-only is marked seen only after a successful turn: a seat whose discussion turn failed gets the same messages again next round, the others only what is new' in `test/meeting.test.js`. The rule that a seat without a thread (failed first spawn) receives `background()` again has no test of its own.
- Seen-tracking is room state coupled to thread resumption; a lost thread means a full re-send of `background()` plus everything unseen.
- The before/after numbers compare pre-redesign code (which also had bugs fixed later, and which is not in the repository: the earliest commit `c75d465` is already post-redesign) against the current code, so they do not isolate the token levers. A naive-mode flag on the same commit (`bench/README.md`, `ORCHESTRA_NAIVE=1`, now implemented in `src/config.js` and `meeting.js`, no benchmark run yet) is the way to get a clean comparison with `--repeat 3` and ablations.
- The tests named above live in `test/meeting.test.js` and run under plain `npm test` against the fake CLIs. There is no fix commit to link: the token-lean redesign and the review fixes predate the repository's first commit (`c75d465`, 2026-10-07 22:19 +03:00, already contains `lastLine()`, the seen-only-on-`ok` rule and per-room threads), so the tests above are the link, and the before-run room JSON is the only artifact of the pre-fix code.

## Alternatives considered

- **Full transcript every turn**: robust to lost threads, but this is the design that cost 1.69M.
- **Summarize each round**: an extra, lossy model call per round; CLI resume already remembers earlier turns on the seat's room thread.
- **Shared repo index / RAG**: rejected on structural grounds, not on measured numbers. It needs an embedding model plus a vector store or an index build step, i.e. a dependency or a build (conflicts with ADR 0001) and API keys for embeddings (conflicts with ADR 0005); an index goes stale between meetings while a brief is regenerated from the current tree each time; and retrieved chunks carry no `file:line` provenance unless more tooling adds it.
