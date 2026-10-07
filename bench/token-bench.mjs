#!/usr/bin/env node
// token-bench.mjs - reproducible "lean vs naive" Debate benchmark for Agent Orchestra Board.
//
// Starts the same Debate on two running boards (one normal = lean, one started with ORCHESTRA_NAIVE=1 = naive
// baseline), waits for both over SSE, and prints a Markdown report: total / uncached / cached tokens, CLI-reported cost, wall time,
// rounds, early stop, per-agent and per-phase usage, and the Claude/Codex usage-limit meters before and after.
//
// Zero dependencies, Node >= 20, node:http only. Every turn it starts runs under YOUR Claude/Codex logins and spends
// real quota: the script asks for confirmation (or --yes) and never starts anything in --dry-run.
//
// See README.md next to this file for the server contract (ORCHESTRA_NAIVE=1) and the exact procedure.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH_VERSION = '0.1.0';

// Fixed public topic: a planning meeting about the (public) agent-orchestra-board repository itself, so anybody can
// reproduce the run by pointing both boards at a clone of the same commit. Override with --topic / --topic-file.
const DEFAULT_TOPIC = [
  'Planning meeting for Agent Orchestra Board (this repository).',
  'Goal: add per-room token budgets. The user sets a maximum of net tokens for a Debate or Propose -> Review room;',
  'the board must stop the room cleanly when the budget is reached and show the remaining budget live.',
  'Decide: (1) where the budget is enforced (src/runner.js vs src/rooms.js vs src/workflows/*),',
  '(2) how public/app.js shows the remaining budget, (3) what happens to turns already queued when the budget runs out,',
  '(4) which tests need to be added (test/, src/adapters/*.test.js).',
  'Cite file:line for every claim about the code, or mark the claim "unverified".',
].join(' ');

const USAGE = `token-bench ${BENCH_VERSION} - lean vs naive Debate benchmark for Agent Orchestra Board

Usage:
  node token-bench.mjs --url <lean board url> --token <token> --naive-url <naive board url> --naive-token <token> [options]

  The lean board is a normal agent-orchestra-board launch. The naive board is a second launch of the SAME code on another
  port, started with ORCHESTRA_NAIVE=1 (see README.md; the script refuses to run
  when the naive board does not report it). A board URL may be the full start URL printed in the terminal
  (http://localhost:4317/?t=...), in which case --token / --naive-token can be omitted.

Options:
  --seats <id,id,...>       participants (default: every seat of the lean board, in board order; 2-20)
  --scout <id|none>         lean arm only: seat that writes the shared brief (default: first participant)
  --synth <id|none>         facilitator for both arms (default: first participant)
  --rounds <1-5>            discussion rounds (default 2)
  --topic <text>            meeting topic (default: fixed public topic about the agent-orchestra-board repo)
  --topic-file <path>       read the topic from a file instead
  --repeat <n>              run each arm n times (default 1); the report adds mean rows
  --order <lean,naive>      arm order within each repeat (default lean,naive; use naive,lean to reverse)
  --timeout-min <n>         per-run timeout; the room is stopped and reported as 'timeout' (default 45)
  --out-dir <dir>           where token-bench.md / token-bench.json go (default: ./results/<timestamp>/ next to this file)
  --allow-unverified-naive  do not refuse when the naive board does not report naive:true in /api/state
  --allow-seat-mismatch     do not refuse when the two boards' seat configs differ
  --dry-run                 preflight + print the exact request bodies, start nothing
  --yes                     skip the confirmation prompt (required when stdin is not a TTY)
  -h, --help                this text

Exit codes: 0 ok, 1 a run failed/timed out or the report could not be written, 2 bad usage/preflight refused.`;

