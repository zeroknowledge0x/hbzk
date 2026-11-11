// Controller: the single gameplay owner. It serialises chat commands and planner ticks
// through one async promise chain so no two operations can mutate state concurrently.
// It never holds a lock longer than one tool await, and it releases ownership the moment
// the planner reports failure.

import { byName } from './adapters/index.js';
import { checkAction } from './safety.js';
import { labelMatchesPlay } from './play-labels.js';
import { kenoNumbers, readObservedProgress } from './progress.js';
import { cashoutLine } from './play-talk.js';
import { createScratch, exhausted, noteFailure, noteSuccess, openTask } from './reflexion.js';
import { boardTable } from './play-labels.js';
import { compressControls, legalControls, pickFromReply, resolveLookedClick, withBudget } from './look-then-click.js';

// A click that puts a bet on the table. Direction presets, mode toggles, tiles and in-round
// actions are not bets; only these arm the round timer.
const STARTS_ROUND = /^(bet|deal|spin|roll|go|play|bet again|new bet|repeat)\b/i;

export class Controller {
  constructor({ world, tools, planner, verifier, game, speak, log, rotation, playable, seeFrame, playQueue, random, now, advise, notifyAction, look }) {
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
    // Playbook advice (verified lessons) and the drift watch's action tap.
    this.advise = typeof advise === 'function' ? advise : null;
    this.notifyAction = typeof notifyAction === 'function' ? notifyAction : null;
    // When set, the model looks at the table and names the click. The policy is not a fallback.
    this.look = typeof look === 'function' ? look : null;
    this.scratch = createScratch();
    // Breathing room between rounds. Without it a table whose "round" is one click (Hilo
    // skip, Dice bet) replans the instant it finishes and looks like a click bot.
    this._nextRoundAt = 0;
    // A bet that is on the table is not over until a result is read back. The page phase can
    // read idle for a beat while a board settles, and that gap is how the host used to walk
    // off mid-round. The cap keeps a lost result from wedging the rotation forever.
    this._betAt = 0;
    this._betCapMs = Number(process.env.HUBIE_BET_CAP_MS) > 0 ? Number(process.env.HUBIE_BET_CAP_MS) : 45000;
    this._deferredGame = null;
    // One label clicked over and over is a click bot, not a host. This counts it per round.
    this._repeatLabel = null;
    this._repeatCount = 0;
  }

  _roundLive(now = this.now()) {
    if ((this.world?.get?.()?.phase || '') === 'playing') return true;
    return !!this._betAt && now - this._betAt < this._betCapMs;
  }

  // Only a click that puts a bet on the table arms the round timer. A direction preset ("Outside"),
  // a mode toggle or a tile does not — otherwise the host holds itself on a table forever while it
  // fiddles with controls, which is exactly what it did on Dice.
  _noteBet(label) {
    if (!STARTS_ROUND.test(String(label || ''))) return;
    this._betAt = this.now();
  }

  _noteSettled() { this._betAt = 0; this._fallbackHolds = 0; this._repeatLabel = null; this._repeatCount = 0; }

