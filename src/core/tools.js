// Tools: the only module that touches the game page. Planner, host and chat all go
// through run(), so there is exactly one place where an action can be half-applied and
// exactly one place that records what happened.
//
// SAFETY MODEL (v2):
//  - Zero-stake policy: set_stake rejects any value != 0. This is non-negotiable for
//    live/demo play. The old optimistic-nonzero path is removed; existing unit tests
//    that assert set_stake(5) succeeds are documented as unsafe and will not pass.
//  - No optimistic world writes: after a setter, the world is updated ONLY with the
//    value observed from game.readSettings() or the verified API envelope. The requested
//    value is never written without confirmation.
//  - Verified API contract: GameFeed setters return {ok, observed, verified, settings}.
//    We accept only when verified===true AND observed matches the requested value.
//    Missing readback or mismatch is a hard failure.
//  - Serialized run(): a promise queue ensures this.current cannot race between
//    concurrent callers. post() always sees the correct current.args.
//  - change_game: exact pathname match /games/${slug} from byName registry. No substring.
//    When getReport() exists, stale world is never used as fallback.
//  - Click safety: round actions require known zero stake; a failed/unknown fresh
//    readback never falls back to cached world state. Money/stake modifiers are denied.

const MAX_TEXT = 400;
const MAX_STAKE = 1e9;
const MAX_MULTIPLIER = 1000;
const SETTLED = new Set(['idle', 'betting', 'result', 'unknown']);

const DANGEROUS_LABELS = new Set(['bet', 'roll', 'deal', 'spin', 'play', 'cash out', 'go', 'start', 'double', 'split']);
const BLOCKED_CLICKS = /\b(wallet|deposit|withdraw|half|halve|min(?:imum)?|max(?:imum)?|stake|wager|amount)\b|\bdouble\s+bet\b|^(?:1\s*\/\s*2|½|2\s*[×x])(?:\s*bet)?$/i;

