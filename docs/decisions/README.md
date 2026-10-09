# Architecture decision records

Seven records for the choices that shape Agent Orchestra Board. The decisions were made by the project owner, Can Erganis. Records 0001 to 0005 were drafted by AI agents on 2026-10-07, **after** the decisions, from the commit history, `.orchestra/LOG.md` and the code, so each one carries a "Recorded ... retroactively" row, the approximate time of the original decision, who decided, the evidence it rests on, and a revisit trigger. Records 0006 and 0007 were written with the v0.2.0 release, on 2026-10-08, from the design, the plan and the code; their "Recorded" rows say so. Record 0006 carries an amendment for the containment gate.

| ADR | Decision | Evidence |
| --- | --- | --- |
| [0001](0001-zero-dependencies.md) | Zero runtime dependencies; package name `agent-orchestra-board` with bins `agent-orchestra-board` and `aob` | `package.json`, CI |
| [0002](0002-scout-brief-and-unseen-only-transcripts.md) | Scout brief, no-tools rounds, unseen-only transcripts, early stop | per-phase table from [`../measurements/2026-10-07/`](../measurements/2026-10-07/README.md) |
| [0003](0003-per-room-threads.md) | Threads scoped to a room; reset on seat change | `src/runner.js`, `src/seats.js`, `test/meeting.test.js` |
| [0004](0004-read-only-v0-1.md) | Read-only default; what actually confines Claude vs Codex write seats (superseded in part by 0006) | `src/security.js`, `src/target.js`, `src/platform.js` |
| [0005](0005-cli-subprocesses-instead-of-apis.md) | CLIs as subprocesses, not APIs; conditions for moving to APIs | `src/runner.js`, `src/adapters/` |
| [0006](0006-worktree-write-gate.md) | Writes only in per-item git worktrees, behind a gate with a per-CLI write check and a runtime guard; amended: Codex never edits files (patch mode instead), Claude write turns have no shell, checks need proof of an attempt, records live per user (v0.2.0) | `src/capability.js`, `src/platform.js`, `src/runner.js`, `src/worktree.js`, `src/patch.js`, `test/capability.test.js`, `test/turn-guard.test.js` |
| [0007](0007-engines.md) | Engines: the board team builds behind the gate; Claude Code and Codex runs are handed off and watched, read only; launching Codex runs waits for v0.3 (v0.2.0) | `src/engines/`, `src/watch/`, `test/handoff-engines.test.js`, a sandbox scan of Codex sub-agents |

Where a record cites a number, it is from the single before/after run described in the measurements folder: one meeting, one machine, not a benchmark. See also [ARCHITECTURE.md](../ARCHITECTURE.md).

## About the evidence

Several records cite entries of the owner's local `.orchestra/LOG.md` and run files under `.orchestra/runs/`. `.orchestra/` is git-ignored, so those are **the owner's local log, not published**; readers cannot check them in the repository. The published, checkable evidence is the code, the tests and [`docs/measurements/2026-10-07/`](../measurements/2026-10-07/README.md). Code is cited by function name rather than line number, because line numbers drift.
