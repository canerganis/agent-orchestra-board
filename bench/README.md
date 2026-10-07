# bench: a repeatable token comparison

## Status, in one paragraph

The README quotes **1.69M -> 0.46M total tokens (-73%)** for the same 4-agent planning meeting. That figure is a **single before/after observation**: one run on the pre-redesign board, one run on the token-lean board 12 minutes later, same topic, same seats, same 2 rounds + synthesis. The raw rooms are in [`../docs/measurements/2026-10-07/`](../docs/measurements/2026-10-07/README.md) with the metric defined there; `node summarize.mjs` in that folder recomputes every number. It is **not** a benchmark result: n = 1 per arm, the baseline code is not in the repository (and had bugs that were fixed later), so the number mixes the token levers with every other change, and no lever has its own measured share. Early stop did not fire in the after run. `token-bench.mjs` is the tool to produce a repeatable number from the same commit. **No benchmark run with it has been published yet.** Quote its results only with the mean and min-max spread of a `--repeat 3` run.

## What is in this folder

| File | What |
| --- | --- |
| `token-bench.mjs` | zero-dependency Node (>= 20) script that runs the same Debate on a lean board and a naive board, waits over SSE, and prints a Markdown report with total / uncached / cached tokens, CLI-reported cost, wall time, rounds, early stop, per-agent and per-phase usage, usage-limit meters, and mean with min-max spread for `--repeat` runs. It only talks to the board's HTTP API, never spawns a CLI itself |
| `../docs/measurements/2026-10-07/` | the two sanitized room JSONs, `summarize.mjs`, and `README.md` with the metric definition and per-phase / per-seat tables |

## Terms

- **Total tokens**: all input tokens the CLIs reported, cache reads included, plus output. The 1.69M and 0.46M are total tokens; it is the only figure the pre-redesign board recorded (one undivided count per turn).
- **Uncached tokens**: the board's `tokens` field (Claude `input + cache_creation + output`; Codex `(input - cached) + output`). The UI labels it "net". After run: 204,374.
- **Cached tokens**: cache reads, reported separately by both CLIs. After run: 257,166. Not recorded by the before board, so not compared.
- **Cost**: Claude Code's `total_cost_usd` only; Codex CLI reports none. $1.02 -> $0.16 for the Claude turns, indicative only (the Claude model is not recorded per message).

## The naive flag: `ORCHESTRA_NAIVE=1`

A benchmark needs the baseline produced by the **same code**, not by an old commit, which is why the server has one switch, `ORCHESTRA_NAIVE=1` (`naive()` in `src/config.js`, read by the runner and `src/workflows/meeting.js`), that turns the token levers off. This script refuses to run unless the "naive" board reports `naive: true` in `GET /api/state`. `state()` in `src/server.js` returns `naive` (true only when the flag is set), so a correctly started naive board passes this check. `--allow-unverified-naive` skips it; use it only if you know the server runs naive.

What the flag does:

| Area | Lean (default) | Naive |
| --- | --- | --- |
| CLI token-trimming flags | `CLAUDE_TOKEN` / `CODEX_TOKEN` (`src/config.js`) | dropped (`--disable-slash-commands`, `--exclude-dynamic-system-prompt-sections`, Codex `features.*=false` and `web_search`). The isolation flags stay in both arms (`CLAUDE_ISOLATION` / `CODEX_ISOLATION`: `--strict-mcp-config`, `--setting-sources ''`, `--ignore-user-config`, `features.hooks=false`), so user MCP servers, plugins and hooks are off in both. `-c windows.sandbox="unelevated"` stays in both as well |
| Scout | optional, own thread, brief shared with everyone; a Claude scout's brief runs on `claude-haiku-5-5` unless its model is overridden (not the seat model) | ignored; every seat reads the code itself |
| Round 1 | `tools: 'none'` when a brief exists | read tools, target attached |
| Rounds 2..N | unseen messages only, resumed per-room thread, no tools, effort capped at `medium`, silent agreement skips | full transcript every turn on a fresh CLI thread, read tools, no effort cap, nobody skips |
| Early stop | when every seat says `STANCE: CONVERGED` | off: every planned round runs |
| Synthesis | facilitator gets only what it has not seen | full transcript, fresh thread |

