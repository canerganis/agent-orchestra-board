// Runs one CLI turn for a seat (runSeat queues per seat; execSeat spawns the CLI through its adapter).
// Robustness: a transient failure (rate limit, overload, 429/5xx, network, idle watchdog) retries the same turn on
// the same thread with backoff; a thread the CLI can no longer resume is replaced by a fresh one that gets a
// recovery preamble; login problems become one actionable error. A turn always resolves, it never throws.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { claudeBin, codexBin, retryDelays, idleTimeoutMs } = require('./config');
// spawnResolved: the CLI is resolved on PATH (or at ORCHESTRA_*_BIN) before every spawn, so a claude.exe/codex.exe
// inside the project or a seat's target (the child's cwd) can never be what runs.
const { codexEnv, killTree, spawnResolved } = require('./platform');
const { resolveTarget } = require('./target');
const claudeAdapter = require('./adapters/claude');
const codexAdapter = require('./adapters/codex');
const { spawnErrorMessage, explainExit, classifyFailure, authMessage } = require('./adapters/diagnose');
const versions = require('./adapters/versions');
const { now, newId } = require('./util');

// Waiting longer than this for `<bin> --version` would delay a failed turn's error message noticeably.
const VERSION_WAIT_MS = 3000;
// Retry prompt on a resumed thread that already holds the interrupted turn's message.
const CONTINUE_PROMPT = '[Your previous reply was interrupted before it finished. Answer the last message again, in full.]';

