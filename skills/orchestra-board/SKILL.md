---
name: orchestra-board
description: Open Agent Orchestra Board for the current project, or ask its Claude Code and Codex agents from the chat. Use when the user asks to open the orchestra board, to get a second opinion or a council from several models, to have Claude and Codex debate a plan, or to ask one board agent something.
---

# Agent Orchestra Board

A local web board (127.0.0.1 only) that runs the user's own Claude Code and Codex CLI logins as agents. It needs Node 20 or newer; builds need git. Every call below goes through one helper script; run it with the Bash tool from the user's project folder, or pass `--project <dir>`.

Helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestra.mjs" <command>`

## Commands

1. Open the board: `start`. It reuses a board already running for this project (ports 4317 to 4326) or starts one in the background. Give the user the printed `http://localhost:<port>/?t=...` link; it is their private session link, so do not paste it anywhere else.
2. See what is there: `status` lists the agents and the newest rooms.
3. A Council: `council "<question>"` with optional `--seats claude,luna` and `--rounds 1` (default 1 round, all agents). Several models answer, discuss and one writes a synthesis; no files change. It waits for the end and prints the synthesis. Tell the user it uses their plan quota on every agent, and offer `--seats` with two agents for a cheap run.
4. One agent: `ask "<text>"` with optional `--seat <id>` (default the first agent). Prints the reply.

## Rules

1. Everything here is read-only for the project: Council and Ask never edit files. Builds that edit files (Workflow) are started by the user in the board UI, where they approve the plan first; do not start them from the chat.
2. Quote the synthesis or reply faithfully and say which agents took part. If the script exits with an error, show the error and the `doctor` hint: `node "${CLAUDE_PLUGIN_ROOT}/bin/agent-orchestra-board.js" doctor`.
3. Long questions: keep the question under 4000 characters; point the agents at files by path instead of pasting them.
4. Never pass `--dangerously-skip-permissions` or edit `.orchestra/` files by hand.
