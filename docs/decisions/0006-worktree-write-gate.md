# ADR 0006: Writes only in per-item git worktrees, behind a verified gate

| | |
| --- | --- |
| Status | Accepted (v0.2.0). Amended on 2026-10-08 by the containment gate (see [Amendment](#amendment-containment-gate-2026-10-08)) |
| Recorded | 2026-10-08, with the v0.2.0 release. Drafted by an AI agent from the v0.2 design, the code and the tests; not written at the moment of the decision. The amendment was drafted the same way after the containment gate was built |
| Decision made | 2026-10-08, in the v0.2 design (Plan → Approve → Build). It replaces the per-room worktree plan of ADR 0004 for write seats. The amendment follows the owner decisions of 2026-10-08 14:40 |
| Decided by | Can Erganis (project owner). The record was drafted by an AI agent |
| Evidence | `src/capability.js` (the gate, the write check, the runtime guard), `src/platform.js` (`codexWriteSupport`), `src/runner.js` (the write clamp, the pre-spawn assertion, the startup check), `src/containment-evidence.js`, `src/worktree.js`, `src/patch.js`, `src/workflows/build.js`, `src/workflows/chain.js` (Codex patch mode); tests `test/capability.test.js`, `test/turn-guard.test.js`, `test/git-hardening.test.js`, `test/containment-evidence.test.js`, `test/propose-patch.test.js`, `test/fake-writes.test.js`, `test/patch.test.js`, `test/build.test.js`, `test/build-api.test.js` |
| Revisit when | a CLI changes its write sandbox or permission flags (a stored write check then stops counting, which is the intended effect); the guard, or a user, sees a write outside a worktree that the gate allowed; `doctor --containment` shows Claude reporting more tools at the start of a turn than it was given; or real macOS and Linux reports show Codex keeping shell writes inside the worktree (then Codex edits may return there, after Codex write argv pinning) |

## Context

In v0.1 a write seat could edit files in the project. A Claude write seat always ran with the project root as its working directory, because Claude keeps sessions per directory (ADR 0003). So `acceptEdits` auto-approved edits to any file in the project, and the seat's target was only a prompt instruction. A Codex write seat was confined by its sandbox to its target. ADR 0004 recorded this and named a worktree per room as the fix.

Plan → Approve → Build makes the board change code item by item. Unattended edits need a boundary the board can check, and a person must decide before anything reaches the checkout.

## Decision

1. **Writes happen only in Build items.** Each item builds in its own detached git worktree under `.orchestra/worktrees/<build>/<item>`. The worktree starts from the build's base commit plus the frozen patches of the items the item depends on. Ask, Council, Propose → Review, the plan manager and every reviewer have no write access.
2. **Three keys for a write turn.** Key A is the repository check: git 2.25 or newer, the project folder is the top level of a non-bare checkout with a commit, and `.orchestra/worktrees/` is ignored by git. Key B is a write check per CLI: one real turn of a seat in a throwaway repository under the OS temp directory, passed on this machine for this CLI version, platform and write-mode argv. Key C is explicit intent: the seat has write permission, the plan revision is approved by hash, and the build runs in write mode. A build started with the Mode left on Automatic runs in write mode when every builder can write, so the seat permission plus the approval of that revision is the intent, and Propose opts out.
3. **The runner enforces it.** `execSeat` runs a write turn as read unless the turn has a worktree and `capability.allowsWrite(seat, dir)` returns true. The check does not depend on the UI.
4. **Confinement flags per CLI.** Claude runs in the worktree with `--tools Read Grep Glob Edit Write` (no shell tool), `--permission-mode acceptEdits`, no `--add-dir`, `--strict-mcp-config --setting-sources ""`, and never `--dangerously-skip-permissions`. `staticCheck` refuses argv that widens these settings. Codex never gets file edits (amendment, point A1).
5. **A containment guard around each builder write turn.** The board fingerprints the main checkout and every other board worktree before and after the turn. A change quarantines the item, stops the build and records a failed write check for that CLI, which turns writes off until a new check passes.
6. **Frozen, hash-bound proposals.** After each builder turn the worktree changes are staged and saved as a patch, identified by its sha256. The review covers that hash, and a worktree that changes after the freeze voids the review. Apply checks a fixed list of preconditions and then runs `git apply --index`. The change is staged and never committed.

## Amendment: containment gate (2026-10-08)

A review of the first gate found that a write check could pass without the CLI ever trying to write outside, that the records lived in the project where a repository could plant one, that a worktree's `.git` file could redirect the board's own git calls, and that the Windows Codex sandbox was characterised only by that weak check. The owner decided:

* **A1. Codex file edits are off on every platform in v0.2.** `platform.codexWriteSupport` refuses Windows (`codex-windows-unelevated`), macOS and Linux (`codex-writes-off`, a frozen source constant that only a release may flip) and any other OS. Nothing overrides it: no setting, flag, environment variable, seat field or constructor switch. The write check refuses Codex seats with `409 unsupported-platform` and spawns nothing, and the runner clamps any Codex write request to read.
* **A2. Codex builds through patch mode.** A Codex write seat runs read-only in its item worktree and ends with a unified diff. The board vets it (size, owner paths, no `.git` or `.orchestra`, no absolute or `..` paths, no symlink or submodule modes), applies it with `git apply` inside the worktree and freezes it like any edit. A file that changes during the read-only turn quarantines the item. This keeps Codex useful as a builder without trusting its sandbox for writes.
* **A3. Claude write turns are checked at three points.** Before the spawn: the worktree is a registered board worktree strictly inside `.orchestra/worktrees/`, not a link, equal to the working directory, and the real argv passes `staticCheck`, which now compares every `--flag=value` by name and refuses `--settings`, `--mcp-config`, `--plugin-dir`, `--agents`, `--allowedTools`, `--permission-prompt-tool` and any shell tool. At the start: the CLI's own `init` report must list only the five tools, the worktree, `acceptEdits` and no MCP server, and nothing may come before it; otherwise the turn is killed, its later output ignored and Claude writes turned off for the session (code `startup`). Across turns: a write turn resumes only a thread born in the same worktree.
* **A4. The write check needs proof of an attempt.** The check asks for one write inside and two outside (an absolute path and a `../` path), collects the CLI's tool log, and passes only when the inside file exists, nothing escaped on disk, and each outside write was attempted and refused. Without that proof the verdict is `inconclusive`, which is stored and leaves writes off.
* **A5. Records live outside the project.** One file per user (`%APPDATA%`, `~/Library/Application Support` or `~/.config`, under `agent-orchestra-board`), version 2, bound also to the CLI binary (realpath, size, modification time), the host and the user. `.orchestra/capability.json` is never read. Every earlier pass is void.
* **A6. Git and worktree hardening.** Every git call on a board worktree passes `--git-dir` and `--work-tree` explicitly; the worktree's `.git` file is hashed around each write turn and a change counts as an escape. Worktrees check out with `core.symlinks=false`, a write turn refuses a worktree holding a symbolic link or junction, and hooks point at a path that never exists.
* **A7. `doctor --containment` is the evidence tool.** An opt-in command runs the real CLIs on cheap models in a temporary repository and reports, per case, whether writes stayed inside (including shell, `..`, absolute, prefix sibling, `.git` and Windows `\\?\` and UNC paths) and whether a read-only Codex seat can start sub-agents. It never writes a record: the in-app write check stays the only way to turn writes on. By owner decision it ships without having been run against the real CLIs.

The gate's order is: repository, platform, static check, CLI version, record present, record inconclusive, record failed, drift (version, platform, settings, binary, machine), violation seen this session (`guard`, `startup`). Each step has a stable `code` in the status.

## Consequences

Positive:

* The v0.1 path that let a Claude write seat edit any file in the project is gone. A builder's edits stay in its worktree until a person applies them.
* A review is about exact bytes. The verdict is bound to the patch hash, so a changed worktree cannot carry an old verdict.
* The board never commits. The user reviews `git diff --cached` and commits, or unstages.
* A pass now means the CLI tried to write outside and was refused, not only that nothing happened to change.
* A repository cannot plant a passing record, and a record from another machine, user or binary does not count.
* Codex builds through patch mode on every platform. The board checks and applies its proposed diffs.
* Read-only stays the default. Ask, Council and Propose → Review never write.

Negative:

* The guard detects changes; it does not prevent them. It does not fingerprint ignored files, files outside the project, or a change that is undone before the turn ends. Containment of Claude writes still rests on the CLI's `acceptEdits` and tool flags.
* The guard's main-checkout fingerprint excludes `.orchestra/`, so a write that escapes into it is not detected.
* Codex patch mode is weaker than a real edit loop: the builder cannot run its change, so every Codex proposal is untested until the user runs it.
* The startup check is strict and unverified against the real CLI. If Claude's `init` lists more tools than requested, every Claude write turn fails closed until the list is reviewed.
* Moving the records voided every existing pass, so each user needs one more paid write check for Claude.
* More moving parts: worktrees, a patch store under `.orchestra/proposals/`, plan and build rooms, and a per-user record file.
* A quarantine ends the build with status `error`, and such a build cannot be resumed. The user deletes it and starts again.
* The write check spends one real turn of the chosen seat from the user's plan quota.

## Alternatives considered

* **Containers.** Stronger isolation for the CLI process and its files. Rejected for v0.2: it needs a runtime the user installs, it conflicts with the zero-dependency install (ADR 0001), and the CLIs run on the host under the user's own logins (ADR 0005). It stays a candidate for stricter setups.
* **Branch per item.** Each item would get its own history. Rejected: it creates branches in the user's repository, needs merges or rebases to apply, and makes apply harder to reason about. Detached worktrees leave the repository's refs alone.
* **Auto-commit.** The board commits each approved item. Rejected: committing is the user's decision, and the commit is what the user reviews and can revert. The board stages the change and leaves the commit to the user.
* **One worktree per room (the ADR 0004 plan).** Simpler, but one room holds several items, so an item could not be applied or discarded alone. Per-item worktrees keep items separable.
* **Text proposals only.** Keeps the v0.1 trust model with no path from a reviewed change into the checkout. Rejected as the end state, kept for propose mode, where each passing item now also exports a checked patch file.
* **Codex edits on macOS and Linux once the write check passes there.** Rejected for v0.2 by the owner: nobody has run the check on a real Mac or Linux machine, and the old check never tried a shell write. It returns after Codex write argv pinning (`-C <worktree>`, no extra writable roots, no resumed thread) and real reports.
