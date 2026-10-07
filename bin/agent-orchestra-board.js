#!/usr/bin/env node
// CLI entry. Usage: agent-orchestra-board [projectDir] [--port <n>] [--open]   |   agent-orchestra-board doctor [projectDir] [--json]
// Legacy form still works: agent-orchestra-board [projectDir] [port]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnResolved } = require('../src/platform'); // every child process of the board resolves its binary on PATH first
const { DEFAULT_PORT } = require('../src/config');
const { version: VERSION } = require('../package.json');

const USAGE = `Agent Orchestra Board ${VERSION} - a local board that runs Claude CLI and Codex CLI agents as seats.

Usage: agent-orchestra-board [projectDir] [--port <n>] [--open]
       agent-orchestra-board doctor [projectDir] [--port <n>] [--json]
       agent-orchestra-board --version | --help

  projectDir     project to orchestrate (default: current directory); state lives in <projectDir>/.orchestra/
  --port <n>     listen port (default: $PORT or ${DEFAULT_PORT}); the board binds 127.0.0.1 only
  --open         open the board in the default browser once it is listening
  doctor         check the environment (Node, Claude/Codex CLIs and logins, Windows sandbox, port, state dir)
                 prints a table, or JSON with --json; exit code 1 when a check fails
  -V, --version  print the version
  -h, --help     show this help

Legacy form: agent-orchestra-board [projectDir] [port]

Environment: ORCHESTRA_CLAUDE_BIN, ORCHESTRA_CODEX_BIN (CLI executables), ORCHESTRA_LANG (agents' reply language), PORT`;

function parseArgs(argv) {
  const a = { projectDir: null, port: null, open: false, help: false, cmd: null, version: false, json: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--port') { const v = argv[++i]; a.port = v === undefined ? NaN : Number(v); }
    else if (x.startsWith('--port=')) a.port = Number(x.slice('--port='.length));
    else if (x === '--open') a.open = true;
    else if (x === '--json') a.json = true;
    else if (x === '--help' || x === '-h') a.help = true;
    else if (x === '--version' || x === '-V') a.version = true;
    else if (x === '--') { positional.push(...argv.slice(i + 1)); break; }
    else if (x.startsWith('-') && x.length > 1) throw Object.assign(new Error(`unknown option '${x}' (try --help)`), { exitCode: 2 });
    else if (i === 0 && x === 'doctor') a.cmd = 'doctor';
    else positional.push(x);
  }
  // [projectDir] [port]: the second positional is the legacy port argument.
  if (positional[0] !== undefined) a.projectDir = positional[0];
  if (positional[1] !== undefined && /^\d+$/.test(positional[1]) && a.port === null) a.port = Number(positional[1]);
  return a;
}

function resolvePort(a) {
  const port = a.port !== null ? a.port : Number(process.env.PORT) || DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const msg = Number.isNaN(a.port) ? '--port needs a number (1-65535)' : `invalid port '${a.port !== null ? a.port : process.env.PORT}' (expected 1-65535)`;
    throw Object.assign(new Error(msg), { exitCode: 2 });
  }
  return port;
}

// Open a URL in the default browser without blocking or inheriting stdio.
function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawnResolved(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => console.error(`Could not open a browser; visit ${url}`));
    child.unref();
  } catch { console.error(`Could not open a browser; visit ${url}`); }
}

function banner(info, projectDir) {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
  return [
    '',
    `  ${bold(`Agent Orchestra Board ${VERSION}`)}`,
    `  Board    ${bold(info.url)}  ${dim('(127.0.0.1 only)')}`,
    `  Project  ${projectDir}`,
    `  State    ${path.join(projectDir, '.orchestra')}`,
    `  ${dim('Press Ctrl+C to stop; running agent turns are killed with the board.')}`,
    '',
  ].join('\n');
}

// Ctrl+C / SIGTERM: kill every running CLI child (process tree), close the server, then exit. A second signal forces exit.
function installShutdown(app) {
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) { console.error('\nForced exit.'); process.exit(130); }
    stopping = true;
    console.error(`\n${signal}: stopping the board (Ctrl+C again to force)...`);
    // stopWork first: no new CLI turn starts (queued and retrying turns end as stopped), rooms stop, running children die.
    let killed = 0;
    try { killed = app.stopWork(); } catch {}
    if (killed) console.error(`  stopped ${killed} running agent turn${killed === 1 ? '' : 's'}`);
    const bye = () => process.exit(0);
    const t = setTimeout(bye, 3000); t.unref();
    Promise.resolve().then(() => app.close()).then(bye, bye);
  };
  for (const sig of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) process.on(sig, () => shutdown(sig));
  return shutdown;
}

async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.help) { console.log(USAGE); return; }
  if (a.version) { console.log(`agent-orchestra-board ${VERSION}`); return; }
  const projectDir = path.resolve(a.projectDir || process.cwd());
  const port = resolvePort(a);
  if (a.cmd === 'doctor') {
    const doctor = require('../src/doctor');
    const result = await doctor.run({ projectDir, port });
    if (a.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`\n  Agent Orchestra Board ${VERSION} doctor  (${process.platform} ${os.arch()}, node ${process.versions.node})\n\n${doctor.format(result, { color: process.stdout.isTTY && !process.env.NO_COLOR })}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  // `start` must never create a mistyped project path: createServer() runs `mkdir -p` for .orchestra/ and would
  // silently serve an empty project (doctor has its own projectCheck and reports instead of exiting).
  let st; try { st = fs.statSync(projectDir); } catch { throw Object.assign(new Error(`project directory does not exist: ${projectDir}\n  Pass an existing directory (agent-orchestra-board <projectDir>), or run from inside your project.`), { exitCode: 2 }); }
  if (!st.isDirectory()) throw Object.assign(new Error(`not a directory: ${projectDir}`), { exitCode: 2 });
  const { createServer } = require('../src/server');
  const app = createServer({ projectDir, port });
  let info;
  try { info = await app.start(); } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      throw Object.assign(new Error(`port ${port} is already in use. Is another Agent Orchestra Board running at http://localhost:${port}? Otherwise pass --port <other>.`), { exitCode: 1 });
    }
    if (e && e.code === 'EACCES') throw Object.assign(new Error(`no permission to listen on port ${port}; pass --port <other> (1024-65535).`), { exitCode: 1 });
    throw e;
  }
  // info.url is the only valid entry point (it carries the per-project token persisted in .orchestra/session), so
  // never rebuild it from the port.
  const url = (info && info.url) || `http://localhost:${port}`;
  console.log(banner({ url }, projectDir));
  installShutdown(app);
  if (a.open) openBrowser(url);
  return app;
}

if (require.main === module) main().catch((e) => { console.error(`agent-orchestra-board: ${e.message || e}`); process.exit(e.exitCode || 1); });

module.exports = { main, parseArgs, openBrowser };
