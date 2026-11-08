// Adapter registry. The host resolves a game by the labels chat already uses (plus
// the Housebets slug) and never needs to know which module owns it.
import dice from './dice.js';
import mines from './mines.js';
import plinko from './plinko.js';
import keno from './keno.js';
import wheel from './wheel.js';
import limbo from './limbo.js';
import maxWin from './maxwin.js';
import dragonTower from './dragon-tower.js';
import hubieRoad from './hubie-road.js';
import hilo from './hilo.js';
import blackjack from './blackjack.js';

export const ALL = [
  dice,
  mines,
  plinko,
  keno,
  wheel,
  limbo,
  maxWin,
  dragonTower,
  hubieRoad,
  hilo,
  blackjack,
];

const key = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

const BY_KEY = new Map();
for (const adapter of ALL) {
  BY_KEY.set(key(adapter.name), adapter);
  BY_KEY.set(key(adapter.slug), adapter);
}

// Chat and the old URL map still say "tower" for Dragon Tower, and "crash" has always
// been routed to Limbo because the real crash slug 404s.
const ALIASES = {
  tower: 'Dragon Tower',
  crash: 'Limbo',
  road: "Hubie's Road",
  hubiesroad: "Hubie's Road",
};

export function byName(name) {
  const wanted = key(name);
  if (!wanted) return null;
  const direct = BY_KEY.get(wanted);
  if (direct) return direct;
  const alias = ALIASES[wanted];
  return alias ? BY_KEY.get(key(alias)) || null : null;
}

export function names() {
  return ALL.map((adapter) => adapter.name);
}

export default { ALL, byName, names };
