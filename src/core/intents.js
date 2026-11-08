// Chat intent parser for a bilingual (English/Indonesian) stream chat.
// Matching runs on a normalised string: viewers type "Hubie, bet 50 pls!!" and "bet 50"
// with the same meaning, so casing, emoji, @mentions and filler words ("dong", "bang")
// must never decide whether a command works.
// Total by design: chat is untrusted input, so every path returns null instead of throwing.

const GAME_TABLE = [
  ['dice', ['dice', 'dadu']],
  ['mines', ['mines', 'mine']],
  ['plinko', ['plinko']],
  ['keno', ['keno']],
  ['wheel', ['wheel', 'roda', 'wheel of fortune']],
  ['limbo', ['limbo']],
  ['max win', ['max win', 'maxwin']],
  ['dragon tower', ['dragon tower', 'dragon', 'tower']],
  ['hilo', ['hilo', 'hi lo', 'high low']],
  ['blackjack', ['blackjack', 'black jack', 'bj']],
  ["hubie's road", ["hubie's road", 'hubies road', 'hubie s road']],
  ['limbo', ['crash']],
];

/** Canonical game slugs; adapters key their tables off these. */
// Controller contract games; Road is queue-routed until a controller adapter exists.
export const GAMES = [...new Set(GAME_TABLE.map(([game]) => game))].filter(game => game !== "hubie's road");

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Longest alias first so "dragon tower" is not swallowed by "tower".
const GAME_ALIASES = GAME_TABLE
  .flatMap(([game, aliases]) => aliases.map((alias) => ({ game, alias })))
  .sort((a, b) => b.alias.length - a.alias.length);

const GAME_BY_ALIAS = new Map(GAME_ALIASES.map(({ alias, game }) => [alias, game]));
const GAME_MATCHERS = GAME_ALIASES.map(({ alias, game }) => [
  new RegExp(`(?:^| )${escapeRe(alias)}(?: |$)`),
  game,
]);

