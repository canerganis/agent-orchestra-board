# Orchestra Board

A local control board that runs Claude Code and Codex CLI agents as a team and shows you the debate while it happens.

## Why

- **Two vendors, one table.** Seats are either `claude -p` or `codex exec`. Put an Opus architect, a GPT reviewer and a devil's advocate in the same debate; let a Claude builder and a Codex reviewer loop on one task.
- **Cost-aware by design.** Every turn is launched lean, agents only see what they have not seen yet, converged debates stop early, and every room shows net vs cached tokens and cost. The same 4-agent meeting went from **1.69M to 0.46M tokens (-73%)** after the token-lean pass.
- **Live and local.** A zero-dependency Node server streams each turn over SSE: who is thinking, writing, running a command, and what it costs. Nothing leaves your machine except the CLIs' own API calls.

## Quick start

Prerequisites: Node 20+ (20, 22 and 24 are tested), [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) logged in, [Codex CLI](https://github.com/openai/codex) logged in. One of the two is enough if all your seats use it: the board's setup card marks a CLI that no agent uses as *Optional*, and `doctor` still lists it as failed (ignore that line). The default team is one Claude seat and three Codex seats, so with only one CLI installed, open the other seats and switch their *Runtime* (or delete them) before the first Debate; the setup card names the affected seats, and the *New session* dialog proposes only seats whose CLI passed the check.

**Windows:** the board spawns the CLIs without a shell, so the `claude.cmd` / `codex.cmd` shims that `npm i -g` creates do not work (Node cannot start a `.cmd` file: not found, or `EINVAL`). Use the native installers (`claude.exe`, `codex.exe`), or set `ORCHESTRA_CLAUDE_BIN` / `ORCHESTRA_CODEX_BIN` to the full path of an `.exe` (for an npm Codex install that is the vendored `codex.exe` inside the package). `doctor` flags a `.cmd` shim with a warning and tells you which file it found.

```sh
git clone https://github.com/0000can0000/orchestra-board.git
cd orchestra-board
node bin/orchestra-board.js /path/to/your/project --open
```

The terminal prints a URL like `http://localhost:4317/?t=...`; open that one (or pass `--open`). The token in it is exchanged for a session cookie on first load, so plain <http://localhost:4317> works afterwards in the same browser.

The package is not on npm yet. When it is, it will be published under the scoped name `@0000can0000/orchestra-board` (`npx @0000can0000/orchestra-board`). **Do not run `npx orchestra-board`:** the unscoped name on npm belongs to an unrelated project with a similar idea, and `npx` would download and execute that package.

```
node bin/orchestra-board.js [projectDir] [--port <n>] [--open]   # projectDir defaults to the current directory and must exist (exit 2 otherwise)
node bin/orchestra-board.js doctor [projectDir] [--json]          # Node, CLIs and logins, Windows sandbox, port, state dir
node bin/orchestra-board.js --version | --help
```

Nothing puts an `orchestra-board` command on your `PATH` by default. Run `npm link` once in the clone (or `npm i -g .`) if you want the short form; the rest of this README writes `orchestra-board ...` for brevity, and `node bin/orchestra-board.js ...` is always equivalent.

Run `doctor` first if anything looks off: it only spawns `claude --version` / `codex --version`, never a billable turn, and exits 1 when a check fails. A CLI you do not have installed is such a failure, so with only one of the two installed expect one red line.

The board binds `127.0.0.1` only. All state lives in `<project>/.orchestra/`: `seats.json`, `rooms/`, `limits.json`, `settings.json`, `BRAINSTORM.md`, `LOG.md`, `empty/` (an empty cwd for no-tools Codex turns) and `session`, the board's session token. **Never commit `session`**: it is the password to this board (see [SECURITY.md](SECURITY.md)). The board writes a `.orchestra/.gitignore` that lists `session` and `empty/` on first start, so you can ignore the whole directory or commit the rest (transcripts, syntheses, log), your call.

## Workflows

```
Debate                         Propose -> Review                 Direct chat
------                         -----------------                 -----------
[scout brief] (read-only)      builder: proposal / edits         you <-> one seat
      |                              |                            (own thread,
 round 1: all seats, parallel  reviewer: BLOCKER/SHOULD-FIX/NIT    resumable)
      |                              |
 round 2..N: unseen msgs only   VERDICT: PASS  -> done
   every "STANCE: CONVERGED"    VERDICT: FAIL  -> builder again
   -> early stop                   (optional effort escalation,
      |                             your notes go to the next turn)
[facilitator synthesis]
   -> .orchestra/BRAINSTORM.md
```

- **Debate**: 2+ seats, 1-5 rounds, optional scout and facilitator. A seat that has nothing new to say is skipped ("agreed silently") instead of spending a turn. You can interject at any time; the next speaker reads it.
- **Propose -> Review**: a builder and a reviewer (different seats), up to 6 rounds. A read-only builder (the default) just proposes; a builder you set to `write` (see *Permissions*) edits files and the reviewer sees the `git diff`. Ends `passed`, `needs-you` (round limit without a PASS) or `error` (the builder could not run, for example a missing CLI).
- **Direct chat**: talk to one seat in its own resumable thread; use it to settle what a room left open.

## Token-lean design

Measured on 2026-10-07 with the default seats:

| Lever | Effect |
| --- | --- |
| Lean CLI launch (no user plugins, MCP servers, skills, hooks, slash commands or extra tool families) | Claude baseline **36k -> 6.7k tokens per call**; Codex 24k -> 15k |
| Per-mode tools: discussion rounds and synthesis run with no tools; the scout gets `Read`/`Grep`/`Glob` only; a review turn runs with the reviewer seat's own permission (read tools for a `read` seat) | no code re-reads during debate |
| Scout brief in its own thread, shared with everyone | files are read once, not once per seat |
| Per-room threads and unseen-only transcripts (marked seen only after a successful turn) | each turn carries only the delta |
| Early stop on `STANCE: CONVERGED`, silent agreement, effort cap for discussion rounds | fewer and cheaper turns |
| Net vs cached accounting (`tokens` = uncached input + output; cached input shown separately) | cached input is billed at a discount and still counts toward plan limits, so the two are kept apart; the cost column (Claude only, Codex reports 0) is the actual spend |
| **Same 4-agent meeting** | **1.69M -> 0.46M tokens (-73%)** |

Per-seat token budgets stop a seat once it has used its allowance.

## Permissions and safety

- **Read-only by default.** Seats start with `perm: read`. Claude gets `--tools Read Grep Glob`; Codex runs in `sandbox_mode=read-only`. Only a seat you explicitly set to `write` can edit files: Claude with `--permission-mode acceptEdits` (edits are auto-approved, no prompt) plus `Edit`/`Write`, Codex with `sandbox_mode=workspace-write`.
- **Enabling write is deliberate and outside the UI.** The v0.1 agent editor shows a seat's permission but has no toggle for it; saving a seat keeps its permission as is. To grant write: stop the board, set `"perm": "write"` on the seat in `<project>/.orchestra/seats.json`, start again (the seat's memory is reset because its first message fixed the permission), or `POST /api/seats` with `{"id": "<seat>", "perm": "write"}` from an authenticated client (see [docs/api.md](docs/api.md)). The home page and the agent editor then say which seats can edit.
- **How far a write seat is confined differs by CLI.** A Codex write seat runs with the target directory as its sandbox cwd, so its edits are confined to that directory. A Claude write seat always runs with the project root as cwd (Claude stores sessions per cwd), so `acceptEdits` can touch **any file in the project**; its target is a prompt-level instruction ("Your scope is ... Stay inside it."), not an enforced boundary. Neither CLI can write outside the project through the board, but treat a Claude write seat as having the whole project.
- **Local only.** The server listens on `127.0.0.1`. A request is served only if its `Host` is exactly `localhost:<port>`, `127.0.0.1:<port>` or `[::1]:<port>` (blocks DNS rebinding), any `Origin` is one of those (blocks cross-site requests), and every `POST` is `application/json` with type- and length-checked fields. Static files are served only from `public/`; responses carry a strict CSP and `no-store`.
- **Session token.** Each project gets a random token, kept in `<project>/.orchestra/session` (mode 0600) and printed in the start URL, exchanged for an `HttpOnly; SameSite=Strict` cookie, and required on every `/api/*` request. A web page you happen to have open, or another local process without your terminal, gets `401`. The cookie dies with the browser session; a restart of the board keeps it valid (delete `.orchestra/session` to rotate the token). Still: do not expose the port with a tunnel or reverse proxy.
- **Targets stay inside the project.** A seat's target is resolved with `realpath` and rejected if it points outside the project (`..`, absolute paths, symlinks out).
- **The project never supplies the CLI.** Every child process (`claude`, `codex`, their `--version` probes, `git`, `taskkill`) is resolved on `PATH` (or at `ORCHESTRA_*_BIN`) and started by absolute path. A `claude.exe` or `codex.exe` planted at the root of a repository you point the board at is never run, even though Windows would otherwise look in the child's working directory first; `doctor` points such a file out.
- **Costs are yours.** Turns run under your own Claude and Codex logins and count against your plans. The *Refresh Claude usage* button spawns one tiny Claude Haiku call (under $0.01: the lean launch is about 7k tokens) because that is the only way to read Claude's rate-limit window.
- The CLIs run with your user account's permissions. Keep write seats pointed at a target directory you are happy to let an agent edit, and review the diff.

