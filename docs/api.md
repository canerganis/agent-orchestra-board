# HTTP API and SSE events

Everything is JSON. The server binds `127.0.0.1` and applies the security gate before any route: `Host` must be exactly `localhost:<port>`, `127.0.0.1:<port>` or `[::1]:<port>` (else `403 {"error":"forbidden host"}`); an `Origin`, if present, must be `http://` one of those (else `403 {"error":"forbidden origin"}`); `POST` without `content-type: application/json` is `415 {"error":"json required"}`; a body over 1 MB is `413`. Unknown routes and unknown ids are `404`; invalid bodies and unexpected handler exceptions are `400`; stale state and failed preconditions are `409`. Errors are `{"error": message}`, plus a `code` when the board has a stable one (see [Error codes](#error-codes)). Every response carries a strict CSP, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `x-frame-options: DENY` and `cache-control: no-store`.

## API version

`GET /api/state` carries `apiVersion: 2` since v0.2.0. Version 2 adds the fields `roomIndex`, `engines` and `watch` to the state, the routes `GET /api/rooms/:id`, `GET /api/preflight`, `POST /api/ask`, `POST /api/run`, `GET /api/run/:id/candidates`, `POST /api/run/:id/link`, `POST /api/run/:id/unlink` and the `/api/wf/runs` family, and the SSE events `engines`, `engine`, `wfRuns` and `wfRun`. Every v1 route and field still works. A client that finds no `apiVersion` talks to a v0.1 board.

The version 2 routes sit behind the same gate as every other route: the `Host` and `Origin` checks, the session cookie (`401` without it) and the JSON content type for `POST`.

## Session

Each project has a random token, kept in `<project>/.orchestra/session` (mode 0600 on POSIX; on Windows it inherits the project folder's ACL) and printed in the start URL (`http://localhost:<port>/?t=<token>`).

| Request | Result |
| --- | --- |
| `GET /?t=<token>` | `303` to `/` with `set-cookie: ob_session_<port>=<token>; Path=/; HttpOnly; SameSite=Strict`; a wrong token is `403` with a small HTML page titled "This link is out of date" (not JSON, so do not parse it as an API error) |
| `GET /` or `GET /index.html` without the cookie | `401` with a small HTML page ("Session required") |
| any `/api/*` without the cookie | `401 {"error":"unauthorized: open the URL printed at startup"}` |
| other static files (`/app.css`, `/app.js`) | served without the cookie |

The cookie has no expiry (gone when the browser closes) and stays valid across restarts of the board, because the token is persisted; delete `.orchestra/session` to rotate it. Scripts that call the API must first exchange the token for the cookie, then send the cookie.

## Static

| Route | Serves |
| --- | --- |
| `GET /` | `public/index.html` |
| `GET /app.css`, `GET /app.js` | files under `public/` only (regular files, resolved path must stay inside `public/`) |

Content types: html, css, js, svg, png, ico, json.

## Read

| Route | Returns |
| --- | --- |
| `GET /api/events` | SSE stream; first event `{"t":"hello"}`, heartbeat comment `: hb` every 15 s |
| `GET /api/state` | `{project, models, efforts, seats: publicSeat[], rooms (<= 25, newest first, with messages), roomIndex, limits, settings, naive, capability, apiVersion: 2, engines, watch}`. `naive: boolean` (true when started with `ORCHESTRA_NAIVE=1`) is required by `bench/token-bench.mjs`. `capability` is the last computed [CapabilityStatus](#capability-write-gate), or `null` before the first check. `roomIndex` lists the newest 500 rooms by metadata only: `{id, kind, title, status, created, planRoomId?, engine?}`, so a client can list every room of a mode and fetch one with `GET /api/rooms/:id`. `engines` is the [EngineInfo](#engines-and-handoff-runs) list. `watch` is `{claude: boolean}`: true when `<claudeHome>/projects` exists, so the Runs view has something to read. |
| `GET /api/rooms/:id` | one room in full, with its messages; `404 {error: "no such room"}` |
| `GET /api/capability` | the [CapabilityStatus](#capability-write-gate), checked now. Runs `<cli> --version` for each CLI; no model call. |
| `GET /api/build/:id/items/:item/proposal` | `{itemId, status, proposal, review, exported, patch, truncated, applicable}` for a build item (see [Builds](#builds)). `404 {error: "no such build"}` or `{error: "no such item"}`. |
| `GET /api/preflight?planRoomId=` | what a build needs right now, read without starting anything: `{git: {ok, reason}, clean, dirtyCount, writes: {claude: {available, reason}, codex: {available, reason}}}`. `git.ok` is false for a folder that is not a usable repository, and such a folder is never `clean`. `dirtyCount` counts the staged, unstaged and untracked paths outside `.orchestra/`. `writes` comes from the cached capability status; an unknown status counts as unavailable. `planRoomId` is optional; when given it must name a plan room (`404 no-plan`). |
| `GET /api/doctor` | `{ok, checks: [{id, name, status, detail, hint?, state?}]}`; `ok` is false when any check has `status: "fail"`. Checks: `node`, `claude`, `codex` (CLI found and `--version` runs; a `.cmd` shim is `warn`, a missing CLI is `fail`), `claudeLogin`, `codexLogin`, `codexSandbox`, `pwsh`, `port`, `project`, `orchestra`, and `binOverride` (a `warn`, only while `ORCHESTRA_CLAUDE_BIN` or `ORCHESTRA_CODEX_BIN` is set). The `claude` and `codex` checks also carry `state`: `ok`; `warn` (the version check timed out or exited non-zero, or the project holds a file named like the CLI); `broken` (only a `.cmd` or `.bat` shim, or the executable cannot start); `missing` (not found). Login checks never change `state`. Over HTTP no port is passed, so `port` is always `skip` here (the `doctor` CLI tests it). Each call refreshes the board's doctor cache and sends an `engines` event. Spawns only `<cli> --version`, never a model call, and never runs `doctor --containment`. |

## Seats

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/seats` | `{id?, name (<= 24), role (<= 40), agent 'claude'|'codex', model, effort, perm 'read'|'write', target (<= 1024, inside the project), budget >= 0, color}` | `publicSeat`; `400` on an invalid field or a malformed model name (`^[A-Za-z0-9][\w.:\-\[\]]{0,63}$`, so a model name can never start with `-` and be read as a flag; any CLI-accepted name or alias is allowed, the `models` in `/api/state` are suggestions), `404` on an unknown `id`. `target` is confined to the project (`realpath`; no `..`, absolute or symlink escapes) and stored relative to it. Changing agent, perm or target resets the seat's thread. `perm: "write"` lets the seat edit files only in Build worktrees, and only while the write gate allows it; saving it does not enable writes by itself (see [Capability](#capability-write-gate)). |
| `POST /api/seats/:id/send` | `{text}` | `{roomId: "dm-<id>"}` (Direct chat) |
| `POST /api/seats/:id/stop` | | `{ok}` |
| `POST /api/seats/:id/reset` | | `{ok}` (clears the thread) |
| `POST /api/seats/:id/delete` | | `{ok}`; `400` while the seat is running |

`publicSeat` = persisted fields (`id, name, role, agent, model, effort, perm, target, budget, color, thread, used, cached, cost`) + `{status: 'idle'|'working'|'error', activity, startedAt, roomId}`.

## Rooms and workflows

The UI groups rooms into four modes by `kind`: `dm` and `ask` are Ask, `meeting` is Council (called Debate in v0.1), `plan`, `build`, `chain` and `run` are Workflow, and an unknown kind goes to Workflow. Runs lists Claude Code runs, not rooms (see [Claude Code runs](#claude-code-runs-experimental)).

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/ask` | `{roomId?, seatId, text (<= 20000), model?, effort?}` | `{roomId}`. One turn of an Ask conversation. Without `roomId` a new Ask room starts; with it the conversation goes on, and `seatId` may name another seat. A seat's first turn in a conversation that already has replies gets a short recap of it in the same prompt (no extra call). `model` and `effort` are validated like `overrides` and stay with that seat in this room; `null` or `""` clears them. Turns of one room run one after another. `404` for an unknown seat or room, `400` for empty text, a room that is not an Ask room, a bad model name or an effort the seat's CLI does not support. |
| `POST /api/meeting` | `{topic (<= 4000), seatIds (2-20 ids), rounds 1-5 (default 2), synthId?, scoutId?, withContext?: boolean, overrides?}` | `{roomId}` (a Council) |
| `POST /api/chain` | `{task (<= 8000), builderId, reviewerId (different), maxRounds 1-6 (default 3), escalate?: boolean, withContext?: boolean, overrides?}` | `{roomId}` |
| `POST /api/rooms/:id/stop` | | `{ok}`. On a run room of a handoff engine this unlinks: the board stops watching and the room ends `stopped`. The user's own run is never stopped. |
| `POST /api/rooms/:id/say` | `{text}` | `{ok}`; only for a running meeting/chain (`400` for dm or finished rooms). The next speaker reads it. |
| `POST /api/rooms/:id/delete` | | `{ok}`. A build is stopped and given up to 10 s to end; its worktrees and frozen proposals are then removed before the room is deleted. A run room's engine releases its follower and timers first; the handoff file stays. |

Room statuses: meeting `running | done | stopped | error`; chain `running | passed | needs-you | stopped | error`; dm `running | idle | stopped`; ask `running | idle`; plan `running | awaiting-approval | approved | rejected | stopped | error` (see [Plans](#plans)); build `running | paused | stopped | needs-approval | needs-you | done | error` (see [Builds](#builds)); run `waiting | running | idle | done | stopped | unknown | error` (see [Engines](#engines-and-handoff-runs)). A room left `running` when the board stopped is set to `stopped` on restart; an Ask room comes back `idle`, and a linked run room reads its run again and takes the status it has now. A build that was running then also gets `resumeNeeded: true` and waits for an explicit resume; nothing restarts by itself.

`overrides` (optional, New session modal) is `{seatId: {model?, effort?}}`, stored on the room. Each key must be a real agent id (`400 no such agent`). Each value must be an object (`400 each override must be an object`), and the whole field must be an object keyed by agent id (`400 overrides must be an object keyed by agent id`). `model` is a CLI model name of up to 64 characters from `[A-Za-z0-9._:\-\[\]]` that starts with a letter or digit (`400 invalid model name`). `effort` must be one the agent's CLI supports (`400 effort "..." is not supported by <agent>`). Empty values mean the seat's own setting and are dropped. An override applies to every turn that seat takes in that room and never changes the seat. A Claude scout's brief runs on `claude-haiku-5-5` unless the scout has a `model` override, and the scout's other turns keep their own model. Haiku models get no `--effort` flag.

## Limits and settings

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/limits/refresh` | | `{ok: true}`; re-reads the Codex rollout and spawns one Claude Haiku probe |
| `POST /api/settings` | `{lang?, capEffort?: boolean, watchScope?: "project" or "all"}` | settings (`lang` must match `^[\p{L} ()-]{2,30}$`; `capEffort` absent or `true` caps Council discussion rounds at `medium`, `false` keeps each seat's own effort; `watchScope` picks which Claude Code runs the Runs view lists, `project` by default, and any other value is `400` with nothing changed) |

## Capability (write gate)

File edits are available only when every check passes: the repository check, the platform gate, the static check of the board's write flags, a passed write check for the CLI, and explicit intent. See [ADR 0006](decisions/0006-worktree-write-gate.md) and the [security model](ARCHITECTURE.md#security-model). The Settings card, the start page, the agent editor, the Start build dialog and the preflight read this status.

Codex file edits are off on every platform in v0.2, and nothing turns them on: no setting, flag, environment variable or seat field. A Codex builder in a write build runs read-only and returns a diff that the board checks and applies in the item worktree ([Codex patch mode](#builds)).

| Route | Body | Returns |
| --- | --- | --- |
| `GET /api/capability` | | `CapabilityStatus`, checked now (runs `<cli> --version` for each CLI) |
| `POST /api/capability/verify` | `{seatId}` | `200 {ok: true, started: true}`. Starts one real turn of that seat in a throwaway repository under the OS temp directory, laid out like a build (`.orchestra/worktrees/check/item`). The turn costs one seat turn. The verdict arrives as a `capability` SSE event, and `pass`, `fail` and `inconclusive` are stored in the per-user record file (see [Persistence](#persistence)). `404 {error: "no such agent"}` for an unknown seat; `409 {error, code: "unsupported-platform"}` for a CLI the platform gate refuses (every Codex seat in v0.2), with nothing spawned, created or stored; `409 {error, code: "busy"}` while a check runs; `400` for a missing or malformed `seatId`. |

The write check asks the CLI, with its Write tool only, to create one file inside its worktree, one in the check repository's root by absolute path and one in a folder next to the repository by a `../` path, and to report each step. The turn runs with the tool log collected. Verdicts, decided from the disk first:

1. `fail`: something escaped (an outside file exists; the repository, the scratch folder or `.orchestra/` outside the worktree changed; or a read failed), or the inside file is missing.
2. `inconclusive`: an outside write was never attempted, or an attempt was neither an error nor a permission denial. Writes stay off; run the check again.
3. `pass`: the inside file exists and every outside attempt was refused.

A check that could not run (git missing, a setup error, a failed turn, a turn that was not granted write mode, or a violation recorded while it ran) is sent as an error in the SSE event and is not stored, so an earlier verdict stays.

`CapabilityStatus` (example values on Windows):

```json
{
  "writes": "unavailable",
  "reason": "Claude Code: not verified yet: run the write check for this CLI; Codex: off on Windows: ...",
  "platform": "win32",
  "legacyRecordIgnored": false,
  "git": { "ok": true, "version": "2.45.2", "reason": null },
  "repo": { "ok": true, "reason": null },
  "agents": {
    "claude": { "available": false, "reason": "not verified yet: run the write check for this CLI", "code": "unverified", "verifiable": true, "version": "2.1.291", "verified": null, "settings": ["cwd = the item worktree", "..."] },
    "codex": { "available": false, "reason": "off on Windows: ...", "code": "codex-windows-unelevated", "verifiable": false, "version": "0.160.0", "verified": null, "settings": ["Codex file edits are off in v0.2: Codex seats read, review and propose", "..."] }
  },
  "checkedAt": "2026-10-08T09:00:00.000Z"
}
```

`writes` is `available` when at least one agent is available, and `reason` is then `null`. `platform` is the OS the gate decided for. `legacyRecordIgnored` is true when an old `.orchestra/capability.json` exists in the project: it is never read, and the card says so. `repo.reason` names the failed repository check: git missing or too old, not a git repository, not the top level of one, a bare repository, no commits yet, or `.orchestra/worktrees` not ignored by git.

Each agent entry has `available`, `reason` and `code` (both `null` when available), `verifiable` (false when the platform gate refuses this CLI, so the write check cannot run at all), `version`, `verified` (the stored record or `null`) and `settings` (the confinement settings for that CLI on this platform). The checks run in this order, and the first failure sets `reason` and `code`:

| # | Condition | `code` |
| --- | --- | --- |
| 1 | the repository is not usable | `repo` |
| 2 | the platform gate refuses the CLI (Codex on Windows; Codex on macOS and Linux in v0.2; any other OS) | `codex-windows-unelevated`, `codex-writes-off`, `codex-platform-unsupported` |
| 3 | the board's own write argv fails the static check | `unsafe-flags` |
| 4 | no CLI version | `no-version` |
| 5 | no record | `unverified` |
| 6 | the record is inconclusive | `check-inconclusive` |
| 7 | the record failed | `check-failed` |
| 8 | the record no longer matches: CLI version, platform, write settings, CLI binary (path, size or modification time), or host and user | `drift-version`, `drift-platform`, `drift-settings`, `drift-binary`, `drift-machine` |
| 9 | this board process saw a violation: the runtime guard saw a change outside a worktree, or the CLI reported an unsafe setup at the start of a write turn | `guard`, `startup` |

An agent whose status could not be computed at all has `code: "error"` and is unavailable. A seat whose CLI is neither Claude nor Codex fails the platform gate with `unknown-agent`.

## Plans

A plan room runs an optional debate (two or more participants), then the manager writes the plan. Nothing is built by a plan. The manager reads the project with read tools only and gets at most two turns: the second one repairs an invalid plan.

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/plan` | `{goal (required, <= 8000 chars), seatIds? (0 or 2-20 agent ids; unknown ids are dropped first), managerId (required), rounds? (1-5, default 1), scoutId?, synthId?, withContext?: boolean, overrides?, councilId?}` | `{roomId}`. The plan runs in the background. `400` with `Write a goal`, `Pick a manager agent`, or `Pick at least 2 debate participants, or none to let the manager plan alone`. With `councilId` (Turn into Workflow) the plan starts from a finished Council instead of a debate: `seatIds` is ignored, no debate turn runs, the room stores `councilId`, and the manager reads a digest of that Council. The id must name a `meeting` room (`400 no-council`) whose status is `done` (`409 council-not-done`). |
| `POST /api/plan/:id/approve` | `{revision, hash, plan?}` | `{ok: true, approval}`. With `plan`, a plan that differs from the current revision is saved first as a new user revision, and the result is approved in the same step. |
| `POST /api/plan/:id/edit` | `{revision, hash, plan}` | `{ok: true, revision, hash}`. Saves a new revision and clears the approval. `400 no changes` when the plan is identical. |
| `POST /api/plan/:id/reject` | `{revision, hash, note? (<= 2000 chars)}` | `{ok: true}`. A rejected plan can still be edited and approved; it cannot be built while it is rejected. |

`revision` is an integer from 1 to 1000000 and `hash` is the `planHash` of the revision (sha256, 64 hex characters). Approve, edit and reject need both, and both must match the room's current revision, otherwise `409 stale`. They return `409 not-ready` while the plan is running, stopped or in error, and `404 no-plan` when the id is not a plan room.

Plan object:

```json
{
  "goal": "Add a CSV export to the reports page",
  "items": [
    {
      "id": "csv-writer",
      "title": "CSV writer",
      "spec": "Add toCsv(rows, columns) in src/export/csv.js. Quote fields that contain commas, quotes or newlines.",
      "owns": ["src/export/csv.js", "test/csv.test.js"],
      "dependsOn": [],
      "difficulty": "easy",
      "seatId": null
    }
  ]
}
```

Validation (`400 invalid-plan` with the message). `goal` is required and at most 8000 characters. A plan has 1 to 30 items. An item `id` matches `^[a-z0-9][a-z0-9-]{0,31}$` and is unique. `title` is at most 120 characters and `spec` at most 4000. `owns` holds 1 to 20 repo-relative POSIX paths: directories or files, no globs, no `..`, no absolute paths, no colons, no trailing dot or space, and nothing under `.git` or `.orchestra`. No two items may own overlapping paths (case-insensitive). `dependsOn` lists other item ids and must not contain cycles. `difficulty` is `easy`, `medium` or `hard`. `seatId` is `null` or an existing agent id. A non-null `seatId` overrides the tier mapping for that item when the agent exists, also when the manager wrote it; the manager is told to leave it null, but that is not enforced. `planHash` is the sha256 of the plan's canonical JSON (object keys sorted, no whitespace).

A plan room also carries `plan` (the current revision), `planRevision`, `planHash`, `revisions` (the last 20, each with `revision`, `hash`, `by` (`manager` or `user`), `at` and `plan`), `approval` (`null`, or `{decision: "approved" | "rejected", revision, hash, at, note?}`) and `buildIds`.

## Builds

A build runs an approved plan item by item, and each item goes to the agent for its difficulty tier. In write mode each item works in its own git worktree.

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/build` | `{planRoomId, revision, hash, roles, maxRounds? (1-6, default 3), escalate?: boolean, mode?: "write" or "propose"}` | `{roomId}`. `roles` is keyed by `manager`, `hard`, `medium`, `easy` and `reviewer`; a value is an agent id, or `""` or `null` for none. At least one role needs an agent. A role without an agent falls back along a fixed chain: manager to hard, medium, easy, reviewer; hard to medium, manager, easy, reviewer; medium to hard, easy, manager, reviewer; easy to medium, hard, manager, reviewer; reviewer to manager, hard, medium, easy. |
| `POST /api/build/:id/pause` | | `{ok: true}`. The build pauses after the current item. `409 not-running` when no loop is active. |
| `POST /api/build/:id/resume` | `{revision?, hash?}` | `{ok: true}`. Resume is always explicit, also after a board restart. Without `hash`, the plan must still be approved at the build's revision. With `hash` and the approved `revision`, the build adopts that newer revision: unchanged items (same `itemHash`) keep their state, changed or new items start over, and items no longer in the plan are discarded. |
| `POST /api/build/:id/items/:item/apply` | `{hash}` | `{ok: true, tree}`. `hash` must be the item's current proposal hash. The change is staged in the main checkout and never committed. Failures are listed under Apply below. |
| `POST /api/build/:id/items/:item/discard` | | `{ok: true}`. Removes the item's worktree and keeps its patch file. Items that depend on it become blocked. `409 busy` while the item is being built; `409 applied` for an applied item. |
| `GET /api/build/:id/items/:item/proposal` | | `{itemId, status, proposal, review, patch, truncated, applicable}`. `patch` is the frozen diff as text, at most 2,000,000 characters (`truncated` is true when it was cut). `applicable` is `{ok, code, reason}`: whether apply would succeed now, and the first failing precondition if not. |

Mode. Without `mode`, a build runs in write mode when every builder can write, and in propose mode otherwise; `modeReason` says why. A Claude builder can write when it is a write seat and Claude passed its write check. A Codex builder can write when it is a write seat and the repository check passes: it builds in Codex patch mode (below), so the Codex write gate is never asked. The Build dialog's Mode is Automatic by default and then sends no `mode`, so a build started from the UI writes whenever its builders can: the seat's write permission plus the plan approval is the explicit intent. Send `mode: "propose"` to build without file edits. `mode: "write"` with a builder that cannot write is `409 writes-unavailable`. Propose mode makes no file changes, and the apply routes refuse with `400 propose-mode`.

Codex patch mode (write builds). A Codex builder never gets file edits. Its turn runs read-only in the item worktree (`sandbox_mode="read-only"`) and must end with one unified diff in a ```` ```diff ```` block. The board takes the last such block and vets it: at most 8 MB, no absolute path, no `..`, nothing under `.git` or `.orchestra`, no symlink (`120000`) or submodule (`160000`) mode, only paths inside the item's `owns`. It then runs `git apply --check` and `git apply` in the item worktree, never in the main checkout, and freezes the worktree like any write turn. A refused or failing diff is sent back to the builder without a review. A file that changes in the worktree during the read-only turn quarantines the item. The frozen proposal carries `via: "diff"`, `untested: true` and a `note`: the builder only read, and the board ran no tests.

Patch export (propose mode). After a passing review, the builder's last ```` ```diff ```` block is vetted the same way, checked with `git apply --check` against the main checkout (read only), and written to `.orchestra/proposals/<build>/<item>-r<round>.patch` with a `.sha256` file beside it. Nothing is applied. The result is `item.exported`: `{file, rel, hash, files, bytes, check: {ok, reason}, untested: true, note, round, at}`, or, when the diff was refused, `{file: null, hash: null, files, check: {ok: false, reason}, refused: <code>, untested: true, round, at}`. A failing check is recorded, never thrown. Apply it yourself with `git apply --check <file>` and `git apply --index <file>` after you read it.

Start checks, in this order: `404 no-plan` (not a plan room); `409 not-approved` (the plan is not approved at this revision and hash); `409 writes-unavailable` (write mode needed, and the gate or the repository check says no; the message names the reason, for example when HEAD has no commit yet); `409 checkout-dirty` (write mode, and the project has staged, unstaged or untracked changes outside `.orchestra/`); `409 busy` (another write build runs, or an apply is in flight).

Pause and resume. Resume returns `409 not-resumable` unless the build is `paused`, `stopped`, `needs-approval` or `needs-you`. Pause returns `409 not-running` when no loop is active; otherwise the build pauses after the current item. Resume returns `409 busy` while the loop is still running, another write build runs, or an apply is in flight. Resume can also return `409 no-plan`, `409 not-approved`, or `409 writes-unavailable` when a builder that still has work cannot write.

Reviewer. The reviewer of an item is the first of reviewer, manager, hard, medium and easy that is a different agent from the builder. When only one agent is assigned, the builder reviews its own work and the room posts a note.

Apply. These preconditions are checked in this order, and `applicable` reports the same codes:

1. `build-running`: the build is running. Pause it or wait.
2. `not-reviewed`: the item has no passing review.
3. `review-stale`: the review's hash is not the proposal's hash.
4. `proposal-missing` or `proposal-changed`: the patch file is gone, or no longer matches its hash.
5. `unsafe-proposal`: the patch touches `.git`, `.orchestra` or an alias of them, adds or keeps a symlink or a submodule, or touches a path outside the item's owner areas.
6. `dependency-not-applied`: a dependency is not applied yet.
7. `approval-stale`: the plan is no longer approved at the build's revision.
8. `checkout-dirty`: the main checkout has unstaged or untracked changes, or staged changes the board did not apply.
9. `base-changed`: HEAD moved to a commit that does not contain what the board applied.
10. `does-not-apply`: `git apply --check --index` fails.

Then `git apply --index` runs. If the staged paths differ from the proposal's files, the change is reverted and the response is `409 apply-mismatch`. If git's own apply fails, the item becomes `apply-failed` and the response is `409 does-not-apply`. If the index tree cannot be written after a clean apply, the response is `409 apply-failed`. Applies run one at a time: a second request waits for the first and then runs its own checks. `409 stale-proposal` means the `hash` is not the item's current proposal hash. On success the item is `applied`, its worktree is removed, and the room records the new expected tree.

Build object. The room meta (without messages) carries `status`, `mode`, `modeReason`, `planRoomId`, `planRevision`, `planHash`, `roles` (as sent), `resolved` (the agent for each role), `roleNotes`, `maxRounds`, `escalate`, `baseCommit`, `expectedTree`, `order` (item ids in build order), `items` (keyed by id), `applied`, `baseApplied` (applied items that you have since committed) and `resumeNeeded`.

Build statuses: `running`; `paused` (after an item; resume continues); `stopped` (stopped by you or by a board shutdown; resume continues); `needs-approval` (the plan changed or lost its approval; approve it, then resume); `needs-you` (some items failed or need a decision; resume retries them, or discard them); `done` (every item passed or applied); `error` (a build error, or an item was quarantined; such a build cannot be resumed, so delete it).

BuildItem:

```json
{
  "id": "csv-writer",
  "title": "CSV writer",
  "difficulty": "easy",
  "owns": ["src/export/csv.js", "test/csv.test.js"],
  "dependsOn": [],
  "itemHash": "<sha256 of the plan item>",
  "status": "passed",
  "builderId": "claude",
  "reviewerId": "codex-reviewer",
  "selfReview": false,
  "rounds": 1,
  "attempts": 0,
  "worktree": { "rel": ".orchestra/worktrees/<build>/csv-writer", "baseCommit": "<sha>", "startTree": "<tree sha>" },
  "proposal": { "round": 1, "hash": "<sha256 of the patch>", "file": "proposals/<build>/csv-writer-r1.patch", "files": ["src/export/csv.js"], "bytes": 812, "frozenAt": "2026-10-08T09:00:00.000Z" },
  "review": { "hash": "<sha256 of the patch>", "verdict": "pass", "msgId": "<id>", "seatId": "codex-reviewer", "at": "2026-10-08T09:01:00.000Z" },
  "exported": null,
  "error": null
}
```

`proposal.file` is relative to `.orchestra/`. Item statuses: `pending`; `blocked` (waiting for a dependency that is not passed or applied); `building`; `reviewing`; `passed`; `needs-you` (the review rounds ran out); `failed` (two attempts failed, or the worktree could not be prepared); `quarantined` (a change outside the worktree was observed, and the build stops); `applied`; `apply-failed`; `discarded`. In propose mode `worktree` and `proposal.file` are `null`, `proposal.files` is empty, and `proposal.msgId` names the message that holds the proposal text. `exported` is `null` until a propose-mode item passes (see Patch export above).

Deleting a build (`POST /api/rooms/:id/delete`) removes its worktrees and its frozen proposals. Patch files are otherwise kept after discard.

## Engines and handoff runs

After a plan is approved, Workflow asks who builds it. An engine is one of three builders:

| `id` | UI label | `launch` | What it does |
| --- | --- | --- | --- |
| `board` | Board team | `board` | The build workflow above, on your seats, behind the write gate. `POST /api/build` stays the canonical route. |
| `claude-code` | Claude Code, you run it | `handoff` | External. The board writes a handoff file and a paste prompt; you run the plan as a Workflow in your own Claude Code; the board finds the run, links it after one click, mirrors its agents and shows what changed. |
| `codex` | Codex, you run it | `handoff` | External, the same flow with Codex sub-agents (`spawn_agent`), followed through `~/.codex/sessions` rollouts. |

External means outside the board's write gate: the run uses your own CLI settings and can edit your checkout. The handoff asks it to work in a git worktree or on a branch `ob/<code>` and to leave the changes uncommitted, but that is guidance only. The board never starts, stops or kills an external run. Launching Codex runs from the board is planned for v0.3.

`EngineInfo` (in `GET /api/state` and the `engines` event): `{id, label, launch, available, hidden, reason, note, modes}`. `reason` is set when the engine cannot be used, and `note` carries a warning while it can. `modes` lists the build modes the board team can run now (`write` and `propose`; `[]` for the handoff engines). Availability follows the doctor's CLI `state`: the board team needs one CLI in state `ok` or `warn`, and a `broken` CLI turns its seats off. A handoff engine shows when its CLI is not `missing` or its data folder exists (`<claudeHome>/projects` or `<codexHome>/sessions`), and stays available while shown, because the board never launches that CLI. `claudeHome` is `$CLAUDE_CONFIG_DIR` or `~/.claude`; `codexHome` is `$CODEX_HOME` or `~/.codex`.

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/run` | `{engine, planRoomId, revision, hash, options?}` | `{roomId, pastePrompt?}`. Starts an engine for an approved plan. `engine: "board"` starts a build, and `options` then takes `roles`, `maxRounds`, `escalate` and `mode` as in `POST /api/build`; any other key is `400 invalid-options`. A handoff engine takes `options: {tiers: {easy?, medium?, hard?}}`, the suggested model per difficulty, written into the handoff and never enforced. It writes `.orchestra/handoff/<planRoomId>-r<revision>-<code>.md`, creates the run room in `waiting` and returns the prompt to paste into the CLI. Errors: `400 unknown-engine`, `400 invalid-options`, `404 no-plan`, `409 not-approved` (not approved at this revision and hash), `409 engine-unavailable`. |
| `GET /api/run/:id/candidates` | | `{candidates, planChanged}`. Runs that may be yours, at most 20. Runs whose agent labels or agent paths carry the run code come first (`tokenMatch: true`), then runs that started at most 60 s before the handoff or later, ranked by how many plan item ids they name (`score`), then the newest. A Candidate is `{ref, title, status, startedAt, agentCount, tokens, tokenMatch, score}`. |
| `POST /api/run/:id/link` | `{ref}` | `{ok: true, linked, status}`. `ref` must be one of the current candidates (`400 not-a-candidate`, or `400 invalid-ref` when malformed). `409 already-linked` when the room is linked: unlink first. `linked` is `{runId}` for Claude Code and `{parentThreadId}` for Codex. |
| `POST /api/run/:id/unlink` | | `{ok: true}`. The board stops following, and the room waits for another link. The user's run goes on. |

The run routes answer `404 no-run` for an id that is not a handoff run room.

The run code is `ob` plus 6 characters from `[a-z2-7]`. The handoff tells Claude Code to label every agent `<code>:<itemId>:<tier>`, and Codex to give each sub-agent the `task_name` `<code>_<item>`, where the item id is lowercased with `-` turned into `_` (the handoff lists each name). The handoff holds the goal, the plan revision and its hash, the code, the rules, the suggested models and the plan items with `id, title, spec, owns, dependsOn, difficulty` only: no seat ids and no usage.

Run room (`kind: "run"`):

```json
{
  "id": "<room id>", "kind": "run", "engine": "claude-code", "title": "Claude Code run: Add CSV export",
  "status": "running",
  "planRoomId": "<plan room id>", "planRevision": 2, "planHash": "<sha256>", "planChanged": false,
  "token": "obk7q2mz", "handoffFile": ".orchestra/handoff/<plan>-r2-obk7q2mz.md", "handoffMs": 1791460000000,
  "baseHead": "<commit sha or null>", "worktreesAtHandoff": ["<path>"],
  "linked": { "runId": "wf_09d1c243-a39" },
  "run": { "id": "wf_09d1c243-a39", "status": "running", "agentCount": 3, "done": 1, "tokens": 120000 },
  "agents": [{ "id": "<agent id>", "label": "obk7q2mz:i1:easy", "model": "claude-haiku-5-5", "status": "done", "tokens": 41000, "toolCalls": 23 }],
  "changes": null
}
```

`status` is `waiting` (no run linked), `running`, `idle`, `done`, `stopped`, `unknown` (ended without a summary) or `error`. Claude Code's `completed` reads as `done` and `killed` as `stopped`. `planChanged` is set when the plan was edited, rejected or deleted after the handoff; the run still follows the handed revision. `agents` keeps at most 300 entries, with labels, models, statuses, tokens and tool counts only, never prompt or result text. A Codex agent also carries `sandbox` (from its rollout, for example `read-only`, `workspace-write` or `danger-full-access`), `depth`, `parentId` and `itemId`. When the run ends, `changes` is computed once with read-only git: `{git: true, files, stat, newWorktrees}`, that is the changed file count against `baseHead` plus untracked files (`.orchestra` left out), the first 40 lines of `git diff --stat`, and the worktrees that did not exist at the handoff (the board's own left out). Outside a repository it is `{git: false}`.

A linked room is saved at most every 5 s while only its agents change, and sends at most 2 `engine` events per second.

## Claude Code runs (experimental)

The Runs view lists Claude Code Workflow runs by reading Claude Code's own files under `<claudeHome>/projects`, read only and by polling. The formats are undocumented and can change with any Claude Code update, so the list carries `experimental: true`, unknown fields are ignored and parsing fails soft. Nothing polls while no client holds a lease and no run room is linked.

| Route | Returns |
| --- | --- |
| `GET /api/wf/runs` | `{runs: RunSummary[], scope, experimental: true}`, newest activity first, at most 100. Renews the list lease (60 s; the UI calls it every 30 s while Runs is open). `scope` is `settings.watchScope`. `project` lists runs whose session `cwd` is this project, lies under it, or is an ancestor of it below your home folder; `all` lists every run. |
| `GET /api/wf/runs/:runId` | `{run, agents: RunAgent[]}`. Renews that run's detail lease (90 s). `404 no-run` for an unknown run. |
| `GET /api/wf/runs/:runId/agents/:agentId/preview` | `{prompt, result}`, each at most 400 characters, read on demand. Previews never go into SSE, `.orchestra` files, `LOG.md` or any prompt. `404 no-agent`. |

Ids are checked before any file is read: `400 bad-run-id` unless the run id matches `^wf_[0-9a-f]{8}-[0-9a-f]{3}$` (or the fallback `^wf_[\w-]{1,40}$`), and `400 bad-agent-id` unless the agent id matches `^a\w{8,40}$`. Every path must resolve under `<claudeHome>/projects`, and symbolic links are skipped.

RunSummary: `{id, engine: "claude-code", title, project, sessionId, status, startedAt, lastActivityAt, endedAt, agentCount, done, failed, tokens, phases, linkedRoomId}`. `status` is `completed` or `killed` (a summary exists and nothing changed more than 5 s after it), `running` (a change in the last 2 minutes), `idle` (the last change 2 to 15 minutes ago) or `unknown` (no summary and no change for 15 minutes; the UI says "Ended without a summary").

RunAgent: `{id, key, label, phase, model, status, attempt, startedAt, lastActivityAt, endedAt, tokens, net, toolCalls, lastTool}`. `status` is `done`, `failed`, `retried`, `running` or `stopped`. `tokens` is Claude Code's own figure for the agent; `net` sums input, cache creation and output once per message id.

What is read, and nothing else is opened: the first line with a `cwd` in each session transcript (within 256 KB; only `cwd` is kept), the workflow journals (type, key, agent id, label and phase; a result only by its shape and size), each agent's meta file (description, phase, model, start time), the transcripts of running agents (timestamps, message ids, models, usage, content block types and tool names) and the run summaries (the fields above). Prompt text, result text, scripts, logs, arguments and errors are never stored.

## Error codes

Errors are `{error, code?}`. Branch on `code`; the message is for people. Malformed bodies return `400` without a code, and `404 {error: "no such build"}` or `{error: "no such item"}` have no code either.

| Code | Status | Meaning |
| --- | --- | --- |
| `no-plan` | 404 on plan routes, 409 on builds | the plan does not exist, or the build's plan is gone |
| `stale` | 409 | the plan revision or hash is not the room's current one |
| `not-ready` | 409 | the plan is running, stopped or in error |
| `invalid-plan` | 400 | the plan does not validate, or it names an agent that does not exist |
| `no-changes` | 400 | the edited plan is identical to the current revision |
| `not-approved` | 409 | the plan is not approved at this revision and hash |
| `invalid-roles` | 400 | a role name or an agent id is not valid, or no role has an agent |
| `writes-unavailable` | 409 | write mode is needed and the gate does not allow it; the message names the reason |
| `checkout-dirty` | 409 | the project checkout has changes the board did not make |
| `busy` | 409 | a write build, an apply, a write check or the item's own build is in progress |
| `build-busy` | 409 | deleting a build room while its loop is still stopping; the room stays stopped, retry in a moment |
| `not-running` | 409 | pause on a build that is not running |
| `not-resumable` | 409 | resume on a build that is not paused, stopped, waiting for approval or waiting for you |
| `propose-mode` | 400 | apply on a build that only proposes changes |
| `stale-proposal` | 409 | the apply hash is not the item's current proposal hash |
| `build-running` | 409 | the item is being built, or the build is still running |
| `not-reviewed`, `review-stale`, `proposal-missing`, `proposal-changed`, `unsafe-proposal`, `dependency-not-applied`, `approval-stale`, `base-changed`, `does-not-apply` | 409 | apply preconditions (see Builds) |
| `apply-mismatch`, `apply-failed` | 409 | the apply ran, and its result was reverted or failed |
| `state-not-saved` | 500 | the apply was staged in the main checkout, but the build state could not be persisted |
| `applied` | 409 | discard of an item that is already applied |
| `unsupported-platform` | 409 | a write check for a CLI the platform gate refuses (every Codex seat in v0.2); nothing ran |
| `invalid-mode`, `invalid-rounds` | 400 | a build `mode` or `maxRounds` outside the allowed values |
| `dependency-conflict` | 409 | a dependency's frozen patch does not apply to a new item worktree |
| `no-council` | 400 | `councilId` does not name a Council room |
| `council-not-done` | 409 | `councilId` names a Council that has not finished |
| `unknown-engine` | 400 | `POST /api/run` names an engine that does not exist |
| `invalid-options` | 400 | the engine options are malformed or hold an unknown key |
| `engine-unavailable` | 409 | the engine cannot run now; the message names the reason |
| `no-run` | 404 | the id is not a handoff run room, or the Claude Code run is unknown |
| `invalid-ref`, `not-a-candidate` | 400 | link with a malformed ref, or one that is not a current candidate |
| `already-linked` | 409 | link on a run room that is linked; unlink first |
| `bad-run-id`, `bad-agent-id` | 400 | a Claude Code run or agent id with the wrong shape; no file was read |
| `no-agent` | 404 | no such agent in that Claude Code run |

## SSE events

Each `data:` line is a JSON object with a `t` field:

| `t` | Payload |
| --- | --- |
| `hello` | first event |
| `seat` | `{seat: publicSeat}` |
| `seatGone` | `{id}` |
| `run` | `{seatId, runId, roomId}` a turn started |
| `delta` | `{seatId, runId, text, reset?: true}` streamed answer text; `reset: true` (with empty text) means a retry started, so the client drops the text streamed so far |
| `item` | `{seatId, runId, roomId, kind: 'tool'|'reasoning'|'error'|'retry'|'system', text (<= 200 chars), ts}` |
| `end` | `{seatId, runId, roomId, ok, tokens, cached, cost, error|null}` |
| `room` | `{room}` room meta without messages (plan and build rooms also carry `plan`, `revisions`, `approval`, `items` and `order`) |
| `roomGone` | `{id}` |
| `msg` | `{roomId, msg}` |
| `limits` | `{limits}` |
| `settings` | `{settings}` |
| `cli` | `{cli}` detected CLI versions (`<bin> --version`, cached) |
| `capability` | `{capability}` after each status or write check. `error` (a string) is added when a write check ended without a verdict |
| `build` | `{roomId, itemId, item}` after each item state change; `item` is a BuildItem (see [Builds](#builds)) |
| `apply` | `{roomId, itemId, ok, code, error, tree}` after each apply attempt; `tree` is set on success, `code` on failure |
| `engines` | `{engines: EngineInfo[]}` after each doctor run (at start and on each `GET /api/doctor`) |
| `engine` | `{roomId, run, agents}` when a linked run changes; `agents` holds only the agents that changed. At most 2 per second per room |
| `wfRuns` | `{runs: RunSummary[]}` when the Claude Code run list changes while a list lease is held |
| `wfRun` | `{run, agents}` with only the changed agents, at most every 500 ms per run, while that run has a detail lease or a linked run room |

`tokens` is net (Claude: input + cache creation + output; Codex: input minus cached plus output); `cached` is cached input; `cost` is USD (Codex reports 0).

## Persistence

`<project>/.orchestra/`: `seats.json`, `rooms/<id>.json`, `limits.json`, `settings.json`, `session` (the session token, mode 0600 on POSIX), `LOG.md` (one line per finished Council, Propose -> Review, plan or build), `BRAINSTORM.md`, `empty/` (cwd for Codex no-tools turns). The generated `.orchestra/.gitignore` keeps `session`, `empty/`, `worktrees/` and `capability.json` out of git; an existing one gains any missing line. Optional `.orchestra/PLAN.md` and `.orchestra/HANDOFF.md` are attached, with the tail of `LOG.md`, when a room is started *with context*.

Write-mode state (v0.2):

* Write check records are not in the project. They live in one file per user: `%APPDATA%\agent-orchestra-board\capability.json` on Windows, `~/Library/Application Support/agent-orchestra-board/capability.json` on macOS and `${XDG_CONFIG_HOME:-~/.config}/agent-orchestra-board/capability.json` elsewhere, written atomically. Shape: `{version: 2, agents: {claude, codex}}`; each agent is `null` or `{result: "pass" | "fail" | "inconclusive", detail, checkedAt, cliVersion, platform, settingsHash, exe, exeSize, exeMtimeMs, host, user}`, where `exe` is the realpath of the CLI binary the board would start. A version 1 file counts as no record. A `.orchestra/capability.json` from an earlier v0.2 build is never read; it only sets `legacyRecordIgnored`.
* `proposals/<build>/<item>-r<round>.patch`: the frozen proposal of each round, identified by its sha256. Kept after discard; removed when the build is deleted.
* `proposals/<build>/<item>-r<round>.patch` and `.patch.sha256` in propose mode: the exported diff of a passing item and its hash. Untested, never applied by the board.
* `handoff/<planRoomId>-r<revision>-<code>.md`: the handoff file of an external run. Kept when the run room is deleted.
* `worktrees/<build>/<item>`: the git worktrees of build items. Created in write mode; removed on apply, on discard and when the build is deleted. Detached, so no branches are created.

## Environment

| Variable | Meaning |
| --- | --- |
| `PORT` | default port (overridden by `--port` or the legacy positional port); 4317 otherwise |
| `ORCHESTRA_CLAUDE_BIN`, `ORCHESTRA_CODEX_BIN` | CLI executables, read at spawn time (`claude` / `codex` by default) |
| `ORCHESTRA_LANG` | default `settings.lang` (`English`) |
| `ORCHESTRA_NAIVE` | `1` turns the token levers off (drops the token-trimming CLI flags; the isolation flags stay; no scout, full transcripts, fresh threads, no early stop or effort cap). **Benchmark baseline only**, read at start; see [bench/README.md](../bench/README.md) |
| `ORCHESTRA_RETRY_DELAYS_MS` | comma-separated delays in ms before each automatic retry of a transiently failed turn (`src/config.js` has the default) |
| `ORCHESTRA_IDLE_MINUTES` | minutes of CLI silence before a turn is treated as a transient failure. Default 5, or 10 for Codex seats. The effort multiplies it: x2 at `high`, x3 at `xhigh` and `max`, so a Codex `xhigh` seat waits 30 minutes of silence by default (and a Codex `max` seat too). `ORCHESTRA_IDLE_MINUTES=2` on a Codex `xhigh` seat gives 6 minutes. A `settings.idleMinutes` key in `.orchestra/settings.json` takes precedence over the variable; it is hand-edited only, `POST /api/settings` does not accept it. `0` or `off` disables the watchdog |
| `CLAUDE_CONFIG_DIR` | Claude Code's data folder (default `~/.claude`). The Runs view and the Claude Code engine read its `projects` folder, read only |
| `CODEX_HOME` | Codex's data folder (default `~/.codex`). The usage meter, the Codex engine and `doctor --containment` read its `sessions` folder, read only |
| `CI`, `GITHUB_ACTIONS` | when either is set, `doctor --containment` refuses to run (exit 2) |
