# ADR 0004: Read-only by default for v0.1

| | |
| --- | --- |
| Status | Superseded in part by ADR 0006 (v0.2.0): write seats edit only per-item worktrees |
| Recorded | 2026-10-07, **retroactively**, by AI agents drafting from the commit history, `.orchestra/LOG.md` and the code; not written when the decision was made |
| Decision made | approx. 2026-10-07, after a board-run planning meeting whose synthesis recommended it (`.orchestra/LOG.md`: "Planning meeting for GitHub-ready v0.1: consensus read-only v0.1, security gate, adapters + fake-CLI tests") and the owner's decision entry that followed ("user \| Decisions: v0.1 read-only; ...") |
| Decided by | Can Erganis (project owner), on the recommendation of the 4-seat planning meeting. The record was drafted by agents |
| Evidence | the Windows sandbox failure that shaped the Codex launch flags: `.orchestra/LOG.md` "codex \| First run failed (sandbox access denied, no files touched)" and "fixed Codex sandbox for board runs (unelevated + PATH w/o WindowsApps)"; the cause as recorded in the comment above `codexEnv` in `src/platform.js` (the unelevated sandbox cannot launch the Microsoft Store `pwsh` alias, `CreateProcessAsUserW: access denied`) |
| Revisit when | the v0.2 worktree-per-room lands (then Claude write seats get a real boundary), either CLI changes its permission flags or sandbox modes (`doctor` version drift), or a user reports an agent write outside the places this ADR says are possible |

## Context

The board runs agents under the user's OS account and CLI logins against a real project, often a dozen turns unattended, with no per-edit confirmation (`SECURITY.md` item 4). An agent that edits files during a brainstorm, or a reviewer that "fixes" what it reviews, is the most expensive mistake a local orchestrator can make. Both CLIs expose permission controls: Claude `--tools` and `--permission-mode`, Codex `sandbox_mode`.

## Decision

Every seat starts with `perm: 'read'` (`src/config.js`). The runner maps a turn to a tools mode (`none` | `read` | `write`) and clamps it: `write` on a non-write seat becomes `read` (`execSeat` in `src/runner.js`). Modes become CLI flags (`buildArgs` in `src/adapters/claude.js` and `src/adapters/codex.js`):

| Seat / turn | Claude | Codex |
| --- | --- | --- |
| `none` (discussion, synthesis, round 1 with a brief) | `--tools '' --permission-mode dontAsk` | `sandbox_mode="read-only"`, cwd `.orchestra/empty`; the shell tool stays available and is only asked not to be used (not enforced) |
| `read` (default seat) | `--tools Read Grep Glob --permission-mode dontAsk` (a tool outside the list is denied, not prompted); no shell tool, so no write path | `sandbox_mode="read-only"` (its shell can still read outside the project) |
| `write` (user opt-in per seat) | `--tools Read Grep Glob Edit Write --permission-mode acceptEdits` | `sandbox_mode="workspace-write"` |

**What confines a write seat, as the code does it, not as the prompt says it.**

- A **Codex write seat** runs with its target directory as cwd (`execSeat`, `src/target.js`), so `workspace-write` is confined to that directory by the Codex sandbox.
- A **Claude write seat always runs with the project root as cwd** (`execSeat`, because Claude stores sessions per cwd, ADR 0003). `acceptEdits` therefore auto-approves edits to **any file in the project**. Its target only narrows the prompt: "Your scope is the directory ... Stay inside it." (`target.js`) plus a listing; `--add-dir` is never needed for a target inside the project. The target is advisory for Claude. The README [Safety and permissions](../../README.md#safety-and-permissions) section and `SECURITY.md` item 1 say the same, and every public post must say it plainly.
- Neither CLI can write outside the project through the board: `confineTarget` resolves a target with `realpath` and rejects `..`, absolute paths elsewhere and symlinks that point out (`target.js`), and a target that resolves outside is ignored at run time (`target.js`).

In Propose -> Review a read-only builder proposes a patch; a write builder edits and the reviewer reads `git diff` of the target (`src/workflows/chain.js`).

## Consequences

Positive:

- **Agents cannot edit project files on a fresh install; the board itself writes only under `<project>/.orchestra/`** (`rooms/*.json`, `seats.json`, `limits.json`, `settings.json`, `LOG.md`, `BRAINSTORM.md`, the `empty/` cwd; `src/store.js`). `doctor` additionally writes and removes one probe file to test that the directory is writable (`src/doctor.js`). A bad prompt costs tokens at worst.
- Tools-per-mode also saves tokens (no tool schemas or re-reads in discussion): safety and cost align.
- The `src/security.js` threat model can treat the browser, not the agent, as the main attacker.

Negative (accepted, and to be stated plainly in every public post):

- **Read-only is enforced by the vendors' CLIs, not by the board.** For Claude it is the tool allowlist (no `Bash`, no `Edit`/`Write` unless `write`); for Codex it is the sandbox. The board adds no second line of defence.
- **Unelevated Windows sandbox.** On Windows Codex children run with `-c windows.sandbox="unelevated"` and a `PATH` without `WindowsApps` (`src/adapters/codex.js`, `codexEnv` in `src/platform.js`) because the Microsoft Store `pwsh` alias cannot be launched under the restricted token the sandbox uses. Cost: the board relies on the unelevated mode's restrictions rather than the elevated mode, which `doctor` describes as needing an admin setup the board does not rely on (`doctor.js`). What isolation the elevated mode adds beyond that has not been characterised here; the Codex CLI documentation of `windows.sandbox` is the reference. Verification status today: `doctor` only confirms the launch flag and the user's `config.toml` setting (`doctor.js`) and that a non-Store PowerShell is reachable (`doctor.js`); it does **not** prove that a write is denied. A manual check on Windows (Direct chat with a Codex `read` seat asked to create a file in the project, confirm the command is refused and no file exists; same for a Claude `read` seat, expecting no write tool) has not been done yet and should be recorded here when it is. A `doctor` check that performs this write attempt in a temp dir is a v0.2 candidate.
- **Claude write seats have the whole project, not their target** (above). Accepted for v0.1 because the only alternative with today's CLI (`cwd = target`) breaks session resume for Claude. Planned fix: **git worktree per room in v0.2**, so a write seat's cwd and its edit scope are the same fresh worktree and the diff is reviewable and revertible as a unit.
- Write seats run unattended with the user's full permissions and directory-level scope: no container isolation, no per-file allowlist, no rollback. Users should rely on git.
- "Read-only" and "local" are not a privacy boundary: prompts and any code the agents read go to Anthropic/OpenAI through the CLIs, exactly as in direct CLI use.
- Default Propose -> Review yields text, not commits; autonomous building is a per-seat opt-in.

## Alternatives considered

- **Write by default**: faster demos, unacceptable for an unattended loop on real code. No survey of other tools' defaults was made for this decision; the comparison earlier drafts implied ("as most agent-swarm tools do") is withdrawn rather than left unsupported.
- **Git worktree per room**: strong isolation and easy rollback; deferred because it needs a git repo and more UI (v0.2 candidate, and the fix for the Claude target issue above).
- **Container sandbox**: real isolation, but kills the zero-dependency, "your CLI logins" install story (ADR 0001, 0005).
