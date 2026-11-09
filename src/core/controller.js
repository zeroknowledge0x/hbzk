// Controller: the single gameplay owner. It serialises chat commands and planner ticks
// through one async promise chain so no two operations can mutate state concurrently.
// It never holds a lock longer than one tool await, and it releases ownership the moment
// the planner reports failure.

import { byName } from './adapters/index.js';
import { checkAction } from './safety.js';
import { labelMatchesPlay } from './play-labels.js';
import { kenoNumbers, readObservedProgress } from './progress.js';

export class Controller {
  constructor({ world, tools, planner, verifier, game, speak, log, rotation, playable, seeFrame, playQueue, random, now }) {
    this.world = world;
    this.tools = tools;
    this.planner = planner;
    this.verifier = verifier;
    this.game = game;
    this.speak = speak || (() => {});
    this.log = log || (() => {});
    this.rotation = rotation;
    this.playable = new Set([...(playable || ['Dice', 'Mines', 'Plinko', 'Keno', 'Wheel', 'Limbo', 'Max Win', 'Dragon Tower', 'Hilo', 'Blackjack', "Hubie's Road"])].map(x => String(x).toLowerCase()));
    this.seeFrame = typeof seeFrame === 'function' ? seeFrame : null;
    this.playQueue = playQueue || null;
    this._chain = Promise.resolve();
    this._paused = false;
    this._active = false;
    this._snapshot = null;
    this._completed = 0;
    this._demoAttempts = 0;
    this._lastShotTalk = 0;
    this.random = typeof random === 'function' ? random : Math.random;
    this.now = typeof now === 'function' ? now : Date.now;
    // Breathing room between rounds. Without it a table whose "round" is one click (Hilo
    // skip, Dice bet) replans the instant it finishes and looks like a click bot.
    this._nextRoundAt = 0;
  }

  // 6-15 s, the same band the quiet-talk timer uses for a human beat.
  _dwell() { return 6000 + Math.floor(this.random() * 9000); }

  // ── public API ──────────────────────────────────────────────────────────────

  async handle(intent, msg) {
    return this._enqueue(() => this._handle(intent, msg));
  }

  async tick() {
    return this._enqueue(() => this._tick());
  }

  pause() { this._paused = true; this._active = false; }
  resume() { this._paused = false; }