// ---------- args ----------
function parseArgs(argv) {
  const a = {
    url: null, token: null, naiveUrl: null, naiveToken: null, seats: null, scout: null, synth: null, rounds: 2,
    topic: null, topicFile: null, repeat: 1, order: ['lean', 'naive'], timeoutMin: 45, outDir: null,
    allowUnverifiedNaive: false, allowSeatMismatch: false, dryRun: false, yes: false, help: false,
  };
  const flags = { '--allow-unverified-naive': 'allowUnverifiedNaive', '--allow-seat-mismatch': 'allowSeatMismatch', '--dry-run': 'dryRun', '--yes': 'yes', '-y': 'yes', '--help': 'help', '-h': 'help' };
  const valued = { '--url': 'url', '--token': 'token', '--naive-url': 'naiveUrl', '--naive-token': 'naiveToken', '--seats': 'seats', '--scout': 'scout', '--synth': 'synth', '--rounds': 'rounds', '--topic': 'topic', '--topic-file': 'topicFile', '--repeat': 'repeat', '--order': 'order', '--timeout-min': 'timeoutMin', '--out-dir': 'outDir' };
  for (let i = 0; i < argv.length; i++) {
    let x = argv[i], val;
    const eq = x.indexOf('=');
    if (x.startsWith('--') && eq > 0) { val = x.slice(eq + 1); x = x.slice(0, eq); }
    if (flags[x]) { a[flags[x]] = true; continue; }
    if (!valued[x]) throw usageError(`unknown option '${x}'`);
    if (val === undefined) { val = argv[++i]; if (val === undefined) throw usageError(`${x} needs a value`); }
    a[valued[x]] = val;
  }
  const int = (v, name, min, max) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw usageError(`${name} must be an integer ${min}-${max}`); return n; };
  a.rounds = int(a.rounds, '--rounds', 1, 5);
  a.repeat = int(a.repeat, '--repeat', 1, 20);
  a.timeoutMin = int(a.timeoutMin, '--timeout-min', 1, 600);
  if (typeof a.order === 'string') a.order = a.order.split(',').map((s) => s.trim());
  if (a.order.length !== 2 || !a.order.includes('lean') || !a.order.includes('naive')) throw usageError('--order must be lean,naive or naive,lean');
  if (typeof a.seats === 'string') a.seats = a.seats.split(',').map((s) => s.trim()).filter(Boolean);
  if (a.topicFile) a.topic = fs.readFileSync(a.topicFile, 'utf8').trim();
  a.topic = (a.topic || DEFAULT_TOPIC).trim();
  if (!a.topic || a.topic.length > 4000) throw usageError('topic must be 1-4000 characters');
  return a;
}
const usageError = (m) => Object.assign(new Error(m), { exitCode: 2 });

// Accepts the printed start URL (…/?t=TOKEN): the token is taken from it when no explicit token is given.
function boardFrom(name, url, token) {
  if (!url) throw usageError(`${name === 'lean' ? '--url' : '--naive-url'} is required`);
  let u; try { u = new URL(url); } catch { throw usageError(`${name} board url is not a valid URL: ${url}`); }
  if (u.protocol !== 'http:') throw usageError(`${name} board url must be http:// (the board is local only)`);
  if (!u.port) throw usageError(`${name} board url must include the port, e.g. http://localhost:4317`);
  const t = token || u.searchParams.get('t');
  if (!t) throw usageError(`${name} board: pass --${name === 'lean' ? '' : 'naive-'}token or the full start URL with ?t=...`);
  return { name, base: `${u.protocol}//${u.host}`, host: u.host, port: u.port, token: t };
}

// ---------- http ----------
function request(board, method, p, bodyObj, { stream = false, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, board.base);
    const body = bodyObj === undefined ? null : JSON.stringify(bodyObj);
    const headers = { host: board.host, cookie: `ob_session_${board.port}=${board.token}` };
    if (body !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    if (stream) headers.accept = 'text/event-stream';
    const req = http.request({ hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      if (stream) { if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${method} ${p} -> ${res.statusCode}`)); } return resolve(res); }
      let s = ''; res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        let j = null; try { j = s ? JSON.parse(s) : null; } catch {}
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`${method} ${p} -> ${res.statusCode} ${j?.error || s.slice(0, 200)}`), { status: res.statusCode }));
        resolve(j);
      });
    });
    if (!stream) req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${p} timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}
const explainHttpError = (board, e) => {
  if (e.code === 'ECONNREFUSED') return `${board.name} board at ${board.base} is not running (connection refused)`;
  if (e.status === 401) return `${board.name} board rejected the token (401). Copy the ?t=... value from the terminal where that board was started; it is per project and stays the same until <project>/.orchestra/session is deleted.`;
  if (e.status === 403) return `${board.name} board refused the Host (403). Use http://localhost:<port> or http://127.0.0.1:<port>.`;
  return `${board.name} board: ${e.message}`;
};

// ---------- SSE ----------
// Long-lived watcher with reconnect. Each board gets one; handlers receive parsed `data:` objects.
function watchEvents(board, onEvent, log) {
  let closed = false, res = null, attempts = 0, helloResolve;
  const hello = new Promise((r) => { helloResolve = r; });
  const connect = async () => {
    if (closed) return;
    try { res = await request(board, 'GET', '/api/events', undefined, { stream: true }); }
    catch (e) { attempts++; log(`  (sse ${board.name}: ${e.message}; retry in ${Math.min(10, 2 ** attempts)}s)`); setTimeout(connect, Math.min(10000, 1000 * 2 ** attempts)); return; }
    attempts = 0; let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c; let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue; // ': hb' heartbeats and blank lines
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev?.t === 'hello') helloResolve();
          try { onEvent(ev); } catch (e) { log(`  (sse handler error: ${e.message})`); }
        }
      }
    });
    // 'end' and 'close' both fire on one dropped stream: reconnect once per response, and drop this socket first.
    const mine = res; let handled = false;
    const gone = () => { if (handled) return; handled = true; try { mine.destroy(); } catch {} if (!closed) { log(`  (sse ${board.name} dropped; reconnecting)`); setTimeout(connect, 1000); } };
    mine.on('end', gone); mine.on('close', gone); mine.on('error', () => {});
  };
  connect();
  return { hello, close() { closed = true; try { res?.destroy(); } catch {} } };
}

