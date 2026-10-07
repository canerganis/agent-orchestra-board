# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Claude Haiku 5.5** (`claude-haiku-5-5`) on day one: listed in the Claude model list (the other models stay), the default model for the usage probe, and the default model of a Claude scout in the New session modal. The id is **not verified against the real CLI yet**; the tests use a fake CLI. The CLI may print an `unrecognized_model` warning for this id. Warnings on stderr or non-JSON lines are never read as errors (covered by tests). The usage probe retries on `claude-haiku-4-5-20251001`; the Claude scout has no fallback.
- **Per-session overrides** in *New session*: optionally set the model and effort of each participant (Debate and Propose -> Review) for that session only. Stored on the room (so *Run again* keeps them), validated like seats (a CLI model name, an effort the seat's CLI supports; otherwise 400). Seat defaults are unchanged.
- **Cap effort in discussion rounds** setting (Settings, on by default): when on, Debate discussion rounds run at `medium` at most; when off, every turn uses the seat's own effort. Persisted in `.orchestra/settings.json` as `capEffort`.

## [0.1.0] - 2026-10-07

First public cut.

### Added

- Seats: Claude Code (`claude -p --output-format stream-json`) and Codex (`codex exec --json`) agents with name, role, model, effort, permission (`read` default, `write` opt-in), target scope, token budget and colour; resumable per-seat threads.
- Workflows: **Debate** (optional scout brief, parallel round 1, unseen-only discussion rounds, early stop on `STANCE: CONVERGED`, silent agreement, facilitator synthesis appended to `.orchestra/BRAINSTORM.md`), **Propose -> Review** (`VERDICT: PASS/FAIL` loop, `git diff` for write builders, optional effort escalation, user notes delivered to the next turn) and **Direct chat**.
- Live UI over Server-Sent Events: seat status and activity, streamed text, tool-call lines and failed-turn errors, per-room net vs cached tokens and cost. English UI; agents reply in a configurable language (`ORCHESTRA_LANG`, Settings).
- Usage meters: Claude from `rate_limit_event` plus an on-demand Haiku probe; Codex from the newest `~/.codex/sessions` rollout file (30 s poll).
- Token-lean launch: no user plugins, MCP servers, skills, hooks or extra tool families; per-mode `--tools`; codex no-tools turns run in an empty cwd. Observed (not reproducible from this repository, no raw per-call captures saved): Claude baseline 36k -> 6.7k tokens per call, Codex 24k -> 15k. Observed once: the same 4-agent meeting 1.69M -> 0.46M tokens (-73%); n = 1 per arm, not a benchmark (see the README's measurement caveats).
- Security gate: binds `127.0.0.1`; `Host`/`Origin` allowlist; JSON-only `POST` with a 1 MB cap and validated bodies; per-project session token (`.orchestra/session`, kept out of git by a generated `.orchestra/.gitignore`) printed in the start URL and exchanged for an `HttpOnly; SameSite=Strict` cookie that every `/api/*` request needs; CSP and `no-store` headers; static files only from `public/`; seat targets confined to the project via `realpath`.
- Windows fixes: `-c windows.sandbox="unelevated"` and a `PATH` without `WindowsApps` for Codex children; `taskkill /T /F` to stop a seat's process tree.
- CLI: `agent-orchestra-board [projectDir] [--port <n>] [--open]` (also `aob`) (exit 2 when `projectDir` is missing or not a directory, so a typo never creates a project), `agent-orchestra-board doctor [projectDir] [--json]` (Node, CLIs and logins, Windows sandbox, port, state dir; exit 1 on failure), `--version`, legacy `node server.js [projectDir] [port]`; Ctrl+C stops running turns before exiting; `PORT`, `ORCHESTRA_CLAUDE_BIN`, `ORCHESTRA_CODEX_BIN`, `ORCHESTRA_LANG`, `ORCHESTRA_RETRY_DELAYS_MS`, `ORCHESTRA_IDLE_MINUTES`, `CODEX_HOME` env overrides.
- CLI version detection (`<bin> --version`, cached) surfaced to the UI and doctor; readable failure messages for a missing binary or an exit without a result.
- Module layout under `src/` (adapters, runner, seats, rooms, workflows, limits, store, target, platform, doctor) with `node:test` unit tests for the adapter contracts.
- Project docs: README, LICENSE (MIT), SECURITY, CONTRIBUTING, `docs/api.md`, `docs/ARCHITECTURE.md`, CI on Ubuntu/macOS/Windows with Node 20, 22 and 24.
- Workflow status: a Propose -> Review whose builder cannot run ends `error` (not `needs-you`), and a Debate in which every turn failed ends `error` (not `done`).
- Setup card: a CLI that no seat uses is shown as *Optional* instead of blocking; a blocked CLI names the seats that depend on it; the *New session* defaults and team presets are built from seats whose CLI passed the check. The agent editor shows a seat's permission (read-only display; write is enabled in `.orchestra/seats.json` or via `POST /api/seats`) and preserves it on save.
- Product and package name **Agent Orchestra Board** / `agent-orchestra-board`, renamed from `orchestra-board` because that npm name belongs to an unrelated project (`npx orchestra-board` would run it). Bins: `agent-orchestra-board` and `aob`, both pointing at `bin/agent-orchestra-board.js`. The package is not published to npm yet; until it is, install by cloning. `bin/orchestra-board.js` remains as a deprecated alias of the same CLI.
- Docs: `docs/ARCHITECTURE.md` (module map, data flow, turn lifecycle, threads, token-lean levers, security model), `docs/decisions/` (five ADRs: decisions by the project owner, records drafted by agents), `docs/measurements/2026-10-07/` (sanitized room files and `summarize.mjs` behind the 1.69M -> 0.46M figure) and `bench/` (`token-bench.mjs`, a repeatable lean-vs-naive comparison; uses the implemented `ORCHESTRA_NAIVE=1` flag, and `GET /api/state` reports `naive`). `ORCHESTRA_NAIVE=1` is a benchmark-only switch that turns the token levers off.

### Security

- Every child process of the board (`claude`, `codex`, their `--version` probes, the Claude usage probe, `git`, `taskkill`, the browser opener) is resolved on `PATH` (or at `ORCHESTRA_*_BIN`) and started by absolute path (`platform.spawnResolved`). Before this, on Windows a `claude.exe` or `codex.exe` at the root of the project (or of a seat's target directory) ran as the CLI on the first turn, even for a read-only seat, because libuv looks in the child's working directory before `PATH` unless `NoDefaultCurrentDirectoryInExePath` is set. The board now also sets that variable for itself on Windows (children do not inherit it unless the user had it), `doctor` points out a CLI-named executable in the project, and `test/spawn.test.js` plants such files and proves they never run.

### Known limitations

- Usage meters are experimental; both source formats are undocumented.
- A server restart stops turns in flight.
- CLI stream formats can change. Developed against Codex CLI 0.160.0 and Claude Code CLI 2.1.291; the lean launch flags are verified by unit tests on the argument lists, and a paid smoke test (one Direct chat per CLI plus one usage refresh) is part of the release checklist, not of CI.
- One session token per project (persisted in `.orchestra/session`); no remote or multi-user access.

[Unreleased]: https://github.com/canerganis/agent-orchestra-board/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/canerganis/agent-orchestra-board/releases/tag/v0.1.0