The permission model (`--tools Read Grep Glob`, `sandbox_mode="read-only"`) is identical in both modes: the comparison is about token levers, not safety.

## Procedure for a real benchmark (not yet done)

1. Make sure `/api/state` reports `naive` (see above). Both boards must run the **same commit**. Use two clones of the repository at that commit as the project dirs (the fixed topic is a planning meeting about the agent-orchestra-board code itself, so anyone can reproduce it). One shared project dir also works, but then both boards share `.orchestra/`; do not use the UI on both at once.
2. Make the seats identical on both boards: copy `<leanProject>/.orchestra/seats.json` to the naive project after configuring the seats once (the script refuses on a mismatch of agent/model/effort/perm/target unless `--allow-seat-mismatch`). The default seats are 1 Claude + 3 Codex.
3. Start the two boards:

   ```sh
   # terminal 1: lean (normal)
   node bin/agent-orchestra-board.js /path/to/agent-orchestra-board-lean --port 4317
   # terminal 2: naive baseline
   ORCHESTRA_NAIVE=1 node bin/agent-orchestra-board.js /path/to/agent-orchestra-board-naive --port 4318
   # PowerShell: $env:ORCHESTRA_NAIVE='1'; node bin/agent-orchestra-board.js C:\path\agent-orchestra-board-naive --port 4318
   ```

   Each prints a start URL `http://localhost:<port>/?t=<token>`; the token is per project: it is stored in `<project>/.orchestra/session` and stays valid across restarts until you delete that file.
4. Preflight without spending anything:

   ```sh
   node token-bench.mjs --url "http://localhost:4317/?t=LEANTOKEN" --naive-url "http://localhost:4318/?t=NAIVETOKEN" --dry-run
   ```

   Checks: both boards reachable and tokens valid, the naive board reports `naive: true` and the lean one does not, participants exist on both with identical config, no seat busy or over budget, no room running. Prints the exact `POST /api/meeting` bodies.
5. Run at least three repeats, alternating the arm order to cancel warm-cache effects (`--order lean,naive` for one invocation, `--order naive,lean` for the next), or one invocation with `--repeat 3` and note the fixed order in the report:

   ```sh
   node token-bench.mjs --url "http://localhost:4317/?t=LEANTOKEN" --naive-url "http://localhost:4318/?t=NAIVETOKEN" --repeat 3
   ```

   Progress goes to stderr (one line per finished turn with uncached/cached tokens), the Markdown report to stdout and `results/<timestamp>/token-bench.md`, raw rooms/metrics to `token-bench.json` next to it. Exit code 0 when every run ended `done`, 1 on a failed or timed-out run, 2 for usage/preflight refusals.
6. Ablations, so each lever gets its own share (each is a separate lean-arm run against the same naive arm; record which):
   - `--scout none`: unseen-only transcripts + no-tools discussion rounds + lean flags + early stop, without the brief (round 1 then reads the code).
   - token-trimming flags only: not measurable with the current switch, which drops only the token-trimming flags and keeps isolation. The MCP/plugin/hook share of the per-call saving is outside what this bench measures; a separate switch (e.g. `ORCHESTRA_NAIVE=flags`) would be follow-up work.
   - early stop off: pick a topic where seats disagree, or compare the `Early stop` column across runs; it did not fire in the published observation anyway.
7. Publish `token-bench.md`, `token-bench.json`, the commit hash, and `claude --version` / `codex --version` (the script does not read CLI versions; the board announces them only on the SSE `cli` event at startup). Quote the mean with the min–max spread, never a single run. Until then every asset calls 1.69M -> 0.46M a single before/after observation.