// ---------- one debate run ----------
async function runDebate(board, arm, body, { timeoutMin, log, onStarted }) {
  const msgs = new Map(); let meta = null, roomId = null, finished = false, timedOut = false;
  const pending = []; // events seen before the POST returned the room id
  let resolveDone; const done = new Promise((r) => { resolveDone = r; });
  const settle = (room) => { if (finished) return; finished = true; meta = room; resolveDone(); };
  const terminal = (st) => st && st !== 'running';
  const seatMsg = (m) => m.seatId !== 'system' && m.seatId !== 'user';
  const handle = (ev) => {
    if (!roomId) { if (pending.length < 2000) pending.push(ev); return; }
    if (ev.t === 'room' && ev.room?.id === roomId) {
      const prev = meta; meta = ev.room;
      if (ev.room.round && prev?.round !== ev.room.round) log(`  [${arm}] round -> ${ev.room.round}`);
      if (terminal(ev.room.status)) settle(ev.room);
    } else if (ev.t === 'msg' && ev.roomId === roomId) {
      const m = ev.msg; msgs.set(m.id, m);
      if (seatMsg(m) && !m.streaming) log(`  [${arm}] ${phaseOf(m)} · ${m.name}: uncached ${fmtInt(m.tokens || 0)} · cached ${fmtInt(m.cached || 0)} · $${(m.cost || 0).toFixed(4)}${m.error ? ` · ERROR ${clip(m.error, 120)}` : ''}`);
      else if (m.seatId === 'system' && (m.earlyStop || m.skip)) log(`  [${arm}] system: ${clip(m.text, 120)}`);
    }
  };
  const watcher = watchEvents(board, handle, log);
  let poll = null, timer = null;
  try {
  await Promise.race([watcher.hello, sleep(10000).then(() => { throw new Error(`${board.name} board: SSE stream did not say hello within 10 s`); })]);

  const t0 = Date.now();
  const started = await request(board, 'POST', '/api/meeting', body);
  roomId = started.roomId;
  onStarted?.(roomId);
  log(`  [${arm}] started room ${roomId} on ${board.base}`);
  for (const ev of pending.splice(0)) handle(ev);

  // Safety net: poll the room status so a dropped SSE stream cannot hang the benchmark.
  poll = setInterval(async () => {
    try { const st = await request(board, 'GET', '/api/state'); const r = st.rooms.find((x) => x.id === roomId); if (r && terminal(r.status)) settle(roomMeta(r)); } catch {}
  }, 15000);
  timer = setTimeout(async () => {
    if (finished) return;
    timedOut = true; log(`  [${arm}] TIMEOUT after ${timeoutMin} min: stopping room ${roomId}`);
    try { await request(board, 'POST', `/api/rooms/${roomId}/stop`, {}); } catch (e) { log(`  [${arm}] stop failed: ${e.message}`); }
    setTimeout(() => settle(meta || { id: roomId, status: 'stopped' }), 60000);
  }, timeoutMin * 60000);
  await done;
  const wallMs = Date.now() - t0;
  clearTimeout(timer); clearInterval(poll); watcher.close();
  return await finish(wallMs);
  } finally { clearTimeout(timer); clearInterval(poll); watcher.close(); }

  async function finish(wallMs) {

  // Authoritative final read: /api/state carries the 25 newest rooms with their messages.
  let room = null, limits = null;
  try { const st = await request(board, 'GET', '/api/state'); room = st.rooms.find((x) => x.id === roomId) || null; limits = st.limits; } catch (e) { log(`  [${arm}] final /api/state failed: ${e.message}`); }
  if (!room) room = { ...(meta || {}), id: roomId, messages: [...msgs.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts))) };
  return { arm, board: board.name, roomId, room, wallMs, timedOut, limitsAfter: limits };
  }
}
const roomMeta = (r) => { const { messages, ...m } = r; return m; };