// NFKD + \p{L} keeps accented and non-latin chat from silently failing to match.
function normalise(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/@[a-z0-9_]+/g, ' ') // a mention is an address, not a command word
    .replace(/\bhubie\b(?![’']?s?\s+(?:s\s+)?road\b)/g, ' ')
    .replace(/[^\p{L}\p{N}%. ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const LEAD_FILLER = /^(?:ayo|ayok|yuk|gas|tolong|pls|plz|please|mohon|coba|eh)\s+/;
const TAIL_FILLER = /\s+(?:please|pls|plz|dong|deh|dunk|donk|ya|yah|sih|bang|kak|min|bro|gan|bos|nih|aja|saja|kk|sis)$/;

// Chat politeness ("main hilo dong") is not meaning. Strip a few layers at most so a
// message made only of filler words becomes empty instead of looping.
function trimFillers(text) {
  let out = text;
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(LEAD_FILLER, '').replace(TAIL_FILLER, '').trim();
    if (!next || next === out) break;
    out = next;
  }
  return out;
}

const SWITCH_VERB = /^(?:switch|change|go|move|jump|play|open|load|enter|start|main|maen|ganti|pindah|ubah|buka|masuk|jalankan|jalanin|pilih)\b/;
const REQUEST_VERB = /^(?:can we|could we|can u|let s|lets|bisa|bisakah|mau|pengen|pingin|gimana kalau|how about|what about)\b/;

function exactGame(text) {
  const core = text.replace(/^(?:game|mode)\s+/, '').replace(/\s+(?:game|mode)$/, '').trim();
  return GAME_BY_ALIAS.get(core) || null;
}

function findGame(text) {
  for (const [re, game] of GAME_MATCHERS) if (re.test(text)) return game;
  return null;
}

function matchGame(text) {
  const exact = exactGame(text);
  if (exact) return exact;
  if (!SWITCH_VERB.test(text) && !REQUEST_VERB.test(text)) return null;
  return findGame(text);
}

// Number syntax shared by the three money knobs. Units are rupiah-sized because the
// chat types "25k" / "100 ribu"; the unit needs a word boundary so "5 kali" stays 5.
const NUM = '(\\d+(?:[.,]\\d+)?)(?:\\s*(k\\b|rb\\b|ribu\\b|jt\\b|juta\\b))?';

const SET_VERB = /^(?:set|setel|ubah|ganti|change|naikin|naikkan|turunin|turunkan|kecilin|kecilkan|raise|atur|make|bikin)\s+/;

const MULTIPLIER_RE = new RegExp(`^(?:multiplier|multi|mult|po|payout|pengali|kali)\\b\\s*(?:to|jadi|ke|nya)?\\s*${NUM}`);
const CHANCE_RE = new RegExp(`^(?:win\\s*chance|winchance|win\\s*rate|winrate|chance|peluang(?:\\s*menang)?|probabilitas|persen|menang|win)\\b\\s*(?:(?:menang|win|chance|to|jadi|ke)\\b\\s*)?${NUM}`);
const BARE_PERCENT_RE = /^(\d+(?:[.,]\d+)?)\s*(?:%|persen|percent)$/;
const STAKE_RE = new RegExp(`^(?:stake|bet\\s*amount|bet|taruhan|pasang(?:in)?)\\b\\s*(?:rp|idr)?\\s*(?:to|jadi|ke)?\\s*${NUM}`);
const TILE_RE = /^(?:tile|pick|pilih|kotak|box|open|buka)\s*(?:(?:the|nomor|number|no|tile|kotak)\s*)*(\d{1,2})(?!\d)/;

// "stop playing" is a halt, but the CONTRACTS table maps bare "stop" to the blackjack
// stand, so the long form has to be recognised first.
const STOP_RE = /^(?:stop\s+(?:playing|it|semua|bot|dulu|ya|now)|berhenti(?:\s+(?:main|dulu|ya|aja))?|setop|udahan|quit|exit|keluar|matikan|pause|jeda)\b/;
const CASHOUT_RE = /^(?:cash\s?out|cashout|withdraw|tarik(?:\s+(?:dana|duit|uang|semua))?|wd|cairkan|ambil\s+semua)\b/;

const STATUS_EXACT = new Set([
  'status', 'stat', 'saldo', 'balance', 'my balance', 'cek saldo', 'cek balance',
  'sisa saldo', 'berapa saldo', 'berapa balance', 'info saldo', 'saldo berapa',
  'modal', 'modal berapa',
]);

const HIGHER = new Set(['higher', 'high', 'naik']);
const LOWER = new Set(['lower', 'low', 'turun']);
const HIT = new Set(['hit', 'hit me', 'kartu', 'tambah kartu', 'minta kartu', 'tambah']);
const STAND = new Set(['stand', 'stay', 'stop', 'tahan', 'cukup', 'selesai']);
const START_EXACT = new Set([
  'roll', 'bet', 'deal', 'spin', 'gas', 'start', 'begin', 'go', 'play', 'main', 'maen',
  'putar', 'lempar', 'bagikan', 'pasang', 'taruhan', 'gaskeun', 'roll it', 'spin it',
]);

function matchStart(text) {
  if (START_EXACT.has(text)) return true;
  if (/^(?:start|new|next|mulai|buka|begin)\s+(?:a\s+|the\s+)?(?:round|game|hand|ronde)\b/.test(text)) return true;
  if (/^(?:round|ronde|hand)\s+(?:baru|new|next)\b/.test(text)) return true;
  if (/^(?:roll|spin|bet|deal|main|gas|putar|lempar)\s+(?:lagi|again|now|sekarang|dulu)\b/.test(text)) return true;
  return false;
}

function toNumber(raw, unit) {
  let text = String(raw).replace(/[.,]$/, '');
  // "1,000" is a thousands separator in English; "0,5" is a decimal in Indonesian.
  if (/^\d{1,3}(?:,\d{3})+$/.test(text)) text = text.replace(/,/g, '');
  else text = text.replace(',', '.');
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  const u = String(unit || '').toLowerCase();
  if (u === 'k' || u === 'rb' || u === 'ribu') return Math.round(n * 1000 * 100) / 100;
  if (u === 'jt' || u === 'juta') return Math.round(n * 1e6 * 100) / 100;
  return n;
}

export function parseIntent(text) {
  if (typeof text !== 'string') return null;
  try {
    const s = trimFillers(normalise(text));
    if (!s) return null;

    if (STOP_RE.test(s)) return { kind: 'stop', args: {} };

    const game = matchGame(s);
    if (game) return { kind: 'change_game', args: { game } };

    // Numeric commands are anchored: "i bet 50 you can't" is chatter, not a stake change.
    const numeric = s.replace(SET_VERB, '');

    const multiplier = MULTIPLIER_RE.exec(numeric);
    if (multiplier) {
      const value = toNumber(multiplier[1], multiplier[2]);
      if (value !== null) return { kind: 'set_multiplier', args: { value } };
    }

    const chance = CHANCE_RE.exec(numeric) || BARE_PERCENT_RE.exec(numeric);
    if (chance) {
      const value = toNumber(chance[1], chance[2]);
      if (value !== null) return { kind: 'set_win_chance', args: { value } };
    }

    const stake = STAKE_RE.exec(numeric);
    if (stake) {
      const value = toNumber(stake[1], stake[2]);
      if (value !== null) return { kind: 'set_stake', args: { value } };
    }

    const tile = TILE_RE.exec(numeric);
    if (tile) {
      const n = Number(tile[1]);
      // Mines is a 5x5 grid; a "tile 40" is a joke, not a command.
      if (n >= 1 && n <= 25) return { kind: 'pick_tile', args: { n } };
    }

    if (STATUS_EXACT.has(s) || /\b(?:saldo|balance)\b/.test(s)) return { kind: 'status', args: {} };
    if (CASHOUT_RE.test(s)) return { kind: 'cash_out', args: {} };
    if (HIGHER.has(s)) return { kind: 'higher', args: {} };
    if (LOWER.has(s)) return { kind: 'lower', args: {} };
    if (HIT.has(s)) return { kind: 'hit', args: {} };
    if (STAND.has(s)) return { kind: 'stand', args: {} };
    if (matchStart(s)) return { kind: 'start_round', args: {} };

    return null;
  } catch {
    return null; // a parser bug must never take the host down
  }
}
