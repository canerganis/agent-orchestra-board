# Real CLI recordings

Recorded on 2026-10-09 on Windows 11 with the board's own adapter arguments (read-only seats), in a throwaway two file sample project:

1. Claude Code 2.1.291, model claude-haiku-5-5: claude-plain, claude-tool (reads src/list.js), claude-resume.
2. Codex CLI 0.160.0, model gpt-6-luna at low effort, unelevated Windows sandbox, read-only: codex-plain, codex-tool, codex-resume.
3. Google Antigravity CLI (agy) 1.2.17, model gemini-3.8-flash-low, plan mode and sandbox: agy-tool, agy-resume.

Local paths are rewritten to C:\work\demo and the user name to dev; nothing else is edited. The fake CLI in test/fake-cli replays these files, so the parser tests run against real output.