// ---------- metrics ----------
function phaseOf(m) {
  if (m.label === 'scout brief' || m.round === 'scout') return 'scout';
  if (m.label === 'synthesis' || m.round === 'synthesis') return 'synthesis';
  if (typeof m.round === 'number') return `round ${m.round}`;
  return m.label || String(m.round ?? 'other');
}
const PHASE_ORDER = (p) => (p === 'scout' ? 0 : p === 'synthesis' ? 1000 : p.startsWith('round ') ? Number(p.slice(6)) || 500 : 900);

function analyze(run) {
  const ms = run.room.messages || [];
  const turns = ms.filter((m) => m.seatId !== 'system' && m.seatId !== 'user');
  const sys = ms.filter((m) => m.seatId === 'system');
  const sum = (arr, k) => arr.reduce((s, m) => s + (Number(m[k]) || 0), 0);
  const usage = run.room.usage && typeof run.room.usage.tokens === 'number' ? run.room.usage : { tokens: sum(turns, 'tokens'), cached: sum(turns, 'cached'), cost: sum(turns, 'cost') };
  const numericRounds = turns.map((m) => (typeof m.round === 'number' ? m.round : 0));
  const perSeat = {}, perPhase = {};
  for (const m of turns) {
    const s = (perSeat[m.seatId] ||= { id: m.seatId, name: m.name, agent: m.agent, turns: 0, net: 0, cached: 0, cost: 0, failed: 0, skipped: 0 });
    s.turns++; s.net += m.tokens || 0; s.cached += m.cached || 0; s.cost += m.cost || 0; if (m.error) s.failed++;
    const p = (perPhase[phaseOf(m)] ||= { turns: 0, net: 0, cached: 0, cost: 0 });
    p.turns++; p.net += m.tokens || 0; p.cached += m.cached || 0; p.cost += m.cost || 0;
  }
  for (const m of sys) if (m.skip?.seatId) { (perSeat[m.skip.seatId] ||= { id: m.skip.seatId, name: m.skip.seatId, agent: '', turns: 0, net: 0, cached: 0, cost: 0, failed: 0, skipped: 0 }).skipped++; }
  return {
    status: run.timedOut ? 'timeout' : run.room.status || 'unknown',
    // `net` = the board's `tokens` (uncached input + output); `total` = net + cached, the figure comparable with the
    // pre-redesign board, which recorded one undivided token count per turn (see docs/measurements/2026-10-07/README.md).
    net: usage.tokens, cached: usage.cached, total: (usage.tokens || 0) + (usage.cached || 0), cost: usage.cost || 0, wallMs: run.wallMs,
    roundsPlanned: run.room.rounds ?? null, roundsRun: numericRounds.length ? Math.max(...numericRounds) : 0,
    earlyStop: sys.find((m) => m.earlyStop)?.earlyStop ?? null,
    turns: turns.length, skipped: sys.filter((m) => m.skip).length, failed: turns.filter((m) => m.error).length,
    scout: !!run.room.scoutId, perSeat, perPhase,
  };
}

