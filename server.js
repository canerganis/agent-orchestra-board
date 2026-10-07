#!/usr/bin/env node
// Compatibility shim: `node server.js [projectDir] [port]` (used by .claude/launch.json) -> bin/orchestra-board.js
require('./bin/orchestra-board.js').main(process.argv.slice(2)).catch((e) => { console.error(e.message || e); process.exit(1); });
