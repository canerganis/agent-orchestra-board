#!/usr/bin/env node
// Compatibility shim: the legacy `node server.js [projectDir] [port]` form -> bin/agent-orchestra-board.js
require('./bin/agent-orchestra-board.js').main(process.argv.slice(2)).catch((e) => { console.error(e.message || e); process.exit(1); });
