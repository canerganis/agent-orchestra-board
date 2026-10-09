#!/usr/bin/env node
// ledger-report.mjs - prints ledger.summarize() for a project as two tables (per model, per task type).
// Usage: node bench/ledger-report.mjs [project-dir]   (reads <project>/.orchestra/records/ledger.jsonl)
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readRecords, summarize } = require('../src/ledger.js');

const project = path.resolve(process.argv[2] || process.cwd());
const records = readRecords(path.join(project, '.orchestra', 'records'));
const summary = summarize(records);
const COLS = ['attempts', 'passedFirstReview', 'fixes', 'tokens', 'ms', 'tokensPerAccepted'];

function table(title, group) {
  const rows = Object.entries(group);
  console.log(`\n${title}`);
  if (!rows.length) { console.log('(none)'); return; }
  const cells = [[title.split(' ').pop(), ...COLS], ...rows.map(([k, s]) => [k, ...COLS.map((c) => String(Math.round(s[c] * 10) / 10))])];
  const widths = cells[0].map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  for (const r of cells) console.log(r.map((c, i) => (i ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  '));
}

console.log(`${records.length} ledger record(s) in ${path.join(project, '.orchestra', 'records')}`);
table('By model', summary.models);
table('By taskType', summary.taskTypes);