**It spends real quota.** Every turn runs under your own Claude Code and Codex CLI logins; the naive arm is deliberately wasteful. The script asks for confirmation before starting (or `--yes`), supports `--dry-run`, and stops the running room on Ctrl+C.

## What `token-bench.mjs` measures, exactly

| Column | Source |
| --- | --- |
| Total tokens | uncached + cached (see Terms) |
| Uncached tokens | `room.usage.tokens` as the board computes it |
| Cached tokens | `room.usage.cached` |
| Cost | `room.usage.cost`: Claude Code's `total_cost_usd`. Codex seats contribute $0, so the column understates mixed meetings |
| Wall time | from the `POST /api/meeting` response until the first terminal `room` status (`done`, `stopped`, `error`); includes CLI start-up and per-seat queueing |
| Rounds run / planned | highest numeric `round` among seat messages vs `room.rounds` |
| Early stop | the system message carrying `earlyStop: <round>` |
| Turns (skipped, failed) | seat messages; system messages carrying `skip`; seat messages with `error` |
| Per agent / per phase | per `seatId`; `scout`, `round 1`, `round 2`, ..., `synthesis` from each message's `label` / `round` |
| Usage-limit meters | `state.limits.{claude,codex}.windows[*].pct` before the runs and after the last run of each arm (experimental readings; Claude's appears only after a Claude turn, Codex's comes from `~/.codex/sessions`) |
| Mean, min–max | added per arm when `--repeat` > 1; with fewer than 3 runs the report prints a reminder that it is an observation |

The authoritative numbers come from a final `GET /api/state` (25 newest rooms with messages); SSE is used to wait and to print progress, and a 15 s status poll protects against a dropped stream. A run that exceeds `--timeout-min` (default 45) is stopped via `POST /api/rooms/:id/stop` and reported as `timeout`.

## Fixed topic

A planning meeting about the agent-orchestra-board repository itself (per-room token budgets: where to enforce them, how to show them in `public/app.js`, what happens to queued turns, which tests to add; cite `file:line` or mark claims unverified). It exercises what the lean design optimises: the scout reads code once and the others argue from the brief, while the naive baseline has every agent read the code. Change it with `--topic` / `--topic-file`, but then say so in the report. The published observation used a different (Turkish) topic; see `../measurements/2026-10-07/README.md`.

## Options

```
--seats <id,id,...>       participants (default: every seat of the lean board; 2-20)
--scout <id|none>         lean arm only (default: first participant). 'none' is the no-brief ablation.
--synth <id|none>         facilitator for both arms (default: first participant)
--rounds <1-5>            default 2
--topic / --topic-file    override the fixed topic
--repeat <n>              default 1
--order lean,naive        or naive,lean
--timeout-min <n>         default 45
--out-dir <dir>           default ./results/<timestamp>/ next to the script
--allow-unverified-naive  skip the naive:true check (only if you are sure the server runs naive)
--allow-seat-mismatch     skip the identical-seats check
--dry-run, --yes, --help
```

## Limitations

- **Scout model confound.** With the default seats the lean arm's scout is the first participant, a Claude seat, so its brief runs on `claude-haiku-5-5` while the seat itself may be `claude-sonnet-5-5`. The naive arm has no scout. The cost delta therefore includes a model change on that turn, not only the token levers. Before quoting a comparison, pin the scout to the seat model (set the scout's model override in *New session*, or use a Codex scout), or report the delta with and without that turn. `token-bench` does not record the scout model in its report; write it into the report header by hand.
- Two boards are required because `ORCHESTRA_NAIVE` is read at server start; the script refuses one URL for both arms.
- The script does not read CLI versions; record them by hand in the report header.
- Cost is partial (Codex reports none). The script ships no price table; apply your own per-token prices to the per-agent uncached/cached columns if you need a dollar figure.
- The naive mode approximates "a board without the token-lean levers" on today's code; it is not a replay of the pre-redesign commit, which is not in the repository.
- A lean-flags-only ablation needs an extra switch (step 6).
