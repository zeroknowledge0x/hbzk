// Controller: the single gameplay owner. It serialises chat commands and planner ticks
// through one async promise chain so no two operations can mutate state concurrently.
// It never holds a lock longer than one tool await, and it releases ownership the moment
// the planner reports failure.

import { byName } from './adapters/index.js';
import { checkAction } from './safety.js';
import { preferInRoundLabels, labelMatchesPlay } from './play-labels.js';
import { varietyClicks, varietyPlay } from './variety.js';

export class Controller {
  constructor({ world, tools, planner, verifier, game, speak, log, rotation, playable, seeFrame, playQueue }) {
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
    this._lastShotTalk = 0;
  }

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
    if (this._paused) return;
    if (!this._active) {
      const asked = this.playQueue?.peek?.();
      if (asked && this.playable.has(String(asked.game).toLowerCase())) {
        const now = Date.now();
        const current = String(this.world?.get?.()?.game || '').toLowerCase();
        const want = String(asked.game).toLowerCase();
        if (this.playQueue.size > 1 && asked.startedAt && !this.playQueue.due(now) && current === want) {
          return;
        }
        if (this.playQueue.size > 1 && this.playQueue.due(now)) this.playQueue.shift();
        const next = this.playQueue.peek();
        if (!next) return;
        this.planner.setGoal({ kind: 'play', game: next.game, rounds: 1 });
        this._active = true;
        this.playQueue.holdMs(now);
        this.log(`controller: chat switch ${next.name} -> ${next.game}`);
        return;
      }
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

    const step = this.planner.tick();
    if (!step) {
      // Planner finished or failed
      const st = this.planner.status();
      if (st.failed) {
        this._active = false;
        this.log(`controller: plan failed (${st.error})`);
        this.rotation?.playNow?.();
      }
      if (st.done) {
        this._active = false;
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
    this.planner.settle(result);

    // Check post-settle state
    const st = this.planner.status();
    if (st.failed) {
      this._active = false;
      this.log(`controller: plan failed (${st.error})`);
      this.rotation?.playNow?.();
      return;
    }

    // Only count completion when await_result succeeded
    if (step.kind === 'await_result' && result && result.ok) {
      this._completed += 1;
      if (this.rotation && typeof this.rotation.next === 'function') {
        this.rotation.arm();
      }
    }

    if (st.done) {
      this._active = false;
    }
  }

  async _executeStep(step) {
    switch (step.kind) {
      case 'enter_game': {
        const phase = this.world?.get?.()?.phase;
        if (phase === 'playing') {
          this.log('controller: already in a round — play this table, do not swap');
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

  async _playTable(step) {
    this._snapshot = this._captureSnapshot();
    const gameName = this.planner.status().goal?.game;
    const adapter = byName(gameName);
    if (adapter?.pick === 'tile' && typeof this.game?.clickMinesTile === 'function') {
      const tile = await this.game.clickMinesTile();
      if (tile?.ok) {
        await this._snapPlay(tile.text || 'tile');
        return { ok: true, detail: tile };
      }
    }
    if (adapter?.pick === 'number' && typeof this.game?.clickText === 'function') {
      const spots = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
        .sort(() => Math.random() - 0.5)
        .slice(0, 2 + Math.floor(Math.random() * 3));
      for (const n of spots) {
        const spot = await this.game.clickText(String(n)).catch(() => null);
        if (spot?.ok) {
          await this._snapPlay(String(n));
          break;
        }
      }
    }
    const worldState = this.world?.get?.() || {};
    const controls = Array.isArray(worldState.controls) ? worldState.controls : [];
    const phase = worldState.phase;
    if (!this.variety || this.variety.game !== gameName || (phase === 'idle' && this.variety.done)) {
      this.variety = { game: gameName, chips: varietyClicks(gameName, controls), at: 0, done: false };
    }
    if (phase === 'idle' && this.variety.at < this.variety.chips.length && typeof this.game?.clickText === 'function') {
      const chip = this.variety.chips[this.variety.at++];
      const hit = await this.game.clickText(chip).catch(() => null);
      if (hit?.ok) {
        this.log(`controller: variety "${chip}"`);
        await this._snapPlay(chip);
        return { ok: true, detail: hit };
      }
    }
    if (phase === 'idle') this.variety.done = true;
    const varied = varietyPlay(gameName, controls);
    let labels = preferInRoundLabels(
      [varied, ...(adapter?.startLabels || []), step.args?.label]
        .filter(Boolean)
        .filter((v, i, a) => a.findIndex((x) => String(x).toLowerCase() === String(v).toLowerCase()) === i),
      { phase, controls },
    );
    if (controls.length) {
      const present = labels.filter((label) =>
        controls.some((c) => labelMatchesPlay(label, c)));
      if (present.length) labels = present;
    }
    const prev = this.game?.lastPointer;
    const prevText = String(prev?.text || '').toLowerCase();
    const stuck = prev?.at && Date.now() - prev.at < 8000
      && /^(random pick|cash out|higher|lower|hit|stand)$/.test(prevText);
    if (stuck) {
      const start = labels.filter((l) => /^(bet|go|roll|deal|spin|play|start)$/i.test(String(l)));
      const rest = labels.filter((l) => !start.includes(l) && String(l).toLowerCase() !== prevText);
      labels = [...start, ...rest];
    }
    let last = { ok: false, error: 'no play control' };
    for (const label of labels) {
      if (typeof this.game?.clickText === 'function') {
        const raw = await this.game.clickText(label).catch(() => null);
        if (raw?.ok) {
          await this._snapPlay(raw.text || label);
          return { ok: true, detail: raw };
        }
        last = { ok: false, error: raw?.error || 'not found' };
        continue;
      }
      last = await this.tools.run('click', { label });
      if (last?.ok) {
        await this._snapPlay(last.text || label);
        return last;
      }
    }
    return last;
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
