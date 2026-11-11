// Dice: roll over/under. Both the payout multiplier and the win chance are settable;
// the caller passes the wanted values, and the tools layer owns the safe band.
const NAME = 'Dice';
const SLUG = 'housegames-dice';
const SETTINGS = { multiplier: 'Number', winChance: 'Number' };
const START_LABELS = ['Bet', 'Roll'];

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function applySetting(tools, tool, value, applied) {
  const fn = tools?.[tool];
  if (typeof fn !== 'function') return;
  try {
    const result = await fn.call(tools, value);
    applied.push({ tool, value, ok: result?.ok !== false });
  } catch (err) {
    applied.push({ tool, value, ok: false, error: err?.message || String(err) });
  }
}

function controlsOf(tools) {
  const world = tools?.world;
  const state = typeof world?.get === 'function' ? world.get() : world;
  const list = tools?.controls ?? state?.controls;
  return Array.isArray(list) ? list : null;
}

function pickLabel(labels, controls) {
  for (const label of labels) {
    const want = String(label).toLowerCase();
    const hit = controls.find((control) => String(control).trim().toLowerCase() === want);
    if (hit != null) return hit;
  }
  return null;
}

async function clickFirst(tools, labels) {
  const click = tools?.click;
  if (typeof click !== 'function') return { ok: false, error: 'no click tool' };
  const controls = controlsOf(tools);
  if (controls) {
    const label = pickLabel(labels, controls);
    if (label == null) return { ok: false, error: 'no start control' };
    return click.call(tools, label);
  }
  let last = null;
  for (const label of labels) {
    last = await click.call(tools, label);
    if (last?.ok !== false) return last;
  }
  return last || { ok: false, error: 'no start control' };
}

function mapResult(world) {
  const state = typeof world?.get === 'function' ? world.get() : world;
  const last = state?.lastResult;
  if (last == null) return null;
  if (typeof last === 'number') {
    return Number.isFinite(last) ? { value: last, won: null, source: 'world' } : null;
  }
  const value = number(last.value);
  const won = last.won === true ? true : last.won === false ? false : null;
  if (value == null && won == null) return null;
  return { value, won, source: last.source ? String(last.source) : 'world' };
}

export default {
  name: NAME,
  slug: SLUG,
  settings: SETTINGS,
  startLabels: START_LABELS,
  pick: null,
  // Measured 2026-11-11: at stake 0 Dice's result marker is read in only 14 of 59 goals (24%). The
  // Bet click always lands, so the table plays fine — it is the *result wait* that failed and
  // produced every `goal failed ... await_result failed after re-entering Dice` line (two 8 s
  // timeouts plus a re-entry, ~30–60 s per visit). Dice is played as a demo click like the other
  // ten tables: click its own controls, do not wait for a result that may never publish.
  resolvesAtZero: false,

  async configure(tools, want) {
    const applied = [];
    const multiplier = number(want?.multiplier ?? want?.target ?? want?.payout);
    if (multiplier != null) await applySetting(tools, 'set_multiplier', multiplier, applied);
    const winChance = number(want?.winChance ?? want?.win_chance ?? want?.chance);
    if (winChance != null) await applySetting(tools, 'set_win_chance', winChance, applied);
    return { ok: applied.every((entry) => entry.ok), applied: applied.map((entry) => entry.tool) };
  },

  async start(tools) {
    return clickFirst(tools, START_LABELS);
  },

  result(world) {
    return mapResult(world);
  },
};
