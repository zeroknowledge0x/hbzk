// Playbook: a verified, per-table skill library.
//
// Pattern borrowed from Voyager (skill library) and the "playbook ladder" write-up: only a
// result that has been *verified* earns a stored lesson, everything else stays in the
// scratchpad. The library is tiny, keyed by table, and read back on the next round so the host
// stops repeating a mistake it already paid for.
import fs from 'node:fs';

const EMPTY = {
  tables: {},          // table -> { rounds, wins, bestMultiplier, cashouts: [], notes: [] }
  updatedAt: 0,
};

export const MAX_NOTES = 6;
export const MAX_CASHOUTS = 12;

export function createPlaybook(patch = {}) {
  return { ...EMPTY, ...patch, tables: { ...(patch.tables || {}) } };
}

const key = (table) => String(table || '').toLowerCase().trim();

// null/undefined/'' mean "not measured". Number(null) is 0, which would otherwise be stored as
// a real cashout at zero and turn into nonsense advice.
function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function tableState(book, table) {
  return book.tables[key(table)] || { rounds: 0, wins: 0, bestMultiplier: null, cashouts: [], notes: [] };
}

// `verified` must be true: a click that was delivered is not a settled round.
export function record(book, table, { verified = false, won = null, multiplier = null, cashoutAt = null, progress = null, note = '' } = {}) {
  if (!verified || !key(table)) return createPlaybook(book);
  const state = { ...tableState(book, table) };
  state.rounds += 1;
  if (won === true) state.wins += 1;
  const m = numOrNull(multiplier);
  if (m !== null && m > 1 && (state.bestMultiplier === null || m > state.bestMultiplier)) {
    state.bestMultiplier = m;
  }
  const c = numOrNull(cashoutAt);
  if (c !== null && c >= 0) state.cashouts = [...state.cashouts, c].slice(-MAX_CASHOUTS);
  if (note) state.notes = [...state.notes, String(note).slice(0, 120)].slice(-MAX_NOTES);
  const tables = { ...book.tables, [key(table)]: state };
  return { ...createPlaybook(book), tables, updatedAt: Date.now() };
}

export function hitRate(book, table) {
  const s = tableState(book, table);
  return s.rounds ? Number((s.wins / s.rounds).toFixed(3)) : null;
}

// Bounded advice: one line, and only when the sample is big enough to mean anything.
export function advise(book, table, { progress = 0 } = {}) {
  const s = tableState(book, table);
  if (s.rounds < 4) return null;
  const rate = hitRate(book, table);
  if (rate !== null && rate <= 0.25 && progress >= 2) return 'this table has been cold, take the demo early';
  if (s.bestMultiplier !== null && s.bestMultiplier >= 5) return `best run here was ${s.bestMultiplier.toFixed(2)}x, so one more step is fine`;
  if (s.cashouts.length >= 3) {
    const avg = s.cashouts.reduce((a, b) => a + b, 0) / s.cashouts.length;
    return `cashing around ${avg.toFixed(1)} has been the sweet spot here`;
  }
  return null;
}

export function summary(book, table) {
  const s = tableState(book, table);
  return {
    rounds: s.rounds,
    hits: s.wins,
    hitRate: hitRate(book, table),
    bestMultiplier: s.bestMultiplier,
    cashoutMean: s.cashouts.length
      ? Number((s.cashouts.reduce((a, b) => a + b, 0) / s.cashouts.length).toFixed(2))
      : null,
    notes: s.notes.length,
  };
}

export function playbookLine(book) {
  const names = Object.keys(book.tables || {});
  if (!names.length) return 'PLAYBOOK empty';
  return `PLAYBOOK ${names.length} table(s) · ${names
    .map((n) => `${n} ${summary(book, n).rounds}r/${summary(book, n).hits}w`)
    .join(' · ')}`.slice(0, 200);
}

// Persistence mirrors the uptime ledger: atomic write, corrupt file falls back to empty.
export function loadPlaybook(file) {
  try {
    if (!fs.existsSync(file)) return createPlaybook();
    return createPlaybook(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return createPlaybook();
  }
}

export function savePlaybook(file, book) {
  try {
    const dir = file.replace(/[\\/][^\\/]+$/, '');
    if (dir) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(book, null, 2));
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
