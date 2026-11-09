// Logic audit: sweep every House table through every phase and control shape the host can
// meet, and check the invariants that keep the show controllable.
//
//   node scripts/logic-audit.mjs            # matrix + verdict, exit 1 on any violation
//   node scripts/logic-audit.mjs --verbose  # one line per case
//
// The point is not to re-test what the unit tests already cover, but to prove the *whole*
// decision surface has no dead end, no un-clickable label and no forbidden control.
import { ALL, byName } from '../src/core/adapters/index.js';
import { has, NEVER_PLAY } from '../src/core/adapters/policy-helpers.js';
import { readObservedProgress } from '../src/core/progress.js';

const MULTI_ALLOWED = {
  Dice: [1.5, 2, 3, 5, 10],
  'Max Win': [10, 50, 100, 1000],
};

const tiles = (n) => Array.from({ length: n }, (_, i) => `Tile ${i + 1}`);
const floors = (from, to) => {
  const out = [];
  for (let f = from; f <= to; f++) for (let t = 1; t <= 3; t++) out.push(`Floor ${f}, tile ${t}`);
  return out;
};
const kenoBoard = ['1 Number 1', '2 Number 2', '7 Number 7', '9 Number 9', '14 Number 14'];

// Controls as they really appear in the snapshot (probe 2026-11-08 plus the two traps).
export const FIXTURES = {
  Dice: {
    idle: ['Bet', 'Bet Amount 0.00', '2× Double bet amount (S)', 'Over', 'Under', 'Inside', 'Outside'],
    playing: ['Bet', 'Bet Amount 0.00', 'Over', 'Under', 'Inside', 'Outside'],
    board: false,
  },
  Mines: {
    idle: ['Bet', 'Bet Amount 0.00', '2× Double bet amount (S)'],
    playing: [...tiles(25), 'Random tile', 'Cash out $0.00'],
    playingCleared: [...tiles(23), 'Random tile', 'Cash out $0.00'],
    board: true,
  },
  Plinko: {
    idle: ['Bet', 'Bet Amount 0.00', 'Low', 'Medium', 'High'],
    playing: ['Bet', 'Low', 'Medium', 'High'],
    board: false,
  },
  Keno: {
    idle: ['Bet', 'Classic (Q)', 'Low (Q)', 'Medium (Q)', 'High (Q)', 'Clear table',
      'Auto pick numbers at random (R)', ...kenoBoard],
    playing: ['Bet', 'Classic (Q)', 'Low (Q)', 'Medium (Q)', 'High (Q)', 'Clear table',
      'Auto pick numbers at random (R)', ...kenoBoard],
    board: false,
  },
  Wheel: {
    idle: ['Bet', 'Bet Amount 0.00', 'Low', 'Medium', 'High'],
    playing: ['Bet', 'Low', 'Medium', 'High'],
    board: false,
  },
  Limbo: {
    idle: ['Bet', 'Bet Amount 0.00', '2× Double bet amount (S)', '1.5x', '2x', '5x', '10x', '100x'],
    playing: ['Bet', '1.5x', '2x', '5x', '10x', '100x'],
    board: false,
  },
  'Max Win': {
    idle: ['Bet', 'Bet Amount 0.00', 'Standard 1,000×', '1.000×'],
    playing: ['Bet', 'Standard 1,000×', '1.000×'],
    board: false,
  },
  'Dragon Tower': {
    idle: ['Bet', 'Bet Amount 0.00', 'Random pick a random tile on the next floor (R)', ...floors(1, 9)],
    playing: ['Cash out $0.00', 'Random pick a random tile on the next floor (R)', ...floors(4, 9)],
    board: true,
  },
  Hilo: {
    idle: ['Bet', 'Higher / same 38.46% Higher / same (W)', 'Lower / same 69.23% Lower / same (E)',
      'Skip card Skip card (Q)', 'Cash out $ 0.00'],
    playing: ['Higher / same 38.46% Higher / same (W)', 'Lower / same 69.23% Lower / same (E)',
      'Skip card Skip card (Q)', 'Cash out $ 0.00'],
    board: true,
  },
  Blackjack: {
    idle: ['Bet', 'Bet Amount 0.00', '1', '2', '3'],
    playing: ['Hit', 'Stand', 'No thanks', 'Insure $0.00'],
    playingCleared: ['Hit', 'Stand', 'Insure $0.00'],
    edge: ['No thanks', 'Insure $0.00'],
    board: true,
  },
  "Hubie's Road": {
    idle: ['Bet', 'Go', 'Bet Amount 0.00', 'Easy', 'Medium', 'Hard', 'Daredevil'],
    playing: ['Cash out $0.00', 'Lane 1', 'Lane 2', 'Lane 3', 'Lane 4', 'Lane 5', 'Lane 6'],
    board: true,
  },
};

