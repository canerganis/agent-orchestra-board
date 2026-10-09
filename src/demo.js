// Zero token demo (`agent-orchestra-board demo`): the board on a temporary copy of a tiny sample project, with
// prerecorded rooms from bench/demo-rooms/*.json. No agent can run: the server is built and started here without the
// background CLI checks, every request that could start work is refused, and the runner is shut down so a spawn is
// impossible even if a route slipped through. Nothing touches the user's project or .orchestra/.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const ROOMS_DIR = path.join(__dirname, '..', 'bench', 'demo-rooms');
const MESSAGE = 'Demo, no agents run';

const SAMPLE = {
  'package.json': '{\n  "name": "taskly",\n  "version": "0.1.0",\n  "private": true\n}\n',
  'README.md': '# taskly\n\nA tiny task list CLI used by the Agent Orchestra Board demo.\n',
  'src/format.js': 'function formatText(task) { return `${task.done ? "[x]" : "[ ]"} ${task.id} ${task.title}`; }\nmodule.exports = { formatText };\n',
  'src/list.js': 'const { formatText } = require("./format");\nmodule.exports = (tasks) => tasks.map(formatText).join("\\n");\n',
};

// Banner text. Rooms recorded from a real run carry recordedAt (ISO time); hand written rooms do not and keep MESSAGE.
function bannerText(recordedAt) {
  const d = typeof recordedAt === 'string' ? new Date(recordedAt) : null;
  if (!d || Number.isNaN(d.getTime())) return MESSAGE;
  return `Recorded from a real run on ${d.toISOString().slice(0, 10)}. No agents run now.`;
}

// The first valid recordedAt among the room files in dir, or null.
function recordedAtOf(dir = ROOMS_DIR) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return null; }
  for (const f of names) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).recordedAt;
      if (typeof v === 'string' && !Number.isNaN(new Date(v).getTime())) return v;
    } catch {}
  }
  return null;
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bannerHtml = (text) => `<div id="demo-banner" style="flex:none;box-sizing:border-box;height:32px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:6px 12px;background:#b45309;color:#fff;font:600 13px/20px system-ui;text-align:center">${esc(text)}</div>`;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function copySample(dir) {
  for (const [rel, text] of Object.entries(SAMPLE)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  const rooms = path.join(dir, '.orchestra', 'rooms');
  fs.mkdirSync(rooms, { recursive: true });
  const names = fs.readdirSync(ROOMS_DIR).filter((f) => f.endsWith('.json'));
  for (const f of names) fs.copyFileSync(path.join(ROOMS_DIR, f), path.join(rooms, f));
  return names.length;
}

// Replaces the server's request listener with a guard in front of it. Allowed: GETs that only read state.
function guard(app, banner) {
  const inner = app.handle;
  const refuse = (res, code) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: MESSAGE, demo: true }));
  };
  app.server.removeAllListeners('request');
  app.server.on('request', (req, res) => {
    let p = '/';
    try { p = new URL(req.url, 'http://localhost').pathname; } catch {}
    if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(res, 403);
    // Both probe the CLIs (`<cli> --version`, a capability check): they are not needed to look at recorded rooms.
    if (p === '/api/doctor') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, demo: true, checks: [] })); }
    if (p === '/api/capability') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify(app.capability.cached() || { demo: true })); }
    if (p === '/' || p === '/index.html') {
      // Banner on the page itself: inserted after <body> in the served HTML.
      const end = res.end.bind(res);
      res.end = (chunk, ...rest) => {
        if (chunk && res.statusCode === 200 && /text\/html/.test(String(res.getHeader('content-type') || ''))) {
          chunk = String(chunk).replace(/<body[^>]*>/i, (t) => t + banner);
        }
        return end(chunk, ...rest);
      };
      const wh = res.writeHead.bind(res);
      res.writeHead = (code, ...a) => { res.statusCode = code; const h = a[a.length - 1]; if (h && typeof h === 'object') for (const [k, v] of Object.entries(h)) res.setHeader(k, v); return wh(code, ...a); };
    }
    res.setHeader('x-orchestra-demo', '1');
    return inner(req, res);
  });
}

// -> { app, url, port, projectDir, rooms, close }. opts.port: fixed port (default: a free one, never DEFAULT_PORT).
async function startDemo({ port, tmpRoot = os.tmpdir() } = {}) {
  const { createServer } = require('./server');
  const projectDir = fs.mkdtempSync(path.join(tmpRoot, 'orchestra-demo-'));
  const rooms = copySample(projectDir);
  const usePort = port || await freePort();
  const app = createServer({ projectDir, port: usePort, recordsDir: path.join(projectDir, '.orchestra', 'records') });
  app.runner.shutdown(); // no CLI child can start from this board, whatever route is reached
  const recordedAt = recordedAtOf();
  const banner = bannerText(recordedAt);
  guard(app, bannerHtml(banner));
  // Not app.start(): it also runs the CLI checks and the limits poller, which spawn and read the user's CLI state.
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(usePort, '127.0.0.1', resolve); });
  const url = `http://localhost:${usePort}/?t=${app.token}`;
  const close = async () => {
    try { await app.close(); } finally { try { fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} }
  };
  return { app, url, port: usePort, projectDir, rooms, recordedAt, banner, close };
}

module.exports = { startDemo, MESSAGE, bannerText, recordedAtOf };