  _noteRepeat(label) {
    const key = String(label || '').toLowerCase();
    if (!key) return;
    if (key === this._repeatLabel) this._repeatCount += 1;
    else { this._repeatLabel = key; this._repeatCount = 1; }
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

    // A round with a bet on it finishes first. Walking off mid-round is what made the host look
    // like it abandoned the table; the switch is deferred, not dropped.
    if (this._roundLive()) {
      const actual = this.world?.get?.()?.game || '';
      this._deferredGame = gameName;
      this.speak(`finishing ${actual || 'this one'} first, then ${gameName}`, msg);
      this.log(`controller: switch to ${gameName} deferred (round in progress)`);
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
      // A switch that was asked for during a round runs the moment that round is over.
      if (this._deferredGame && !this._roundLive()) {
        const name = this._deferredGame;
        this._deferredGame = null;
        if (this.playable.has(String(name).toLowerCase())) {
          this._nextRoundAt = 0;
          this.planner.setGoal({ kind: 'play', game: name, rounds: 1 });
          this.scratch = openTask(this.scratch, `play ${name}`);
          this._active = true;
          this.log(`controller: deferred switch -> ${name}`);
          return;
        }
      }
      const asked = this.playQueue?.peek?.();
      if (asked && this.playable.has(String(asked.game).toLowerCase())) {
        const now = Date.now();
        if (this.playQueue.size > 1 && this.playQueue.due(now)) this.playQueue.shift();
        const next = this.playQueue.peek();
        if (!next) return;
        this._nextRoundAt = 0;
        this.planner.setGoal({ kind: 'play', game: next.game, rounds: 1 });
        this.scratch = openTask(this.scratch, `play ${next.game}`);
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
      this.scratch = openTask(this.scratch, `play ${name}`);
      this._active = true;
    }

    const step = this._deferredStep || this.planner.tick();
    if (!step) {
      // Planner finished or failed
      const st = this.planner.status();
      if (st.failed) {
        this._active = false;
        // The plan gave up on this table, so the bet on it is abandoned on purpose. Holding the
        // switch any longer would just keep the host parked on a table it cannot finish.
        this._noteSettled();
        this._nextRoundAt = this.now() + this._dwell();
        this.log(`controller: plan failed (${st.error})`);
        // Reflexion: keep one verbal lesson, and after a few tries ask for a different table
        // instead of grinding the same failure.
        this.scratch = noteFailure(this.scratch, { step: this.scratch.task || st.goal?.game || 'round', error: st.error || 'unknown' });
        if (exhausted(this.scratch)) {
          this.log(`controller: giving up on ${this.scratch.task || 'this table'} after ${this.scratch.attempts} tries`);
          this.rotation?.playNow?.();
          this._nextRoundAt = 0;
          this.scratch = noteSuccess(this.scratch);
        }
      }
      if (st.done) {
        this._active = false;
        this._nextRoundAt = this.now() + this._dwell();
        this.scratch = noteSuccess(this.scratch);
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
      this.scratch = noteFailure(this.scratch, { step: this.scratch.task || 'round', error: st.error || 'unknown' });
      this.log(`controller: plan failed (${st.error})`);
      if (exhausted(this.scratch)) {
        this.log(`controller: giving up on ${this.scratch.task} after ${this.scratch.attempts} tries`);
        this.rotation?.playNow?.();
        this._nextRoundAt = 0;
        this.scratch = noteSuccess(this.scratch);
      }
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
        if (this._roundLive()) {
          const actual = this.world?.get?.()?.game;
          const same = byName(actual)?.name === byName(step.args?.game)?.name;
          // The table name can come from the page URL while the board on screen is still the
          // previous table. If the controls belong to another table, the switch is real — the
          // round that is "live" belongs to a table the host is not playing.
          const onScreen = boardTable(this.world?.get?.()?.controls);
          if (same && onScreen && byName(onScreen)?.name !== byName(step.args?.game)?.name) {
            this.log(`controller: ${step.args?.game} is not on screen (found ${onScreen}) — switching anyway`);
            const away = await this.tools.run('change_game', step.args);
            if (away?.ok) this._noteSettled();
            return away;
          }
          if (!same) {
            // A fallback that the same live bet keeps holding is a dead table, not a round in
            // progress. Without this the planner spins on the table until the bet cap expires.
            if (step.fallback) {
              this._fallbackHolds = (this._fallbackHolds || 0) + 1;
              if (this._fallbackHolds > 2) {
                this.log('controller: round would not settle, leaving the table anyway');
                this._noteSettled();
                const away = await this.tools.run('change_game', step.args);
                if (away?.ok) this._noteSettled();
                return away;
              }
            }
            await this._playTable({ ...step, game: actual });
            return { ok: false, deferred: true, reason: 'in-round', error: 'Waiting for current table before switch' };
          }
          return { ok: true, skipped: true, reason: 'in-round' };
        }
        const switched = await this.tools.run('change_game', step.args);
        if (switched?.ok) this._noteSettled();
        return switched;
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
        if (verified?.ok) {
          this._noteSettled();
          return verified;
        }
        if (!adapter?.resolvesAtZero) {
          this._noteSettled();
          return { ok: true, skipped: true, reason: 'demo-click' };
        }
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
      const r = await withBudget(this.game.setStake(0), 8000, 'setStake');
      if (this._recovering()) return { ok: false, deferred: true, error: 'Capture recovery in progress' };
      if (r?.ok === true && r.verified === true && r.observed === 0
        && (r.settings?.stake === undefined || r.settings.stake === 0)) {
        this._stakeWaitSince = 0;
        return r;
      }
      // The field is not in the DOM yet on a table that just opened. Wait, but not forever:
      // a hung read used to freeze the click loop with no log at all. A table that already
      // burned the long wait gets the short one, so the same dead end is not paid twice.
      if (r?.pending || (r && r.ok !== true && /no stake control|not ready|timed out/i.test(String(r.error || '')))) {
        const now = this.now();
        const game = String(this.world?.get?.()?.game || '');
        const absent = this._stakeFieldAbsent || (this._stakeFieldAbsent = new Set());
        const limit = absent.has(game) ? 1500 : 12000;
        if (!this._stakeWaitSince) this._stakeWaitSince = now;
        if (now - this._stakeWaitSince < limit) {
          this.log(`controller: stake not ready (${r.error}), waiting`);
          return { ok: false, deferred: true, error: r.error };
        }
        this._stakeWaitSince = 0;
        absent.add(game);
        // Empty and locked is not a number. A non-zero lock still fails above. Don't kill the round.
        this.log('controller: stake field stayed empty, continuing without a write');
        return { ok: false, skipped: true, error: r.error || 'stake field never appeared' };
      }
      return { ok: false, error: r?.error || 'Zero stake readback mismatch' };
    } catch (err) { return { ok: false, error: err.message }; }
  }

  async _playTable(step) {
    const zero = await this._verifyZeroStake();
    if (!zero.ok && !zero.skipped) return zero;
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
    // Every table: the model sees the controls (compressed when the board is long) and names
    // one. A silent or illegal answer is a no-click. The measured policy is not a fallback,
    // because a random Hit/Stand/chip is what made the host play without looking.
    let choice;
    if (this.look) {
      let live = controls;
      let seen = '';
      if (typeof this.game?.getUiSnapshot === 'function') {
        const snap = await withBudget(this.game.getUiSnapshot({ force: true }), 8000, 'snapshot').catch(() => null);
        const fresh = (snap?.clickables || []).map((item) => String(item?.text || '').trim()).filter(Boolean);
        if (fresh.length) live = fresh;
        seen = String(snap?.dialogText || '').slice(0, 240);
      }
      // Never click a board that belongs to another table. The plan's table is the authority here:
      // a start_round step carries no game of its own, and the world's name comes from the page
      // URL, which can lag the board (the host then clicked Hilo's cards under a Keno goal).
      const planned = String(this.planner?.status?.()?.goal?.game || gameName || '').trim();
      const onScreen = boardTable(live);
      if (onScreen && planned && byName(onScreen)?.name !== byName(planned)?.name) {
        const key = `${onScreen}->${planned}`;
        this._boardSwitches = this._boardSwitches || new Map();
        const tries = (this._boardSwitches.get(key) || 0) + 1;
        this._boardSwitches.set(key, tries);
        if (tries > 3) {
          // The planned table will not come up. Playing the one that is actually open beats
          // standing still on the stream.
          this.log(`controller: ${planned} will not come up after ${tries} tries — playing ${onScreen} instead`);
          this._noteSettled();
          this.planner?.setGoal?.({ kind: 'play', game: onScreen, rounds: 1 });
          return { ok: false, deferred: true, error: 'planned table would not come up' };
        }
        this.log(`controller: board is ${onScreen}, not ${planned} — switching the table first`);
        this._noteSettled();
        const r = await this.tools.run('change_game', { game: planned });
        return r?.ok ? { ok: true, detail: r } : { ok: false, deferred: true, error: 'table switch failed' };
      }
      this._boardSwitches?.clear();
      if (this._blockedGame !== gameName) {
        this._blockedGame = gameName;
        this._blocked = new Set();
      }
      if (this._blocked?.size) live = live.filter((label) => !this._blocked.has(String(label).toLowerCase()));
      // A round that stops responding to the same click looks like a bot. The model is told how
      // many times it has already spent that click, and the label stops being offered at ten.
      const repeats = this._repeatCount >= 3 && this._repeatLabel
        ? { label: this._repeatLabel, count: this._repeatCount }
        : null;
      if (this._repeatCount >= 10 && this._repeatLabel) {
        live = live.filter((label) => String(label).toLowerCase() !== this._repeatLabel);
      }
      const offered = compressControls(legalControls(live));
      if (!offered.length) {
        this.log('controller: table not ready (no play control yet)');
        return { ok: false, deferred: true, error: 'table not ready' };
      }
      let pick = null;
      try {
        pick = await this.look({ game: gameName, phase: worldState.phase, controls: offered, progress, seen, repeats });
      } catch (err) {
        this.log(`controller: look failed (${err?.message || err})`);
        return { ok: false, error: 'look failed' };
      }
      const named = typeof pick === 'object' && pick ? pick.label : pick;
      // Resolve against the full board, not the compressed prompt. A Keno number the
      // compressor cut still has to be clickable if the model named it.
      const label = pickFromReply(named, live) || resolveLookedClick({ controls: live, pick: named });
      if (!label) {
        this._emptyLooks = (this._emptyLooks || 0) + 1;
        if (this._emptyLooks < 12) {
          this.log(`controller: model chose nothing clickable (${String(named || 'empty').slice(0, 80)}; board ${live.slice(0, 6).join(' | ')}), waiting`);
          return { ok: false, deferred: true, error: 'model did not choose a visible control' };
        }
        this.log(`controller: model chose nothing clickable (${named || 'empty'})`);
        return { ok: false, error: 'model did not choose a visible control' };
      }
      this._emptyLooks = 0;
      choice = { label };
    } else {
      if (!adapter || typeof adapter.decide !== 'function') return { ok: false, error: 'no per-game policy' };
      choice = adapter.decide({ phase: worldState.phase, controls, progress }, this.random);
    }
    if (!choice) return { ok: false, error: 'no measured action' };
    // A table with a writable payout field gets a random target on the way in. Best effort:
    // the setter verifies its own readback, and a table that cannot write it still plays.
    if (worldState.phase !== 'playing' && Number.isFinite(choice.multi)
      && typeof this.game?.setMultiplier === 'function') {
      if (this._recovering()) return { ok: false, deferred: true, error: 'Capture recovery in progress' };
      const set = await this.game.setMultiplier(choice.multi).catch(() => null);
      this.log(`controller: multiplier ${choice.multi}x ${set?.ok ? `set (${set.observed}x)` : `skipped (${set?.error || 'no control'})`}`);
    }
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
      if (!raw?.ok) {
        this._blocked = this._blocked || new Set();
        this._blocked.add(String(label).toLowerCase());
        this.log(`controller: click "${label}" missed (${raw?.error || 'not found'}), skipping it`);
        return { ok: false, deferred: true, error: raw?.error || 'not found' };
      }
      await this._snapPlay(raw.text || label);
      if (/^cash out/i.test(String(label))) {
        // Say why the round was taken off the table: a click with a reason reads as a host.
        const lesson = this.advise?.(gameName, { progress }) || null;
        this.speak(lesson ? `${cashoutLine(gameName, { progress })} ${lesson}.` : cashoutLine(gameName, { progress }), {});
      }
      this.notifyAction?.(String(label));
      // Taking a bet off the table is the one click that ends a round instead of starting one.
      this._noteBet(raw.text || label);
      this._noteRepeat(raw.text || label);
      return { ok: true, detail: raw };
    }
    const raw = await this.tools.run('click', { label });
    if (raw?.ok) {
      await this._snapPlay(raw.text || label);
      this._noteBet(raw.text || label);
      this._noteRepeat(raw.text || label);
    }
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
