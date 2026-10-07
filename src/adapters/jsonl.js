// Robust JSONL splitter shared by the CLI adapters.
// - handles partial lines across chunks (and a UTF-8 character split across chunks)
// - tolerates CRLF, blank lines, ANSI colour codes and non-JSON noise (warnings, banners)
// - counts what it saw so the runner can tell "nothing recognised" from "finished": stats.{lines,json,bad,noise,events,unknown}
// onEvent(obj) returns false for an event type the adapter does not know; anything else counts as recognised.
const { StringDecoder } = require('string_decoder');

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_LINE = 8 * 1024 * 1024; // a single JSON line larger than this is not a CLI event

function createFeeder(onEvent) {
  const dec = new StringDecoder('utf8');
  const stats = { lines: 0, json: 0, bad: 0, noise: 0, events: 0, unknown: 0, handlerErrors: 0, unknownTypes: [], lastNoise: '', lastBad: '', lastHandlerError: '' };
  let buf = '';

  function line(raw) {
    const s = raw.replace(ANSI, '').trim();
    if (!s) return;
    stats.lines++;
    if (!s.startsWith('{')) { stats.noise++; stats.lastNoise = s.slice(0, 300); return; }
    let obj;
    try { obj = JSON.parse(s); } catch { stats.bad++; stats.lastBad = s.slice(0, 300); return; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { stats.bad++; stats.lastBad = s.slice(0, 300); return; }
    stats.json++;
    let known;
    try { known = onEvent(obj); } catch (e) { stats.handlerErrors++; stats.lastHandlerError = String(e && e.message || e).slice(0, 300); return; }
    if (known === false) {
      stats.unknown++;
      const t = typeof obj.type === 'string' ? obj.type : '(no type)';
      if (!stats.unknownTypes.includes(t) && stats.unknownTypes.length < 12) stats.unknownTypes.push(t);
    } else stats.events++;
  }

  function feed(chunk) {
    buf += Buffer.isBuffer(chunk) ? dec.write(chunk) : String(chunk);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); line(l); }
    if (buf.length > MAX_LINE) { stats.bad++; stats.lastBad = '(line longer than 8MB dropped)'; buf = ''; }
  }
  // Call when the stream has closed: the last line often has no trailing newline.
  function end() { buf += dec.end(); if (buf) line(buf); buf = ''; }

  return { feed, end, stats };
}

module.exports = { createFeeder };
