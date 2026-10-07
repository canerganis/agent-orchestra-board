// Small shared helpers (no state).
const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const shortCmd = (c) => { const m = String(c).match(/-Command\s+'([\s\S]*)'$/); return (m ? m[1] : String(c)).slice(0, 160); };
// Strings are clipped as-is (whitespace collapsed); anything else is JSON-encoded first.
const clip = (o, n = 120) => { try { const s = typeof o === 'string' ? o.replace(/\s+/g, ' ').trim() : JSON.stringify(o); return s.length > n ? s.slice(0, n) + '…' : s; } catch { return ''; } };
const lastLine = (text) => (text || '').trim().split(/\r?\n/).pop().replace(/[*`_]/g, '').trim();

// Splits a stdout stream into JSON lines and hands each parsed object to onEvent; non-JSON lines are ignored.
function jsonlFeeder(onEvent) {
  let buf = '';
  return (chunk) => {
    buf += chunk; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line.startsWith('{')) { try { onEvent(JSON.parse(line)); } catch {} }
    }
  };
}

module.exports = { now, today, newId, shortCmd, clip, lastLine, jsonlFeeder };
