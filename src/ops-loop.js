// Owner ops loop: keep the Kick stream alive without a human in chat.
// Not Hermes. One timer in-process. Capture death is handled first, without an LLM.
import fs from 'node:fs';
import path from 'node:path';
import { isFrameBlack, parseOps, OWNER_MS, CAPTURE_MS } from './capture-health.js';
import { matchPlayClick } from './core/play-labels.js';

export class OpsLoop {
  constructor({ game, brain, rotation, controller, speak, log, world, now, chat } = {}) {
    this.game = game;
    this.brain = brain;
    this.rotation = rotation;
    this.controller = controller;
    this.speak = speak || (() => {});
    this.log = log || (() => {});
    this.world = world;
    this.now = now || (() => Date.now());
    this.chat = typeof chat === 'function' ? chat : () => [];
    this.turns = [];
    this.blackStreak = 0;
    this.timer = null;
    this.llmTimer = null;
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.watchCapture().catch(() => {}); }, CAPTURE_MS);
    this.timer.unref?.();
    this.llmTimer = setInterval(() => { this.askOwner().catch(() => {}); }, OWNER_MS);
    this.llmTimer.unref?.();
    this.log('ops: owner loop on (capture 2s, prompt 5s)');
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.llmTimer);
    this.timer = null;
    this.llmTimer = null;
  }

  async watchCapture() {
    const img = this.game?.frame;
    const age = Number(this.game?.frameAgeMs);
    const black = isFrameBlack(img);
    const stale = age < 0 || age > 2500;
    if (black || stale) this.blackStreak += 1;
    else this.blackStreak = 0;
    if (this.blackStreak < 5) return;
    this.blackStreak = 0;
    this.log(`ops: capture dead (black=${black} age_ms=${age}) — revive`);
    if (typeof this.game?.reviveCapture === 'function') {
      await this.game.reviveCapture();
    }
  }

  report() {
    const w = this.world && typeof this.world.get === 'function' ? this.world.get() : {};
    return {
      game: w.game || null,
      phase: w.phase || null,
      controls: Array.isArray(w.controls) ? w.controls.slice(0, 24) : [],
      black: isFrameBlack(this.game?.frame),
      frameAgeMs: this.game?.frameAgeMs ?? -1,
      lastError: this.game?.lastError || null,
      lastClick: this.game?.lastPointer?.text || null,
      lastClickAgeMs: this.game?.lastPointer?.at ? this.now() - this.game.lastPointer.at : null,
      chat: (this.chat() || []).slice(0, 6),
      active: !!(this.controller && typeof this.controller.status === 'function' && this.controller.status()?.active),
    };
  }

  async askOwner() {
    if (this.busy) return;
    if (!this.brain || this.brain.offline) return;
    this.busy = true;
    try {
      const report = this.report();
      if (!report.black && report.lastClickAgeMs != null && report.lastClickAgeMs < 4000) return;
      const user = `OWNER: Keep Hubie live. State=${JSON.stringify(report)}. Click only a visible play label. JSON only.`;
      this.turns.push({ role: 'user', content: user });
      if (this.turns.length > 16) {
        const summary = this.turns.slice(0, -4).map((t) => t.content).join(' | ').slice(0, 500);
        this.turns = [{ role: 'user', content: `SUMMARY: ${summary}` }, ...this.turns.slice(-4)];
        this.log('ops: context compacted');
      }
      let jpeg = null;
      if (report.black || report.lastClickAgeMs == null || report.lastClickAgeMs > 8000) {
        try { jpeg = await this.game?.captureLowRes?.(); } catch { jpeg = null; }
      }
      const text = await this.brain.say('owner', { report, history: this.turns.slice(-6), jpeg });
      const op = parseOps(text);
      this.turns.push({ role: 'assistant', content: JSON.stringify(op) });
      this.#write(op, report);
      await this.apply(op);
    } catch (err) {
      this.log(`ops: owner skip (${err?.message || err})`);
    } finally {
      this.busy = false;
    }
  }

  async apply(op) {
    const d = op?.do;
    if (!d || d === 'noop') return;
    this.log(`ops: do=${d} why=${op.why || ''}`);
    if (d === 'rearm_capture' && typeof this.game?.reviveCapture === 'function') {
      await this.game.reviveCapture();
      return;
    }
    if (d === 'play_now' || d === 'cycle_table') {
      this.rotation?.playNow?.();
      return;
    }
    if (d === 'speak' && op.say) this.speak(op.say);
    if (d === 'click') {
      if (this.controller && typeof this.controller.status === 'function' && this.controller.status()?.active) {
        this.log('ops: click skipped (controller owns hands)');
        return;
      }
      const w = this.world && typeof this.world.get === 'function' ? this.world.get() : {};
      const label = matchPlayClick(op.click, w.controls);
      if (!label || typeof this.game?.clickText !== 'function') return;
      await this.game.clickText(label);
    }
  }

  #write(op, report) {
    try {
      fs.mkdirSync('logs', { recursive: true });
      fs.appendFileSync(path.join('logs', 'ops-loop.jsonl'), `${JSON.stringify({ at: this.now(), op, report })}\n`);
    } catch { /* ignore */ }
  }
}