// spawnFn is injectable so tests can run the runner against a fake child process (never the real CLIs).
// detectVersions=false turns CLI version detection off entirely (tests that count spawns).
// retryDelaysMs / idleMs override config.retryDelays() / config.idleTimeoutMs() (tests).
function createRunner({ store, seats, limits, settings, broadcast, spawnFn = spawnResolved, detectVersions = true, retryDelaysMs = null, idleMs = null }) {
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

  // Board shutdown: no new CLI child is spawned after this (queued and retrying turns resolve as 'stopped').
  let closing = false;
  function shutdown() { closing = true; }

  // opts.signal (AbortSignal, optional): when it fires while this turn still waits in the seat's queue, the turn
  // resolves at once as stopped; the queued execSeat then no-ops (it checks the same signal before spawning).
  // A turn that already started is stopped through stopSeat (its child is killed), as before.
  function runSeat(seatId, prompt, opts = {}) {
    const r = rtOf(seatId);
    let started = false;
    const p = r.queue.then(() => { started = true; return execSeat(seatId, prompt, opts); }).catch((e) => {
      // A bug in a turn must never stall a meeting or chain: report it as a failed turn.
      const m = `internal error: ${(e && e.message) || e}`;
      try { setRt(seatId, { status: 'error', activity: m, child: null, startedAt: null, roomId: null, retryWait: null }); } catch {}
      return { ok: false, error: m, text: '', tokens: 0, cached: 0, cost: 0, failure: 'other' };
    });
    r.queue = p.catch(() => {});
    const sig = opts.signal;
    if (!sig) return p;
    const stoppedRes = () => ({ ok: false, error: 'stopped', text: '', tokens: 0, cached: 0, cost: 0, failure: 'stopped' });
    const cut = new Promise((resolve) => {
      const fire = () => { if (!started) resolve(stoppedRes()); };
      if (sig.aborted) fire(); else sig.addEventListener('abort', fire, { once: true });
    });
    return Promise.race([p, cut]);
  }

  // tools: 'none' (discussion), 'read' (look at code), 'write' (seat must allow it).
  // room: meetings/chains keep one thread per seat per room, so old conversations are never re-sent.
  // recovery(): text that re-establishes the context on a fresh thread (role header is added here); onRecover(note):
  // called once when a lost thread was replaced (rooms.js records it as a system line).
  async function execSeat(seatId, prompt, { effort, model = null, runId = newId(), roomId = null, room = null, tools = null, withTarget = true, threadKey = null, cancelled = null, signal = null, recovery = null, onRecover = null } = {}) {
    roomId ??= room?.id ?? null; // run/item/end events carry the room even when the caller passed only `room`
    const seat = seatById(seatId);
    if (!seat) return { ok: false, error: 'no such agent', text: '' };
    const isStopped = () => !!(closing || room?.stopped || cancelled?.() || signal?.aborted);
    if (isStopped()) return { ok: false, error: 'stopped', text: '' }; // queued before the stop or the board shutdown
    if (seat.budget && seat.used >= seat.budget) return { ok: false, error: `${seat.name} reached its token budget`, text: '' };
    const eff = effort || seat.effort;
    const mdl = model || seat.model; // per-session model override (room.overrides), else the seat model
    const mode = tools === 'write' && seat.perm !== 'write' ? 'read' : tools || (seat.perm === 'write' ? 'write' : 'read');
    const threads = room ? (room.threads ||= {}) : null;
    const key = threadKey || seat.id;
    // Room threads are persisted with the room (rooms.js); a seat thread goes to seats.json right away.
    // A seat thread is written only while the seat still has the generation this turn started with: a 'Clear memory'
    // or a runtime/role/scope edit made while the turn ran must not be undone when the turn ends.
    const gen0 = seat.threadGen || 0;
    const saveThread = (id) => {
      if (threads) { threads[key] = id; return; }
      if ((seat.threadGen || 0) !== gen0) return;
      if (seat.thread !== id) { seat.thread = id; saveSeats(); }
    };
    const agent = seat.agent === 'codex' ? 'codex' : 'claude';
    const delays = retryDelaysMs ?? retryDelays();

    let thread = threads ? threads[key] || null : seat.thread;
    let recoveryText = '', recovered = false, retries = 0, idleRetried = false, first = true, turnPrompt = prompt;
    const total = { tokens: 0, cached: 0, cost: 0 };
    // Every retry/recovery attempt is another billable CLI turn: the seat budget is checked before each one.
    const overBudget = () => { const s = seatById(seatId) || seat; return s.budget && s.used >= s.budget ? `${s.name} reached its token budget` : null; };
    // The live bubble of this turn shows the streamed text of the current attempt only (UI: clear tw[runId]).
    const resetStream = () => broadcast({ t: 'delta', seatId, runId, text: '', reset: true });
    const startRecovery = (lost, why) => {
      // The CLI lost the thread (expired, deleted, other cwd, or resumed it as a new one): start a fresh one and
      // re-send the context with the full prompt.
      recovered = true;
      thread = null; turnPrompt = prompt;
      try { recoveryText = typeof recovery === 'function' ? String(recovery() || '') : ''; } catch { recoveryText = ''; }
      const note = `${seat.name}'s thread ${String(lost).slice(0, 12)}… could not be resumed (${String(why).slice(0, 160)}); started a fresh thread with a recap of the conversation.`;
      try { if (typeof onRecover === 'function') onRecover(note); else broadcast({ t: 'item', seatId, runId, roomId, kind: 'system', text: note.slice(0, 200), ts: now() }); } catch {}
      resetStream();
    };
    let out;
    for (;;) {
      out = await attempt({ seat, seatId, agent, prompt: turnPrompt, eff, mdl, mode, thread, recoveryText, withTarget, runId, roomId, first });
      first = false;
      total.tokens += out.tokens; total.cached += out.cached; total.cost += out.cost;
      // spawn() threw before anything ran: the CLI cannot run at all ('unavailable'), so meetings bench the seat.
      if (out.notStarted) return { ok: false, error: out.error, text: '', failure: out.stopped ? 'stopped' : 'unavailable' };
      if (out.ok) {
        // A CLI that resumes an unknown id by quietly starting a new thread answered without the conversation: treat
        // it as a lost thread (once) instead of saving the context-free thread over the real one.
        if (thread && out.gotThread && out.gotThread !== thread && !recovered && !isStopped()) {
          const budget = overBudget();
          if (budget) { out = { ...out, ok: false, error: budget, kind: 'other' }; break; }
          startRecovery(thread, `the CLI answered on a new thread ${String(out.gotThread).slice(0, 12)}…`);
          continue;
        }
        if (out.gotThread || out.pendingThread) saveThread(out.gotThread || out.pendingThread);
        break;
      }
      const stopped = out.stopped || isStopped() || !!rtOf(seatId).stopRequested;
      if (stopped) { out.error = 'stopped'; out.kind = 'stopped'; break; }
      if (out.spawnErr) { out.kind = 'unavailable'; break; } // the binary could not be launched: a retry cannot help
      let kind = out.idle ? 'transient' : classifyFailure(`${out.error}\n${out.stderr}`, { resumed: !!thread, thread });
      // A turn the CLI reported as completed is never re-run (Codex: turn.completed is the source of truth).
      if (out.completed && agent === 'codex' && kind === 'transient') kind = 'other';
      out.kind = kind;
      if (kind === 'auth') { out.error = authMessage(agent, out.error, out.stderr); break; }
      if (kind === 'resume' && !recovered) {
        const budget = overBudget();
        if (budget) { out.error = budget; out.kind = 'other'; break; }
        startRecovery(thread, out.error);
        continue;
      }
      // An idle-watchdog kill means slow work, not a network glitch: it is retried at most once.
      if (kind === 'transient' && retries < delays.length && !(out.idle && idleRetried)) {
        retries++;
        if (out.idle) idleRetried = true;
        const label = `retrying (${retries}/${delays.length})`;
        broadcast({ t: 'item', seatId, runId, roomId, kind: 'retry', text: `${label}: ${String(out.error).slice(0, 160)}`, ts: now() });
        setRt(seatId, { status: 'working', activity: label, child: null, roomId, runId });
        const waited = await backoff(seatId, delays[retries - 1]);
        if (!waited || isStopped() || rtOf(seatId).stopRequested) { out.error = 'stopped'; out.kind = 'stopped'; break; }
        if (!seatById(seatId)) { out.error = 'no such agent'; out.kind = 'other'; break; } // deleted while waiting
        const budget = overBudget();
        if (budget) { out.error = budget; out.kind = 'other'; break; }
        // On a resumed thread the CLI already stored the prompt once it reported the thread: re-sending it would leave
        // it twice in the thread (and in every later turn), so the retry asks for the answer again instead.
        if (thread && out.gotThread === thread) turnPrompt = CONTINUE_PROMPT;
        // A transient failure on a brand-new thread retries on a brand-new thread (the half-made one is dropped).
        resetStream();
        continue;
      }
      break;
    }
    // A failed turn still remembers the thread its CLI reported (the next turn resumes it, as before).
    // A failed turn keeps the old thread: a CLI that could not resume it and reported a different id must not
    // replace the conversation the seat still has (the new thread holds none of it).
    if (!out.ok && out.gotThread && (!thread || out.gotThread === thread)) saveThread(out.gotThread);
    const ok = out.ok, err = ok ? null : out.error;
    setRt(seatId, { status: ok ? 'idle' : 'error', activity: ok ? '' : err, startedAt: null, child: null, roomId: null, stopRequested: false, retryWait: null });
    broadcast({ t: 'end', seatId, runId, roomId, ok, tokens: total.tokens, cached: total.cached, cost: total.cost, error: err });
    const res = { ok, text: out.text, tokens: total.tokens, cached: total.cached, cost: total.cost, error: err };
    if (!ok) res.failure = out.kind || 'other';
    if (recovered && ok) res.recovered = true;
    return res;
  }

  // Waits ms unless the seat is stopped meanwhile (stopSeat cancels it). -> Promise<boolean> (true = waited).
  function backoff(seatId, ms) {
    return new Promise((resolve) => {
      const r = rtOf(seatId);
      const t = setTimeout(() => { r.retryWait = null; resolve(true); }, ms);
      r.retryWait = { cancel: () => { clearTimeout(t); r.retryWait = null; resolve(false); } };
    });
  }

  // One CLI process. Resolves with the raw outcome; the retry/recovery policy lives in execSeat.
  function attempt({ seat, seatId, agent, prompt, eff, mdl, mode, thread, recoveryText, withTarget, runId, roomId, first }) {
    return new Promise((resolve) => {
      if (closing) return resolve({ ok: false, notStarted: true, stopped: true, error: 'stopped', text: '', tokens: 0, cached: 0, cost: 0 });
      const tgt = withTarget ? resolveTarget(seat, PROJECT) : { cwd: PROJECT, preface: '' };
      // Role header and target scope go out once per thread; a resumed thread already has them.
      const header = thread ? '' : `[You are "${seat.name}" (${seat.role || 'agent'}) in a multi-agent orchestra of Claude and Codex seats. Reply in ${settings.lang}. Be concise.${mode !== 'write' ? ' Do not modify files.' : ''}]\n\n`;
      const toolNote = mode === 'none' ? '(No tools or commands this turn: answer from the conversation.)\n\n' : '';
      const recap = !thread && recoveryText ? `${recoveryText.trim()}\n\n` : '';
      const stdin = header + (thread ? '' : tgt.preface) + recap + toolNote + prompt;

      const isCodex = agent === 'codex';
      const adapter = isCodex ? codexAdapter : claudeAdapter;
      let cmd, args, cwd = tgt.cwd, pendingThread = null;
      if (isCodex) {
        cmd = codexBin();
        // Codex always has a shell tool; in a no-tools turn an empty cwd keeps it from re-reading the project.
        if (mode === 'none') { cwd = path.join(store.orch, 'empty'); fs.mkdirSync(cwd, { recursive: true }); }
        args = codexAdapter.buildArgs({ model: mdl, effort: eff, mode, thread });
      } else {
        cmd = claudeBin(); cwd = PROJECT; // Claude sessions are stored per project dir, so resume needs a stable cwd
        if (!thread) pendingThread = crypto.randomUUID();
        args = claudeAdapter.buildArgs({ model: mdl, effort: eff, thread, sessionId: pendingThread, addDir: tgt.dir && !tgt.dir.startsWith(PROJECT) ? tgt.dir : null, mode });
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
      catch (e) {
        const m = spawnErrorMessage(agent, cmd, e, env);
        if (first) { setRt(seatId, { status: 'error', activity: m, child: null, retryWait: null }); return resolve({ ok: false, notStarted: true, error: m, text: '', tokens: 0, cached: 0, cost: 0 }); }
        return resolve({ ok: false, spawnErr: m, error: m, text: '', stderr: '', tokens: 0, cached: 0, cost: 0 });
      }
      const patch = { status: 'working', activity: first ? 'starting' : rtOf(seatId).activity || 'starting', child, roomId, runId, stopRequested: false, retryWait: null };
      if (first) patch.startedAt = now();
      setRt(seatId, patch);
      if (first) broadcast({ t: 'run', seatId, runId, roomId });

      // Idle watchdog: no stdout for idleMs -> kill the process tree; the turn then counts as a transient failure.
      // limit 0 = watchdog off (settings/env 'off' or 0): no timer at all.
      const limit = idleMs ?? idleTimeoutMs(eff, settings, agent);
      let idle = false, watchdog = null;
      const arm = () => {
        if (!limit) return;
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => { idle = true; try { killTree(child); } catch {} }, limit);
        if (typeof watchdog.unref === 'function') watchdog.unref();
      };
      arm();

      let spawnErr = null, closed = false;
      child.stdout?.on('data', (d) => { if (!closed) arm(); parser.feed(d); });
      child.stderr?.on('data', (d) => { if (!closed) arm(); stderr = (stderr + d).slice(-4000); });
      // A missing/unlaunchable binary: Node emits 'error' (ENOENT, EACCES, EINVAL) and then 'close'.
      child.on('error', (e) => { spawnErr = spawnErrorMessage(agent, cmd, e, env); if (!closed) setTimeout(() => finish(null, null), 1000).unref?.(); });
      child.on('close', finish);
      // Writing to the stdin of a child that failed to start raises EPIPE on the stream: never let that crash the board.
      if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }

      function finish(code, signal) {
        if (closed) return; closed = true;
        clearTimeout(watchdog);
        parser.end(); // flush a last line without a trailing newline
        const stopped = !!rtOf(seatId).stopRequested;
        // Final usage wins; the stream's running totals only stand in when the turn never reported usage (or reported
        // nothing but zeros because the result carried no usage object), e.g. a run killed mid-answer.
        const u = usage && (usage.tokens || usage.cached || usage.cost) ? usage : partial || usage || {};
        const tokens = u.tokens || 0, cached = u.cached || 0, cost = u.cost || 0;
        seat.used = (seat.used || 0) + tokens; seat.cached = (seat.cached || 0) + cached; seat.cost = (seat.cost || 0) + cost;
        saveSeats();
        setRt(seatId, { child: null });
        if (isCodex && !spawnErr) setTimeout(() => limits.refreshCodex(), 500);
        // Success means the CLI reported a completed turn. A clean exit with nothing we could parse is a failure
        // (schema change, wrong binary, plain-text output), and a finished turn still counts even if the CLI exits
        // non-zero afterwards (e.g. a failing notify hook).
        const ok = !err && !spawnErr && completed;
        const base = { ok, completed, text: final ?? text, tokens, cached, cost, gotThread, pendingThread: ok && !gotThread ? pendingThread : null, stderr, stopped, idle: idle && !completed, spawnErr };
        if (ok) return resolve({ ...base, error: null });
        if (spawnErr || err || stopped) return resolve({ ...base, error: spawnErr || err || 'stopped' });
        if (idle) return resolve({ ...base, error: `${agent === 'codex' ? 'Codex' : 'Claude'} CLI produced no output for ${Math.round(limit / 6000) / 10} min (idle watchdog); the process was killed` });
        // Only an unexplained exit needs the CLI version for its diagnosis (detected lazily, briefly awaited).
        versionOf(agent).then((version) => resolve({ ...base, error: explainExit({ agent, bin: cmd, code, signal, stats: parser.stats, stderr, version }) }));
      }
    });
  }

  function stopSeat(id) {
    const r = rtOf(id);
    if (r.retryWait) { r.stopRequested = true; r.retryWait.cancel(); return true; } // waiting to retry
    // Between two attempts (process gone, retry not scheduled yet): the turn checks stopRequested before retrying.
    if (!r.child) { if (r.status !== 'working') return false; r.stopRequested = true; return true; }
    r.stopRequested = true;
    killTree(r.child);
    return true;
  }

  return { runSeat, execSeat, stopSeat, shutdown, detectCli, cliVersions: versions.cliVersionsCached };
}

module.exports = { createRunner };
