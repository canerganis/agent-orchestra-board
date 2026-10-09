# ADR 0007: Engines: the board team builds, Claude Code and Codex runs are handed off and watched

| | |
| --- | --- |
| Status | Accepted (v0.2.0) |
| Recorded | 2026-10-08, with the v0.2.0 release. Drafted by an AI agent from the wave 2 plan, the code and the tests |
| Decision made | 2026-10-08, in the wave 2 plan and the owner decisions of 2026-10-08 14:40 (Codex launch moves to v0.3) |
| Decided by | Can Erganis (project owner). The record was drafted by an AI agent |
| Evidence | `src/engines/index.js` (registry, `engineInfo`, `publish`), `src/engines/board.js`, `src/engines/handoff.js`, `src/engines/claude-code.js`, `src/engines/codex.js`, `src/watch/claude-runs.js`, `src/watch/codex-rollouts.js`, `src/api/run.js`, `src/api/handoff.js`; tests `test/engines.test.js`, `test/handoff-engines.test.js`, `test/claude-runs.test.js`, `test/codex-rollouts.test.js`, `test/api-v2.test.js`. A scan of `~/.codex/sessions` on the development machine (2026-10-08): 0 of 231 Codex sub-agents ran read-only (206 full access, 24 workspace-write), and 21 ran under a different sandbox than their parent |
| Revisit when | Claude Code offers a CLI entry point that starts a Workflow under the board's lean flags; a real check shows a read-only Codex parent's children staying read-only on each OS; or the Claude Code journal or Codex rollout formats change |

## Context

After a plan is approved, someone has to build it. The board's own build (ADR 0006) runs each item as a Propose → Review loop on the user's seats, behind the write gate. Many users already run large jobs in Claude Code's Workflow tool or with Codex sub-agents, with their own settings, and want those runs next to the plan rather than a second build system.

Launching those runs from the board looked natural. Two facts stood against it:

* There is no known CLI entry point that starts a Claude Code Workflow, and it is unverified whether `claude -p` can use the Workflow tool with the board's lean flags.
* Codex sub-agents do not simply inherit a read-only sandbox. On the development machine no Codex sub-agent had ever run read-only, most ran with full access, and 21 ran under a different sandbox than their parent. A board-launched "read-only" Codex multi-agent run would therefore make a claim with no evidence behind it.

## Decision

1. **Three engines behind one interface.** `board` (the Board team), `claude-code` and `codex`. Each has `info`, `start`, `stop`, `dispose` and `recover`; the two handoff engines also have `candidates`, `link` and `unlink`. `POST /api/run {engine, planRoomId, revision, hash, options}` starts any of them, after the same approval check. `POST /api/build` stays the canonical route for the Board team.
2. **The Board team is the only engine inside the write gate.** It is the default and keeps every rule of ADR 0006.
3. **Claude Code and Codex are handoff and watch only in v0.2.** The board writes `.orchestra/handoff/<plan>-r<rev>-<code>.md` and a prompt to paste (not a shell command, so no quoting issues). The user runs it in their own CLI. The board finds the run by a code (`ob` plus 6 characters) that the handoff asks the agents to put in their labels or task names, falls back to runs that started near the handoff scored by the plan item ids they name, and links a run only after the user picks it. It then mirrors the agents and, once the run ends, computes what changed with read-only git.
4. **External means outside the gate, and the UI says so.** The engines are labelled "Claude Code, you run it" and "Codex, you run it" and tagged external. The handoff asks for a worktree or a branch `ob/<code>` and no commit, as guidance. The run card shows each Codex sub-agent's sandbox and flags full access. The board never starts, stops or kills an external run; stop means unlink.
5. **Watching is read only and lean.** Claude Code journals and Codex rollouts are read by polling, never `fs.watch`, with leases so nothing polls when no one is looking, byte caps per tick, and a whitelist of fields: no prompt or result text, no account ids. The same watcher feeds the Runs mode, which lists Claude Code Workflow runs whether or not the board handed them off.
6. **Launching Codex runs from the board waits for v0.3**, and needs first: a real check per OS that a read-only parent's children stay read-only (the engine stays hidden until it passes); a runtime guard that stops the run when a child's sandbox is not read-only; the project fingerprint guard around the run; no retries for multi-agent turns; its own runtime slot; child tokens counted against the lead seat's budget; a persisted pid with orphan handling on restart; and each item's proposal taken from its child and fed through the patch checks. Launching Claude Code runs waits for a verified CLI entry point.

## Consequences

Positive:

* Users keep their own Claude Code and Codex workflows and still get the plan, the approval by hash, a live view and a change summary in one place.
* The board makes no containment claim it cannot back: what it launches is gated, and what it does not launch is labelled as outside the gate.
* One engine interface, so a launched engine in v0.3 plugs into the same routes, run room and UI.
* Runs gives Claude Code Workflow users a live view of every run, with nothing to install.

Negative:

* External runs can edit the checkout with the user's own settings, and the handoff rules are only guidance. The board can show what changed; it cannot prevent anything.
* Linking depends on the model following the naming rule. When it does not, the user picks from a scored list.
* The board depends on undocumented Claude Code and Codex file formats. Runs is tagged experimental, unknown fields are ignored and parsing fails soft, but a CLI update can break it.
* Polling another tool's files costs some I/O on machines with many Claude Code projects, kept small by leases, name prefilters, per-directory caches and byte caps.

## Alternatives considered

* **Launch Codex multi-agent runs read-only in v0.2.** Rejected: the read-only claim had no evidence, and the evidence on disk pointed the other way.
* **Launch Claude Code Workflows with `claude -p`.** Rejected for now: no verified entry point under the board's flags.
* **Only the Board team.** Simpler, but it ignores the workflows users already run and leaves them without a view of those runs.
* **Watch with `fs.watch`.** Rejected: unreliable across platforms and network folders, and hard to bound on a machine with many projects. Polling with leases is predictable and stops when no one is looking.
* **Store prompts and results for a richer view.** Rejected: they can hold code and secrets from other projects. Previews are read on demand, capped at 400 characters and never stored.
