# Adapters

An adapter turns one agent CLI into the three things the board needs: the argv for a turn, the parsed output of that turn, and the list of models a seat can pick. The registry in `src/adapters/index.js` holds one entry per CLI. `test/adapter-contract.test.js` checks every entry.

## Status

| CLI | Adapter | Status |
| --- | --- | --- |
| Claude Code (`claude`) | `src/adapters/claude.js` | Wired into seats. Read, write and none modes. |
| Codex CLI (`codex`) | `src/adapters/codex.js` | Wired into seats. Read and write modes. |
| Antigravity CLI (`agy`) | `src/adapters/antigravity.js` | Read-only. Verified against one real turn of agy 1.2.17 on Windows on 2026-10-09 (`test/fixtures/antigravity/real-turn.jsonl`). Not wired into seats or config. |
| Cursor CLI (`cursor-agent`) | `src/adapters/cursor.js` | Read-only. UNVERIFIED: built from public docs and fixtures, not from a real run. Not wired into seats or config. |

The Gemini CLI adapter was replaced by the Antigravity adapter because `agy` is what Antigravity installs, and the Gemini CLI is not installed here. `agy` serves Gemini models and also Claude models through its own Antigravity quota. It is not on PATH on Windows: `resolveBin` checks `ORCHESTRA_AGY_BIN`, then PATH, then `%LOCALAPPDATA%\Packages\OpenAI.Codex_*\LocalCache\Local\agy\bin\agy.exe`.

Cursor stays unverified until someone runs them against the real CLIs, checks the flags with `--help`, and records a real stream into `test/fixtures/`. Until then its flag names and event shapes may be wrong.

## The contract

Each registry entry has these fields. `validateAdapter(adapter)` returns a list of problems, and an empty list means the entry is valid.

1. `name`: the registry key, a non-empty string.
2. `MODELS`: a non-empty array of model ids the CLI accepts. Any id the CLI accepts works, so the list only sets the choices the board offers.
3. `readOnly`: a non-empty sentence that says how a read-only turn is enforced.
4. `buildArgs(opts)`: returns the argv array for one turn. `opts.mode` is `'read'`, `'write'` or `'none'`. Read mode must never grant a write or shell permission.
5. `parseLine(line)`: returns an array of normalized events for one stdout line. Noise, blank lines and non-JSON lines return `[]`.

Event types returned by `parseLine`:

| type | Fields | Meaning |
| --- | --- | --- |
| `thread` | `id`, optional `model` | Session or thread id from the init event. |
| `text` | `text` | Assistant text. |
| `tool` | `name`, `id`, `input`, or `failed` | A tool call started, or a tool call failed. |
| `usage` | `tokens`, `cached`, `cost` | Per-turn token and cost totals. |
| `error` | `message`, `fatal` | The turn failed or the CLI reported an error. |
| `done` | `result` | The turn finished. |

For Claude and Codex, `parseLine` is a stateless view built on the stateful `createParser` in each module. The runner keeps using `createParser` because it needs state across lines (partial usage, containment checks, de-duplication). Use `parseLine` for tools and tests, not for live runs.

## Read-only rules

A read-only turn must not carry write or shell permissions. The contract test enforces a deny list per adapter.

1. Claude: `--permission-mode dontAsk` and `--tools Read Grep Glob`. Any other tool is denied without a prompt. The deny list covers `acceptEdits`, `bypassPermissions`, `--dangerously-skip-permissions`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit` and `Bash`.
2. Codex: `sandbox_mode="read-only"`. The deny list covers `--full-auto`, `--yolo`, `--dangerously-bypass-approvals-and-sandbox`, and any argument that contains `workspace-write` or `danger-full-access`.
3. Antigravity: `--mode plan` and `--sandbox`. The deny list covers `--dangerously-skip-permissions`, `--add-dir` and `accept-edits`. A resumed turn adds `--conversation <id>`.
4. Cursor: `--mode ask` and `--sandbox enabled`. The deny list covers `--force`, `-f`, `--yolo` and `agent` (the mode that can edit). Cursor's buildArgs throws on write mode.

Antigravity and Cursor have no write mode at all. Their buildArgs throws when asked for one.

## Adding a CLI

1. Create `src/adapters/<name>.js`. Export `buildArgs` and `parseLine`, and a model list. Put the docs you relied on in the file header, and mark anything you could not verify as UNVERIFIED.
2. Build the argv so the prompt comes last, after `--` or as the value of `-p`, so a prompt that starts with a dash cannot be read as a flag.
3. Add an entry to `registry` in `src/adapters/index.js`, with `name`, `MODELS`, `readOnly`, `buildArgs` and `parseLine`.
4. Add a deny list and a positive check for the read-only mode in `test/adapter-contract.test.js`.
5. Record real output as fixtures under `test/fixtures/<name>/` and add a parse test for them.
6. Run `node --test test/adapter-contract.test.js`, then `npm test`.
7. Wire the CLI into `src/config.js` (models and efforts) and the seat code only after the real CLI has passed steps 1 to 6 by hand.

A new adapter does not run until it is wired into seats. The registry alone never starts a process.
