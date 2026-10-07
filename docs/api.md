# HTTP API and SSE events

Everything is JSON. The server binds `127.0.0.1` and applies the security gate before any route: `Host` must be exactly `localhost:<port>`, `127.0.0.1:<port>` or `[::1]:<port>` (else `403 {"error":"forbidden host"}`); an `Origin`, if present, must be `http://` one of those (else `403 {"error":"forbidden origin"}`); `POST` without `content-type: application/json` is `415 {"error":"json required"}`; a body over 1 MB is `413`. Unknown routes are `404`; invalid bodies and handler exceptions are `400 {"error": message}`. Every response carries a strict CSP, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `x-frame-options: DENY` and `cache-control: no-store`.

## Session

Each project has a random token, kept in `<project>/.orchestra/session` (mode 0600) and printed in the start URL (`http://localhost:<port>/?t=<token>`).

| Request | Result |
| --- | --- |
| `GET /?t=<token>` | `303` to `/` with `set-cookie: ob_session_<port>=<token>; Path=/; HttpOnly; SameSite=Strict`; a wrong token is `403 {"error":"bad session token"}` |
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
| `GET /api/state` | `{project, models, efforts, seats: publicSeat[], rooms (<= 25, newest first, with messages), limits, settings}`. The `naive: boolean` field (true when started with `ORCHESTRA_NAIVE=1`) is required by `bench/token-bench.mjs`. |
| `GET /api/doctor` | `{ok, checks: [{id, name, status, detail, hint?}]}`; `ok` is false when any check has `status: "fail"`. Checks: `node`, `claude`, `codex` (CLI found and `--version` runs; a `.cmd` shim is `warn`, a missing CLI is `fail`), `claudeLogin`, `codexLogin`, `codexSandbox`, `pwsh`, `port`, `project`, `orchestra`. Over HTTP no port is passed, so `port` is always `skip` here (the `doctor` CLI tests it). Spawns only `<cli> --version`, never a model call. |

## Seats

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/seats` | `{id?, name (<= 24), role (<= 40), agent 'claude'|'codex', model, effort, perm 'read'|'write', target (<= 1024, inside the project), budget >= 0, color}` | `publicSeat`; `400` on an invalid field or a malformed model name (`^[\w.:\-\[\]]{1,64}$`; any CLI-accepted name or alias is allowed, the `models` in `/api/state` are suggestions), `404` on an unknown `id`. `target` is confined to the project (`realpath`; no `..`, absolute or symlink escapes) and stored relative to it. Changing agent, perm or target resets the seat's thread. |
| `POST /api/seats/:id/send` | `{text}` | `{roomId: "dm-<id>"}` (Direct chat) |
| `POST /api/seats/:id/stop` | | `{ok}` |
| `POST /api/seats/:id/reset` | | `{ok}` (clears the thread) |
| `POST /api/seats/:id/delete` | | `{ok}`; `400` while the seat is running |

`publicSeat` = persisted fields (`id, name, role, agent, model, effort, perm, target, budget, color, thread, used, cached, cost`) + `{status: 'idle'|'working'|'error', activity, startedAt, roomId}`.

## Rooms and workflows

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/meeting` | `{topic (<= 4000), seatIds (2-20 ids), rounds 1-5 (default 2), synthId?, scoutId?, withContext?: boolean, overrides?}` | `{roomId}` |
| `POST /api/chain` | `{task (<= 8000), builderId, reviewerId (different), maxRounds 1-6 (default 3), escalate?: boolean, withContext?: boolean, overrides?}` | `{roomId}` |
| `POST /api/rooms/:id/stop` | | `{ok}` |
| `POST /api/rooms/:id/say` | `{text}` | `{ok}`; only for a running meeting/chain (`400` for dm or finished rooms). The next speaker reads it. |
| `POST /api/rooms/:id/delete` | | `{ok}` |

Room statuses: meeting `running | done | stopped | error`; chain `running | passed | needs-you | stopped | error`; dm `running | idle`.

`overrides` (optional, New session modal) is `{seatId: {model?, effort?}}`, stored on the room. Each key must be a real agent id (`400 no such agent`). Each value must be an object (`400 each override must be an object`), and the whole field must be an object keyed by agent id (`400 overrides must be an object keyed by agent id`). `model` is a CLI model name of up to 64 characters from `[A-Za-z0-9._:\-\[\]]` (`400 invalid model name`). `effort` must be one the agent's CLI supports (`400 effort "..." is not supported by <agent>`). Empty values mean the seat's own setting and are dropped. An override applies to every turn that seat takes in that room and never changes the seat. A Claude scout's brief runs on `claude-haiku-5-5` unless the scout has a `model` override, and the scout's other turns keep their own model. Haiku models get no `--effort` flag.

## Limits and settings

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/limits/refresh` | | `{ok: true}`; re-reads the Codex rollout and spawns one Claude Haiku probe |
| `POST /api/settings` | `{lang?, capEffort?: boolean}` | settings (`lang` must match `^[\p{L} ()-]{2,30}$`; `capEffort` absent or `true` caps Debate discussion rounds at `medium`, `false` keeps each seat's own effort) |

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
| `room` | `{room}` room meta without messages |
| `roomGone` | `{id}` |
| `msg` | `{roomId, msg}` |
| `limits` | `{limits}` |
| `settings` | `{settings}` |
| `cli` | `{cli}` detected CLI versions (`<bin> --version`, cached) |

`tokens` is net (Claude: input + cache creation + output; Codex: input - cached + output); `cached` is cached input; `cost` is USD (Codex reports 0).

## Persistence

`<project>/.orchestra/`: `seats.json`, `rooms/<id>.json`, `limits.json`, `settings.json`, `session` (the session token, mode 0600; the generated `.orchestra/.gitignore` keeps it and `empty/` out of git), `LOG.md` (one line per finished Debate or Propose -> Review), `BRAINSTORM.md`, `empty/` (cwd for Codex no-tools turns). Optional `.orchestra/PLAN.md` and `.orchestra/HANDOFF.md` are attached, with the tail of `LOG.md`, when a room is started *with context*.

## Environment

| Variable | Meaning |
| --- | --- |
| `PORT` | default port (overridden by `--port` or the legacy positional port); 4317 otherwise |
| `ORCHESTRA_CLAUDE_BIN`, `ORCHESTRA_CODEX_BIN` | CLI executables, read at spawn time (`claude` / `codex` by default) |
| `ORCHESTRA_LANG` | default `settings.lang` (`English`) |
| `ORCHESTRA_NAIVE` | `1` turns the token levers off (drops the token-trimming CLI flags; the isolation flags stay; no scout, full transcripts, fresh threads, no early stop or effort cap). **Benchmark baseline only**, read at start; see [bench/README.md](../bench/README.md) |
| `ORCHESTRA_RETRY_DELAYS_MS` | comma-separated delays in ms before each automatic retry of a transiently failed turn (`src/config.js` has the default) |
| `ORCHESTRA_IDLE_MINUTES` | minutes of CLI silence before a turn is treated as a transient failure (`settings.idleMinutes` wins; default 5, or 10 for Codex seats; `0` or `off` disables the watchdog) |
