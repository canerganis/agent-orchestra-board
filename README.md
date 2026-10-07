# Agent Orchestra Board

**A local web board where Claude Code and Codex CLI agents debate a plan, propose and review each other's work, and show you every step live.**

[![CI](https://github.com/canerganis/agent-orchestra-board/actions/workflows/ci.yml/badge.svg)](https://github.com/canerganis/agent-orchestra-board/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

Zero dependencies, runs on your own CLI logins (no API keys), read-only seats in v0.1.

<p align="center">
  <img src="docs/screenshot-light.png" alt="A finished Debate in Agent Orchestra Board: four Claude Code and Codex agents discussed whether to ship a Windows installer; the round verdict shows 3 of 4 agreed, the synthesis lists options, and the right panel shows the live workflow timeline with per-agent tokens and time." width="100%">
</p>
<p align="center"><sub>A finished Debate: scout brief, two rounds, a round verdict from the agents' stance lines, the synthesis, and the live workflow timeline with tokens per turn.</sub></p>

## What you get

- **Two vendors at one table.** A seat is either `claude -p` or `codex exec`. Put an Opus-class architect, a GPT-class reviewer and a devil's advocate into the same room.
- **Three workflows.** Debate, Propose -> Review and Direct chat (below).
- **A live workflow view.** A zero-dependency Node server streams each turn over SSE: who is thinking, writing or running a command, what it said, what it cost.
- **Cost you can see.** Every room shows net (uncached) vs cached tokens and the CLI-reported cost, and the board has experimental Claude and Codex usage-limit meters.
- **Token-lean by design.** Lean CLI flags, one shared scout brief, unseen-only transcripts, early stop. See [Token savings](#token-savings) for the numbers and their limits.
- **Local.** Binds `127.0.0.1`, session-token protected. Prompts and any code the agents read go to Anthropic and OpenAI through your CLIs, exactly as when you use them directly.

## Quick start

Prerequisites: Node 20 or newer, and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) and/or the [Codex CLI](https://github.com/openai/codex), logged in. One of the two is enough if all your seats use it.

```sh
git clone https://github.com/canerganis/agent-orchestra-board.git
cd agent-orchestra-board
node bin/agent-orchestra-board.js /path/to/your/project --open
```

The terminal prints a URL like `http://localhost:4317/?t=...`. Open that one (or pass `--open`); the token in it is exchanged for a session cookie on first load.

`npx agent-orchestra-board` will work once the package is published to npm. It is **not published yet**, so use the clone above. Do not run `npx orchestra-board`: that name belongs to an unrelated project. The command to type is `agent-orchestra-board` or `aob`.

```
node bin/agent-orchestra-board.js [projectDir] [--port <n>] [--open]   # projectDir defaults to the current directory
node bin/agent-orchestra-board.js doctor [projectDir] [--json]          # Node, CLIs and logins, Windows sandbox, port, state dir
node bin/agent-orchestra-board.js --version | --help
```

`npm link` (or `npm i -g .`) in the clone puts `agent-orchestra-board` and the short alias `aob` on your `PATH`. Run `doctor` first if anything looks off: it only runs `claude --version` / `codex --version`, never a billable turn. A CLI you do not have installed shows up as a failed check, so with one CLI expect one red line.

The default team is one Claude seat and three Codex seats. With only one CLI installed, switch the other seats' *Runtime* (or delete them) before the first Debate; the setup card in the UI names the affected seats.

All state lives in `<project>/.orchestra/` (`seats.json`, `rooms/`, `BRAINSTORM.md`, `LOG.md`, `session`, ...). **Never commit `session`**: it is the password to the board. The board writes a `.orchestra/.gitignore` that lists it.

## Workflows

| Workflow | Seats | What happens | Ends |
| --- | --- | --- | --- |
| **Debate** | 2+ | Optional read-only **scout** writes a shared brief with `file:line` references. Round 1: every seat gives independent ideas in parallel. Later rounds: each seat sees only the messages it has not seen. Stops early when every seat ends with `STANCE: CONVERGED`. A **facilitator** synthesis is appended to `.orchestra/BRAINSTORM.md`. | `done` |
| **Propose -> Review** | builder + reviewer | The builder proposes; the reviewer answers with BLOCKER / SHOULD-FIX / NIT findings and `VERDICT: PASS` or `FAIL`. On `FAIL` the builder goes again (up to 3 rounds in the New session form, default 2; the API accepts up to 6; optional effort escalation, your notes go to the next turn). | `passed`, `needs-you` or `error` |
| **Direct chat** | 1 | Talk to one seat in its own resumable thread; use it to settle what a room left open. | - |

You can interject in a Debate at any time; the next speaker reads it. Seats that have nothing new to add are skipped ("agreed silently").

Round limits: the New session form offers 1-4 Debate rounds and 1-3 Propose -> Review rounds (both default 2). The API accepts 1-5 Debate rounds and 1-6 Propose -> Review rounds.

## How it works

One Node process, no build step. Workflows call a runner that spawns `claude -p --output-format stream-json` or `codex exec --json` as a child process, parses the JSONL stream, and pushes events to the browser over SSE. Each room is a JSON file under `.orchestra/rooms/`. Threads are scoped per room, so a seat does not drag another meeting along. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map, a data-flow diagram, the turn lifecycle and the security model, [docs/api.md](docs/api.md) for the HTTP and SSE contract, and [docs/decisions/](docs/decisions/README.md) for the decision records.

## Token savings

The levers, all on by default:

| Lever | Effect |
| --- | --- |
| Lean CLI launch (no user plugins, MCP servers, skills, hooks, slash commands, extra tool families) | Per-call baseline **36k -> 6.7k tokens** for Claude and 24k -> 15k for Codex, **on my setup, which has several MCP servers and skills**. These two figures are single observations that were not saved as raw captures, so they are not reproducible from this repository. A bare install will see a much smaller saving. |
| Tools only where needed | Claude seats get no tools in discussion rounds, synthesis and round 1 after a scout; the scout gets `Read`/`Grep`/`Glob`. A Codex seat always has a shell tool: in those turns it runs read-only in an empty folder and is told not to use it. That is an instruction, not an enforced limit. |
| One scout brief in its own thread | Files are read once, not once per seat. |
| Per-room threads and unseen-only transcripts | Each turn carries only the delta. |
| Early stop, silent agreement | Fewer turns (neither fired in the measured run, see below). |
| Effort cap (discussion rounds at `medium`) | Cheaper reasoning per turn. Added after the measured run, so it is **not** part of the measured figure. |

**What was measured:** the same 4-agent planning meeting (default seats: 1 Claude + 3 Codex, 2 rounds + synthesis, scout and facilitator among the four) ran once on the pre-redesign board and once on the token-lean board, 12 minutes apart. Total tokens went from **1,686,111 to 461,540 (-73%)**; the Claude-reported cost of the Claude turns went from $1.02 to $0.16.

**Read this before quoting it.** It is **one run per arm on one machine** (Windows 11, Claude Code 2.1.291, Codex CLI 0.160.0, 2026-10-07), not a benchmark. The "before" ran on older code that is not in this repository and also had bugs fixed later, so the difference mixes the token levers with other changes. "Total" means every input token the CLIs reported, cache reads included, plus output; it is the only figure both runs have, because the old board stored one undivided count per turn. The after run was 204,374 uncached + 257,166 cached. Early stop did not fire in either run, and the after run predates the effort cap (the Sol seat, Architect on Codex, still ran round 2 at `high`). Output quality was not measured. My impression is that the scout brief was the biggest saving, but the levers were not measured separately. The trade-off: only the scout reads code, so a shallow brief misleads every seat, and the `file:line` citations in later rounds are copied from it, not re-checked.

The raw rooms (sanitized) and a script that recomputes every number are in [docs/measurements/2026-10-07/](docs/measurements/2026-10-07/README.md). [bench/](bench/README.md) has a harness for a repeatable lean-vs-naive comparison (a second board started with `ORCHESTRA_NAIVE=1`, which reports `naive: true` in `GET /api/state`; see its README); no result from it has been published yet.

## Safety and permissions

- **Read-only in v0.1.** Seats run read-only: Claude with `--tools Read Grep Glob --permission-mode dontAsk` (a tool outside the list is denied instead of prompting), Codex with `sandbox_mode=read-only`. The UI has no write option. Read-only is enforced by the vendors' CLIs, not by the board.
- **Never uses `--dangerously-skip-permissions`.**
- **Localhost only.** The server binds `127.0.0.1`, accepts only local `Host` and `Origin` values (DNS-rebinding and cross-site protection), takes only validated `application/json` POSTs and sends a strict CSP.
- **Session token.** Each project gets a random token in `.orchestra/session` (mode 0600 on macOS and Linux; on Windows the file inherits the project folder's permissions, so keep the project under your user profile), exchanged for an `HttpOnly; SameSite=Strict` cookie and required on every `/api/*` request. A web page you happen to have open, or another local process, gets `401`. Do not expose the port through a tunnel or reverse proxy.
- **Targets stay inside the project** (resolved with `realpath`), and **the project never supplies the CLI**: every child process is resolved on `PATH` and started by absolute path, so an executable planted in a repository you point the board at is never run.
- **Costs are yours.** Turns run under your own logins and count against your plans. The *Refresh Claude usage* button makes one small Haiku call because that is the only way to read Claude's rate-limit window.
- **Not affiliated with Anthropic or OpenAI.** Claude and Claude Code are trademarks of Anthropic; Codex is a product of OpenAI; this project only drives the CLIs you installed.

Write-capable seats exist in the engine but are deliberately not offered in the UI yet; they run unattended with your user permissions and there is no container or worktree isolation. The details and the threat model are in [SECURITY.md](SECURITY.md) and [ADR 0004](docs/decisions/0004-read-only-v0-1.md).

## Windows notes

Windows 11 is the primary development platform.

- **Use the native CLI installers.** The board spawns the CLIs without a shell, so the `claude.cmd` / `codex.cmd` shims that `npm i -g` creates do not work (Node cannot start a `.cmd` file). Use `claude.exe` / `codex.exe`, or set `ORCHESTRA_CLAUDE_BIN` / `ORCHESTRA_CODEX_BIN` to the full path of an `.exe`. `doctor` flags a `.cmd` shim.
- **Codex sandbox fix.** The Codex sandbox cannot launch the Microsoft Store `pwsh` alias under its restricted token, which fails with access denied. Codex children therefore run with `-c windows.sandbox="unelevated"` and a `PATH` without `WindowsApps`. `taskkill /T /F` stops a seat together with everything it spawned.
- macOS and Linux run the same code paths minus those two fixes. CI runs the test suite on Ubuntu, macOS and Windows (Node 20, 22, 24) against fake CLIs; real-CLI runs have only been done on Windows 11.

## Limitations

- Usage meters are experimental; both source formats are undocumented and may change.
- A server restart stops turns in flight (use *Run again* or *Continue in Direct chat*).
- The adapters parse `claude --output-format stream-json` and `codex exec --json`. Developed against Codex CLI 0.160.0 and Claude Code CLI 2.1.291 (2026-10-07). `doctor` only checks that each CLI starts and prints its version; it does not check the output format. After upgrading either CLI, send a short Direct chat message to each CLI you use: if the format changed, the failed message shows an "Unrecognised ... CLI output" error. The lean flags are covered by unit tests on the argument lists, not by a paid run in CI.
- One user, one project per board, no remote access, on purpose.

## FAQ

**Does it need an API key?** No. It shells out to the `claude` and `codex` CLIs you are already logged into.

**Which models?** The ones your CLIs offer. Type any name or alias your CLI accepts; effort levels map to `--effort` (Claude) and `model_reasoning_effort` (Codex). Claude Haiku 5.5 (`claude-haiku-5-5`) is the default for the usage probe and for a Claude scout. It was checked against the real CLI on 2026-10-08 (Claude Code 2.1.291): a Haiku 5.5 seat and a Codex seat held a two-round debate, kept their threads across a server restart and passed a Propose → Review. Older CLI versions may print an `unrecognized_model` warning for this id; the turn still succeeds. If your CLI rejects the id, the usage probe falls back to `claude-haiku-4-5-20251001`; for a scout, pick another model in *New session*.

**Can I change the model or effort for one session?** Yes. *New session* has an optional "Model and effort for this session" block per participant. It applies to that session only (the seat keeps its settings), and *Run again* keeps it. The Debate discussion rounds are capped at `medium` effort by default; turn off *Settings -> Cap effort in discussion rounds* to let each seat use its own effort there (more tokens).

**Can agents reply in my language?** Yes. The UI is English; set *Settings -> Agents reply in* (or `ORCHESTRA_LANG`) and every seat is told to reply in it.

**What does a seat see of my project?** The project root by default. In turns that have tools, a Claude seat can use `Read`/`Grep`/`Glob` and a Codex seat has a read-only shell (which can also read outside the project). A seat *target* narrows the working directory. Claude seats run discussion rounds, the synthesis and round 1 after a scout with no tools. Codex seats cannot be fully stopped from using their shell: those turns run in an empty folder (`.orchestra/empty`) and the prompt tells them not to use it, so a Codex seat in a discussion round can still read project files.

**Where do results go?** `.orchestra/rooms/<id>.json` per room, facilitator syntheses in `.orchestra/BRAINSTORM.md`, one summary line per finished Debate or Propose -> Review in `.orchestra/LOG.md`.

**How is it different from claude-squad, vibe-kanban, codex-plugin-cc or Orchestra?** I have not benchmarked against them; this is how I understand the scope, so check their READMEs. *claude-squad* and *vibe-kanban* are about managing many parallel agent sessions or tasks; this tool is about a few agents from two vendors discussing or reviewing one thing in one room, with a transcript and a synthesis. *codex-plugin-cc* is OpenAI's plugin for using Codex from inside Claude Code; here Claude and Codex are peers at the same table instead. *Orchestra* (npm `orchestra-board`) is an unrelated project with a similar idea and name, which is why this package is called `agent-orchestra-board`. This is not an autonomous coding agent, not a cloud product, and not a kanban over many tasks.

**Why Node and zero dependencies?** You already have Node for the CLIs, and nothing to install or audit is the point of a local tool that can drive agents ([ADR 0001](docs/decisions/0001-zero-dependencies.md)).

**The page says "Session required".** Open the URL printed in the terminal (it ends in `/?t=...`), or restart with `--open`.

**Something is off. Where do I look?** `doctor`, then the room: tool-call lines appear under a running message and a failed turn shows its error on the message. Then the *Workflow and usage* inspector (the right-hand panel), then `GET /api/state` from the authenticated browser.

## Development

```sh
npm test                       # node:test; no real CLI is spawned
node bin/agent-orchestra-board.js doctor --json
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [CHANGELOG](CHANGELOG.md). Never point tests at the real CLIs; the suite uses fake ones. Security issues: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) - Copyright (c) 2026 Can Erganis.