## Limitations

- **Usage meters are experimental.** Claude limits come from the `rate_limit_event` in the stream; Codex limits are read from the newest rollout file under `$CODEX_HOME/sessions` (default `~/.codex/sessions`). Both formats are undocumented and may change.
- **A server restart stops running jobs.** Rooms are persisted, but a turn in flight is killed with the server; use *Run again* or *Continue in Direct chat*.
- **CLI output formats can change.** The adapters parse `claude --output-format stream-json` and `codex exec --json`. Developed against Codex CLI 0.160.0 and Claude Code CLI 2.1.291 (2026-10-07); run `orchestra-board doctor` after upgrading either. The lean launch flags are covered by unit tests on the argument lists, not by a paid run in CI.
- Windows is the primary development platform (Windows 11, Git Bash and PowerShell). macOS and Linux run the same code paths minus the Windows sandbox and process-tree fixes; the test suite runs on all three in CI (Node 20, 22 and 24), but they have had less manual testing.
- One session token per project (persisted in `.orchestra/session`, valid for every browser you open the printed URL in), one project per board, no remote access: v0.1 is a single-user local tool on purpose.

## FAQ

**Does it need an API key?** No. It shells out to the `claude` and `codex` CLIs you are already logged into. Point `ORCHESTRA_CLAUDE_BIN` / `ORCHESTRA_CODEX_BIN` at other executables if they are not on `PATH`.