// ---------- report ----------
const fmtInt = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '-');
const fmtUsd = (n) => (typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(4)}` : '-');
const fmtDur = (ms) => { if (!Number.isFinite(ms)) return '-'; const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
const pct = (lean, naive) => { if (!Number.isFinite(lean) || !Number.isFinite(naive) || naive <= 0) return '-'; const d = (lean / naive - 1) * 100; return `${d > 0 ? '+' : ''}${d.toFixed(0)}%`; };
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const table = (head, rows) => [`| ${head.map(cell).join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

function report({ args, boards, seats, runs, states, startedAt }) {
  const byArm = { lean: runs.filter((r) => r.arm === 'lean'), naive: runs.filter((r) => r.arm === 'naive') };
  const M = (arm, k) => mean(byArm[arm].map((r) => r.metrics[k]).filter(Number.isFinite));
  const out = [];
  out.push(`# Agent Orchestra Board token benchmark: lean vs naive Debate`, '');
  out.push(`- Date: ${startedAt.slice(0, 10)} · bench ${BENCH_VERSION} · ${os.platform()} ${os.release()} ${os.arch()} · node ${process.versions.node}`);
  out.push(`- Lean board: ${boards.lean.base} (project ${states.lean.project}) · Naive board: ${boards.naive.base} (project ${states.naive.project}, naive flag: ${states.naive.naive === true ? 'reported' : 'NOT reported'})`);
  out.push(`- Debate: ${seats.length} seats, ${args.rounds} rounds planned, scout (lean only): ${args.scoutId || 'none'}, facilitator: ${args.synthId || 'none'}, repeat ${args.repeat}, order ${args.order.join(' -> ')}`);
  out.push(`- Topic: ${clip(args.topic, 240)}`, '');
  out.push(table(['Seat', 'Name', 'Agent', 'Model', 'Effort', 'Perm', 'Target'], seats.map((s) => [s.id, s.name, s.agent, s.model, s.effort, s.perm, s.target || '(none)'])), '');

  out.push('## Summary', '');
  const rows = [];
  for (const r of runs) {
    const m = r.metrics;
    rows.push([r.arm, r.rep, m.status, fmtInt(m.total), fmtInt(m.net), fmtInt(m.cached), fmtUsd(m.cost), fmtDur(m.wallMs), `${m.roundsRun} / ${m.roundsPlanned ?? '-'}`, m.earlyStop ? `yes (after round ${m.earlyStop})` : 'no', `${m.turns} (${m.skipped} skipped, ${m.failed} failed)`]);
  }
  const spread = (arm, k) => { const xs = byArm[arm].map((r) => r.metrics[k]).filter(Number.isFinite); return xs.length > 1 ? ` (${fmtInt(Math.min(...xs))} – ${fmtInt(Math.max(...xs))})` : ''; };
  if (args.repeat > 1) for (const arm of ['lean', 'naive']) rows.push([`${arm} (mean, min – max)`, '-', '-', fmtInt(M(arm, 'total')) + spread(arm, 'total'), fmtInt(M(arm, 'net')) + spread(arm, 'net'), fmtInt(M(arm, 'cached')) + spread(arm, 'cached'), fmtUsd(M(arm, 'cost')), fmtDur(M(arm, 'wallMs')), `${M(arm, 'roundsRun').toFixed(1)} / ${args.rounds}`, '-', `${M(arm, 'turns').toFixed(1)}`]);
  out.push(table(['Arm', 'Run', 'Status', 'Total tokens', 'Uncached tokens', 'Cached tokens', 'Cost (CLI-reported)', 'Wall time', 'Rounds run / planned', 'Early stop', 'Turns (skipped, failed)'], rows), '');
  if (byArm.lean.length && byArm.naive.length) {
    out.push(`**Lean vs naive${args.repeat > 1 ? ' (means)' : ''}:** total tokens ${pct(M('lean', 'total'), M('naive', 'total'))} · uncached ${pct(M('lean', 'net'), M('naive', 'net'))} · cached ${pct(M('lean', 'cached'), M('naive', 'cached'))} · cost ${pct(M('lean', 'cost'), M('naive', 'cost'))} · wall time ${pct(M('lean', 'wallMs'), M('naive', 'wallMs'))} (negative = lean uses less).`, '');
    if (args.repeat < 3) out.push(`_${args.repeat === 1 ? 'One run per arm' : 'Two runs per arm'}: this is an observation, not a benchmark result. Use --repeat 3 or more and quote the mean with the min – max spread._`, '');
  }

  out.push('## Per agent', '');
  const seatRows = seats.map((s) => {
    const agg = (arm) => { const xs = byArm[arm].map((r) => r.metrics.perSeat[s.id]).filter(Boolean); return { net: mean(xs.map((x) => x.net)), cached: mean(xs.map((x) => x.cached)), cost: mean(xs.map((x) => x.cost)), turns: mean(xs.map((x) => x.turns)), skipped: mean(xs.map((x) => x.skipped)) }; };
    const l = agg('lean'), n = agg('naive');
    const t = (x) => (Number.isFinite(x.turns) ? `${x.turns.toFixed(args.repeat > 1 ? 1 : 0)}${x.skipped ? ` (+${x.skipped.toFixed(0)} skipped)` : ''}` : '-');
    return [s.id, `${s.agent} / ${s.model} / ${s.effort}`, fmtInt(l.net), fmtInt(l.cached), fmtUsd(l.cost), t(l), fmtInt(n.net), fmtInt(n.cached), fmtUsd(n.cost), t(n), pct(l.net, n.net)];
  });
  out.push(table(['Seat', 'Agent / model / effort', 'Lean uncached', 'Lean cached', 'Lean cost', 'Lean turns', 'Naive uncached', 'Naive cached', 'Naive cost', 'Naive turns', 'Uncached Δ'], seatRows), '');

  out.push('## Per phase', '');
  const phases = [...new Set(runs.flatMap((r) => Object.keys(r.metrics.perPhase)))].sort((a, b) => PHASE_ORDER(a) - PHASE_ORDER(b));
  out.push(table(['Phase', 'Lean turns', 'Lean uncached', 'Lean cached', 'Naive turns', 'Naive uncached', 'Naive cached', 'Uncached Δ'], phases.map((p) => {
    const agg = (arm) => { const xs = byArm[arm].map((r) => r.metrics.perPhase[p]).filter(Boolean); return xs.length ? { turns: mean(xs.map((x) => x.turns)), net: mean(xs.map((x) => x.net)), cached: mean(xs.map((x) => x.cached)) } : { turns: NaN, net: NaN, cached: NaN }; };
    const l = agg('lean'), n = agg('naive');
    return [p, Number.isFinite(l.turns) ? l.turns.toFixed(args.repeat > 1 ? 1 : 0) : '-', fmtInt(l.net), fmtInt(l.cached), Number.isFinite(n.turns) ? n.turns.toFixed(args.repeat > 1 ? 1 : 0) : '-', fmtInt(n.net), fmtInt(n.cached), pct(l.net, n.net)];
  })), '');

  out.push('## Usage-limit meters (board readings, experimental)', '');
  const limRows = [];
  for (const arm of ['lean', 'naive']) {
    const before = states[arm].limits || {}, after = byArm[arm].at(-1)?.limitsAfter || {};
    for (const agent of ['claude', 'codex']) {
      const wb = before[agent]?.windows || {}, wa = after[agent]?.windows || {};
      for (const w of new Set([...Object.keys(wb), ...Object.keys(wa)])) limRows.push([arm, agent, w, wb[w]?.pct != null ? `${wb[w].pct}%` : '-', wa[w]?.pct != null ? `${wa[w].pct}%` : '-']);
    }
  }
  out.push(limRows.length ? table(['Board', 'CLI', 'Window', 'Before', 'After'], limRows) : '_No limit readings available (Claude limits appear after a Claude turn; Codex limits come from ~/.codex/sessions)._', '');

  out.push('## Notes', '');
  out.push('- `Uncached tokens` = the board\'s `tokens` figure: Claude input + cache creation + output; Codex (input - cached) + output. `Cached tokens` = cached input (cache reads), reported separately by both CLIs. `Total tokens` = uncached + cached, i.e. every input token the CLI reported plus output; this is the figure comparable with the 1.69M -> 0.46M before/after observation, whose "before" board recorded one undivided count per turn.');
  out.push('- `Cost` is only what the CLIs report: Claude Code reports `total_cost_usd`; Codex CLI reports no cost, so Codex seats contribute $0 and the cost column understates mixed meetings.');
  out.push('- `Wall time` is measured by this script from the `POST /api/meeting` response to the first terminal room status; it includes CLI start-up and queueing.');
  out.push('- The naive arm is an approximation of a board without the token-lean levers (no scout, tools and target in every turn, full transcript and fresh CLI thread per turn, fixed rounds, no effort cap, lean CLI flags off); see README.md for the exact contract.');
  out.push('- Agent answers are non-deterministic: repeat with `--repeat 3` or more before quoting a percentage, and quote the mean with the spread.');
  out.push(`- Raw rooms, states and metrics: token-bench.json next to this report.`);
  return out.join('\n') + '\n';
}

// ---------- preflight ----------
async function preflight(args, boards, log) {
  const states = {};
  for (const name of ['lean', 'naive']) {
    try { states[name] = await request(boards[name], 'GET', '/api/state'); }
    catch (e) { throw Object.assign(new Error(explainHttpError(boards[name], e)), { exitCode: 2 }); }
  }
  if (boards.lean.base === boards.naive.base) throw usageError('lean and naive boards must be two different launches (ORCHESTRA_NAIVE is read at server start): use another --port for the naive board');
  const problems = [], warnings = [];
  if (states.lean.naive === true) problems.push('the lean board reports naive:true (it was started with ORCHESTRA_NAIVE=1); start it without the flag');
  if (states.naive.naive !== true) (args.allowUnverifiedNaive ? warnings : problems).push('the naive board does not report naive:true in GET /api/state: either it was not started with ORCHESTRA_NAIVE=1 or the server lacks the flag (see bench/README.md, "The naive flag"). Override with --allow-unverified-naive only if you know the server runs naive.');

  const leanSeats = states.lean.seats || [], naiveSeats = states.naive.seats || [];
  const ids = args.seats && args.seats.length ? args.seats : leanSeats.map((s) => s.id);
  if (ids.length < 2 || ids.length > 20) problems.push(`need 2-20 participants, got ${ids.length} (${ids.join(', ') || 'none'})`);
  const seats = [];
  for (const id of ids) {
    const l = leanSeats.find((s) => s.id === id), n = naiveSeats.find((s) => s.id === id);
    if (!l) problems.push(`seat '${id}' does not exist on the lean board`);
    if (!n) problems.push(`seat '${id}' does not exist on the naive board`);
    if (l && n) {
      const diff = ['agent', 'model', 'effort', 'perm', 'target'].filter((k) => String(l[k] ?? '') !== String(n[k] ?? ''));
      if (diff.length) (args.allowSeatMismatch ? warnings : problems).push(`seat '${id}' differs between boards (${diff.join(', ')}): results would not be comparable. Copy .orchestra/seats.json to the naive project or pass --allow-seat-mismatch.`);
      if (l.perm === 'write' || n.perm === 'write') warnings.push(`seat '${id}' is write-enabled; the Debate never writes, but keep an eye on it`);
      for (const [s, b] of [[l, 'lean'], [n, 'naive']]) {
        if (s.status === 'working') problems.push(`seat '${id}' is busy on the ${b} board; wait for it to finish`);
        if (s.budget && (s.used || 0) >= s.budget) problems.push(`seat '${id}' has reached its token budget on the ${b} board (${fmtInt(s.used)} / ${fmtInt(s.budget)}); raise or clear it`);
      }
      seats.push(l);
    }
  }
  for (const name of ['lean', 'naive']) if ((states[name].rooms || []).some((r) => r.status === 'running')) problems.push(`a room is still running on the ${name} board; stop it or wait`);
  const pick = (opt, name) => { if (opt === 'none') return null; const v = opt || ids[0]; if (!ids.includes(v)) problems.push(`--${name} '${v}' must be one of the participants`); return v; };
  args.scoutId = pick(args.scout, 'scout'); args.synthId = pick(args.synth, 'synth');
  if (!args.scoutId) warnings.push('lean arm runs WITHOUT a scout (--scout none): the biggest single lever is off, so this measures the other levers only');
  if (states.lean.project !== states.naive.project) warnings.push(`the boards point at different project dirs (${states.lean.project} vs ${states.naive.project}): fine if they are clones of the same commit`);
  else warnings.push('both boards share one project dir and therefore one .orchestra/ state dir: ok for a benchmark, but do not use the UI on both at the same time');
  for (const w of warnings) log(`  warning: ${w}`);
  if (problems.length) throw Object.assign(new Error('preflight refused:\n  - ' + problems.join('\n  - ')), { exitCode: 2 });
  return { states, seats, ids };
}

// ---------- main ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function confirm(question) {
  if (!process.stdin.isTTY) throw usageError('stdin is not a TTY: pass --yes to confirm that this run may spend Claude/Codex quota');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((r) => rl.question(question, r)); rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return 0; }
  const log = (s) => console.error(s);
  const boards = { lean: boardFrom('lean', args.url, args.token), naive: boardFrom('naive', args.naiveUrl, args.naiveToken) };
  log(`token-bench ${BENCH_VERSION}: preflight`);
  const { states, seats, ids } = await preflight(args, boards, log);

  const bodies = {
    lean: { topic: args.topic, seatIds: ids, rounds: args.rounds, synthId: args.synthId || undefined, scoutId: args.scoutId || undefined, withContext: false },
    naive: { topic: args.topic, seatIds: ids, rounds: args.rounds, synthId: args.synthId || undefined, withContext: false }, // no scout: every seat reads the code itself
  };
  const plan = [];
  for (let rep = 1; rep <= args.repeat; rep++) for (const arm of args.order) plan.push({ arm, rep });
  log(`\nPlan: ${plan.length} Debate run(s): ${plan.map((p) => `${p.arm}#${p.rep}`).join(', ')}`);
  log(`  participants: ${ids.join(', ')} · rounds ${args.rounds} · scout(lean) ${args.scoutId || 'none'} · facilitator ${args.synthId || 'none'}`);
  log(`  lean  -> POST ${boards.lean.base}/api/meeting ${JSON.stringify(bodies.lean).slice(0, 160)}…`);
  log(`  naive -> POST ${boards.naive.base}/api/meeting ${JSON.stringify(bodies.naive).slice(0, 160)}…`);
  if (args.dryRun) { log('\n--dry-run: nothing started.'); console.log(JSON.stringify({ boards: { lean: boards.lean.base, naive: boards.naive.base }, plan, bodies, seats: seats.map((s) => ({ id: s.id, agent: s.agent, model: s.model, effort: s.effort })) }, null, 2)); return 0; }
  if (!args.yes && !(await confirm(`\nEvery run spends real Claude and Codex quota under your logins (the naive arm deliberately spends a lot). Type "yes" to start: `))) { log('aborted'); return 2; }

  const startedAt = new Date().toISOString();
  const outDir = args.outDir ? path.resolve(args.outDir) : path.join(HERE, 'results', startedAt.replace(/[:.]/g, '-').slice(0, 19));
  fs.mkdirSync(outDir, { recursive: true });
  const runs = [];
  let current = null; // { board, roomId } for Ctrl+C
  const onSignal = async () => {
    log('\ninterrupted: stopping the running room…');
    if (current?.roomId) { try { await request(current.board, 'POST', `/api/rooms/${current.roomId}/stop`, {}); } catch {} }
    process.exit(130);
  };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);

  let failed = false;
  for (const { arm, rep } of plan) {
    log(`\n=== ${arm} run ${rep}/${args.repeat} ===`);
    const board = boards[arm];
    try {
      const run = await runDebate(board, arm, bodies[arm], { timeoutMin: args.timeoutMin, log, onStarted: (roomId) => { current = { board, roomId }; } });
      run.rep = rep; run.metrics = analyze(run);
      runs.push(run);
      const m = run.metrics;
      log(`  [${arm}] ${m.status}: total ${fmtInt(m.total)} (uncached ${fmtInt(m.net)} · cached ${fmtInt(m.cached)}) · ${fmtUsd(m.cost)} · ${fmtDur(m.wallMs)} · rounds ${m.roundsRun}/${m.roundsPlanned}${m.earlyStop ? ` · early stop after round ${m.earlyStop}` : ''} · turns ${m.turns} (${m.skipped} skipped, ${m.failed} failed)`);
      if (m.status !== 'done') failed = true;
    } catch (e) {
      failed = true; log(`  [${arm}] run failed: ${e.message}`);
      runs.push({ arm, rep, board: board.name, roomId: current?.roomId || null, room: { status: 'error', messages: [] }, wallMs: NaN, timedOut: false, error: e.message, metrics: analyze({ room: { status: 'error', messages: [] }, wallMs: NaN, timedOut: false }) });
    } finally { current = null; }
    fs.writeFileSync(path.join(outDir, 'token-bench.json'), JSON.stringify({ bench: BENCH_VERSION, startedAt, args: { ...args, token: undefined, naiveToken: undefined }, boards: { lean: boards.lean.base, naive: boards.naive.base }, bodies, seats, states: { lean: { project: states.lean.project, naive: states.lean.naive, limits: states.lean.limits }, naive: { project: states.naive.project, naive: states.naive.naive, limits: states.naive.limits } }, runs }, null, 2));
    if (plan.length > 1) await sleep(3000); // let the boards settle (seat status, limits refresh)
  }

  const md = report({ args, boards, seats, runs, states, startedAt });
  fs.writeFileSync(path.join(outDir, 'token-bench.md'), md);
  console.log(md);
  log(`\nwritten: ${path.join(outDir, 'token-bench.md')} and token-bench.json`);
  return failed ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`token-bench: ${e.message}`); if (e.exitCode === 2 && /unknown option|needs a value/.test(e.message)) console.error(USAGE); process.exitCode = e.exitCode || 1; });
