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
    this.captureRecovery = null;
    this.captureStage = 'rearm';
    this.lastCaptureReloadAt = null;
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
    if (this.captureRecovery) return;
    const img = this.game?.frame;
    const age = Number(this.game?.frameAgeMs);
    const black = isFrameBlack(img);
    const stale = !Number.isFinite(age) || age < 0 || age > 2500;
    if (black || stale) this.blackStreak += 1;
    else {
      this.blackStreak = 0;
      this.captureStage = 'rearm';
    }
    if (this.blackStreak < 5) return;
    this.blackStreak = 0;
    await this.#recoverCapture();
  }

  #recoverCapture() {
    if (this.captureRecovery) return this.captureRecovery;
    const stage = this.captureStage;
    if (stage === 'reload' && this.lastCaptureReloadAt != null
      && this.now() - this.lastCaptureReloadAt < 60000) return Promise.resolve({ ok: false, error: 'cooldown' });
    if (this.game) this.game.captureRecoveryInFlight = true;
    this.captureRecovery = Promise.resolve().then(async () => {
      this.log(`ops: capture unhealthy — ${stage}`);
      let result;
      if (stage === 'reload') {
        this.lastCaptureReloadAt = this.now();
        const after = Date.now();
        const reload = await this.game?.reload?.(); // Same page, never a table cycle.
        // Healthy pixels cannot override a failed source-table verification.
        const capture = await this.game?.waitForCapture?.({ after, timeoutMs: 8000 });
        result = { ok: reload?.ok === true && capture?.ok === true };
      } else {
        this.captureStage = 'reload';
        result = await this.game?.reviveCapture?.();
      }
      const age = Number(this.game?.frameAgeMs);
      const healthy = result?.ok === true && Number.isFinite(age) && age >= 0 && age <= 2500
        && !isFrameBlack(this.game?.frame);
      if (healthy) {
        this.captureStage = 'rearm';
        this.log(`ops: capture restored (verified ${stage})`);
      } else this.log(`ops: capture still unhealthy after ${stage}`);
      return { ok: healthy, via: stage };
    }).catch((err) => {
      this.log(`ops: capture recovery failed (${err?.message || err})`);
      return { ok: false, error: String(err?.message || err) };
    }).finally(() => {
      if (this.game) this.game.captureRecoveryInFlight = false;
      this.captureRecovery = null;
    });
    return this.captureRecovery;
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
      await this.#recoverCapture();
      return;
    }
    if (d === 'play_now') {
      // "Play now" means start a round on the table that is open. Using the rotation for it changed
      // the table instead, and an idle-looking host rotated every few minutes instead of holding the
      // designed 10–60 min dwell (measured: a rotation 4.4 min after boot, caused by `do=play_now`).
      if (typeof this.controller?.playNowTable === 'function') this.controller.playNowTable();
      return;
    }
    if (d === 'cycle_table') {
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