**Which models?** The ones your CLIs offer. The seat editor suggests common names, but any name or alias your CLI accepts can be typed in; only a malformed name is rejected. Effort levels map to `--effort` (Claude) and `model_reasoning_effort` (Codex).

**Can agents reply in my language?** Yes. The UI is English; set *Settings -> language* (or `ORCHESTRA_LANG`) and every seat is told to reply in it.

**What does a seat see of my project?** The project root, by default. A seat without a *target* works in the project directory and, in any turn that has tools, can read it (Claude `Read`/`Grep`/`Glob`; Codex a shell in a read-only sandbox, which can also read outside the project). A target narrows that: a target directory becomes the working directory and a short listing of it goes into the prompt; a target file is pasted into the prompt. Which turns have tools: Direct chat, Propose -> Review turns and Debate round 1 without a scout run with read tools (or the seat's permission); the scout brief runs with read tools; discussion rounds 2+, the synthesis, and round 1 when a scout brief exists run with no tools at all.

**Where do results go?** Each room is `.orchestra/rooms/<id>.json`. Facilitator syntheses are appended to `.orchestra/BRAINSTORM.md`. `.orchestra/LOG.md` gets one summary line per finished Debate or Propose -> Review loop (Direct chat is not logged). Starting a room *with context* attaches the tail of `LOG.md` plus `.orchestra/PLAN.md` and `.orchestra/HANDOFF.md` if those files exist; they must live inside `.orchestra/`, not the project root.

**Why Node and zero dependencies?** You already have Node for the CLIs, and a one-file install with nothing to audit is the point of a local tool.

**Why does the Windows build pass odd flags to Codex?** `-c windows.sandbox="unelevated"` and a `PATH` without `WindowsApps` keep the Codex sandbox from tripping over the Microsoft Store `pwsh` alias; `taskkill /T /F` is how a seat is stopped together with everything it spawned.

**The page says "Session required".** You opened `http://localhost:4317` directly in a browser that has not seen this board's token. Open the URL printed in the terminal (it ends in `/?t=...`), or restart with `--open`.

**Something is off. Where do I look?** `orchestra-board doctor`, then the room's *items* panel (tool calls, reasoning, errors), then `GET /api/state` from the authenticated browser. See [docs/api.md](docs/api.md) for the HTTP and SSE contract and [docs/architecture.md](docs/architecture.md) for the module map.

## Development

```sh
npm test                       # node:test, no real CLI is spawned
node bin/orchestra-board.js doctor --json
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Never point tests at the real CLIs: set `ORCHESTRA_CLAUDE_BIN=fake-claude ORCHESTRA_CODEX_BIN=fake-codex`.

## License

[MIT](LICENSE) - Orchestra Board contributors.
