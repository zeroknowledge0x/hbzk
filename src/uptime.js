// Unattended-run ledger.
//
// The contest scores continuous hours with no human in the loop, and that clock is the one
// thing a crash silently destroys: a restart looks exactly like a fresh start. So every
// start, human touch and restart is written down, and "unattended" is measured from the last
// human action — a supervisor restart does NOT reset it.
import fs from 'node:fs';

export const EMPTY_LEDGER = {
  windowStartAt: null,
  lastHumanAt: null,
  lastStartAt: null,
  restarts: 0,
  bestHours: 0,
  runs: [],
};

export function createLedger(patch = {}) {
  return { ...EMPTY_LEDGER, ...patch };
}

export function noteStart(ledger, at, { restarted = false } = {}) {
  const l = createLedger(ledger);
  return {
    ...l,
    lastStartAt: at,
    // First start opens the window. A supervised restart keeps the same window, because no
    // human touched anything — that is the whole point of the ledger.
    windowStartAt: l.windowStartAt ?? at,
    restarts: restarted ? l.restarts + 1 : l.restarts,
  };
}

export function noteHuman(ledger, at) {
  const l = createLedger(ledger);
  const hours = hoursUnattended(l, at);
  const run = l.windowStartAt
    ? { startedAt: l.windowStartAt, endedAt: at, hours: Number(hours.toFixed(3)) }
    : null;
  return {
    ...l,
    windowStartAt: at,
    lastHumanAt: at,
    bestHours: Math.max(l.bestHours, Number(hours.toFixed(3))),
    runs: run ? [...l.runs, run].slice(-25) : l.runs,
  };
}

export function hoursUnattended(ledger, now) {
  const start = createLedger(ledger).windowStartAt;
  if (!start || !Number.isFinite(start)) return 0;
  return Math.max(0, (now - start) / 3_600_000);
}

export function noteTick(ledger, now) {
  const l = createLedger(ledger);
  const hours = Number(hoursUnattended(l, now).toFixed(3));
  return hours > l.bestHours ? { ...l, bestHours: hours } : l;
}

export function formatDuration(hours) {
  const total = Math.max(0, Math.round(Number(hours) * 3600));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

// One line for the overlay: what the judges are scoring, visible to every viewer.
export function ledgerLine(ledger, now) {
  const l = createLedger(ledger);
  // Display from the raw value: rounding to three decimals first turned 3h 05m into 3h 04m.
  const hours = hoursUnattended(l, now);
  const best = Math.max(l.bestHours, hours);
  return `UNATTENDED ${formatDuration(hours)} · BEST ${formatDuration(best)} · RESTARTS ${l.restarts}`;
}

export function loadLedger(file) {
  try {
    if (!fs.existsSync(file)) return createLedger();
    return createLedger(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return createLedger();
  }
}

export function saveLedger(file, ledger) {
  try {
    const dir = file.replace(/[\\/][^\\/]+$/, '');
    if (dir) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(createLedger(ledger), null, 2));
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
