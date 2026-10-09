# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

* **Claude Code plugin.** The repository is a Claude Code plugin and marketplace: `/plugin marketplace add canerganis/agent-orchestra-board`, then `/plugin install agent-orchestra-board@agent-orchestra-board`. Its skill opens the board for the current project and runs a Council or an Ask from the chat through `scripts/orchestra.mjs`, which also works from a terminal (`start`, `status`, `council`, `ask`). Council and Ask stay read-only.

## [0.2.0] (2026-10-09)

The board gets four modes (Ask, Council, Workflow, Runs), Plan → Approve → Build with a choice of who builds, and a containment gate for file edits. Writes happen only in per-item git worktrees. Claude write seats have no shell and need a passed write check; Codex never edits files and builds through checked diffs instead. No migration is needed: existing rooms, seats and routes keep working. Every earlier write check is void, because check records moved out of the project: run the check once more for Claude.

### Added

* **Four modes in the sidebar.** Ask (one model), Council (the old Debate), Workflow (Plan → Approve → Build and Single task review) and Runs. Keys `1` to `4` switch modes and `N` starts something new. Each mode lists only its own rooms, from a new room index of the newest 500 rooms, so older rooms no longer vanish behind the 25 room cap. With no CLI installed, Home still shows the mode cards, disabled, each with its reason as text.
* **Ask.** One model at a time, picked by model id, vendor and seat. Switching the model gives the new one a short recap in its first prompt, with no extra call. Legacy Direct chats are listed under Ask. `POST /api/ask`.
* **Council to Workflow.** A finished Council has *Turn into Workflow*: the plan starts from its synthesis and skips the plan debate (`POST /api/plan` with `councilId`).
* **Plan → Approve → Build.** A manager seat writes a plan of 1 to 30 items: goal, title, spec, owner paths, dependencies and a difficulty tier. Nothing is built before you approve a plan revision, and the approval is bound to that revision's hash. It works with one CLI and one seat: a role with no agent falls back along a fixed chain. The plan card shows *Before you build* (`GET /api/preflight`): the git state, uncommitted changes and which CLIs may edit files.
* **Engines: who builds the plan.** *Board team* (default) runs the build on your seats behind the write gate. *Claude Code, you run it* and *Codex, you run it* are external: the board writes a handoff file under `.orchestra/handoff/` and a prompt to paste into your own CLI, finds the run by its code, links it after one click, mirrors its agents live (each Codex sub-agent with its sandbox) and shows what changed when it ends, with read-only git. The board never starts or stops an external run. `POST /api/run`, `GET /api/run/:id/candidates`, `POST /api/run/:id/link`, `POST /api/run/:id/unlink`.
* **Role tiers.** A board build maps the manager, hard, medium, easy and reviewer roles to agents. The plan and build code name no model or seat. A reviewer that is the builder is replaced by the next different agent; with one agent, the builder reviews its own work and the room says so.
* **Per-item git worktrees** under `.orchestra/worktrees/<build>/<item>`. They are detached and start from the build's base commit plus the frozen patches of the items the item depends on.
* **Frozen proposals with sha256.** After each builder turn the worktree changes are staged and saved as `.orchestra/proposals/<build>/<item>-r<round>.patch`. The review is bound to that hash. A worktree that changes after the freeze voids the review.
* **Apply and Discard with preconditions.** Apply checks a fixed list of conditions (build not running, a passing review of the current hash, plan approval, dependencies applied, a clean checkout, the expected base commit, `git apply --check`), then runs `git apply --index`. The change is staged and never committed. Discard removes the item's worktree and keeps its patch file.
* **Codex patch mode.** A Codex write seat builds read-only and ends with a unified diff. The board checks it (size, owner paths, no `.git` or `.orchestra`, no absolute or `..` paths, no symlink or submodule modes) and applies it inside the item's worktree, where it is frozen and reviewed like any other change. The agent editor lets a Codex seat opt in.
* **Patch export in propose mode.** Each passing item exports its diff as a checked patch file with a sha256 and the `git apply` commands to copy. Untested, never applied by the board.
* **Runs (experimental).** A live, read-only list of Claude Code Workflow runs for this project or for all projects, with phases, agents, models, statuses, tokens and tool counts. It reads Claude Code's own files by polling, keeps no prompt or result text, and loads 400 character previews on demand only. `GET /api/wf/runs`, `GET /api/wf/runs/:id`, `GET /api/wf/runs/:id/agents/:aid/preview`, setting `watchScope`.
* **Write check with proof of an attempt.** The check asks the CLI to write one file inside its worktree and two outside it (an absolute path and a `../` path). It passes only when the inside file exists, nothing escaped, and the CLI's own tool log shows both outside writes were tried and refused. A check without that proof is `inconclusive` and leaves writes off.
* **`doctor --containment`.** An opt-in command that runs the real Claude and Codex CLIs on cheap models in a temporary repository and reports whether they keep writes inside the worktree (inside, absolute, `../`, prefix sibling, `CANARY.txt`, the worktree's `.git` file, links, and Windows `\\?\` and UNC paths), and whether a read-only Codex seat can start sub-agents. It prints its plan and runs only with `--yes`, refuses under `CI` or `GITHUB_ACTIONS`, never touches your project and never writes a check record. Plain `doctor` never runs it.
* **CLI states.** `doctor` reports a `state` per CLI (`ok`, `warn`, `broken`, `missing`) that drives which pickers and engines are offered, and warns when `ORCHESTRA_CLAUDE_BIN` or `ORCHESTRA_CODEX_BIN` is set.
* **`demo`.** `agent-orchestra-board demo` opens the board on a temporary sample project with recorded rooms (a Council, a plan and a build waiting for you). No CLI is needed and no agent or model runs. The rooms are recorded from a real run on 2026-10-09 (`bench/record-demo.mjs`, Haiku builds, Luna reviews): a Council, an approved plan, and a build where one item passed with a patch that `git apply --check` accepts and the other was stopped as needs-artifact because the model's patch was corrupt. The demo banner says so.
* **Ledger.** `.orchestra/ledger.jsonl` records every build, review, fix, check, apply and discard with model, effort, tokens of that turn and time, never prompt or result text. `node bench/ledger-report.mjs` prints tokens per accepted change and first pass rates per model.
* **Acceptance checks (off by default).** A plan can carry check commands per item when you turn checks on for that plan. They run after the change is frozen and before any review, so a failing check goes back to the builder without spending a review. See Security.
* **Change receipts.** `src/receipt.js` binds the plan hash, the patch sha256, the reviews of that exact hash, the checks and the containment result into one receipt with its own hash, and `verifyReceipt` recomputes it.
* **Groundwork for v0.3, not used by the UI yet.** Router modules (task classifier, model prior and ladders, profiles with a shadow score), a decision inbox, and read-only adapters for the Google Antigravity CLI (`agy`, which serves Gemini and Claude models on Antigravity's own quota; parsing checked against one real turn of agy 1.2.17 on Windows) and the Cursor CLI (`agent` 2026.10.01, read-only ask mode; checked against one real turn and one resume on Windows).
* **API version 2.** `GET /api/state` carries `apiVersion: 2`, `roomIndex`, `engines` and `watch`; `GET /api/rooms/:id` returns one room in full. New SSE events `engines`, `engine`, `wfRuns`, `wfRun`. See [docs/api.md](docs/api.md).

### Fixed

* A seat update through the API that left out `agent` turned a Claude seat into a Codex seat and reset its effort and permission. Fields left out now keep the seat's values. The real demo recorder found this.
* Read turns now tell the agent it may read files and run read-only commands.

### Changed

* `npm test` now parses real output. `test/fixtures/real/` holds recordings from 2026-10-09 of Claude Code 2.1.291 (claude-haiku-5-5), Codex CLI 0.160.0 (gpt-6-luna low) and the Google Antigravity CLI agy 1.2.17 (gemini-3.8-flash-low), made with the board's own read-only arguments. `test/real-fixtures.test.js` parses all of them, and the fake CLI replays them for normal turns. Synthetic lines remain only for edge cases (errors, broken JSON, hangs). CI runs this on Linux, macOS and Windows with Node 20, 22 and 24.
* An opt-in suite runs the real CLIs: `OB_REAL=1 npm run test:real`. On 2026-10-09 on Windows 11 it passed 12 of 12: a read-only turn and a resume for Claude Code, Codex, Antigravity (agy) and Cursor, a two seat Council that reached a synthesis, and a Propose and Review chain (Haiku proposes, Luna reviews). About 88k net tokens and 0.11 USD. It never runs in CI.
* Write seats no longer edit the project directly. A write turn runs only in a Build item's worktree, and only when the gate allows that seat and directory. The v0.1 path that let a Claude write seat edit any file in the project is removed.
* Ask, Council and Propose → Review are read-only. A write seat in one of them runs read-only, and Propose → Review says so in the room.
* Debate is called Council in the UI. Room kinds, routes and stored rooms are unchanged.
* The Start build dialog has a Mode choice: Automatic (the default: write when every builder may, else propose), Write, or Propose.
* `.orchestra/.gitignore` also lists `worktrees/` and `capability.json`. An existing ignore file gets the lines on the next start.
* `GET /api/state` includes `capability`. Plan and build completions are added to `.orchestra/LOG.md`.
* Model names must start with a letter or a digit, so a model name can never be read as a flag.
* `POST /api/rooms/:id/stop` on an external run room unlinks it; the user's run is never stopped.
* Apply runs as one serialized transaction and reports `state-not-saved` instead of swallowing a failed save. A failed apply can be retried after the checkout is fixed, and resume re-resolves a builder seat that was deleted or changed.
* Prompts put their stable part first so it hits the prompt cache. The scout brief reaches every build item, and review rounds after the first send only the change since the last round and the open findings.
* Usage meters time each window from the reading that produced it. A reading from before a reset, or with no observation time, is never shown as current.
* `doctor` checks logins with `claude auth status` and `codex login status` instead of reading credential files.
* Home shows file edit status in one line with Details, and the four modes in one row.
* Test servers bind OS assigned ports and every wait has a deadline, so the suite no longer collides or hangs.

### Security

* **Codex file edits are off on every platform.** The check has not run on a real Mac or Linux machine. No Codex turn gets write access, the write check refuses Codex seats (`409 unsupported-platform`, nothing spawned), and no setting, flag, environment variable or seat field turns Codex edits on. Codex seats read, review and build through patch mode.
* **Claude write turns have no shell.** They run in the item worktree with `--tools Read Grep Glob Edit Write`, `--permission-mode acceptEdits`, `--strict-mcp-config` and `--setting-sources ""`. The static check compares every `--flag=value` by name and refuses `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--add-dir`, `--allowedTools`, `--settings`, `--mcp-config`, `--plugin-dir`, `--agents` and `--permission-prompt-tool`, a second or different `--permission-mode`, and any `--tools` value outside the five tools or naming a shell.
* **Turn-time enforcement.** Before a write turn spawns, the board checks that the worktree is a registered board worktree, strictly inside `.orchestra/worktrees/`, not a link, equal to the turn's working directory, and that the real argv passes the static check. At the start of a Claude write turn the CLI's own report must list only the allowed tools, the worktree as its working directory, `acceptEdits` and no MCP server; anything else, or any event before that report, kills the turn, ignores its later output and turns Claude writes off for the session. A write turn resumes only a thread born in the same worktree. Containment failures are never retried.
* **Check records outside the project.** Records live in one per-user file (`%APPDATA%\agent-orchestra-board`, `~/Library/Application Support/agent-orchestra-board` or `~/.config/agent-orchestra-board`), written atomically, and bound to the CLI version, platform, write flags, the CLI binary (realpath, size, modification time), the host and the user. Any drift voids the record. `.orchestra/capability.json` is never read again.
* **Git and worktree hardening.** The worktree's `.git` file is never trusted: every git call on a board worktree passes `--git-dir` and `--work-tree` explicitly, and a changed `.git` file during a turn counts as a change outside the worktree. Worktrees are created with `core.symlinks=false`, a write turn refuses a worktree that holds a symbolic link or junction, and `core.hooksPath` points at a path that never exists. Git calls on the build path also disable the fsmonitor, external diff and textconv drivers, signing, and inherited `GIT_*` location variables.
* **Runtime containment guard.** Around each builder write turn the board fingerprints the main checkout and the other board worktrees. A change quarantines the item, stops the build and turns writes off for that CLI until its write check passes again.
* **Runs and external runs are read only.** The board reads Claude Code and Codex files under `CLAUDE_CONFIG_DIR` (or `~/.claude`) and `CODEX_HOME` (or `~/.codex`), checks every id before any file access, resolves every path under the data folder and skips symbolic links. It keeps only whitelisted fields: no prompt or result text, and never the account ids in Codex session metadata.

### Known limitations

* External runs (*Claude Code, you run it*, *Codex, you run it*) are outside the write gate and can edit your checkout with your own CLI settings. The board labels them, shows each Codex sub-agent's sandbox and shows what changed; it cannot prevent anything.
* Runs and the external engines parse undocumented Claude Code journals and Codex rollouts, which can change with any CLI update.
* `doctor --containment` was run once with the real CLIs on Windows 11 (claude-code 2.1.291, codex-cli 0.160.0). The Claude cases were inconclusive because the model did not attempt the outside writes, so Claude write seats still need a passed write check. See [SECURITY.md](SECURITY.md#containment-evidence).
* A read-only board Codex seat could start a sub-agent even with `features.multi_agent=false`. In that run the sub-agent inherited the read-only sandbox.
* Codex loads your global `~/.codex` AGENTS.md, skills list and multi agent prompt even with `--ignore-user-config`. Personal instructions such as a reply language can override the board's instructions and add input tokens to every Codex turn.
* Real CLI runs have only been done on Windows 11.
* Acceptance checks run your plan's commands unsandboxed with your permissions, which is why they are off by default. On Windows, background processes a check starts may outlive it.
* The home screen is built for desktop browsers and overflows at phone width.
* The runtime guard detects changes; it does not prevent them. It does not see ignored files, files outside the project, or a change that is undone before the turn ends. Its main-checkout fingerprint excludes `.orchestra/`.
* A plan item's `seatId` overrides the tier mapping, also when the manager set it, and the plan table does not show it. Check the plan JSON before you approve.
* The write check runs one prompt once, on one machine. It is evidence for that CLI version, not a proof of the sandbox in general.
* `npm test` never spawns a real CLI. Only the opt-in `OB_REAL=1 npm run test:real` does, and it has been run on Windows 11 only.
* A build that quarantines an item ends with status `error` and cannot be resumed. Delete it (this removes its worktrees and proposals) and start a new one after the write check passes.
* Starting a write build needs a clean checkout. Apply stages changes and never commits: review `git diff --cached` and commit yourself.
* Launching Claude Code or Codex runs from the board is not part of this release; Codex launch is planned for v0.3.

## [0.1.0] (2026-10-08)

First public cut.

### Added

* **Claude Haiku 5.5** (`claude-haiku-5-5`) on day one: listed in the Claude model list (the other models stay), the default model for the usage probe, and the default model of a Claude scout in the New session modal. Checked against the real CLI on 2026-10-08 (Claude Code 2.1.291) in a live two-CLI debate, Direct chat across a server restart, and a Propose -> Review. Older CLIs may print an `unrecognized_model` warning for this id; the turn still succeeds. Warnings on stderr or non-JSON lines are never read as errors (covered by tests). If a CLI rejects the id, the usage probe retries on `claude-haiku-4-5-20251001`; for a scout, pick another model in New session.
* **Per-session overrides** in *New session*: optionally set the model and effort of each participant (Debate and Propose -> Review) for that session only. Stored on the room (so *Run again* keeps them), validated like seats (a CLI model name, an effort the seat's CLI supports; otherwise 400). Seat defaults are unchanged.
* **Cap effort in discussion rounds** setting (Settings, on by default): when on, Debate discussion rounds run at `medium` at most; when off, every turn uses the seat's own effort. Persisted in `.orchestra/settings.json` as `capEffort`.
* Seats: Claude Code (`claude -p --output-format stream-json`) and Codex (`codex exec --json`) agents with name, role, model, effort, permission (`read` default, `write` opt-in), target scope, token budget and colour; resumable per-seat threads.
* Workflows: **Debate** (optional scout brief, parallel round 1, unseen-only discussion rounds, early stop on `STANCE: CONVERGED`, silent agreement, facilitator synthesis appended to `.orchestra/BRAINSTORM.md`), **Propose -> Review** (`VERDICT: PASS/FAIL` loop, `git diff` for write builders, optional effort escalation, user notes delivered to the next turn) and **Direct chat**.
* Live UI over Server-Sent Events: seat status and activity, streamed text, tool-call lines and failed-turn errors, per-room net vs cached tokens and cost. English UI; agents reply in a configurable language (`ORCHESTRA_LANG`, Settings).
* Usage meters: Claude from `rate_limit_event` plus an on-demand Haiku probe; Codex from the newest `~/.codex/sessions` rollout file (30 s poll).
* Token-lean launch: no user plugins, MCP servers, skills, hooks or extra tool families; per-mode `--tools`; codex no-tools turns run in an empty cwd. Observed (not reproducible from this repository, no raw per-call captures saved): Claude baseline 36k -> 6.7k tokens per call, Codex 24k -> 15k. Observed once: the same 4-agent meeting 1.69M -> 0.46M tokens (73% fewer); n = 1 per arm, not a benchmark (see the README's measurement caveats).
* Security gate: binds `127.0.0.1`; `Host`/`Origin` allowlist; JSON-only `POST` with a 1 MB cap and validated bodies; per-project session token (`.orchestra/session`, kept out of git by a generated `.orchestra/.gitignore`) printed in the start URL and exchanged for an `HttpOnly; SameSite=Strict` cookie that every `/api/*` request needs; CSP and `no-store` headers; static files only from `public/`; seat targets confined to the project via `realpath`.
* Windows fixes: `-c windows.sandbox="unelevated"` and a `PATH` without `WindowsApps` for Codex children; `taskkill /T /F` to stop a seat's process tree.
* CLI: `agent-orchestra-board [projectDir] [--port <n>] [--open]` (also `aob`) (exit 2 when `projectDir` is missing or not a directory, so a typo never creates a project), `agent-orchestra-board doctor [projectDir] [--json]` (Node, CLIs and logins, Windows sandbox, port, state dir; exit 1 on failure), `--version`, legacy `node server.js [projectDir] [port]`; Ctrl+C stops running turns before exiting; `PORT`, `ORCHESTRA_CLAUDE_BIN`, `ORCHESTRA_CODEX_BIN`, `ORCHESTRA_LANG`, `ORCHESTRA_RETRY_DELAYS_MS`, `ORCHESTRA_IDLE_MINUTES`, `CODEX_HOME` env overrides.
* CLI version detection (`<bin> --version`, cached) surfaced to the UI and doctor; readable failure messages for a missing binary or an exit without a result.
* Module layout under `src/` (adapters, runner, seats, rooms, workflows, limits, store, target, platform, doctor) with `node:test` unit tests for the adapter contracts.
* Project docs: README, LICENSE (MIT), SECURITY, CONTRIBUTING, `docs/api.md`, `docs/ARCHITECTURE.md`, CI on Ubuntu/macOS/Windows with Node 20, 22 and 24.
* Workflow status: a Propose -> Review whose builder cannot run ends `error` (not `needs-you`), and a Debate in which every turn failed ends `error` (not `done`).
* Setup card: a CLI that no seat uses is shown as *Optional* instead of blocking; a blocked CLI names the seats that depend on it; the *New session* defaults and team presets are built from seats whose CLI passed the check. The agent editor shows a seat's permission (read-only display; write is enabled in `.orchestra/seats.json` or via `POST /api/seats`) and preserves it on save.
* Product and package name **Agent Orchestra Board** / `agent-orchestra-board`, renamed from `orchestra-board` because that npm name belongs to an unrelated project (`npx orchestra-board` would run it). Bins: `agent-orchestra-board` and `aob`, both pointing at `bin/agent-orchestra-board.js`. The package is not published to npm yet; until it is, install by cloning.
* Docs: `docs/ARCHITECTURE.md` (module map, data flow, turn lifecycle, threads, token-lean levers, security model), `docs/decisions/` (five ADRs: decisions by the project owner, records drafted by agents), `docs/measurements/2026-10-07/` (sanitized room files and `summarize.mjs` behind the 1.69M -> 0.46M figure) and `bench/` (`token-bench.mjs`, a repeatable lean-vs-naive comparison; uses the implemented `ORCHESTRA_NAIVE=1` flag, and `GET /api/state` reports `naive`). `ORCHESTRA_NAIVE=1` is a benchmark-only switch that turns the token levers off.

### Security

* Every child process of the board (`claude`, `codex`, their `--version` probes, the Claude usage probe, `git`, `taskkill`, the browser opener) is resolved on `PATH` (or at `ORCHESTRA_*_BIN`) and started by absolute path (`platform.spawnResolved`). Before this, on Windows a `claude.exe` or `codex.exe` at the root of the project (or of a seat's target directory) ran as the CLI on the first turn, even for a read-only seat, because libuv looks in the child's working directory before `PATH` unless `NoDefaultCurrentDirectoryInExePath` is set. The board now also sets that variable for itself on Windows (children do not inherit it unless the user had it), `doctor` points out a CLI-named executable in the project, and `test/spawn.test.js` plants such files and proves they never run.

### Known limitations

* Usage meters are experimental; both source formats are undocumented.
* A server restart stops turns in flight.
* CLI stream formats can change. Developed against Codex CLI 0.160.0 and Claude Code CLI 2.1.291; the lean launch flags are verified by unit tests on the argument lists, and a paid smoke test (one Direct chat per CLI plus one usage refresh) is part of the release checklist, not of CI.
* One session token per project (persisted in `.orchestra/session`); no remote or multi-user access.

[0.2.0]: https://github.com/canerganis/agent-orchestra-board/releases/tag/v0.2.0
[0.1.0]: https://github.com/canerganis/agent-orchestra-board/releases/tag/v0.1.0
