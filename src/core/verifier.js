// Verifier: the only module allowed to say "it worked". Tools report what the browser
// acknowledged; the verifier waits for the world — and, when present, the game report —
// to actually reflect it. Every wait is bounded, because a hung verifier stalls the whole
// host loop and the stream goes silent.
//
// Perception arrives at roughly 1 Hz, so the predicate is re-evaluated against a fresh
// snapshot every poll instead of being checked once at dispatch. The first check is
// immediate: a round that already started should not cost a poll interval.
const DEFAULTS = { timeout: 4000, poll: 75, reportEvery: 200 };
const MAX_POLL = 100;
const MIN_POLL = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v) => {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const fold = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const snap = (world) => (world && typeof world.get === 'function' ? world.get() : world || {});
const sig = (v) => (v === null || v === undefined ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export class Verifier {
  constructor({ world = null, game = null, log = () => {}, poll = DEFAULTS.poll, stake = null } = {}) {
    this.world = world;
    this.game = game;
    this.log = log;
    // Keep the poll inside 50..100ms: faster burns CPU for no gain at 1 Hz perception,
    // slower overshoots the caller's timeout by more than they bargained for.
    this.poll = Math.min(MAX_POLL, Math.max(MIN_POLL, Number(poll) || DEFAULTS.poll));
    this.stake = num(stake);
    this.report = { at: 0, value: null };
  }

  async waitFor(name, opts = {}) {
    const started = Date.now();
    const timeout = Number.isFinite(Number(opts.timeout)) ? Math.max(0, Number(opts.timeout)) : DEFAULTS.timeout;

    const build = this.#check(name, opts);
    if (typeof build !== 'function') return { ok: false, error: build.error, detail: { name, ms: 0 } };

    const base = opts.before ? structuredClone(opts.before) : this.#snapshot();
    const test = build(base);
    const deadline = started + timeout;

    for (;;) {
      const s = this.#snapshot();
      let hit = null;
      try {
        hit = test(s);
      } catch (err) {
        this.log(`verifier: ${name} check threw (${err.message})`);
        hit = null;
      }
      if (hit) {
        return { ok: true, detail: { name, match: hit, ...this.#detail(s), ms: Date.now() - started } };
      }
      const left = deadline - Date.now();
      if (left <= 0) break;
      // Never sleep past the deadline: the whole point is a hard upper bound.
      await sleep(Math.min(this.poll, left));
    }

    return { ok: false, error: 'timeout', detail: { name, ...this.#detail(base), ms: Date.now() - started } };
  }

  // Returns either a function(base) -> predicate(snapshot) -> matchLabel|null, or a
  // {error} for a check that can never succeed (unknown name, missing target).
  #check(name, opts) {
    const want = opts.value !== undefined ? opts.value : opts.game;
    switch (name) {
      case 'round_started': {
        const basePlaying = base => base.phase === 'playing';
        return (base) => (s) => {
          if (num(s.round) !== null && num(base.round) !== null && num(s.round) !== num(base.round)) return 'round';
          if (s.phase === 'playing' && !basePlaying(base)) return 'phase';
          return null;
        };
      }

      case 'round_result': {
        return (base) => {
          const baseResult = sig(base.lastResult);
          const baseOutcome = sig(base.report && base.report.outcome);
          return (s) => {
            const source = s.report?.outcome?.source || s.lastResult?.source;
            if (source && ['generic', 'handle-row', 'live-bets'].includes(source)) return null;
            if (base.game && s.game && fold(base.game) !== fold(s.game)) return null;
            if (s.report?.url && s.game) {
              const path = new URL(s.report.url, 'https://housebets.com').pathname;
              const tail = path.split('/').pop().replace(/^housegames-/, '');
              if (fold(tail) !== fold(s.game)) return null;
            }
            if (s.lastResult !== null && s.lastResult !== undefined && sig(s.lastResult) !== baseResult) return 'lastResult';
            const outcome = s.report && s.report.outcome;
            if (outcome !== null && outcome !== undefined && sig(outcome) !== baseOutcome) return 'outcome';
            return null;
          };
        };
      }

      case 'bet_zero': {
        const target = num(want !== undefined && want !== null ? want : this.stake);
        return () => (s) => {
          const stake = num(s.stake);
          if (stake === null) return null;
          if (stake === 0) return 'stake_zero';
          if (target !== null && Math.abs(stake - target) < 1e-9) return 'stake_config';
          return null;
        };
      }

      case 'game_is': {
        const target = fold(want);
        if (!target) return { error: 'game_is needs a game' };
        return () => (s) => {
          if (fold(s.game) === target) return 'game';
          if (s.report) {
            const hay = fold(`${s.report.title || ''} ${s.report.url || ''}`);
            if (hay.includes(target)) return 'page';
          }
          return null;
        };
      }

      default:
        return { error: `unknown check: ${name}` };
    }
  }

  #snapshot() {
    let state;
    try {
      state = snap(this.world);
    } catch (err) {
      // A world mid-apply must read as "nothing observed yet", not as a crash inside a
      // wait: the timeout is the correct answer, the exception is not.
      if (!this.worldWarned) this.log(`verifier: world read failed (${err.message})`);
      this.worldWarned = true;
      state = {};
    }
    return { ...state, report: this.#report() || state.report || null };
  }

  // getReport() is synchronous and internally throttled, but it is not free; at 200ms it
  // is still fresh enough to be a tie-breaker when the world snapshot looks stale.
  #report() {
    if (!this.game || typeof this.game.getReport !== 'function') return null;
    const now = Date.now();
    if (this.report.value && now - this.report.at < DEFAULTS.reportEvery) return this.report.value;
    try {
      this.report = { at: now, value: this.game.getReport() };
    } catch (err) {
      this.log(`verifier: getReport failed (${err.message})`);
      this.report = { at: now, value: null };
    }
    return this.report.value;
  }

  #detail(s) {
    return {
      at: num(s.at) || 0,
      phase: s.phase || 'unknown',
      round: num(s.round) || 0,
      game: s.game ?? null,
      stake: s.stake ?? null,
      lastResult: s.lastResult ?? null,
    };
  }
}
