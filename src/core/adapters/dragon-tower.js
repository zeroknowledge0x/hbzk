// Dragon Tower: climb rows by picking a tile. Difficulty is chosen on the table, not
// through a multiplier or chance field, so configure() never touches settings tools.
const NAME = 'Dragon Tower';
const SLUG = 'housegames-dragon-tower';
const SETTINGS = {};
const START_LABELS = ['Bet', 'Start', 'Cash out', 'Random pick'];

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
  const raw = last.value;
  const parsed = raw === null || raw === undefined || raw === '' ? null : Number(raw);
  const value = Number.isFinite(parsed) ? parsed : null;
  const won = last.won === true ? true : last.won === false ? false : null;
  if (value == null && won == null) return null;
  return { value, won, source: last.source ? String(last.source) : 'world' };
}

export default {
  name: NAME,
  slug: SLUG,
  settings: SETTINGS,
  startLabels: START_LABELS,
  pick: 'tile',
  resolvesAtZero: false,

  async configure(_tools, _want) {
    return { ok: true, applied: [] };
  },

  async start(tools) {
    return clickFirst(tools, START_LABELS);
  },

  result(world) {
    return mapResult(world);
  },
};
