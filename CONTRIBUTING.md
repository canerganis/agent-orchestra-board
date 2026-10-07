# Contributing

Thanks for helping. This is a small, opinionated tool; the easiest contributions to land are bug fixes with a test, adapter fixes for new CLI output, and documentation.

## Ground rules (fixed decisions)

These are deliberate and pull requests that reverse them will not be merged:

- **Zero runtime dependencies.** Node 20+ standard library only. Dev tooling that does not ship is fine but not required.
- **Read-only by default.** A seat edits files only when the user sets `perm: write`.
- **English UI; agents reply in a configurable language.**
- **Only state-showing animations.** Motion must mean something (working, error, streaming), and must respect `prefers-reduced-motion`.
- **The security gate stays.** `127.0.0.1` bind, `Host`/`Origin` allowlist, JSON-only `POST`, static files only from `public/`.
- **Token-lean design stays.** Lean CLI flags, per-mode `--tools`, scout brief in its own thread, per-room threads, unseen-only transcripts marked seen only after a successful turn, early stop, silent agreement, effort cap for discussion rounds, net vs cached accounting. If a change adds tokens to a turn, say so and why.
- **Windows fixes stay.** Codex `-c windows.sandbox="unelevated"` and a `PATH` without `WindowsApps`; `taskkill /T /F` for stop.

## Setup

```sh
git clone https://github.com/0000can0000/orchestra-board.git
cd orchestra-board
npm test
```

Node 20, 22 or 24. No install step. Windows (Git Bash or PowerShell), macOS and Linux are all supported.

## Running without spending money

**Never run the real `claude` or `codex` CLIs from tests or scripts**; each call costs money or quota. Point the board at fake executables and use a scratch project:

```sh
P=$(mktemp -d)
ORCHESTRA_CLAUDE_BIN=fake-claude ORCHESTRA_CODEX_BIN=fake-codex node bin/orchestra-board.js "$P" --port 4391
```

Seats will fail to spawn (status `error`), which is enough to exercise the server, the UI and the SSE stream. Kill the server and delete `$P` afterwards.

## Tests and checks

```sh
for f in server.js bin/orchestra-board.js $(find src test public -name '*.js'); do node --check "$f" || echo "FAIL $f"; done
npm test
```

Tests use `node:test`, which picks up every `*.test.js` in the tree: `test/*.test.js` plus `src/adapters/robust.test.js` (kept next to the adapters, and therefore shipped in the npm package via `files: ["src"]`). Put new tests under `test/`. Adapter tests feed recorded JSONL lines into `createParser` and assert the normalized events; add a recorded line whenever a CLI changes its output. Do not add a test that needs network, a login or a real CLI. The suite must pass both with and without `ORCHESTRA_CLAUDE_BIN` / `ORCHESTRA_CODEX_BIN` set (CI sets both for the whole job), so a test that depends on those variables must set and restore them itself.

## Contracts to respect

- **Adapters** (`src/adapters/*.js`): `buildArgs(opts) -> string[]` and `createParser(handlers) -> {feed, event}` with the handlers `thread`, `activity`, `delta`, `item`, `usage`, `partialUsage` (Claude only: running stream totals, used when a killed run never reports `usage`), `rateLimit`, `completed`, `error`. `usage.tokens` is net (uncached input + output); `cached` is cached input.
- **Runner** (`src/runner.js`): `runSeat(seatId, prompt, opts) -> Promise<{ok, text, tokens, cached, cost, error}>`; `tools: 'write'` is downgraded to `read` unless `seat.perm === 'write'`.
- **HTTP and SSE**: see [docs/api.md](docs/api.md). New routes go into `handle()` in `src/server.js`, GET routes before the static fallthrough, POST routes after body parsing. Errors are `{error: string}`.
- **Persistence**: everything under `<project>/.orchestra/`; never write elsewhere in the user's project unless the seat has `perm: write` and the user asked.
- **Child processes**: only `src/platform.js` may require `child_process`. Everything else spawns through `spawnResolved` / `execFileResolved`, which resolve the program on `PATH` first so the project directory can never supply the executable (`test/spawn.test.js` fails the build otherwise).

## Pull requests

1. One topic per PR; keep the diff small enough to review in one sitting.
2. Add or update a test for behaviour changes; update `docs/` and `CHANGELOG.md` (Unreleased) for anything user-visible.
3. Run the checks above on your platform. CI runs them on Ubuntu, macOS and Windows with Node 20, 22 and 24.
4. Use LF line endings (enforced by `.gitattributes`), 2-space indentation, single quotes, no build step for `public/`.
5. Describe what you measured if the change touches token usage.

## Release checklist (maintainers)

Before tagging a release:

1. The GitHub links (`README.md`, this file, `CHANGELOG.md`, `package.json`, `.github/ISSUE_TEMPLATE/config.yml`) point at `0000can0000/orchestra-board`; update them if the repository moves. The npm name is the scoped `@0000can0000/orchestra-board`: the unscoped `orchestra-board` belongs to an unrelated project, so never publish under, or tell users to `npx`, the bare name.
2. Enable *Private vulnerability reporting* in the repository's Security settings; `SECURITY.md` and the issue template point reporters there.
3. Commit everything (`git status` clean), push, and wait for all 9 CI jobs (3 OSes x Node 20/22/24) to pass before tagging.
4. Run `npm test` with `ORCHESTRA_CLAUDE_BIN=fake-claude ORCHESTRA_CODEX_BIN=fake-codex` set and once without, and `node bin/orchestra-board.js doctor` against the current CLI versions.
5. One deliberate paid smoke test against the real CLIs: a Direct chat with one Claude seat and one Codex seat, plus one *Refresh Claude usage*. This is the only check of the lean launch flags against the installed CLI versions (unit tests cover the argument lists only). Record the versions in `README.md` (*Limitations*) and `CHANGELOG.md`.

## Reporting issues

Use the issue templates. For bugs, include the CLI versions (`claude --version`, `codex --version`), `node --version`, your OS, and the `items` of the failing room if there is one. For security problems see [SECURITY.md](SECURITY.md).
