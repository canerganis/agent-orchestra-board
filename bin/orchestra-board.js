#!/usr/bin/env node
// Deprecated alias kept for the old entry point name: the CLI now lives in bin/agent-orchestra-board.js.
// Safe to delete once nothing references bin/orchestra-board.js any more.
const impl = require('./agent-orchestra-board.js');
module.exports = impl;
if (require.main === module) impl.main().catch((e) => { console.error(`agent-orchestra-board: ${e.message || e}`); process.exit(e.exitCode || 1); });
