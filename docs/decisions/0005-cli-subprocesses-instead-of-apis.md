# ADR 0005: Drive the vendor CLIs as subprocesses, not the model APIs

| | |
| --- | --- |
| Status | Accepted (v0.1.0) |
| Recorded | 2026-10-07, **retroactively**, by AI agents drafting from the commit history, `.orchestra/LOG.md` and the code; not written when the decision was made |
| Decision made | approx. 2026-10-07, at the very start of the prototype: the first board runs in `.orchestra/LOG.md` ("board→claude(claude-haiku-4-5-20251001) \| Run 20261007181035-lju3 done", "board→codex(gpt-6-luna) \| Run 20261007181056-509h done") already drove the CLIs, before commit `c75d465` (22:19 +03:00) |
| Decided by | Can Erganis (project owner). The record was drafted by agents; the decision was the owner's |
| Evidence | `execSeat` and `spawnResolved` in `src/runner.js` (argv per CLI, spawn), `src/adapters/{claude,codex}.js` (argv and stream parsing), `src/config.js` (lean flags with the measured overhead: Claude 36k -> 6.7k, Codex 24k -> 15k), the first recorded CLI runs (run ids `20261007181035-lju3` and `20261007181056-509h`; owner's local `.orchestra/runs/`, not published) |
| Revisit when | any condition in "When to move to direct APIs" below is met |

## Context

The board needs Claude and GPT models with tool use on a local project. Two routes: call the Anthropic and OpenAI APIs and build an agent loop, or spawn the CLIs the user already has. The working assumption was that target users already pay for Claude Code and Codex subscriptions and have both CLIs logged in. **This assumption is unvalidated**: nobody has been asked. The board tolerates one missing CLI (README [Quick start](../../README.md#quick-start): one of the two is enough if all seats use it; `doctor` reports the other as failed), but the two-vendor debate, which is the product's point, needs both.

## Decision

Seats are CLI subprocesses. `src/runner.js` spawns `claude -p --output-format stream-json` or `codex exec --json -`, writes the prompt to stdin, and `src/adapters/{claude,codex}.js` normalize each CLI's JSONL into one event set (`thread`, `activity`, `delta`, `item`, `usage`, `rateLimit`, `completed`, `error`). Lean flags in `src/config.js` (`--strict-mcp-config --setting-sources '' --disable-slash-commands --exclude-dynamic-system-prompt-sections`; `--ignore-user-config` and `features.*=false`, `web_search="disabled"` for Codex) strip the user's plugins, MCP servers, skills and hooks. The board holds no API keys and never passes `--dangerously-skip-permissions`; write seats use `--permission-mode acceptEdits` (ADR 0004).

## Consequences

Positive:

- No keys or billing setup: turns count against existing subscriptions; Claude's `rate_limit_event` and Codex rollout usage become live meters (`src/limits.js`).
- Agent loop, tools, sandboxing, permissions and resume are the vendors' code; the board stays small.
- Lean flags cut fixed overhead: Claude 36k -> 6.7k tokens per call, Codex 24k -> 15k (measured 2026-10-07 on the project owner's setup with several MCP servers and skills; a bare install sees a smaller saving).

Negative (accepted), each with how it is handled today:

- **Shared quota.** Unattended multi-agent loops draw on the same subscription quota and rate limits as the user's own interactive work; a long Debate can exhaust the window the user needed for themselves. Handled by: per-seat token budgets that stop a seat before its turn (`seat.budget` check in `execSeat`, `src/runner.js`), early stop and silent agreement (ADR 0002), a stop button per room (`stopRoom` in `src/rooms.js`), and the usage meters so the draw is visible. Not handled: a per-room or per-day budget, and pausing when a window is nearly full. Both are v0.2 candidates.
- **Vendor terms.** Driving the CLIs programmatically depends on each vendor permitting non-interactive use of a subscription-authenticated CLI. The board uses only documented flags (`-p`, `--output-format stream-json`, `exec --json`), the user's own login, and no permission bypass. Handled by: `doctor` reporting the auth mode found (`src/doctor.js`) so the user knows what they are running under. Not handled: the board cannot know if a vendor changes terms; see the conditions below.
- **Undocumented stream formats.** Adapters are tested against Codex CLI 0.160.0 and Claude Code 2.1.291. Handled by: `doctor` and `versions.js` detect versions and show them in the UI; `explainExit` turns a result-less exit into a readable message naming unknown event types (`src/adapters/diagnose.js`); parsers tolerate unknown events and noise (`test/streams.test.js`, `src/adapters/robust.test.js`). A format break shows up as failed turns with that message, not as a crash.
- **The Claude meter costs quota on every refresh.** Claude's `rate_limit_event` arrives in every normal `claude -p` stream, so after any Claude turn the meter is current for free. The *Refresh Claude usage* button spawns one small Haiku call with no tools (`src/adapters/claude.js`, `src/limits.js`), which counts against the plan. Handled by: the probe runs only on demand (never on a timer; only the Codex meter polls a local file every 30 s), one probe at a time (`limits.js`), and the README states the cost next to the button (README [Safety and permissions](../../README.md#safety-and-permissions)). Not handled: a rate limit on how often a user may click.
- **Process management is ours**: `taskkill /T /F` on Windows, stdin EPIPE must not crash the server, and the review found stop races and lost context on failed turns (fixed; tests in `test/stop.test.js` ('direct chat room stop: the running turn is killed and the queued one is cancelled without ever spawning', 'meeting stop: ...') and `src/adapters/robust.test.js`).
- Slower per turn than a direct API call; each CLI still spends its own system prompt per call (the remaining 6.7k / 15k).
- A third vendor needs a new adapter.

## When to move to direct APIs

Any one of these is the trigger to reopen this ADR and prototype an API-backed seat:

1. A stream-format or flag change that the adapters cannot absorb within one release, i.e. `explainExit` reports unknown event types for the current CLI and no flag restores the old shape.
2. A vendor terms change that disallows programmatic or non-interactive use of the subscription CLI.
3. Users who do not hold both subscriptions ask for API-key seats, or who prefer per-token billing for unattended runs. An API seat would be an additional adapter behind the same event set, not a replacement, so subscription users keep the no-keys path.

## Alternatives considered

- **Direct APIs, home-built agent loop**: documented schemas, but keys, per-token billing on top of subscriptions, and reimplementing tools, sandboxes and resume.
- **Agent SDKs**: API-key billed and add dependencies (ADR 0001).
- **MCP between the CLIs**: one CLI calls the other, but no neutral place for a live board, cost accounting or mixed rounds.