import { byName } from './adapters/index.js';

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v) => {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const same = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;
const fold = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const snap = (world) => (world && typeof world.get === 'function' ? world.get() : world || {});
const has = (list, label) =>
  Array.isArray(list) && list.some((c) => String(c).toLowerCase() === String(label).toLowerCase());

function slugFor(name) { return byName(name)?.slug || null; }

function methodOf(game, names) {
  if (!game) return null;
  for (const name of names) if (typeof game[name] === 'function') return { fn: game[name], name };
  return null;
}

async function callGame(self, names, arg) {
  const hit = methodOf(self.game, names);
  if (!hit) return { ok: false, error: `no ${names[0]} on game` };
  let out;
  try {
    out = await hit.fn.call(self.game, arg);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (out === undefined || out === null) return { ok: false, error: `${hit.name} returned no result` };
  if (out && out.ok === false) return { ok: false, error: out.error || out.reason || `${hit.name} failed` };
  return { ok: true, detail: out && typeof out === 'object' ? out : {} };
}

// Verified API helper: expects {ok, observed, verified, settings} envelope.
// Accept only if verified===true and observed is present.
async function callGameVerified(self, names, arg) {
  const hit = methodOf(self.game, names);
  if (!hit) return { ok: false, error: `no ${names[0]} on game` };
  let out;
  try {
    out = await hit.fn.call(self.game, arg);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (out === undefined || out === null) return { ok: false, error: `${hit.name} returned no result` };
  if (out.ok === false) return { ok: false, error: out.error || out.reason || `${hit.name} failed` };
  if (out.verified !== true) return { ok: false, error: `${hit.name} not verified` };
  if (out.observed === undefined || out.observed === null) return { ok: false, error: `${hit.name} missing readback` };
  return { ok: true, detail: out };
}

async function readSettings(self) {
  if (!self.game || typeof self.game.readSettings !== 'function') return null;
  try {
    const s = await self.game.readSettings();
    if (s === undefined || s === null) return null;
    return s;
  } catch {
    return null;
  }
}

const TABLE = {
  click: {
    pre(world, args) {
      const label = str(args.label);
      if (!label) return 'label required';
      if (!methodOf(this.game, ['clickText', 'clickInGame'])) return 'game has no clickText';

      const s = snap(world);
      const controls = Array.isArray(s.controls) ? s.controls : [];
      if (controls.length && !has(controls, label)) return `"${label}" is not on the table`;

      if (BLOCKED_CLICKS.test(label)) return `money/stake modifier "${label}" blocked`;
      // Click safety for dangerous labels
      const foldedLabel = fold(label);
      const isDangerous = [...DANGEROUS_LABELS].some((dl) => fold(dl) === foldedLabel);
      if (isDangerous) {
        // If readSettings exists, we will verify at exec time.
        // If it does not exist, check world stake === 0 (fail-closed).
        if (typeof this.game?.readSettings !== 'function') {
          const stake = num(s.stake);
          if (stake !== 0 || (typeof s.stake === 'string' && !s.stake.trim())) {
            return `dangerous label "${label}" blocked: stake is ${stake}, must be 0`;
          }
        }
      }
      return true;
    },
    async exec(args) {
      const label = str(args.label);

      // Dangerous label: force zero-stake readback if readSettings available
      const foldedLabel = fold(label);
      const isDangerous = [...DANGEROUS_LABELS].some((dl) => fold(dl) === foldedLabel);
      if (isDangerous && typeof this.game?.readSettings === 'function') {
        const settings = await readSettings(this);
        if (settings === null || settings.ok === false) {
          return { ok: false, error: `readSettings unavailable for dangerous label "${label}"` };
        }
        const observedStake = num(settings.stake);
        if (observedStake !== 0 || (typeof settings.stake === 'string' && !settings.stake.trim())) {
          return { ok: false, error: `dangerous label "${label}" blocked: observed stake ${observedStake}` };
        }

      }

      let out = await callGame(this, ['clickText', 'clickInGame'], label);
      for (let i = 0; i < 5 && !out.ok; i += 1) {
        await new Promise((r) => setTimeout(r, 550));
        out = await callGame(this, ['clickText', 'clickInGame'], label);
      }
      if (!out.ok) return out;
      return { ok: true, detail: { clicked: out.detail.clicked || out.detail.text || label } };
    },
    post(world, before) {
      const s = snap(world);
      if (Number(s.version) > Number(before.version)) return true;
      if (s.phase && s.phase !== 'unknown') return true;
      if (Array.isArray(s.controls) && s.controls.length) return true;
      return 'page looks dead after the click';
    },
  },

  set_stake: {
    pre(world, args) {
      const value = num(args.value);
      // Zero-stake policy: reject any value != 0. 0 is explicitly allowed.
      if (value === null) return 'stake must be a number';
      if (value !== 0) return `zero-stake policy: stake must be 0, got ${value}`;
      if (!methodOf(this.game, ['setStake', 'setBetAmount', 'setStakeValue'])) return 'game has no stake input';
      const s = snap(world);
      if (!SETTLED.has(s.phase)) return `phase ${s.phase}: cannot change stake mid-round`;
      return true;
    },
    async exec(args) {
      const value = num(args.value);
      const out = await callGameVerified(this, ['setStake', 'setBetAmount', 'setStakeValue'], value);
      if (!out.ok) return out;

      // Verify observed matches requested
      if (!same(out.detail.observed, value)) {
        return { ok: false, error: `stake mismatch: requested ${value}, observed ${out.detail.observed}` };
      }

      // Read fresh settings for world update
      const settings = await readSettings(this);
      const observedStake = settings ? num(settings.stake) : out.detail.observed;
      if (observedStake === null) {
        return { ok: false, error: 'cannot confirm stake after set' };
      }
      if (observedStake !== 0) {
        return { ok: false, error: `zero-stake policy: observed stake is ${observedStake}` };
      }

      // Update world ONLY with observed value
      this.world?.set?.('stake', observedStake);
      return { ok: true, detail: { stake: observedStake } };
    },
    post(world) {
      const s = snap(world);
      return same(s.stake, this.current.args.value) ? true : `world stake is ${s.stake}`;
    },
    strict: true,
  },

  set_multiplier: {
    pre(world, args) {
      const value = num(args.value);
      if (value === null || value <= 1 || value > MAX_MULTIPLIER) return 'multiplier must be > 1';
      if (!methodOf(this.game, ['setMultiplier', 'setPayout'])) return 'game has no multiplier input';
      const s = snap(world);
      if (!SETTLED.has(s.phase)) return `phase ${s.phase}: cannot change payout mid-round`;
      return true;
    },
    async exec(args) {
      const value = num(args.value);
      const out = await callGameVerified(this, ['setMultiplier', 'setPayout'], value);
      if (!out.ok) return out;

      if (!same(out.detail.observed, value)) {
        return { ok: false, error: `multiplier mismatch: requested ${value}, observed ${out.detail.observed}` };
      }

      const settings = await readSettings(this);
      const observedMultiplier = settings ? num(settings.multiplier) : out.detail.observed;
      if (observedMultiplier === null) {
        return { ok: false, error: 'cannot confirm multiplier after set' };
      }
      if (!same(observedMultiplier, value)) {
        return { ok: false, error: `multiplier mismatch on readback: ${observedMultiplier}` };
      }

      this.world?.set?.('multiplier', observedMultiplier);
      return { ok: true, detail: { multiplier: observedMultiplier } };
    },
    post(world) {
      const s = snap(world);
      return same(s.multiplier, this.current.args.value) ? true : `world multiplier is ${s.multiplier}`;
    },
    strict: true,
  },

  set_win_chance: {
    pre(world, args) {
      const value = num(args.value);
      if (value === null || value < 1 || value > 99) return 'win chance must be 1..99';
      if (!methodOf(this.game, ['setWinChance', 'setChance'])) return 'game has no win-chance input';
      const s = snap(world);
      if (!SETTLED.has(s.phase)) return `phase ${s.phase}: cannot change win chance mid-round`;
      return true;
    },
    async exec(args) {
      const value = num(args.value);
      const out = await callGameVerified(this, ['setWinChance', 'setChance'], value);
      if (!out.ok) return out;

      if (!same(out.detail.observed, value)) {
        return { ok: false, error: `win chance mismatch: requested ${value}, observed ${out.detail.observed}` };
      }

      const settings = await readSettings(this);
      const observedChance = settings ? num(settings.winChance) : out.detail.observed;
      if (observedChance === null) {
        return { ok: false, error: 'cannot confirm win chance after set' };
      }
      if (!same(observedChance, value)) {
        return { ok: false, error: `win chance mismatch on readback: ${observedChance}` };
      }

      this.world?.set?.('winChance', observedChance);
      return { ok: true, detail: { winChance: observedChance } };
    },
    post(world) {
      const s = snap(world);
      return same(s.winChance, this.current.args.value) ? true : `world win chance is ${s.winChance}`;
    },
    strict: true,
  },

  choose_tile: {
    pre(world, args) {
      const n = num(args.n);
      if (n === null || !Number.isInteger(n) || n < 1 || n > 25) return 'tile must be an integer 1..25';
      const s = snap(world);
      const tiles = (Array.isArray(s.controls) ? s.controls : []).some((c) => /^tile\s*\d+$/i.test(String(c)));
      if (s.phase !== 'playing' && !tiles) return 'no tiles on the table';
      return true;
    },
    async exec(args) {
      const n = num(args.n);
      const direct = methodOf(this.game, ['chooseTile', 'pickTile']);
      if (direct) {
        const out = await callGame(this, [direct.name], n);
        if (!out.ok) return out;
        return { ok: true, detail: { tile: n } };
      }
      const out = await callGame(this, ['clickText', 'clickInGame'], `Tile ${n}`);
      if (!out.ok) return out;
      return { ok: true, detail: { tile: n, clicked: out.detail.clicked || `Tile ${n}` } };
    },
    post(world, before) {
      const s = snap(world);
      if (Number(s.version) > Number(before.version)) return true;
      if (s.phase === 'playing') return true;
      return 'no table change after the tile';
    },
  },

  change_game: {
    pre(world, args) {
      const name = str(args.game);
      if (!name) return 'game required';
      if (!methodOf(this.game, ['openGameByCard', 'openGame'])) return 'game has no lobby';
      const s = snap(world);
      if (s.phase === 'playing') return 'cannot change game mid-round';
      return true;
    },
    async exec(args) {
      const name = str(args.game);
      const slug = slugFor(name);
      if (!slug) return { ok: false, error: 'Unknown game' };
      const expectedPath = `/games/${slug}`;

      const canReadReport = typeof this.game?.getReport === 'function';

      if (canReadReport) {
        const live = this.game.getReport();
        if (live && live.url) {
          let path;
          try {
            path = new URL(live.url, 'https://housebets.com').pathname;
          } catch {
            path = '';
          }
          // Exact pathname match, no substring
          if (path === expectedPath) {
            // Positive onTarget: write world game
            this.world?.set?.('game', name);
            return { ok: true, detail: { game: name, changed: false, url: live.url } };
          }
        }
        // Report exists but does not match: do NOT fallback to stale world.
        // Proceed to open the game.
      } else {
        // No getReport: trust world as fallback (fake game / test double)
        if (fold(snap(this.world).game) === fold(name)) {
          return { ok: true, detail: { game: name, changed: false } };
        }
      }

      let out = await callGame(this, ['openGameByCard', 'openGame'], name);
      if (!out.ok && typeof this.game?.navigate === 'function') {
        await this.game.navigate('https://www.housebets.com/casino').catch(() => {});
        await new Promise((r) => setTimeout(r, 2500));
        out = await callGame(this, ['openGameByCard', 'openGame'], name);
      }
      if (!out.ok) return out;

      // If no getReport (fake game), trust explicit ok:true
      if (!canReadReport) {
        this.world?.set?.('game', name);
        return { ok: true, detail: { game: name, url: null } };
      }

      // Verify via report: exact pathname match, poll up to 5s
      let landed = null;
      for (let i = 0; i < 10; i += 1) {
        const rep = this.game.getReport();
        if (rep && rep.url) {
          let path;
          try {
            path = new URL(rep.url, 'https://housebets.com').pathname;
          } catch {
            path = '';
          }
          if (path === expectedPath) {
            landed = rep.url;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      if (!landed) {
        return { ok: false, error: `${name} did not open (expected path ${expectedPath})` };
      }

      this.world?.set?.('game', name);
      return { ok: true, detail: { game: name, url: landed } };
    },
    post() { return true; },
    strict: true,
  },

  say: {
    pre(world, args) {
      const text = str(args.text);
      if (!text) return 'text required';
      if (text.length > MAX_TEXT) return `text longer than ${MAX_TEXT}`;
      return true;
    },
    async exec(args) {
      const text = str(args.text);
      const kind = str(args.kind) || 'say';
      this.bus?.emit('speak', { text, kind });
      this.lastSpoken = text;
      return { ok: true, detail: { text, kind } };
    },
    post() {
      return this.lastSpoken === str(this.current.args.text) ? true : 'speech not dispatched';
    },
  },
};

export const TOOL_NAMES = Object.freeze(Object.keys(TABLE));

export class Tools {
  constructor({ game = null, world = null, bus = null, log = () => {} } = {}) {
    this.game = game;
    this.world = world;
    this.bus = bus;
    this.log = log;
    this.current = null;
    this.lastSpoken = null;
    // Promise queue for serialization: ensures this.current is not raced.
    this._queue = Promise.resolve();
  }

  get names() {
    return TOOL_NAMES.slice();
  }

  has(name) {
    return Object.prototype.hasOwnProperty.call(TABLE, name);
  }

  async run(name, args = {}) {
    // Serialize: chain onto the queue so concurrent calls do not race this.current.
    const prev = this._queue;
    let release;
    this._queue = new Promise((r) => { release = r; });
    await prev;
    try {
      return await this._runInner(name, args);
    } finally {
      release();
    }
  }

  async _runInner(name, args) {
    const t0 = Date.now();
    const call = args && typeof args === 'object' ? args : {};
    const spec = TABLE[name];
    if (!spec) return this.#finish(name, call, t0, { ok: false, error: `unknown tool: ${name}` });
    this.current = { name, args: call };

    let pre;
    try {
      pre = spec.pre.call(this, this.world, call);
    } catch (err) {
      pre = `pre threw: ${err.message}`;
    }
    if (pre !== true) return this.#finish(name, call, t0, { ok: false, error: String(pre || 'precondition failed') });

    const before = snap(this.world);
    let out;
    try {
      out = await spec.exec.call(this, call);
    } catch (err) {
      out = { ok: false, error: err.message };
    }
    if (!out || out.ok !== true) {
      return this.#finish(name, call, t0, { ok: false, error: (out && out.error) || 'failed' });
    }

    let post;
    try {
      post = spec.post.call(this, this.world, before);
    } catch (err) {
      post = `post threw: ${err.message}`;
    }
    if (post !== true) {
      const strict = spec.strict && typeof this.world?.set === 'function';
      if (strict) return this.#finish(name, call, t0, { ok: false, error: `post: ${post}` });
      this.log(`tools: ${name} post unconfirmed (${post})`);
      return this.#finish(name, call, t0, { ok: true, detail: out.detail, confirmed: false });
    }
    return this.#finish(name, call, t0, { ok: true, detail: out.detail });
  }

  #finish(tool, args, t0, out) {
    const ms = Date.now() - t0;
    const res = { ok: out.ok === true, ms };
    if (!res.ok) res.error = String(out.error || 'failed');
    if (out.detail !== undefined) res.detail = out.detail;
    if (out.confirmed === false) res.confirmed = false;
    try {
      this.bus?.emit('action', { tool, args, ok: res.ok, ms });
    } catch (err) {
      this.log(`tools: action event failed (${err.message})`);
    }
    if (!res.ok) this.log(`tools: ${tool} failed: ${res.error}`);
    return res;
  }
}
