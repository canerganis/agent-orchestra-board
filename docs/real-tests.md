# Real CLI tests

An opt-in suite that talks to the real Claude Code, Codex, Antigravity (agy) and Cursor (cursor-agent) CLIs. It lives in `real-tests/cli.real.js`, outside `test/` and named `*.real.js`, so `npm test` and a plain `node --test` never find it (node:test runs every file under a `test/` directory).

## What it runs

One throwaway sample project per run (`README.md` and `src/list.js`, like the recordings in `test/fixtures/real`), removed afterwards. Cheap models only: `claude-haiku-5-5`, `gpt-6-luna` at low effort, `gemini-3.8-flash-low`, and Cursor `auto`. Prompts are tiny and every turn is read-only.

1. Per CLI, a read-only turn. Claude and Codex go through the board's real runner (`createRunner`, `spawnResolved`, `codexEnv` for Codex). agy and Cursor have no seat type yet, so they use their adapter with the same spawn helper. Each reply must mention `list()` and, where the adapter reports usage, tokens must be above zero.
2. Per CLI, a resume turn on the same thread that must remember the file (Cursor has no resume flag, so it gets one turn only).
3. An in-process board (`startApp` from `test/helpers.js`) with the real CLIs: a two seat Council (Claude Haiku and Codex Luna, one round) that reaches a synthesis, and a Propose and Review chain where Haiku proposes and Luna reviews, read-only. The sample file must stay unchanged.
4. A last test prints the total tokens used.

Each CLI test skips when that CLI is not found (`claude` and `codex` via `ORCHESTRA_*_BIN` or PATH, `agy` via its adapter `resolveBin`, `cursor-agent` via `ORCHESTRA_CURSOR_BIN` or PATH). The board flows need both Claude and Codex. The Cursor adapter is still marked unverified, so its test may fail on the first real run.

The board tests use your real home directory so the CLIs keep their login. Everything the board writes goes into the temporary project.

## Last run

On 2026-10-09 on Windows 11 it passed 10 of 10, with Cursor skipped because it is not installed: a read-only turn and a resume for Claude, Codex and agy, a two seat Council that reached a synthesis, and a Propose and Review chain (Haiku proposes, Luna reviews). It used about 52k net tokens and 0.10 USD. Real CLI runs have only been done on Windows 11.

## Fixtures

`npm test` does not spawn a real CLI, but it parses real output. `test/fixtures/real/` holds recordings from 2026-10-09 of Claude Code 2.1.291 (claude-haiku-5-5), Codex CLI 0.160.0 (gpt-6-luna low) and agy 1.2.17 (gemini-3.8-flash-low), made with the board's own read-only arguments. `test/real-fixtures.test.js` parses all of them, and the fake CLI replays them for normal turns.

## Cost

A few cents per run in total. The final line of the output shows the tokens spent per step.

## How to run

```
OB_REAL=1 npm run test:real
```

On PowerShell: `$env:OB_REAL = '1'; npm run test:real`. Without `OB_REAL=1` every test skips.

## CI

CI never runs it. The files are not discovered by `npm test`, the script is not part of the CI workflow, and every test also skips when `CI` or `GITHUB_ACTIONS` is set.
