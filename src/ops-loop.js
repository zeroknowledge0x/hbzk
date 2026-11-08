// Owner ops loop: keep the Kick stream alive without a human in chat.
// Not Hermes. One timer in-process. Capture death is handled first, without an LLM.
import fs from 'node:fs';
import path from 'node:path';
import { isFrameBlack, parseOps } from './capture-health.js';

export class OpsLoop {
  constructor({ game, brain, rotation, controller, speak, log, world, now } = {}) {
    this.game = game;
    this.brain = brain;
    this.rotation = rotation;
    this.controller = controller;
    this.speak = speak || (() => {});
    this.log = log || (() => {});
    this.world = world;
    this.now = now || (() => Date.now());
    this.turns = [];
    this.blackStreak = 0;
    this.timer = null;
    this.llmTimer = null;
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.watchCapture().catch(() => {}); }, 2000);
    this.timer.unref?.();
    this.llmTimer = setInterval(() => { this.askOwner().catch(() => {}); }, 90000);
    this.llmTimer.unref?.();
    this.log('ops: owner loop on (capture 2s, prompt 90s)');
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
      black: isFrameBlack(this.game?.frame),
      frameAgeMs: this.game?.frameAgeMs ?? -1,
      lastError: this.game?.lastError || null,
      lastClick: this.game?.lastPointer?.text || null,
      lastClickAgeMs: this.game?.lastPointer?.at ? this.now() - this.game.lastPointer.at : null,
    };
  }

  async askOwner() {
    if (this.busy) return;
    if (!this.brain || this.brain.offline) return;
    this.busy = true;
    try {
      const report = this.report();
      if (!report.black && report.lastClickAgeMs != null && report.lastClickAgeMs < 45000) return;
      const user = `OWNER: Keep Hubie live. State=${JSON.stringify(report)}. JSON only.`;
      this.turns.push({ role: 'user', content: user });
      if (this.turns.length > 16) {
        const summary = this.turns.slice(0, -4).map((t) => t.content).join(' | ').slice(0, 500);
        this.turns = [{ role: 'user', content: `SUMMARY: ${summary}` }, ...this.turns.slice(-4)];
        this.log('ops: context compacted');
      }
      const text = await this.brain.say('agent', {
        observation: { owner: true, ...report, history: this.turns.slice(-6) },
      });
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
  }

  #write(op, report) {
    try {
      fs.mkdirSync('logs', { recursive: true });
      fs.appendFileSync(path.join('logs', 'ops-loop.jsonl'), `${JSON.stringify({ at: this.now(), op, report })}\n`);
    } catch { /* ignore */ }
  }
}
