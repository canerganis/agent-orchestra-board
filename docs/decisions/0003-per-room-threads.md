# ADR 0003: Per-room threads instead of one thread per seat

| | |
| --- | --- |
| Status | Accepted (v0.1.0) |
| Recorded | 2026-10-07, **retroactively**, by AI agents drafting from the commit history, `.orchestra/LOG.md` and the code; not written when the decision was made |
| Decision made | approx. 2026-10-07, in the same token-lean pass as ADR 0002 (`.orchestra/LOG.md` entry "Token-lean orchestra: ... per-room threads ..."), after the one-thread-per-seat prototype had run several rooms (`.orchestra/LOG.md` entries "Meeting ... done (claude, luna, 2 rounds)" and following) |
| Decided by | Can Erganis (project owner). The record was drafted by agents; the decision was the owner's. The "stale permissions in long-lived threads" finding came from an independent review pass |
| Evidence | the change was triggered by one-thread-per-seat prototype threads carrying an unrelated earlier room into a later one (no room ids were kept, so no artifact backs that beyond the tests); `execSeat` in `src/runner.js` (thread resolution), `upsertSeat` in `src/seats.js` (thread reset), `test/meeting.test.js` (resumption and unseen-only behaviour; there is no test of the reset rule) |
| Revisit when | a cross-room memory need appears (users re-explain earlier decisions in Direct chat), either CLI changes its resume semantics (`doctor` reports a version drift and seats start getting `background()` again), or the v0.2 worktree-per-room plan (ADR 0004) changes a room's cwd, since Claude stores sessions per cwd |

## Context

Both CLIs resume conversations: Claude via `--session-id` / `--resume`, Codex via `codex exec resume <id>`. Resume makes unseen-only transcripts (ADR 0002) possible: the CLI session carries earlier turns, so the board sends the delta. The first design kept one long-lived thread per seat. A seat sat in several rooms, so a debate about one topic resumed a thread that already held an unrelated earlier room: wasted input tokens and cross-contaminated reasoning. The one-thread-per-seat version predates the repository's first commit (`c75d465` already carries per-room threads and the thread-reset rule), so there is no commit to diff against; the pre-redesign room JSON is the only artifact of it.

## Decision

Thread identity is scoped to the room. `execSeat` in `src/runner.js` resolves `room.threads[threadKey || seat.id]` for meetings and chains, and `seat.thread` only for Direct chat (`room: null` in `say` in `src/rooms.js`). `threadKey` allows sub-threads inside a room (the scout, ADR 0002). Role header and target preface go out once per thread (`execSeat`). Threads persist in `rooms/<id>.json`, so a room survives a restart.

A thread also fixes the seat's agent, permission, scope, name and role at its first message (the header says "Do not modify files" for non-write seats, built in `execSeat`), so `upsertSeat` in `src/seats.js` resets `seat.thread` when any of these change. The review finding "stale permissions in long-lived threads" drove this rule: a seat switched from `read` to `write` kept resuming a thread whose first message forbade edits. **Test status: the reset rule in `src/seats.js` (`upsertSeat`, `resetThread`) has no test yet.** The meeting tests cover per-room thread resumption only indirectly.

## Consequences

Positive:

- Rooms are independent: no leakage between tasks, cheaper resumes, cost attributable per room.
- Direct chat stays long-lived, where continuity is the point.
- Thread ids are plain strings in room JSON; no extra storage.

Negative (accepted):

- No seat memory across rooms. "What did we decide yesterday?" is answered by `.orchestra/BRAINSTORM.md` and `LOG.md` (the *with context* option in `src/rooms.js`), not by the model.
- Every new room pays header, brief and round-1 background again.
- Claude stores sessions per project directory, so Claude turns keep `cwd = PROJECT` even for a subdirectory target (`execSeat`, `--add-dir` only for a target outside it); a moved project loses resumability. This is also why a Claude write seat's target is advisory (ADR 0004).
- Thread ids rest on undocumented CLI session semantics; an upgrade can invalidate them, after which the seat simply gets `background()` again (not covered by a test of its own; the nearest is 'unseen-only is marked seen only after a successful turn' in `test/meeting.test.js`).

## Alternatives considered

- **One thread per seat (original)**: simplest, but caused the contamination above.
- **No threads, full transcript each turn**: robust to CLI changes but is the design that cost 1.69M (ADR 0002).
- **Board-managed summaries as memory**: more calls and lossy; deferred until a cross-room need appears.
