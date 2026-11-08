// Play queue: viewer game requests, FIFO, plus the tiny parser that recognises them.
import { byName } from './core/adapters/index.js';

export const GAMES = ['Dice', 'Mines', 'Limbo', 'Plinko', 'Blackjack', 'Keno', 'Wheel', 'Hilo', 'Dragon Tower', 'Tower', 'Max Win', "Hubie's Road"];

export const DEFAULT_PLAYABLE = [
  'Dice', 'Mines', 'Plinko', 'Keno', 'Wheel', 'Limbo', 'Max Win', 'Dragon Tower', 'Hilo', 'Blackjack', "Hubie's Road",
];

const GAME_WORD = /\b(dice|mines?|crash|limbo|plinko|blackjack|black\s*jack|keno|wheel|hilo|tower|max\s*win|hubie'?s?\s*road)\b/i;
// "other/another/random/ganti/beda/next/change/pindah game(s)" with no named Original
// -> random pick. "change the game" and plural "switch games" are the common chat forms.
const OTHER_GAME = /\b(?:other|another|ganti|switch|random|beda|next|change|pindah)\s+(?:the\s+)?games?\b/i;
// Payout/win-chance tweaks belong to in-game tuning, never a game switch, so this runs
// first: "change target", "change po" and bare "po" must never turn into a random game.
const TUNE_WORD = /\b(po|payout|win chance|(?:change|set|raise|lower)\s+(?:po|payout|target|multiplier))\b/i;
const INTENT = /\b(play|queue|switch|change|load|open|start|run|try|put|show|next|please|lets|let's|ganti|pindah|main|anu|ke)\b/i;

const NORMAL = {
  dice: 'Dice',
  mine: 'Mines',
  mines: 'Mines',
  crash: 'Crash',
  limbo: 'Limbo',
  plinko: 'Plinko',
  blackjack: 'Blackjack',
  keno: 'Keno',
  wheel: 'Wheel',
  hilo: 'Hilo',
  tower: 'Dragon Tower',
  dragontower: 'Dragon Tower',
  maxwin: 'Max Win',
  hubiesroad: "Hubie's Road",
  'hubie\'sroad': "Hubie's Road",
};

export function normalizeGame(word) {
  const key = String(word || '').toLowerCase().replace(/\s+/g, '');
  // Housebets Crash slug 404s (housegames-crash) and unoriginals-crash is the dead legacy path.
  // Map chat "crash" to Limbo so the queue never opens a broken URL.
  if (key === 'crash') return 'Limbo';
  return NORMAL[key] || null;
}

// "play mines", "crash next", "switch to plinko", or just "dice" -> canonical game.
// "other/another/random/ganti/beda/next game" with no named Original -> '__random__'.
export function parseGameRequest(text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (!line || line.length > 200) return null;
  // "change payout" / "win chance" / "po" tune the current game, not a switch.
  if (TUNE_WORD.test(line)) return null;
  const match = line.match(GAME_WORD);
  if (match) {
    const game = normalizeGame(match[0]);
    if (!game) return null;
    if (INTENT.test(line)) return game;
    // A short line led by the game name ("dice", "crash!!") is still a request.
    if (line.length <= 24 && line.toLowerCase().startsWith(match[0].toLowerCase())) return game;
    return null;
  }
  // No named Original: any "other game" phrasing asks for a random pick.
  if (OTHER_GAME.test(line)) return '__random__';
  return null;
}

// Owner policy: rotate every House Original at stake 0 and click its own controls.
// Dice is the only table proven to publish a round result at zero; the others still
// get Bet / Hit / tiles so the stream looks like play. Read at call time.
export function playableList() {
  return String(process.env.PLAYABLE_GAMES || DEFAULT_PLAYABLE.join(',')).split(',').map((x) => x.trim()).filter(Boolean);
}

export const PLAYABLE = DEFAULT_PLAYABLE;

export function isPlayable(name) {
  const want = (byName(name)?.name || name || '').toLowerCase();
  if (!want) return false;
  return playableList().some((p) => (byName(p)?.name || p).toLowerCase() === want);
}

export function pickRandomGame(exclude) {
  const ex = (byName(exclude)?.name || exclude || '').toLowerCase();
  const pool = playableList().filter((g) => (byName(g)?.name || g).toLowerCase() !== ex);
  const list = pool.length ? pool : playableList();
  return list[Math.floor(Math.random() * list.length)];
}

export class PlayQueue {
  constructor({ max = 20 } = {}) {
    this.items = [];
    this.max = Math.max(1, Number(max) || 20);
  }

  enqueue({ name, game, at = Date.now(), from = 'chat', front = false } = {}) {
    const g = normalizeGame(game) || (GAMES.includes(game) ? game : null);
    if (!name || !g) return null;
    const who = String(name).slice(0, 40);
    // One pending request per viewer — spam "dice/hilo/keno" was hopping every few seconds.
    // Never rewrite the head item: it may already be mid-navigate / on the table.
    if (from === 'chat') {
      const i = this.items.findIndex((x) => x.name.toLowerCase() === who.toLowerCase());
      // One pending slot per viewer. A new game replaces the old one, including the
      // head, so "limbo" after "dice" actually switches instead of sticking.
      if (i === 0) {
        if (this.items[0].game !== g) this.items[0] = { name: who, game: g, at, from };
        return this.items[0];
      }
      if (i > 0) {
        this.items[i] = { name: who, game: g, at, from };
        return this.items[i];
      }
    }
    const item = { name: who, game: g, at, from };
    if (front) this.items.unshift(item);
    else this.items.push(item);
    if (this.items.length > this.max) {
      if (front) this.items.length = this.max;
      else this.items.splice(0, this.items.length - this.max);
    }
    return item;
  }

  peek() { return this.items[0] || null; }
  shift() { return this.items.shift() || null; }
  clear() { this.items = []; }
  get size() { return this.items.length; }
  get length() { return this.items.length; }
  toJSON() { return this.items.slice(); }
}
