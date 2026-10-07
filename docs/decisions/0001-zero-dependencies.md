# ADR 0001: Zero runtime dependencies

| | |
| --- | --- |
| Status | Accepted (v0.1.0) |
| Recorded | 2026-10-07, **retroactively**, by AI agents drafting from the commit history, `.orchestra/LOG.md` and the code; not written when the decision was made |
| Decision made | approx. 2026-10-07, while building the first prototype, before commit `c75d465` ("Baseline: Orchestra Board prototype", 2026-10-07 22:19 +03:00) |
| Decided by | Can Erganis (project owner). The record was drafted by agents; the decision was the owner's |
| Evidence | `package.json` has no `dependencies` or `devDependencies` and `engines.node >= 20`; `src/` and `bin/` require only `http`, `child_process`, `fs`, `path`, `crypto`, `net`, `os`, `string_decoder` (`src/platform.js` also requires `events`; tests add `node:test` and `stream`); `.github/workflows/ci.yml` runs `node --test` on Ubuntu, macOS and Windows with Node 20, 22 and 24 and has no install step |
| Revisit when | the UI outgrows hand-rendering, the HTTP layer needs features that built-ins make painful (compression, HTTP/2), or the first dependency that would materially shrink `security.js` / `server.js` appears |

## Context

Agent Orchestra Board spawns `claude` and `codex` with the user's own logins and, for `write` seats, lets them edit files. Anyone installing it must trust the whole dependency tree with that power. Both CLIs already require Node, so Node >= 20 is a free prerequisite. The surface is small: one HTTP server, SSE, JSONL parsing, JSON files under `.orchestra/`, two `child_process.spawn` adapters and a plain-script frontend.

## Decision

`package.json` declares no `dependencies` and no `devDependencies`. Everything uses Node built-ins: `http`, `child_process`, `fs`, `path`, `crypto` (session tokens, `timingSafeEqual`), `node:test` for tests. The browser side is three static files with no bundler or framework.

Install today is `git clone` plus `node bin/agent-orchestra-board.js [projectDir] --open`. The npm package (not published yet) ships `bin`, `src`, `public`, `server.js` (`package.json` `files`).

**Naming.** The npm name `orchestra-board` belongs to an unrelated project with a similar idea (Armin2708/Orchestra), so `npx orchestra-board` would run someone else's package. The product and package are therefore named `agent-orchestra-board`, with two bins, `agent-orchestra-board` and `aob`, both pointing at `bin/agent-orchestra-board.js`. The package is not published yet; until it is, the documented install is clone plus `node bin/agent-orchestra-board.js`.

## Consequences

Positive:

- Nothing to audit beyond about 20 source files; no `npm install`, no lockfile churn, no supply-chain exposure for a tool that can run file-editing agents.
- Startup is instant and identical on Windows, macOS and Linux CI.
- Tests cannot pull in the real CLIs: `spawnFn` is injected (`src/runner.js`) and `ORCHESTRA_*_BIN` points at fakes (`test/fake-cli/`).

Negative (accepted):

- Hand-written pieces a library would provide: JSONL splitting (`src/adapters/jsonl.js`), cookie parsing and body validation (`src/security.js`), SSE framing, a tiny router in `src/server.js`. Each is small but ours to keep correct.
- Validation is an ad-hoc `v.*` set, not a schema library; adding a route means editing `handle()` by hand.
- `public/app.js` renders by hand with no component model, which will not scale to a much richer UI.
- No coverage or snapshot tooling beyond `node:test`.
- The Windows fake CLI needs `csc.exe` from the .NET Framework to build its shim (`test/fake-cli/index.js`); without it those tests skip. A dependency-free alternative would be a prebuilt binary checked into the repo, which was rejected for the same trust reasons.

## Alternatives considered

- **Express/Fastify + ws**: familiar, but dozens of transitive packages for roughly 300 lines of HTTP code.
- **Bundled SPA (Vite + framework)**: better UI ergonomics, but a build step for a page that is mostly a message list and status badges.
- **Vendoring micro-libraries**: still code we own, without the clarity of "zero".
