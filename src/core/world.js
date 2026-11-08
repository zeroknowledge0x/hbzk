// World model: the single truth the host reasons about. Perception writes, everything
// else reads. `apply` is monotonic in time so a slow, late perception packet cannot
// rewind the state a planner already acted on.
const EMPTY = {
  game: null,
  round: 0,
  phase: 'unknown',
  balance: null,
  multiplier: null,
  winChance: null,
  stake: null,
  controls: [],
  lastResult: null,
  report: null,
  at: 0,
};

const PHASES = new Set(['idle', 'betting', 'playing', 'result', 'unknown']);

export class World {
  constructor(initial = {}) {
    this.state = { ...EMPTY, ...initial };
    this.version = 0;
  }

  get() {
    return { ...this.state, version: this.version };
  }

  set(key, value) {
    if (!(key in EMPTY)) return this.get();
    this.state[key] = value;
    this.version += 1;
    return this.get();
  }

  apply(patch = {}) {
    const at = Number(patch.at || Date.now());
    if (at < this.state.at) return this.get();
    const next = { ...this.state };
    for (const key of Object.keys(EMPTY)) {
      if (patch[key] === undefined) continue;
      next[key] = patch[key];
    }
    if (Array.isArray(patch.controls)) next.controls = patch.controls.slice(0, 60);
    if (!PHASES.has(next.phase)) next.phase = 'unknown';
    next.at = at;
    this.state = next;
    this.version += 1;
    return this.get();
  }

  can(action) {
    const s = this.state;
    const has = (label) => s.controls.some((c) => String(c).toLowerCase() === String(label).toLowerCase());
    switch (action) {
      case 'bet':
        return s.phase !== 'playing' && (has('Bet') || has('Roll') || has('Deal') || has('Spin'));
      case 'cashout':
        return has('Cash out');
      case 'hit':
        return has('Hit');
      case 'stand':
        return has('Stand');
      case 'higher':
        return has('Higher');
      case 'lower':
        return has('Lower');
      case 'tile':
        return s.controls.filter((c) => /^tile\s*\d+$/i.test(String(c))).length > 0;
      default:
        return false;
    }
  }

  describe() {
    const s = this.state;
    const bits = [];
    if (s.game) bits.push(s.game);
    if (s.round) bits.push(`round ${s.round}`);
    if (s.phase !== 'unknown') bits.push(s.phase);
    if (Number.isFinite(s.balance)) bits.push(`bal ${s.balance}`);
    if (Number.isFinite(s.multiplier)) bits.push(`${s.multiplier}x`);
    return bits.join(' · ');
  }
}