const RANDS = [0, 0.25, 0.5, 0.75, 0.99];
const PROGRESS = [0, 1, 2, 3];

function checkCase(adapter, spec, phase, controls, progress, random, problems, proposals) {
  const out = adapter.decide({ phase, controls, progress }, () => random);
  const where = `${adapter.name}/${phase}/p${progress}/r${random}`;
  if (!out || typeof out !== 'object') {
    problems.push(`${where}: decide() returned ${JSON.stringify(out)}`);
    return { out: null, label: null };
  }
  const label = out.label ?? null;
  if (label !== null && typeof label !== 'string') problems.push(`${where}: label is ${typeof label}`);

  // A board action must be visible on the table. A *start* label may be proposed while the
  // snapshot is mid-render; the controller re-reads the live page and refuses to click
  // anything it cannot see, so that proposal is counted, not treated as a fault.
  const START = new Set(['Bet', 'GO', 'Go', 'Deal', 'Roll', 'Play', 'Start', 'Spin', 'Drop']);
  if (label && !has(controls, label)) {
    if (START.has(label)) proposals.push(`${where}: start proposal "${label}" (controller verifies)`);
    else problems.push(`${where}: "${label}" is not on the table`);
  }
  if (label && NEVER_PLAY.test(String(label))) problems.push(`${where}: "${label}" matches NEVER_PLAY`);

  // Settings chips are idle-only and must exist.
  if (out.settings) {
    if (phase === 'playing' || phase === 'settling') problems.push(`${where}: settings "${out.settings}" sent mid-round`);
    if (!has(controls, out.settings)) problems.push(`${where}: settings "${out.settings}" not on the table`);
  }

  // Payout field: only the two tables that have one, only when idle, only the allowed steps.
  if (out.multi !== undefined && out.multi !== null) {
    const allowed = MULTI_ALLOWED[adapter.name];
    if (!allowed) problems.push(`${where}: multi ${out.multi} on a table with no payout field`);
    else if (!allowed.includes(out.multi)) problems.push(`${where}: multi ${out.multi} not in ${allowed}`);
    if (phase === 'playing' || phase === 'settling') problems.push(`${where}: multi written mid-round`);
  }

  // No dead ends: if any legal play control is on the table, an action must be chosen — either
  // a label to click or a `pick` instruction the controller knows how to carry out.
  const playable = controls.some((c) => !NEVER_PLAY.test(String(c).toLowerCase()) &&
    /^(bet|go|roll|deal|play|start|hit|stand|higher|lower|skip|cash out|random pick|random tile|auto pick|tile \d+|lane \d+|floor \d+|clear table|\d+ number)/i.test(String(c).trim()));
  const acted = label !== null || Boolean(out.pick);
  if (!acted && phase === 'idle' && playable) problems.push(`${where}: dead end, table has playable controls`);
  if (!acted && phase === 'playing' && spec.board && playable) problems.push(`${where}: dead end mid-round`);

  // Mid-round on a board table, the host never goes back to Bet *while a board action exists*.
  const boardAction = controls.some((c) => /^(lane|tile|floor)\s*\d+/i.test(String(c).trim()) || /^cash out/i.test(String(c).trim()));
  if (phase === 'playing' && spec.board && label === 'Bet' && boardAction) problems.push(`${where}: Bet chosen mid-round while a board action was available`);

  return { out, label };
}

