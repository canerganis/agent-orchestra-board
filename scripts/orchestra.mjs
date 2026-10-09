#!/usr/bin/env node
// Drive Agent Orchestra Board from a terminal or from Claude Code (the plugin skill calls this file).
// Zero dependencies. Usage:
//   node scripts/orchestra.mjs start   [--project <dir>]            start the board for a project, or find the running one
//   node scripts/orchestra.mjs status  [--project <dir>]            seats and recent rooms
//   node scripts/orchestra.mjs council "<question>" [--seats a,b] [--rounds 1-5] [--project <dir>]
//   node scripts/orchestra.mjs ask     "<text>" [--seat <id>] [--project <dir>]
//   node scripts/orchestra.mjs stop    [--project <dir>]
// The project defaults to the current directory. The board binds 127.0.0.1 only; this script talks to it with the
// project's session token from <project>/.orchestra/session, exactly as the browser does.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'agent-orchestra-board.js');
const PORTS = Array.from({ length: 10 }, (_, i) => 4317 + i);

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (k, d = null) => { const i = argv.indexOf(k); return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--')));
const project = path.resolve(flag('--project', process.cwd()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m, code = 1) => { console.error(`orchestra: ${m}`); process.exit(code); };

const token = () => { try { return fs.readFileSync(path.join(project, '.orchestra', 'session'), 'utf8').trim(); } catch { return null; } };

function req(port, method, p, body) {
  const t = token();
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, timeout: 15000, headers: {
      host: `localhost:${port}`, ...(t ? { cookie: `ob_session_${port}=${t}` } : {}),
      ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d));
      res.on('end', () => { let json = null; try { json = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json, text: s }); });
    });
    r.on('error', () => resolve({ status: 0 })); r.on('timeout', () => { r.destroy(); resolve({ status: 0 }); });
    if (data) r.write(data); r.end();
  });
}

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
async function findBoard() {
  for (const port of PORTS) {
    const r = await req(port, 'GET', '/api/state');
    if (r.status === 200 && r.json && r.json.project && same(r.json.project, project)) return { port, state: r.json };
  }
  return null;
}

async function freePort() {
  for (const port of PORTS) { const r = await req(port, 'GET', '/app.css'); if (r.status === 0) return port; }
  die('no free port in 4317-4326');
}

async function start() {
  const found = await findBoard();
  if (found) return { ...found, started: false };
  if (!fs.existsSync(project)) die(`no such project folder: ${project}`);
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, project, '--port', String(port)], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 60; i++) { await sleep(500); const f = await findBoard(); if (f) return { ...f, started: true }; }
  die(`the board did not come up on port ${port}; run "node ${path.relative(process.cwd(), BIN)} doctor"`);
}

const url = (port) => `http://localhost:${port}/?t=${token()}`;
const seatsOf = (state) => (state.seats || []).map((s) => `${s.id} (${s.agent}, ${s.model}, ${s.status})`).join('; ');

async function waitRoom(port, id, minutes = 20) {
  const t0 = Date.now();
  for (;;) {
    const r = await req(port, 'GET', `/api/rooms/${id}`);
    const room = r.json;
    if (room && !['running', 'queued'].includes(room.status)) return room;
    if (Date.now() - t0 > minutes * 60e3) die(`room ${id} is still running after ${minutes} min; open ${url(port)}`);
    await sleep(4000);
  }
}
const lastReply = (room) => [...(room.messages || [])].reverse().find((m) => m.name && m.text && m.kind !== 'user' && m.name !== 'You');

if (cmd === 'start') {
  const b = await start();
  console.log(`${b.started ? 'Started' : 'Already running'}: ${url(b.port)}`);
  console.log(`Project: ${b.state.project}`);
  console.log(`Agents: ${seatsOf(b.state)}`);
} else if (cmd === 'status') {
  const b = await findBoard();
  if (!b) { console.log(`No board running for ${project}. Start one with: node ${fileURLToPath(import.meta.url)} start`); process.exit(0); }
  console.log(`Running: ${url(b.port)}`);
  console.log(`Agents: ${seatsOf(b.state)}`);
  for (const r of (b.state.roomIndex || []).slice(0, 8)) console.log(`  ${r.kind.padEnd(8)} ${r.status.padEnd(14)} ${r.title}`);
} else if (cmd === 'council') {
  const topic = positional[0]; if (!topic) die('usage: council "<question>" [--seats a,b] [--rounds n]');
  const b = await start();
  const seatIds = flag('--seats') ? flag('--seats').split(',').map((s) => s.trim()) : (b.state.seats || []).map((s) => s.id);
  if (seatIds.length < 2) die('a Council needs at least 2 agents; add one in the board first');
  const r = await req(b.port, 'POST', '/api/meeting', { topic, seatIds, rounds: Number(flag('--rounds', 1)) });
  if (r.status !== 200) die(`could not start the Council: ${r.json?.error || r.status}`);
  console.log(`Council started with ${seatIds.join(', ')}. Watch it live: ${url(b.port)}`);
  const room = await waitRoom(b.port, r.json.roomId);
  const synth = (room.messages || []).find((m) => m.id && m.id === room.resultId) || lastReply(room);
  console.log(`\nStatus: ${room.status}\n`);
  console.log(synth ? `${synth.name}:\n${synth.text}` : 'No synthesis was written.');
} else if (cmd === 'ask') {
  const text = positional[0]; if (!text) die('usage: ask "<text>" [--seat id]');
  const b = await start();
  const seatId = flag('--seat') || (b.state.seats || [])[0]?.id;
  if (!seatId) die('no agents on this board');
  const r = await req(b.port, 'POST', '/api/ask', { seatId, text });
  if (r.status !== 200) die(`could not ask: ${r.json?.error || r.status}`);
  const room = await waitRoom(b.port, r.json.roomId, 10);
  const reply = lastReply(room);
  console.log(reply ? `${reply.name}:\n${reply.text}` : `No reply (status ${room.status}). Open ${url(b.port)}`);
} else if (cmd === 'stop') {
  const b = await findBoard();
  if (!b) { console.log('No board running for this project.'); process.exit(0); }
  console.log(`Stop the board with Ctrl+C in its terminal, or close the process listening on port ${b.port}.`);
} else {
  console.log('usage: node scripts/orchestra.mjs start|status|council "<question>"|ask "<text>" [--project <dir>]');
  process.exit(cmd ? 1 : 0);
}
