#!/usr/bin/env node
// Recomputes the headline numbers from the raw room JSON files next to this script, so nobody has to trust README.md.
//   node summarize.mjs                 -> Markdown tables for before.json and after.json
//   node summarize.mjs <room.json ...> -> the same for any Agent Orchestra Board room file
// Zero dependencies. Metric definitions: see README.md in this folder. 
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['before.json', 'after.json'].map((f) => path.join(HERE, f));
const int = (n) => Math.round(n).toLocaleString('en-US');
const PHASE = { 'keşif özeti': 'scout', 'bağımsız fikirler': 'round 1', 'tartışma': 'round 2', 'sentez': 'synthesis', 'scout brief': 'scout', 'independent ideas': 'round', discussion: 'round', synthesis: 'synthesis' };
const phaseOf = (m) => (typeof m.round === 'number' ? `round ${m.round}` : PHASE[m.label] || PHASE[m.round] || String(m.round || m.label || '?'));

const results = [];
for (const file of files) {
  const room = JSON.parse(fs.readFileSync(file, 'utf8'));
  const turns = room.messages.filter((m) => m.seatId !== 'user' && m.seatId !== 'system' && typeof m.tokens === 'number');
  const hasCached = turns.some((m) => typeof m.cached === 'number');
  const sum = (arr, k) => arr.reduce((s, m) => s + (Number(m[k]) || 0), 0);
  const group = (key) => { const g = {}; for (const m of turns) { const k = key(m); (g[k] ||= { turns: 0, tokens: 0, cached: 0, cost: 0 }); g[k].turns++; g[k].tokens += m.tokens; g[k].cached += m.cached || 0; g[k].cost += m.cost || 0; } return g; };
  const ts = room.messages.map((m) => m.ts).sort();
  const r = {
    file: path.basename(file), id: room.id, created: room.created, lastMessage: ts.at(-1), status: room.status,
    seats: room.seatIds, rounds: room.rounds, scout: room.scoutId || null, synth: room.synthId || null,
    turns: turns.length, failed: turns.filter((m) => m.error).length,
    skipped: room.messages.filter((m) => m.seatId === 'system' && m.skip).length,
    earlyStop: room.messages.find((m) => m.seatId === 'system' && m.earlyStop)?.earlyStop ?? null,
    hasCached, tokens: sum(turns, 'tokens'), cached: hasCached ? sum(turns, 'cached') : null, cost: sum(turns, 'cost'),
    roomUsage: room.usage || null, perPhase: group(phaseOf), perSeat: group((m) => `${m.name} (${m.agent})`),
  };
  r.total = r.tokens + (r.cached || 0);
  results.push(r);
}

const out = [];
for (const r of results) {
  out.push(`## ${r.file}`, '', `- room \`${r.id}\`, created ${r.created}, last message ${r.lastMessage}, status ${r.status}`);
  out.push(`- seats ${r.seats.join(', ')} · rounds planned ${r.rounds} · scout ${r.scout || 'none'} · facilitator ${r.synth || 'none'}`);
  out.push(`- turns ${r.turns} (${r.failed} failed, ${r.skipped} skipped) · early stop: ${r.earlyStop ? `after round ${r.earlyStop}` : 'no'}`);
  out.push(r.hasCached
    ? `- **total tokens ${int(r.total)}** = uncached ${int(r.tokens)} + cached ${int(r.cached)} · CLI-reported cost $${r.cost.toFixed(4)} (Claude turns only)${r.roomUsage ? ` · room.usage: tokens ${int(r.roomUsage.tokens)}, cached ${int(r.roomUsage.cached)}` : ''}`
    : `- **total tokens ${int(r.total)}** (this board recorded one undivided token count per turn; no cached split) · CLI-reported cost $${r.cost.toFixed(4)} (Claude turns only)`);
  out.push('', '| Phase | Turns | Tokens' + (r.hasCached ? ' (uncached) | Cached | Total' : '') + ' | Cost |', '| --- | --- | ---' + (r.hasCached ? ' | --- | ---' : '') + ' | --- |');
  for (const [k, v] of Object.entries(r.perPhase)) out.push(`| ${k} | ${v.turns} | ${int(v.tokens)}${r.hasCached ? ` | ${int(v.cached)} | ${int(v.tokens + v.cached)}` : ''} | $${v.cost.toFixed(4)} |`);
  out.push('', '| Seat | Turns | Tokens' + (r.hasCached ? ' (uncached) | Cached | Total' : '') + ' | Cost |', '| --- | --- | ---' + (r.hasCached ? ' | --- | ---' : '') + ' | --- |');
  for (const [k, v] of Object.entries(r.perSeat)) out.push(`| ${k} | ${v.turns} | ${int(v.tokens)}${r.hasCached ? ` | ${int(v.cached)} | ${int(v.tokens + v.cached)}` : ''} | $${v.cost.toFixed(4)} |`);
  out.push('');
}
if (results.length === 2) {
  const [a, b] = results;
  const d = (b.total / a.total - 1) * 100;
  out.push(`## ${a.file} -> ${b.file}`, '', `total tokens ${int(a.total)} -> ${int(b.total)} (${d.toFixed(1)}%) · Claude-reported cost $${a.cost.toFixed(2)} -> $${b.cost.toFixed(2)} · one run each: an observation, not a benchmark.`, '');
}
process.stdout.write(out.join('\n'));