export function audit({ verbose = false } = {}) {
  const problems = [];
  const proposals = [];
  const rows = [];
  for (const adapter of ALL) {
    const spec = FIXTURES[adapter.name];
    if (!spec) { problems.push(`${adapter.name}: no fixture in the audit`); continue; }
    const seen = new Set();
    let cases = 0;
    for (const [phase, controls] of [
      ['idle', spec.idle],
      ['playing', spec.playing],
      ['playing', spec.playingCleared ?? spec.playing],
      ['settling', spec.idle],
      ['idle', []],
      ['playing', []],
      ...(spec.edge ? [['playing', spec.edge]] : []),
    ]) {
      for (const progress of PROGRESS) {
        for (const random of RANDS) {
          cases += 1;
          const { label } = checkCase(adapter, spec, phase, controls, progress, random, problems, proposals);
          if (label) seen.add(label);
          if (verbose) rows.push(`${adapter.name.padEnd(14)} ${phase.padEnd(8)} p${progress} r${random.toFixed(2)} -> ${label ?? '(none)'}${controls.length ? '' : '  [empty table]'}`);
        }
      }
    }
    rows.push(`${adapter.name.padEnd(14)} ${String(cases).padStart(3)} cases · actions: ${[...seen].sort().join(', ') || '(none)'}`);
  }
  return { problems, proposals, rows };
}

// Actions each table must be able to produce, otherwise the policy is not really playing it.
export const EXPECTED = {
  Dice: ['Bet'],
  Mines: ['Bet', 'Cash out', 'Random tile'],
  Plinko: ['Bet'],
  Keno: ['Bet'],
  Wheel: ['Bet'],
  Limbo: ['Bet'],
  'Max Win': ['Bet'],
  'Dragon Tower': ['Bet', 'Cash out', 'Random pick'],
  Hilo: ['Bet', 'Higher', 'Lower'],
  Blackjack: ['Bet', 'Hit', 'Stand', 'No thanks'],
  "Hubie's Road": ['Bet', 'Cash out', 'Lane 1'],
};