  status() {
    const p = this.planner.status();
    return {
      paused: this._paused,
      active: this._active,
      completed: this._completed,
      demoAttempts: this._demoAttempts,
      goal: p.goal,
      step: p.step,
      total: p.total,
      done: p.done,
      failed: p.failed,
      error: p.error,
      kind: p.kind,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  _enqueue(fn) {
    this._chain = this._chain.then(fn, fn);
    return this._chain;
  }

  // ── chat handling ───────────────────────────────────────────────────────────

  async _handle(intent, msg) {
    if (!intent || !intent.kind) return;
    if (this._recovering() && !['stop', 'status'].includes(intent.kind)) return;

    switch (intent.kind) {
      case 'change_game':
        return this._handleChangeGame(intent, msg);
      case 'set_multiplier':
        return this._handleSetting('set_multiplier', intent, msg);
      case 'set_win_chance':
      case 'set_chance':
        return this._handleSetting('set_win_chance', intent, msg);
      case 'set_stake':
        return this._handleSetStake(intent, msg);
      case 'stop':
        return this._handleStop(msg);
      case 'status':
        return this._handleStatus(msg);
      case 'start_round':
        return this._handleStartRound(intent, msg);
      case 'pick_tile':
      case 'cash_out':
      case 'higher':
      case 'lower':
      case 'hit':
      case 'stand':
      case 'double':
      case 'split':
        return this._handleAction(intent, msg);
      default:
        return;
    }
  }

  async _handleChangeGame(intent, msg) {
    const gameName = byName(intent.args?.game)?.name || '';
    if (!gameName) {
      this.speak('which game?', msg);
      return;
    }

    // Check playable whitelist
    if (this.playable.size > 0 && !this.playable.has(gameName.toLowerCase())) {
      this.speak(`cannot run zero-stake on ${gameName}`, msg);
      return;
    }

    // Reset old plan safely at queue boundary
    this.planner.reset('change_game');
    this._active = false;
    this._snapshot = null;
    this._deferredStep = null;

    // Set new goal — do NOT speak "done" prematurely
    const rounds = intent.args?.rounds || 1;
    this.planner.setGoal({ kind: 'play', game: gameName, rounds });
    this._active = true;
    this.log(`controller: goal set → ${gameName} ×${rounds}`);
  }

  async _handleSetting(toolName, intent, msg) {
    const value = Number(intent.args?.value);
    if (!Number.isFinite(value)) {
      this.speak('invalid value', msg);
      return;
    }

    const safety = checkAction({ kind: toolName, args: { value } }, this.world);
    if (!safety.ok) {
      this.speak(safety.reason, msg);
      return;
    }

    let r;
    try {
      r = await this.tools.run(toolName, { value });
    } catch (err) {
      this.speak(`error: ${err.message}`, msg);
      return;
    }

    if (!r || !r.ok) {
      this.speak(r?.error || `${toolName} failed`, msg);
      return;
    }

    // Readback verification: check world reflects the change
    const readbackOk = this._verifyReadback(toolName, value);
    if (readbackOk) {
      this.speak(`${toolName} set to ${value}`, msg);
    } else {
      this.speak(`${toolName} applied but readback mismatch`, msg);
    }
  }

  _verifyReadback(toolName, value) {
    const state = this.world.get();
    switch (toolName) {
      case 'set_multiplier':
        return state.multiplier === value;
      case 'set_win_chance':
        return state.winChance === value;
      default:
        return true;
    }
  }

  async _handleSetStake(intent, msg) {
    const value = Number(intent.args?.value);
    if (!Number.isFinite(value)) {
      this.speak('invalid stake', msg);
      return;
    }
    if (value !== 0) {
      this.speak('stake changes are not allowed', msg);
      return;
    }
    const r = await this.tools.run('set_stake', {value: 0});
    this.speak(r.ok ? 'Stake verified at zero.' : `Stake reset failed: ${r.error}`, msg);
  }

  async _handleStop(msg) {
    this.planner.reset('stop');
    this._active = false;
    this._snapshot = null;
    this._deferredStep = null;
    this.pause();
    this.speak('stopped', msg);
  }

  async _handleStatus(msg) {
    const s = this.status();
    const bits = [];
    if (s.goal) bits.push(`${s.goal.game} ×${s.goal.rounds}`);
    if (s.kind) bits.push(s.kind);
    bits.push(`step ${s.step}/${s.total}`);
    if (s.done) bits.push('done');
    if (s.failed) bits.push(`failed: ${s.error}`);
    if (s.paused) bits.push('paused');
    this.speak(bits.join(', '), msg);
  }

  async _handleStartRound(intent, msg) {
    const zero = await this._verifyZeroStake();
    if (!zero.ok) { this.speak(zero.error, msg); return; }
    // Single Bet click — capture snapshot before
    const snapshot = this._captureSnapshot();
    let r;
    try {
      r = await this.tools.run('click', { label: 'Bet' });
    } catch (err) {
      this.speak(`error: ${err.message}`, msg);
      return;
    }
    if (!r || !r.ok) {
      this.speak(r?.error || 'click failed', msg);
      return;
    }
    const verified = await this.verifier.waitFor('round_result', {before: snapshot, timeout: 8000});
    if (verified.ok) { this._completed += 1; this.speak('Round result verified.', msg); }
    else this.speak('I could not verify a completed round.', msg);
  }

  async _handleAction(intent, msg) {
    const zero = await this._verifyZeroStake();
    if (!zero.ok) { this.speak(zero.error, msg); return; }
    const labels = {cash_out: 'Cash out', higher: 'Higher', lower: 'Lower', hit: 'Hit', stand: 'Stand'};
    const label = labels[intent.kind] || intent.kind;
    let r;
    try {
      r = intent.kind === 'pick_tile'
        ? await this.tools.run('choose_tile', { n: intent.args?.n })
        : await this.tools.run('click', { label });
    } catch (err) {
      this.speak(`error: ${err.message}`, msg);
      return;
    }
    if (!r || !r.ok) {
      this.speak(r?.error || 'action failed', msg);
      return;
    }
    this.speak(`${intent.kind} done`, msg);
  }

  // ── tick: process one planner step ─────────────────────────────────────────

  async _tick() {
    if (this._paused || this._recovering()) return;
    if (!this._active) {
      const asked = this.playQueue?.peek?.();
      if (asked && this.playable.has(String(asked.game).toLowerCase())) {
        const now = Date.now();
        if (this.playQueue.size > 1 && this.playQueue.due(now)) this.playQueue.shift();
        const next = this.playQueue.peek();
        if (!next) return;
        this._nextRoundAt = 0;
        this.planner.setGoal({ kind: 'play', game: next.game, rounds: 1 });
        this._active = true;
        this.playQueue.holdMs(now);
        this.log(`controller: chat switch ${next.name} -> ${next.game}`);
        return;
      }
      // A viewer request jumps the dwell; an unattended round waits for it.
      if (this.now() < this._nextRoundAt) return;
      if (typeof this.rotation?.due !== 'function') return;
      const rotate = this.rotation.due();
      let name = null;
      if (rotate) {
        name = typeof this.rotation.random === 'function' ? this.rotation.random() : this.rotation.next();
      } else {
        name = String(this.world?.get?.()?.game || this.planner.status()?.goal?.game || '').trim();
      }
      if (!name || !this.playable.has(name.toLowerCase())) return;
      this.planner.setGoal({kind: 'play', game: name, rounds: rotate ? 3 : 1});
      this._active = true;
    }

    const step = this._deferredStep || this.planner.tick();
    if (!step) {
      // Planner finished or failed
      const st = this.planner.status();
      if (st.failed) {
        this._active = false;
        this._nextRoundAt = this.now() + this._dwell();
        this.log(`controller: plan failed (${st.error})`);
        this.rotation?.playNow?.();
      }
      if (st.done) {
        this._active = false;
        this._nextRoundAt = this.now() + this._dwell();
      }
      return;
    }

    let result;
    try {
      result = await this._executeStep(step);
    } catch (err) {
      result = { ok: false, error: err.message };
    }

    // Settle the planner with the result (await tool only once per tick)
    if (result?.deferred) {
      // Keep this exact step pending without spending retry/fallback budget.
      this._deferredStep = step;
      return;
    }
    this._deferredStep = null;
    this.planner.settle(result);

    // Check post-settle state
    const st = this.planner.status();
    if (st.failed) {
      this._active = false;
      this._nextRoundAt = this.now() + this._dwell();
      this.log(`controller: plan failed (${st.error})`);
      this.rotation?.playNow?.();
      return;
    }

    // Only count completion when await_result succeeded
    if (step.kind === 'await_result' && result && result.ok) {
      if (result.skipped || result.reason === 'demo-click') this._demoAttempts += 1;
      else this._completed += 1;
    }

    if (st.done) {
      this._active = false;
      this._nextRoundAt = this.now() + this._dwell();
    }
  }

  _recovering() { return !!(this.game?.captureRecoveryInFlight || this.game?.recoveryInFlight); }

  async _executeStep(step) {
    if (this._recovering()) return { ok: false, deferred: true, error: 'Capture recovery in progress' };
    switch (step.kind) {
      case 'enter_game': {
        const phase = this.world?.get?.()?.phase;
        if (phase === 'playing') {
          const actual = this.world?.get?.()?.game;
          if (byName(actual)?.name !== byName(step.args?.game)?.name) {
            await this._playTable({ ...step, game: actual });
            return { ok: false, deferred: true, reason: 'in-round', error: 'Waiting for current table before switch' };
          }
          return { ok: true, skipped: true, reason: 'in-round' };
        }
        return this.tools.run('change_game', step.args);
      }

      case 'configure': {
        const r = await this.tools.run(step.tool, step.args);
        if (r && r.ok) {
          const readbackOk = this._verifyReadback(step.tool, step.args?.value);
          if (!readbackOk) {
            return { ok: false, error: `${step.tool} readback mismatch` };
          }
        }
        return r;
      }

      case 'start_round':
        return this._playTable(step);

      case 'await_result': {
        if (!this._snapshot) {
          return { ok: false, error: 'await_result without snapshot' };
        }
        const adapter = byName(this.planner.status().goal?.game);
        const timeout = adapter?.resolvesAtZero ? (step.timeout || 8000) : 1200;
        const verified = await this.verifier.waitFor('round_result', { before: this._snapshot, timeout });
        if (verified?.ok) return verified;
        if (!adapter?.resolvesAtZero) return { ok: true, skipped: true, reason: 'demo-click' };
        return verified;
      }

      default:
        return { ok: false, error: `unknown step kind: ${step.kind}` };
    }
  }

  async _verifyZeroStake() {
    if (this._recovering()) return { ok: false, deferred: true, error: 'Capture recovery in progress' };
    if (typeof this.game?.setStake !== 'function') return { ok: false, error: 'No verified stake control' };
    try {
      const r = await this.game.setStake(0);
      if (this._recovering()) return { ok: false, deferred: true, error: 'Capture recovery in progress' };
      if (r?.ok === true && r.verified === true && r.observed === 0
        && (r.settings?.stake === undefined || r.settings.stake === 0)) return r;
      return { ok: false, error: r?.error || 'Zero stake readback mismatch' };
    } catch (err) { return { ok: false, error: err.message }; }
  }

  async _playTable(step) {
    const zero = await this._verifyZeroStake();
    if (!zero.ok) return zero;
    this._snapshot = this._captureSnapshot();
    const worldState = this.world?.get?.() || {};
    const gameName = worldState.phase === 'playing'
      ? worldState.game : (step.game || this.planner.status().goal?.game);
    const adapter = byName(gameName);
    if (!adapter || typeof adapter.decide !== 'function') return { ok: false, error: 'no per-game policy' };
    const controls = Array.isArray(worldState.controls) ? worldState.controls : [];
    // Progress is read from the board that is actually on screen (revealed gems, cleared
    // floors/lanes); the number of clicks is never used as proof.
    const progress = readObservedProgress(gameName, { ...(worldState.report || {}), controls });
    const choice = adapter.decide({ phase: worldState.phase, controls, progress }, this.random);
    if (!choice) return { ok: false, error: 'no measured action' };
    if (worldState.phase !== 'playing' && choice.settings && typeof this.game?.clickText === 'function') {
      if (this._recovering()) return { ok: false, deferred: true, error: 'Capture recovery in progress' };
      const setting = await this.game.clickText(choice.settings).catch(() => null);
      if (!setting?.ok) return { ok: false, error: 'settings control not available' };
    }
    if (choice.pick === 'tile') {
      if (typeof this.game?.clickMinesTile !== 'function') return { ok: false, error: 'no tile tool' };
      const tile = await this.game.clickMinesTile();
      if (!tile?.ok) return { ok: false, error: 'tile unavailable' };
      await this._snapPlay(tile.text || 'tile');
      if (!choice.label) return { ok: true, detail: tile };
    }
    if ((choice.pick === 'auto-or-numbers' || choice.pick === 'numbers') && typeof this.game?.clickText === 'function') {
      const auto = choice.pick === 'auto-or-numbers' && this.random() < 0.5;
      if (auto) {
        const result = await this.game.clickText('Auto pick');
        if (!result?.ok) return { ok: false, error: 'auto pick unavailable' };
      } else {
        // Keno keeps the previous round's selection on the board and greys those tiles out,
        // so a later round can fail every click and look like "no numbers selected".
        if (controls.some((c) => labelMatchesPlay('Clear table', c))) {
          await this.game.clickText('Clear table').catch(() => null);
        }
        const spots = kenoNumbers(controls);
        for (let i = spots.length - 1; i > 0; i--) {
          const j = Math.floor(this.random() * (i + 1));
          [spots[i], spots[j]] = [spots[j], spots[i]];
        }
        const want = 2 + Math.floor(this.random() * 3);
        let picked = 0;
        for (const n of spots) {
          if (picked >= want) break;
          if (this._recovering()) return { ok: false, deferred: true, error: 'Capture recovery in progress' };
          const spot = await this.game.clickText(String(n)).catch(() => null);
          if (spot?.ok) picked++;
        }
        if (!picked) return { ok: false, error: 'no Keno numbers selected' };
      }
    }
    let currentControls = controls;
    if (choice.label && !controls.some((c) => labelMatchesPlay(choice.label, c))
      && typeof this.game?.getUiSnapshot === 'function') {
      const snap = await this.game.getUiSnapshot({ force: true });
      const fresh = (snap?.clickables || []).map((item) => String(item?.text || '').trim()).filter(Boolean);
      if (fresh.length) currentControls = fresh;
    }
    const label = choice.label;
    if (!label || !currentControls.some((c) => labelMatchesPlay(label, c))) {
      this.log(`controller: "${label || 'nothing'}" is not on the table (saw: ${currentControls.slice(0, 10).join(' | ').slice(0, 240)})`);
      return { ok: false, error: 'no visible play control' };
    }
    if (this._recovering()) return { ok: false, deferred: true, error: 'Capture recovery in progress' };
    if (typeof this.game?.clickText === 'function') {
      const raw = await this.game.clickText(label).catch(() => null);
      if (!raw?.ok) return { ok: false, error: raw?.error || 'not found' };
      await this._snapPlay(raw.text || label);
      return { ok: true, detail: raw };
    }
    const raw = await this.tools.run('click', { label });
    if (raw?.ok) await this._snapPlay(raw.text || label);
    return raw;
  }

  async _snapPlay(tag) {
    let shot = null;
    if (typeof this.game?.snapPlay === 'function') {
      try {
        shot = await this.game.snapPlay(tag);
      } catch (err) {
        this.log(`controller: play frame skip (${err?.message || err})`);
      }
    }
    const now = Date.now();
    if (now - this._lastShotTalk < 25000) return shot;
    this._lastShotTalk = now;
    if (!this.seeFrame) return shot;
    Promise.resolve()
      .then(() => this.seeFrame(tag))
      .then((line) => { if (line) this.speak(line); })
      .catch(() => {});
    return shot;
  }

  _captureSnapshot() {
    const worldState = this.world.get();
    const report = this.game && typeof this.game.getReport === 'function'
      ? this.game.getReport()
      : null;
    return structuredClone({ ...worldState, report });
  }
}
