#!/usr/bin/env node
// record-demo.mjs: records the demo rooms (bench/demo-rooms/*.json) from a REAL run.
//
// What it does: creates a temporary sample project (the taskly CLI, one git commit), starts the board in this process
// on a free port with real seats (Claude claude-haiku-5-5, Codex gpt-6-luna at low effort), runs a Council with one
// round, a Workflow plan and a propose mode build of at most 2 small items (Claude Haiku builds, Codex Luna reviews),
// waits for all three, then exports the rooms with local paths rewritten to C:\work\taskly and the user name removed.
// Every room gets a recordedAt field; the demo banner reads it.
//
// It spends real quota on your Claude and Codex logins, so it refuses to run unless OB_REAL=1 is set.
//   OB_REAL=1 node bench/record-demo.mjs [--out <dir>]
// Zero dependencies, Node >= 20. Never uses port 4317.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const require = createRequire(import.meta.url);

export const TOPIC = 'Should taskly add a --json flag to list, and what should it print?';
export const GOAL = 'Add a --json flag to the taskly list command, following the council outcome. Plan at most 2 small items.';
export const SHOWN_PROJECT = 'C:\\work\\taskly';
export const MAX_ITEMS = 2;
export const DEMO_IDS = { meeting: 'demo-council', plan: 'demo-plan', build: 'demo-build' };
const PHASE_TIMEOUT_MS = 25 * 60 * 1000;

export const SAMPLE = {
  'package.json': '{\n  "name": "taskly",\n  "version": "0.1.0",\n  "private": true,\n  "bin": { "taskly": "src/list.js" }\n}\n',
  'README.md': '# taskly\n\nA tiny task list CLI.\n\n    taskly list    print every task, one per line\n',
  'src/list.js': [
    '#!/usr/bin/env node',
    'const tasks = [',
    "  { id: 1, title: 'write the README', done: true },",
    "  { id: 2, title: 'add tests', done: false },",
    "  { id: 3, title: 'publish to npm', done: false },",
    '];',
    'function formatText(task) { return `${task.done ? "[x]" : "[ ]"} ${task.id} ${task.title}`; }',
    'function list(all) { return all.map(formatText).join("\\n"); }',
    'if (require.main === module) console.log(list(tasks));',
    'module.exports = { list, formatText };',
    '',
  ].join('\n'),
};

export function refusal(env = process.env) {
  if (env.CI || env.GITHUB_ACTIONS) return 'record-demo: refusing to run in CI.';
  if (env.OB_REAL === '1') return null;
  return 'record-demo: refusing to run. It starts real Claude and Codex agents under your logins and spends real quota. Set OB_REAL=1 to run it.';
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Rewrites one room for publishing. Pure: returns a new object. paths: absolute local paths of the temporary project
// (all spellings), home: the user's home folder, user: the user name. idMap renames room ids (old -> new).
export function sanitizeRoom(room, { paths = [], home = '', user = '', idMap = {} } = {}) {
  const projectRes = [...new Set(paths.filter(Boolean))].flatMap((p) => [p, p.replace(/\\/g, '/')]).sort((a, b) => b.length - a.length)
    .map((p) => new RegExp(esc(p), 'gi'));
  const homes = [...new Set([home, home.replace(/\\/g, '/')].filter(Boolean))].map((p) => new RegExp(esc(p), 'gi'));
  const userRe = user ? new RegExp(`(?<![A-Za-z0-9_])${esc(user)}(?![A-Za-z0-9_])`, 'gi') : null;
  const fix = (s) => {
    let t = s;
    for (const re of projectRes) t = t.replace(re, (m) => (m.includes('/') ? SHOWN_PROJECT.replace(/\\/g, '/') : SHOWN_PROJECT));
    for (const re of homes) t = t.replace(re, (m) => (m.includes('/') ? 'C:/Users/dev' : 'C:\\Users\\dev'));
    if (userRe) t = t.replace(userRe, 'dev');
    for (const [from, to] of Object.entries(idMap)) t = t.split(from).join(to);
    return t;
  };
  const walk = (v) => {
    if (typeof v === 'string') return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [fix(k), walk(x)]));
    return v;
  };
  return walk(room);
}

// Throws when a sanitized room still carries a local path or the user name.
export function assertClean(room, { paths = [], home = '', user = '' } = {}) {
  const text = JSON.stringify(room).toLowerCase();
  const bad = [...paths, home, user].filter(Boolean).flatMap((p) => [p, p.replace(/\\/g, '\\\\'), p.replace(/\\/g, '/')]).map((p) => p.toLowerCase());
  const hit = bad.find((p) => text.includes(p));
  if (hit) throw new Error(`a room still contains a local value (${hit.slice(0, 4)}...): not written`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=taskly', '-c', 'user.email=taskly@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || '').trim()}`);
}

function makeSample() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-record-'));
  for (const [rel, text] of Object.entries(SAMPLE)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'taskly: initial version');
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[record-demo] ${m}`);

