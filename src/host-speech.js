// Host-only speech clock. The agent remains the sole playback/priority owner.
export class HostSpeech {
  constructor({ brain, enqueue, context = () => ({}), now = Date.now,
    random = Math.random, timers = { setTimeout, clearTimeout } }) {
    Object.assign(this, { brain, enqueue, context, now, random, timers });
    this.running = false;
    this.timer = null;
    this.seenOutcomes = new Set();
    this.recentIdle = [];
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.arm();
  }

  stop() {
    this.running = false;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  async observeOutcome(outcome) {
    // Fail closed: ordinary DOM results/targets and global live-bet rows do not
    // establish either local ownership or a settled payout multiplier.
    if (!this.running || outcome?.source !== 'local-round' || outcome.confirmed !== true
      || outcome.local !== true || outcome.won !== true) return false;
    const payout = Number(outcome.payoutMultiplier);
    if (!Number.isFinite(payout) || payout < 3) return false;
    const context = this.context();
    const identity = outcome.eventId ?? outcome.roundId;
    // Never synthesize identity from poll time, completed counter, or DOM absence.
    const key = JSON.stringify([context.game || '', identity == null ? 'value' : 'id',
      identity == null ? payout : String(identity)]);
    if (this.seenOutcomes.has(key)) return false;
    this.seenOutcomes.add(key); // reserve before generation, including concurrent polls
    const eventAt = this.now();
    try {
      const shaped = await this.brain.say('win', {
        ...context, detail: `Confirmed local round paid ${payout}x`,
      });
      if (!this.running || !shaped?.text) return false;
      return this.enqueue(shaped.text, 'react:win', { eventAt });
    } catch { return false; }
  }

  arm() {
    if (!this.running) return;
    const delay = 300000 + Math.floor(this.random() * 600000);
    this.timer = this.timers.setTimeout(async () => {
      this.timer = null;
      try {
        const shaped = await this.brain.say('idle', { ...this.context(), force: true });
        const text = String(shaped?.text || '').replace(/\s+/g, ' ').trim();
        const key = text.toLowerCase();
        if (this.running && text && !shaped.fallback && !/\bzero[\s-]+locked\b/i.test(text)
          && !this.recentIdle.includes(key)) {
          if (this.enqueue(text, 'idle') !== false) {
            this.recentIdle.push(key);
            if (this.recentIdle.length > 5) this.recentIdle.shift();
          }
        }
      } catch {
        // No fixed fallback loop: the next random slot can try a fresh thought.
      } finally {
        this.arm();
      }
    }, delay);
    this.timer?.unref?.();
  }
}