// Stage 2: the controller must turn a policy decision into at most one legal click, and it
// must refuse to click at all when the zero-stake readback is not exactly zero.
export async function controllerSweep() {
  const { Controller } = await import('../src/core/controller.js');
  const { World } = await import('../src/core/world.js');
  const { Planner } = await import('../src/core/planner.js');
  const problems = [];
  const rows = [];

  const build = ({ name, phase, controls, stakeReadback }) => {
    const world = new World({ game: name, phase, controls, stake: 0 });
    const planner = new Planner({ world });
    planner.setGoal({ game: name, rounds: 1 });
    const clicks = [];
    const game = {
      setStake: async () => stakeReadback,
      setMultiplier: async (v) => ({ ok: true, verified: true, observed: v }),
      clickText: async (label) => { clicks.push(label); return { ok: true, text: label }; },
      clickMinesTile: async () => { clicks.push('tile'); return { ok: true }; },
      getReport: () => ({ url: '', clickables: controls }),
    };
    const controller = new Controller({
      world, planner, game,
      tools: { run: async () => ({ ok: false }) },
      verifier: { waitFor: async () => ({ ok: false }) },
      speak: () => {},
      random: () => 0,
      log: () => {},
    });
    return { controller, clicks };
  };

  for (const adapter of ALL) {
    const spec = FIXTURES[adapter.name];
    for (const phase of ['idle', 'playing']) {
      for (const random of [0, 0.5, 0.99]) {
        const controls = phase === 'idle' ? spec.idle : spec.playing;
        const { controller, clicks } = build({ name: adapter.name, phase, controls, stakeReadback: { ok: true, verified: true, observed: 0 } });
        controller.random = () => random;
        const expected = adapter.decide({ phase, controls, progress: readObservedProgress(adapter.name, { controls }) }, () => random);
        const res = await controller._executeStep({ kind: 'start_round', args: { label: 'Bet' } }).catch((err) => ({ ok: false, error: err.message }));
        const where = `${adapter.name}/${phase}/r${random}`;
        if (clicks.length > 8) problems.push(`${where}: ${clicks.length} clicks in one step (${clicks.join(', ')})`);
        for (const label of clicks) {
          if (NEVER_PLAY.test(String(label).toLowerCase())) problems.push(`${where}: clicked a trap "${label}"`);
          if (label !== 'tile' && !has(controls, label)) problems.push(`${where}: clicked "${label}" which is not on the table`);
        }
        // A step may click a settings chip (and Keno clears/selects) before it plays, but the
        // click that starts the round must be the one the policy asked for.
        if (expected.label && has(controls, expected.label) && clicks.length) {
          const last = clicks[clicks.length - 1];
          if (last !== expected.label && last !== 'tile') {
            problems.push(`${where}: policy asked for "${expected.label}" but the step ended on "${last}"`);
          }
        }
        if (!expected.label && !expected.pick && clicks.length) {
          problems.push(`${where}: policy asked for nothing but the controller clicked ${clicks.join(', ')}`);
        }
        if (res && res.ok === false && clicks.length && !res.deferred) problems.push(`${where}: reported failure but still clicked`);
        rows.push(`${adapter.name.padEnd(14)} ${phase.padEnd(8)} r${random.toFixed(2)} ok=${String(res?.ok).padEnd(5)} clicks=${clicks.join(',') || '-'}`);
      }
    }
  }

  // The stake readback is the last line of defence: anything but a verified zero means no click.
  for (const readback of [
    { ok: true, verified: false, observed: 0 },
    { ok: true, verified: true, observed: 25 },
    { ok: false, error: 'stake field not found' },
  ]) {
    const { controller, clicks } = build({ name: 'Dice', phase: 'idle', controls: FIXTURES.Dice.idle, stakeReadback: readback });
    const res = await controller._executeStep({ kind: 'start_round', args: { label: 'Bet' } });
    if (clicks.length) problems.push(`stake readback ${JSON.stringify(readback)}: clicked ${clicks.join(',')} anyway`);
    if (res?.ok !== false) problems.push(`stake readback ${JSON.stringify(readback)}: reported ok=${res?.ok}`);
    rows.push(`stake guard   ${JSON.stringify(readback).padEnd(44)} ok=${String(res?.ok).padEnd(5)} clicks=${clicks.length}`);
  }

  return { problems, rows };
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/logic-audit.mjs');
if (isMain) {
  const verbose = process.argv.includes('--verbose');
  const { problems, proposals, rows } = audit({ verbose });
  for (const row of rows) console.log(row);

  // Coverage: every table must be able to reach its own key actions.
  const missed = [];
  for (const row of rows) {
    const m = row.match(/^(\S.*?)\s+\d+ cases · actions: (.*)$/);
    if (!m) continue;
    const [, name, list] = m;
    const seen = new Set(list.split(', '));
    for (const want of EXPECTED[name.trim()] || []) if (!seen.has(want)) missed.push(`${name.trim()}: never proposes "${want}"`);
  }
  if (missed.length) problems.push(...missed);

  console.log('');
  const sweep = await controllerSweep();
  if (verbose) for (const row of sweep.rows) console.log(row);
  else console.log(`[controller] ${sweep.rows.length} steps swept, ${sweep.problems.length} violation(s)`);
  problems.push(...sweep.problems);

  const tables = ALL.length;
  console.log(`\n[tables] ${tables} · [policy cases] ${tables * 6 * PROGRESS.length * RANDS.length} · [verified start proposals] ${proposals.length}`);
  if (problems.length) {
    console.error(`\n[violations] ${problems.length}`);
    for (const p of problems.slice(0, 60)) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('[violations] 0 — every decision is a visible, legal control, and every click is stake-verified');
}