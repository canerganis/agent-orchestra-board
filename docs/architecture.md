# Architecture

One Node process, no dependencies, no build step. `bin/orchestra-board.js` parses the CLI and calls `src/server.js`, which wires the modules below around a single project directory and its `.orchestra/` state.

```
browser (public/)  <-- SSE /api/events, JSON /api/* -->  src/server.js
                                                             |
            seats.js --- runner.js --- adapters/{claude,codex}.js --> platform.spawnResolved(claude | codex)
               |            |  |
            store.js     limits.js  target.js / platform.js
               |
            rooms.js --- workflows/{meeting,chain}.js
```

## Modules

| File | Responsibility |
| --- | --- |
| `bin/orchestra-board.js` | CLI entry: `[projectDir] --port <n> --open`, legacy positional port, `doctor` subcommand. Exports `main(argv)`, `parseArgs(argv)`. |
| `server.js` | Root shim so `node server.js . 4317` keeps working; delegates to `bin`. |
| `src/server.js` | `createServer({projectDir, port})`: static files from `public/`, SSE, security gate (Host/Origin, session cookie, JSON-only validated POST, security headers), every API route. |
| `src/security.js` | Session token and cookie helpers, security headers (CSP, nosniff, no-referrer, no-store), request body validators; its header holds the threat model. |
| `src/config.js` | Models, efforts, colours, default seats, persisted seat fields, lean CLI flags, probe model, env overrides, settings defaults. |
| `src/store.js` | `.orchestra/` paths and JSON/text persistence (`seats.json`, `rooms/`, `limits.json`, `settings.json`, `LOG.md`, `BRAINSTORM.md`); `ensure()` creates the directory and a `.gitignore` for `session`. |
| `src/seats.js` | Seat definitions plus runtime map (status, activity, child process, queue, roomId); upsert validation, thread reset, delete. |
| `src/runner.js` | One CLI turn per seat: per-seat queue, spawn via adapter, thread bookkeeping, token/cost accounting, `run`/`delta`/`item`/`end` events, `stopSeat`. |
| `src/adapters/claude.js` | `claude -p --output-format stream-json` args (lean flags, `--tools` per mode, `--session-id`/`--resume`, `--add-dir`, `acceptEdits`) and JSONL -> normalized events; Haiku probe args. |
| `src/adapters/codex.js` | `codex exec --json` / `codex exec resume <id>` args (lean flags, model, effort, `sandbox_mode`, `windows.sandbox=unelevated`) and JSONL -> normalized events. |
| `src/adapters/versions.js`, `diagnose.js`, `jsonl.js` | `<bin> --version` detection (cached, SSE `cli` event), readable failure messages for spawn errors and result-less exits, JSONL splitting. |
| `src/rooms.js` | Rooms (meeting, chain, dm): load `rooms/*.json` (an unreadable file is skipped and logged), post/say/sys/user messages, usage roll-up, context builder, stop, delete, Direct chat. |
| `src/workflows/meeting.js` | Debate: scout brief -> parallel round 1 -> unseen-only rounds with `STANCE: CONVERGED` early stop and silent agreement -> synthesis to `BRAINSTORM.md`. |
| `src/workflows/chain.js` | Propose -> Review: builder proposal or edits, `git diff` for write seats, `VERDICT: PASS/FAIL` loop, effort escalation, user notes. |
| `src/limits.js` | Usage meters: Claude from `rate_limit_event`, Codex from the newest rollout under `$CODEX_HOME/sessions` (default `~/.codex`; 30 s poll, unref'd), `limits.json`, Haiku probe. |
| `src/target.js` | Seat target scope: `confineTarget` (realpath inside the project), directory listing, prompt preface, cwd resolution, `git diff` including untracked files. |
| `src/platform.js` | The only module that requires `child_process`. `spawnResolved` / `execFileResolved` resolve a program name on `PATH` (`resolveBin`, `.com`/`.exe` only on Windows; `.cmd`/`.bat` are shims) and spawn the absolute path, so the child's cwd (the project) can never supply the executable; `NoDefaultCurrentDirectoryInExePath=1` for the board process on Windows. Windows fixes: Codex `PATH` without `WindowsApps`; process-tree kill (`taskkill /T /F`, else `SIGTERM`). |
| `src/doctor.js` | Environment checks (Node, CLIs and logins, Windows sandbox, PowerShell, port, project, state dir) for `orchestra-board doctor` and `GET /api/doctor`; spawns only `<cli> --version`. |
| `src/util.js` | Stateless helpers: ids, timestamps, clipping, last line, JSONL feeder. |
| `public/index.html`, `app.css`, `app.js` | Markup, styles (tokens, layout, state animations, reduced motion) and the plain-script frontend (state, rendering, SSE client, API calls). |
| `test/helpers.js`, `test/fake-cli/`, `test/fixtures/` | Shared test support: temp projects, in-process server on 4390-4394, cookie-aware HTTP/SSE client, isolated home dir; launchable fake `claude`/`codex` CLIs (POSIX `sh` wrappers, a compiled C# shim on Windows) driven by a scenario file; recorded JSONL fixtures. No real CLI anywhere in the suite. |
| `src/adapters/robust.test.js` | Adapter robustness tests kept next to the adapters; `node --test` picks it up too (so it ships in the npm package via `files: ["src"]`). |

### Tests (`node --test`, all under `test/` unless noted)

| File | Covers |
| --- | --- |
| `adapters.test.js` | Adapter contracts: `buildArgs` shape (lean flags, `--tools` per mode, Windows sandbox flag) and the normalized parser events. |
| `streams.test.js` | Parsers against recorded-style streams: whole feed vs arbitrary chunking, noise lines, usage/cached math, rate-limit passthrough, error paths. |
| `src/adapters/robust.test.js` | JSONL splitting, unknown schemas, usage fallback, spawn error messages, version detection. |
| `runner.test.js` | Runner against the fake CLIs (no HTTP): accounting, thread bookkeeping, tool modes, exit/error semantics, stop. |
| `meeting.test.js` | Debate end-to-end (port 4392): scout brief, parallel round 1, unseen-only rounds, user notes, early stop, silent agreement, synthesis to `BRAINSTORM.md`, failing seats. |
| `chain.test.js` | Propose -> Review end-to-end (port 4393): strict `VERDICT` parsing, escalation, user notes, round limit, builder failure (`error`), write-seat `git diff`. |
| `stop.test.js` | Stop semantics with hanging fake CLIs (port 4394): seat/DM/meeting stop, deleting a running room; the process tree really dies. |
| `security.test.js` | Security gate on a live server (port 4391): Host/Origin allowlists, JSON-only POST, session token and cookie, static confinement, body limits, headers, API validation. |
| `limits.test.js` | Usage meters: Claude windows from `rate_limit_event`, Codex windows from the newest rollout in an isolated home, persistence, SSE broadcast. |
| `doctor.test.js` | Binary resolution (PATH only, `.com`/`.exe`, `.cmd`/`.bat` shims), spawn failures, the `ORCHESTRA_*_BIN` note, a CLI-named file in the project, state-directory probe, login detection. |
| `spawn.test.js` | Spawn safety: a planted executable in the child cwd never runs (`spawnResolved`, `execFileResolved`, runner turns, version detection, usage probe, all with the real libuv lookup live); only `platform.js` requires `child_process`. |
| `cli.test.js` | `bin/orchestra-board.js` and the legacy `server.js` shim: argument parsing, real launches on 4395-4399, missing project dir (exit 2), `doctor --json`, `--help`. |
| `store.test.js` | `store.ensure()` writes `.orchestra/.gitignore` once; `rooms.load()` skips an unreadable room file and keeps the rest. |
| `util.test.js` | Stateless helpers: verdict/stance line extraction, clipping, JSONL splitting, ids. |

## One turn

1. A workflow (or a Direct chat) calls `runner.runSeat(seatId, prompt, opts)`. Turns queue per seat.
2. The runner resolves the tools mode: `opts.tools`, downgraded from `write` to `read` unless `seat.perm === 'write'`; default is the seat's permission. It resolves the target (cwd and prompt preface) unless `withTarget: false`, and finds the thread to resume (`room.threads[threadKey || seatId]`, or `seat.thread` for Direct chat).
3. The adapter builds argv. Claude: lean flags, `--tools` for the mode, `--session-id` for a new thread or `--resume` for an old one. Codex: lean flags, model, effort, `sandbox_mode`; no-tools turns run in `.orchestra/empty` so the shell tool has nothing to read.
4. The CLI's JSONL stdout goes through the adapter parser, which emits `thread`, `activity`, `delta`, `item`, `usage`, `rateLimit`, `completed`, `error`. The runner broadcasts `run`, `delta`, `item` and `end` over SSE and persists tokens, cached tokens and cost on the seat and room.
5. The result `{ok, text, tokens, cached, cost, error}` returns to the workflow, which marks the transcript as seen for that seat only if the turn succeeded.

## Where tokens are saved

- **Launch**: `CLAUDE_LEAN` / `CODEX_LEAN` in `config.js` strip plugins, MCP servers, skills, hooks, slash commands and extra tool families (Claude 36k -> 6.7k tokens per call; Codex 24k -> 15k).
- **Tools per mode**: discussion rounds and synthesis run with no tools (and round 1 too when a scout brief exists); the scout gets read tools; review turns, builder turns, Direct chat and a scout-less round 1 pass no `tools` option and so use the seat's permission (read tools for a `read` seat, edit tools for a `write` seat). Note that for Claude the target only narrows the prompt: cwd stays the project root, so a write seat can edit anywhere in the project; Codex write seats are sandboxed to the target cwd.
- **Threads**: the scout brief lives in its own thread so the files it read never ride along; each room has its own threads; a seat that already has a thread gets only the messages it has not seen.
- **Turns**: early stop on `STANCE: CONVERGED`; a seat whose unseen messages all converged is skipped; discussion rounds cap effort.
- **Accounting**: `tokens` is net (uncached input + output) and `cached` is reported separately, because cached input is billed at a discount and still counts toward plan limits; `cost` (Claude `total_cost_usd`; Codex reports 0) is the actual spend.

## Adding something

- A route: `handle()` in `src/server.js`, GET before the static fallthrough, POST after body parsing. Return `{error}` on failure.
- A CLI event: the adapter's `event()`; add a recorded line to `test/adapters.test.js`.
- A workflow: a `createX({store, seats, rooms})` in `src/workflows/` that drives `rooms.say()` and sets `room.status`; register the route and a room kind.
- An environment check: `src/doctor.js`, surfaced by `orchestra-board doctor` and `GET /api/doctor`.
