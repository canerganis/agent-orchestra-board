// Runs one CLI turn for a seat (runSeat queues per seat; execSeat spawns the CLI through its adapter).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { claudeBin, codexBin } = require('./config');
const { codexEnv, killTree } = require('./platform');
const { resolveTarget } = require('./target');
const claudeAdapter = require('./adapters/claude');
const codexAdapter = require('./adapters/codex');
const { now, newId } = require('./util');

function createRunner({ store, seats, limits, settings, broadcast }) {
  const { rtOf, seatById, setRt, saveSeats } = seats;
  const PROJECT = store.project;

  function runSeat(seatId, prompt, opts = {}) {
    const r = rtOf(seatId);
    const p = r.queue.then(() => execSeat(seatId, prompt, opts));
    r.queue = p.catch(() => {});
    return p;
  }

  // tools: 'none' (discussion), 'read' (look at code), 'write' (seat must allow it).
  // room: meetings/chains keep one thread per seat per room, so old conversations are never re-sent.
  function execSeat(seatId, prompt, { effort, runId = newId(), roomId = null, room = null, tools = null, withTarget = true, threadKey = null, cancelled = null } = {}) {
    return new Promise((resolve) => {
      const seat = seatById(seatId);
      if (!seat) return resolve({ ok: false, error: 'no such agent', text: '' });
      if (room?.stopped || cancelled?.()) return resolve({ ok: false, error: 'stopped', text: '' }); // queued before the stop
      if (seat.budget && seat.used >= seat.budget) return resolve({ ok: false, error: `${seat.name} reached its token budget`, text: '' });
      const eff = effort || seat.effort;
      const mode = tools === 'write' && seat.perm !== 'write' ? 'read' : tools || (seat.perm === 'write' ? 'write' : 'read');
      const threads = room ? (room.threads ||= {}) : null;
      const key = threadKey || seat.id;
      const thread = threads ? threads[key] || null : seat.thread;
      const saveThread = (id) => { if (threads) threads[key] = id; else seat.thread = id; };
      const tgt = withTarget ? resolveTarget(seat, PROJECT) : { cwd: PROJECT, preface: '' };
      // Role header and target scope go out once per thread; a resumed thread already has them.
      const header = thread ? '' : `[You are "${seat.name}" (${seat.role || 'agent'}) in a multi-agent orchestra of Claude and Codex seats. Reply in ${settings.lang}. Be concise.${mode !== 'write' ? ' Do not modify files.' : ''}]\n\n`;
      const toolNote = mode === 'none' ? '(No tools or commands this turn: answer from the conversation.)\n\n' : '';
      const stdin = header + (thread ? '' : tgt.preface) + toolNote + prompt;

      const isCodex = seat.agent === 'codex';
      const adapter = isCodex ? codexAdapter : claudeAdapter;
      let cmd, args, cwd = tgt.cwd, pendingThread = null;
      if (isCodex) {
        cmd = codexBin();
        // Codex always has a shell tool; in a no-tools turn an empty cwd keeps it from re-reading the project.
        if (mode === 'none') { cwd = path.join(store.orch, 'empty'); fs.mkdirSync(cwd, { recursive: true }); }
        args = codexAdapter.buildArgs({ model: seat.model, effort: eff, mode, thread });
      } else {
        cmd = claudeBin(); cwd = PROJECT; // Claude sessions are stored per project dir, so resume needs a stable cwd
        if (!thread) pendingThread = crypto.randomUUID();
        args = claudeAdapter.buildArgs({ model: seat.model, effort: eff, thread, sessionId: pendingThread, addDir: tgt.dir && !tgt.dir.startsWith(PROJECT) ? tgt.dir : null, mode });
      }

      let text = '', final = null, tokens = 0, cached = 0, cost = 0, err = null, gotThread = null, stderr = '', completed = false;
      const activity = (a) => { const r = rtOf(seatId); if (r.activity !== a) setRt(seatId, { activity: a }); };
      const parser = adapter.createParser({
        thread: (id) => { gotThread = id; },
        activity,
        delta: (s) => { text += s; broadcast({ t: 'delta', seatId, runId, text: s }); },
        item: (kind, s) => broadcast({ t: 'item', seatId, runId, roomId, kind, text: String(s).slice(0, 200), ts: now() }),
        usage: (u) => { tokens = u.tokens; cached = u.cached; cost = u.cost; },
        rateLimit: (info) => limits.claudeLimits(info),
        completed: (c) => { completed = true; final = c?.result ?? null; },
        error: (m) => { err = m; },
      });

      let child;
      try { child = spawn(cmd, args, { cwd, windowsHide: true, env: isCodex ? codexEnv() : process.env }); }
      catch (e) { return resolve({ ok: false, error: e.message, text: '' }); }
      setRt(seatId, { status: 'working', activity: 'starting', startedAt: now(), child, roomId, runId, stopRequested: false });
      broadcast({ t: 'run', seatId, runId, roomId });
      child.stdout.on('data', (d) => parser.feed(d));
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      child.on('error', (e) => { err = e.message; });
      child.on('close', (code) => {
        const stopped = rtOf(seatId).stopRequested;
        if (gotThread) saveThread(gotThread);
        else if (pendingThread && code === 0) saveThread(pendingThread);
        seat.used = (seat.used || 0) + tokens; seat.cached = (seat.cached || 0) + cached; seat.cost = (seat.cost || 0) + cost;
        saveSeats();
        // A finished turn counts as success even if the CLI exits non-zero afterwards (e.g. a failing notify hook).
        const ok = !err && (completed || (code === 0 && !stopped));
        const out = final ?? text;
        if (!ok && !err) err = stopped ? 'stopped' : (stderr.trim().split('\n').pop() || `exit code ${code}`);
        setRt(seatId, { status: ok ? 'idle' : 'error', activity: ok ? '' : err, startedAt: null, child: null, roomId: null, stopRequested: false });
        broadcast({ t: 'end', seatId, runId, roomId, ok, tokens, cached, cost, error: ok ? null : err });
        if (isCodex) setTimeout(() => limits.refreshCodex(), 500);
        resolve({ ok, text: out, tokens, cached, cost, error: ok ? null : err });
      });
      child.stdin.end(stdin);
    });
  }

  function stopSeat(id) {
    const r = rtOf(id); if (!r.child) return false;
    r.stopRequested = true;
    killTree(r.child);
    return true;
  }

  return { runSeat, execSeat, stopSeat };
}

module.exports = { createRunner };
