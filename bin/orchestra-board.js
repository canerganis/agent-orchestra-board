#!/usr/bin/env node
// CLI entry. Usage: orchestra-board [projectDir] [--port <n>] [--open]   |   orchestra-board doctor
// Legacy form still works: node server.js [projectDir] [port]
const path = require('path');
const { spawn } = require('child_process');
const { DEFAULT_PORT } = require('../src/config');

const USAGE = `Usage: orchestra-board [projectDir] [--port <n>] [--open]
       orchestra-board doctor

  projectDir   project to orchestrate (default: current directory); state lives in <projectDir>/.orchestra/
  --port <n>   listen port (default: $PORT or ${DEFAULT_PORT}); binds 127.0.0.1 only
  --open       open the board in the default browser
  doctor       check the environment (Claude/Codex CLIs, project state) and print JSON`;

function parseArgs(argv) {
  const a = { projectDir: null, port: null, open: false, help: false, cmd: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--port') a.port = Number(argv[++i]);
    else if (x.startsWith('--port=')) a.port = Number(x.slice('--port='.length));
    else if (x === '--open') a.open = true;
    else if (x === '--help' || x === '-h') a.help = true;
    else if (i === 0 && x === 'doctor') a.cmd = 'doctor';
    else positional.push(x);
  }
  // [projectDir] [port]: the second positional is the legacy port argument.
  if (positional[0] !== undefined) a.projectDir = positional[0];
  if (positional[1] !== undefined && /^\d+$/.test(positional[1]) && a.port === null) a.port = Number(positional[1]);
  return a;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}

async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.help) { console.log(USAGE); return; }
  const projectDir = path.resolve(a.projectDir || process.cwd());
  if (a.cmd === 'doctor') {
    const result = await require('../src/doctor').run({ projectDir });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const port = a.port || Number(process.env.PORT) || DEFAULT_PORT;
  const { createServer } = require('../src/server');
  const app = createServer({ projectDir, port });
  const info = await app.start();
  console.log(`Orchestra board: ${info.url}  (project: ${info.project})`);
  if (a.open) openBrowser(info.url);
  return app;
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(1); });

module.exports = { main, parseArgs };