async function main() {
  const why = refusal();
  if (why) { console.error(why); process.exit(2); }
  let out = path.join(ROOT, 'bench', 'demo-rooms');
  const oi = process.argv.indexOf('--out');
  if (oi > 0 && process.argv[oi + 1]) out = path.resolve(process.argv[oi + 1]);

  const { createServer } = require(path.join(ROOT, 'src', 'server.js'));
  const sec = require(path.join(ROOT, 'src', 'security.js'));
  const projectDir = makeSample();
  const port = await freePort();
  if (port === 4317) throw new Error('refusing port 4317');
  const app = createServer({ projectDir, port, recordsDir: path.join(projectDir, '.orchestra', 'records') });
  try {
    await app.start();
    const base = `http://localhost:${port}`;
    const cookie = `${sec.cookieName(port)}=${app.token}`;
    const api = async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${json?.error || text.slice(0, 200)}`);
      return json;
    };
    const waitRoom = async (id, done, what) => {
      const t0 = Date.now();
      for (;;) {
        const room = await api('GET', `/api/rooms/${id}`);
        if (done.includes(room.status)) return room;
        if (['error', 'stopped'].includes(room.status)) {
          // Show why: the last messages carry the error text of the failed turn.
          const tail = (room.messages || []).slice(-4).map((m) => `${m.name || m.kind || 'system'}: ${String(m.error || m.text || '').slice(0, 400)}`).join('\n');
          throw new Error(`${what} ended as ${room.status}${room.error ? ` (${room.error})` : ''}\n${tail}`);
        }
        if (Date.now() - t0 > PHASE_TIMEOUT_MS) throw new Error(`${what} timed out`);
        await sleep(3000);
      }
    };

    // Real seats: Claude Haiku builds, Codex Luna reviews, both at low effort. The other default seats are removed.
    await api('POST', '/api/seats', { id: 'claude', name: 'Claude', role: 'Builder', model: 'claude-haiku-5-5', effort: 'low' });
    await api('POST', '/api/seats', { id: 'luna', name: 'Luna', role: 'Reviewer', model: 'gpt-6-luna', effort: 'low' });
    for (const id of ['sol', 'astra']) await api('POST', `/api/seats/${id}/delete`, {});

    log('Council, one round');
    const council = (await api('POST', '/api/meeting', { topic: TOPIC, seatIds: ['claude', 'luna'], rounds: 1, synthId: 'claude', withContext: true })).roomId;
    await waitRoom(council, ['done'], 'the council');

    log('Workflow plan');
    const planId = (await api('POST', '/api/plan', { goal: GOAL, councilId: council, managerId: 'claude', withContext: true })).roomId;
    const plan = await waitRoom(planId, ['awaiting-approval'], 'the plan');
    if (!plan.plan || plan.plan.items.length < 1 || plan.plan.items.length > MAX_ITEMS) throw new Error(`the plan has ${plan.plan?.items?.length} items, expected 1 to ${MAX_ITEMS}: not recording`);
    await api('POST', `/api/plan/${planId}/approve`, { revision: plan.planRevision, hash: plan.planHash });

    log('Build, propose mode');
    const buildId = (await api('POST', '/api/build', {
      planRoomId: planId, revision: plan.planRevision, hash: plan.planHash, mode: 'propose', maxRounds: 2,
      roles: { manager: 'claude', hard: 'claude', medium: 'claude', easy: 'claude', reviewer: 'luna' },
    })).roomId;
    await waitRoom(buildId, ['done', 'needs-you'], 'the build');

    const recordedAt = new Date().toISOString();
    const real = fs.realpathSync.native(projectDir);
    const ctx = { paths: [projectDir, real], home: os.homedir(), user: os.userInfo().username, idMap: { [council]: DEMO_IDS.meeting, [planId]: DEMO_IDS.plan, [buildId]: DEMO_IDS.build } };
    const files = {};
    for (const [name, id, kind] of [['council', council, 'meeting'], ['plan', planId, 'plan'], ['build', buildId, 'build']]) {
      const room = await api('GET', `/api/rooms/${id}`);
      if (room.kind !== kind) throw new Error(`${name} is a ${room.kind} room`);
      const clean = { ...sanitizeRoom(room, ctx), recordedAt };
      assertClean(clean, ctx);
      files[name] = JSON.stringify(clean, null, 2) + '\n';
    }
    fs.mkdirSync(out, { recursive: true });
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(out, `${name}.json`), text);
    log(`wrote council.json, plan.json and build.json to ${out} (recordedAt ${recordedAt})`);
  } finally {
    try { await app.close(); } catch {}
    try { fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), (e) => { console.error(`record-demo: ${e.message}`); process.exit(1); });
}
