# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-07

First public cut.

### Added

- Seats: Claude Code (`claude -p --output-format stream-json`) and Codex (`codex exec --json`) agents with name, role, model, effort, permission (`read` default, `write` opt-in), target scope, token budget and colour; resumable per-seat threads.
- Workflows: **Debate** (optional scout brief, parallel round 1, unseen-only discussion rounds, early stop on `STANCE: CONVERGED`, silent agreement, facilitator synthesis appended to `.orchestra/BRAINSTORM.md`), **Propose -> Review** (`VERDICT: PASS/FAIL` loop, `git diff` for write builders, optional effort escalation, user notes delivered to the next turn) and **Direct chat**.
- Live UI over Server-Sent Events: seat status and activity, streamed text, tool/reasoning/error items, per-room net vs cached tokens and cost. English UI; agents reply in a configurable language (`ORCHESTRA_LANG`, Settings).
- Usage meters: Claude from `rate_limit_event` plus an on-demand Haiku probe; Codex from the newest `~/.codex/sessions` rollout file (30 s poll).
- Token-lean launch: no user plugins, MCP servers, skills, hooks or extra tool families; per-mode `--tools`; codex no-tools turns run in an empty cwd. Measured: Claude baseline 36k -> 6.7k tokens per call, Codex 24k -> 15k; the same 4-agent meeting 1.69M -> 0.46M tokens (-73%).
- Security gate: binds `127.0.0.1`; `Host`/`Origin` allowlist; JSON-only `POST` with a 1 MB cap and validated bodies; per-project session token (`.orchestra/session`, kept out of git by a generated `.orchestra/.gitignore`) printed in the start URL and exchanged for an `HttpOnly; SameSite=Strict` cookie that every `/api/*` request needs; CSP and `no-store` headers; static files only from `public/`; seat targets confined to the project via `realpath`.
- Windows fixes: `-c windows.sandbox="unelevated"` and a `PATH` without `WindowsApps` for Codex children; `taskkill /T /F` to stop a seat's process tree.
- CLI: `orchestra-board [projectDir] [--port <n>] [--open]` (exit 2 when `projectDir` is missing or not a directory, so a typo never creates a project), `orchestra-board doctor [projectDir] [--json]` (Node, CLIs and logins, Windows sandbox, port, state dir; exit 1 on failure), `--version`, legacy `node server.js [projectDir] [port]`; Ctrl+C stops running turns before exiting; `PORT`, `ORCHESTRA_CLAUDE_BIN`, `ORCHESTRA_CODEX_BIN`, `ORCHESTRA_LANG`, `CODEX_HOME` env overrides.
- CLI version detection (`<bin> --version`, cached) surfaced to the UI and doctor; readable failure messages for a missing binary or an exit without a result.
- Module layout under `src/` (adapters, runner, seats, rooms, workflows, limits, store, target, platform, doctor) with `node:test` unit tests for the adapter contracts.
- Project docs: README, LICENSE (MIT), SECURITY, CONTRIBUTING, `docs/api.md`, `docs/architecture.md`, CI on Ubuntu/macOS/Windows with Node 20, 22 and 24.
- Workflow status: a Propose -> Review whose builder cannot run ends `error` (not `needs-you`), and a Debate in which every turn failed ends `error` (not `done`).
- Setup card: a CLI that no seat uses is shown as *Optional* instead of blocking; a blocked CLI names the seats that depend on it; the *New session* defaults and team presets are built from seats whose CLI passed the check. The agent editor shows a seat's permission (read-only display; write is enabled in `.orchestra/seats.json` or via `POST /api/seats`) and preserves it on save.
- Package name `@0000can0000/orchestra-board` (the unscoped `orchestra-board` on npm belongs to an unrelated project; `npx orchestra-board` would run that one). The command installed by the package is still `orchestra-board`.

### Security

- Every child process of the board (`claude`, `codex`, their `--version` probes, the Claude usage probe, `git`, `taskkill`, the browser opener) is resolved on `PATH` (or at `ORCHESTRA_*_BIN`) and started by absolute path (`platform.spawnResolved`). Before this, on Windows a `claude.exe` or `codex.exe` at the root of the project (or of a seat's target directory) ran as the CLI on the first turn, even for a read-only seat, because libuv looks in the child's working directory before `PATH` unless `NoDefaultCurrentDirectoryInExePath` is set. The board now also sets that variable for itself on Windows (children do not inherit it unless the user had it), `doctor` points out a CLI-named executable in the project, and `test/spawn.test.js` plants such files and proves they never run.

### Known limitations

- Usage meters are experimental; both source formats are undocumented.
- A server restart stops turns in flight.
- CLI stream formats can change. Developed against Codex CLI 0.160.0 and Claude Code CLI 2.1.291; the lean launch flags are verified by unit tests on the argument lists, and a paid smoke test (one Direct chat per CLI plus one usage refresh) is part of the release checklist, not of CI.
- One session token per project (persisted in `.orchestra/session`); no remote or multi-user access.

[Unreleased]: https://github.com/0000can0000/orchestra-board/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/0000can0000/orchestra-board/releases/tag/v0.1.0
