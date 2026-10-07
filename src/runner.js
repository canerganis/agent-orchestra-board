// Runs one CLI turn for a seat (runSeat queues per seat; execSeat spawns the CLI through its adapter).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { claudeBin, codexBin } = require('./config');
// spawnResolved: the CLI is resolved on PATH (or at ORCHESTRA_*_BIN) before every spawn, so a claude.exe/codex.exe
// inside the project or a seat's target (the child's cwd) can never be what runs.
const { codexEnv, killTree, spawnResolved } = require('./platform');
const { resolveTarget } = require('./target');
const claudeAdapter = require('./adapters/claude');
const codexAdapter = require('./adapters/codex');
const { spawnErrorMessage, explainExit } = require('./adapters/diagnose');
const versions = require('./adapters/versions');
const { now, newId } = require('./util');

// Waiting longer than this for `<bin> --version` would delay a failed turn's error message noticeably.
const VERSION_WAIT_MS = 3000;

// spawnFn is injectable so tests can run the runner against a fake child process (never the real CLIs).
// detectVersions=false turns CLI version detection off entirely (tests that count spawns).
function createRunner({ store, seats, limits, settings, broadcast, spawnFn = spawnResolved, detectVersions = true }) {
  const { rtOf, seatById, setRt, saveSeats } = seats;
  const PROJECT = store.project;

  // CLI versions (`<bin> --version`, no billable turn) are detected lazily: the first time a failed turn needs one
  // for its diagnosis, or on an explicit detectCli() from doctor/refresh. Nothing is spawned at construction time.
  function detectCli(opts = {}) {
    return versions.cliVersions({ spawnFn, ...opts }).then((cli) => { broadcast({ t: 'cli', cli }); return cli; });
  }
  // -> Promise<string|null>: the cached version, or a fresh detection capped at VERSION_WAIT_MS (null on timeout/error).
  function versionOf(agent) {
    const cached = versions.cliVersionsCached()[agent];
    if (cached || !detectVersions) return Promise.resolve(cached?.version || null);
    const wait = new Promise((r) => { const t = setTimeout(() => r(null), VERSION_WAIT_MS); if (typeof t.unref === 'function') t.unref(); });
    return Promise.race([detectCli().then((cli) => cli[agent]?.version || null), wait]).catch(() => null);
  }

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
      roomId ??= room?.id ?? null; // run/item/end events carry the room even when the caller passed only `room`
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
      const agent = isCodex ? 'codex' : 'claude';
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

      let text = '', final = null, usage = null, partial = null, err = null, gotThread = null, stderr = '', completed = false;
      const activity = (a) => { const r = rtOf(seatId); if (r.activity !== a) setRt(seatId, { activity: a }); };
      const parser = adapter.createParser({
        thread: (id) => { gotThread = id; },
        activity,
        delta: (s) => { text += s; broadcast({ t: 'delta', seatId, runId, text: s }); },
        item: (kind, s) => broadcast({ t: 'item', seatId, runId, roomId, kind, text: String(s).slice(0, 200), ts: now() }),
        usage: (u) => { usage = u; }, // the one authoritative per-turn report
        partialUsage: (u) => { partial = u; }, // running stream totals: used only when no final usage arrives (killed run)
        rateLimit: (info) => { try { limits.claudeLimits(info); } catch {} },
        completed: (c) => { completed = true; final = c?.result ?? null; },
        error: (m) => { err = String(m || 'error'); },
      });

      const env = isCodex ? codexEnv() : process.env;
      let child;
      try { child = spawnFn(cmd, args, { cwd, windowsHide: true, env }); }
      catch (e) { const m = spawnErrorMessage(agent, cmd, e, env); setRt(seatId, { status: 'error', activity: m }); return resolve({ ok: false, error: m, text: '' }); }
      setRt(seatId, { status: 'working', activity: 'starting', startedAt: now(), child, roomId, runId, stopRequested: false });
      broadcast({ t: 'run', seatId, runId, roomId });
      let spawnErr = null, closed = false;
      child.stdout?.on('data', (d) => parser.feed(d));
      child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      // A missing/unlaunchable binary: Node emits 'error' (ENOENT, EACCES, EINVAL) and then 'close'.
      child.on('error', (e) => { spawnErr = spawnErrorMessage(agent, cmd, e, env); if (!closed) setTimeout(() => finish(null, null), 1000).unref?.(); });
      child.on('close', finish);
      // Writing to the stdin of a child that failed to start raises EPIPE on the stream: never let that crash the board.
      if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }

      function finish(code, signal) {
        if (closed) return; closed = true;
        parser.end(); // flush a last line without a trailing newline
        const stopped = !!rtOf(seatId).stopRequested;
        if (gotThread) saveThread(gotThread);
        else if (pendingThread && completed && !err) saveThread(pendingThread);
        // Final usage wins; the stream's running totals only stand in when the turn never reported usage (or reported
        // nothing but zeros because the result carried no usage object), e.g. a run killed mid-answer.
        const u = usage && (usage.tokens || usage.cached || usage.cost) ? usage : partial || usage || {};
        const tokens = u.tokens || 0, cached = u.cached || 0, cost = u.cost || 0;
        seat.used = (seat.used || 0) + tokens; seat.cached = (seat.cached || 0) + cached; seat.cost = (seat.cost || 0) + cost;
        saveSeats();
        // Success means the CLI reported a completed turn. A clean exit with nothing we could parse is a failure
        // (schema change, wrong binary, plain-text output), and a finished turn still counts even if the CLI exits
        // non-zero afterwards (e.g. a failing notify hook).
        const ok = !err && !spawnErr && completed;
        const out = final ?? text;
        const done = (error) => {
          if (!ok) err = error;
          setRt(seatId, { status: ok ? 'idle' : 'error', activity: ok ? '' : err, startedAt: null, child: null, roomId: null, stopRequested: false });
          broadcast({ t: 'end', seatId, runId, roomId, ok, tokens, cached, cost, error: ok ? null : err });
          if (isCodex && !spawnErr) setTimeout(() => limits.refreshCodex(), 500);
          resolve({ ok, text: out, tokens, cached, cost, error: ok ? null : err });
        };
        if (ok || spawnErr || err || stopped) return done(spawnErr || err || (stopped ? 'stopped' : null));
        // Only an unexplained exit needs the CLI version for its diagnosis (detected lazily, briefly awaited).
        versionOf(agent).then((version) => done(explainExit({ agent, bin: cmd, code, signal, stats: parser.stats, stderr, version })));
      }
    });
  }

  function stopSeat(id) {
    const r = rtOf(id); if (!r.child) return false;
    r.stopRequested = true;
    killTree(r.child);
    return true;
  }

  return { runSeat, execSeat, stopSeat, detectCli, cliVersions: versions.cliVersionsCached };
}

module.exports = { createRunner };
