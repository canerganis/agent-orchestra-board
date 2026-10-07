# Security policy

## Threat model

Orchestra Board is a local tool. It listens on `127.0.0.1` only and spawns the `claude` and `codex` CLIs under your own user account and your own logins. The things it protects are:

1. **Your files.** Seats are read-only unless you set `perm: write`. Write seats get Claude `--permission-mode acceptEdits` with `Read/Grep/Glob/Edit/Write`, or Codex `sandbox_mode=workspace-write`. The confinement differs: a Codex write seat's sandbox cwd is its target directory, so edits stay inside it; a Claude write seat always runs with the project root as cwd, so `acceptEdits` auto-approves edits to **any file in the project**, and its target is only a prompt instruction. Read turns can read the whole project in both cases (and the Codex read-only sandbox can read outside it).
2. **Your browser as an attack path.** The attacker is a web page you have open, not someone on the network. Every request must carry a `Host` of exactly `localhost:<port>`, `127.0.0.1:<port>` or `[::1]:<port>` (DNS rebinding), any `Origin` must be `http://` one of those (cross-site fetch/XHR), and `POST` bodies must be `application/json` (no simple-form CSRF), at most 1 MB, with every field type- and length-checked. On top of that, every `/api/*` request needs the session cookie: a random 192-bit token, stored per project in `<project>/.orchestra/session` (mode 0600) and printed in the start URL, exchanged on first load for an `HttpOnly; SameSite=Strict` session cookie named per port, compared in constant time. Responses carry a strict CSP (`default-src 'self'`, no framing, no external connections), `nosniff`, `no-referrer` and `no-store`. Static files are served only from `public/` after `path.resolve` and a prefix check.
3. **Other local processes and users.** Without the token from your terminal they get `401` from the API; they can only see that the port is open.
4. **Your money.** Turns run against your Claude and Codex plans. Budgets, early stop and lean launches limit spend. Note that the board runs the CLIs non-interactively: a Claude write seat uses `acceptEdits`, which auto-approves file edits without a prompt, and Codex runs with the sandbox mode chosen by the seat's permission; there is no per-edit confirmation step in either case.
5. **Scope of a seat.** A seat's target is confined to the project with `realpath` (no `..`, no absolute escapes, no symlinks pointing out); a target that resolves outside is rejected on save and ignored at run time.
6. **The project under review never supplies the CLI binary.** The board spawns the CLIs with the project (or a seat's target) as working directory, and on Windows libuv looks for a bare program name in the child's cwd before `PATH` unless `NoDefaultCurrentDirectoryInExePath` is set. Every child process of the board (`claude`, `codex`, the `--version` probes, the usage probe, `git`, `taskkill`, the browser opener) therefore goes through `platform.spawnResolved`, which resolves the name on `PATH` (or at the explicit `ORCHESTRA_*_BIN` path) and spawns the absolute file, or fails with "not found"; a `claude.exe` planted in a repository is never run. The board also sets `NoDefaultCurrentDirectoryInExePath=1` for itself on Windows (not for its children) as a second line, and `test/spawn.test.js` enforces that no other module spawns directly.

Out of scope for v0.1: a compromised browser extension with host permissions, malware running as your user, multi-user or remote access, and anything an agent does with the tools you explicitly granted it. The full threat model is in the header of `src/security.js`.

## Supported versions

Only the latest release on `main` receives fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on the repository ("Security" tab, "Report a vulnerability"). If that is not available, open an issue titled "Security contact request" without details and a maintainer will reply with a private channel.

Include: the version or commit, your OS, the request or steps that reproduce it, and what you believe the impact is. You should get an acknowledgement within 7 days. Fixes ship as a patch release with a CHANGELOG entry; we will credit you unless you prefer otherwise.

## Hardening tips

- Never put the port behind a tunnel, reverse proxy or `0.0.0.0` bind; the session cookie is sent over plain HTTP and is only safe on the loopback interface.
- Treat the printed start URL like a password for that project: do not paste it into chats or screenshots. It stays valid across restarts; delete `<project>/.orchestra/session` to rotate it.
- Keep write seats pointed at a directory you can `git diff` and revert, and remember that a Claude write seat can edit anywhere in the project regardless of its target.
- Commit or ignore `<project>/.orchestra/` deliberately: room transcripts can contain file contents a scout read. `.orchestra/session` holds the board's session token and must never be committed; the board writes a `.orchestra/.gitignore` listing it on first start (do not remove that entry).
- Run `orchestra-board doctor` after upgrading either CLI; adapters parse undocumented stream formats.
