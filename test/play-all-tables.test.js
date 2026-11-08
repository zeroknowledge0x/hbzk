import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL, byName } from '../src/core/adapters/index.js';
import { DEFAULT_PLAYABLE, isPlayable, playableList } from '../src/play-queue.js';
import { Controller } from '../src/core/controller.js';
import { Planner } from '../src/core/planner.js';
import { World } from '../src/core/world.js';
import { PLAY_CLICK_LABELS } from '../src/core/play-labels.js';

test('default rotation includes every House Original, not Dice only', () => {
  const prev = process.env.PLAYABLE_GAMES;
  delete process.env.PLAYABLE_GAMES;
  try {
    assert.ok(DEFAULT_PLAYABLE.includes('Blackjack'));
    assert.ok(DEFAULT_PLAYABLE.includes('Keno'));
    assert.equal(playableList().length, 10);
    assert.equal(isPlayable('Blackjack'), true);
    assert.equal(isPlayable('tower'), true);
    assert.equal(isPlayable('Dragon Tower'), true);
    assert.equal(isPlayable('Limbo'), true);
  } finally {
    if (prev === undefined) delete process.env.PLAYABLE_GAMES;
    else process.env.PLAYABLE_GAMES = prev;
  }
});

test('blackjack and hilo expose in-round labels, keno/mines pick spots', () => {
  const bj = byName('Blackjack');
  assert.ok(bj.startLabels.some((l) => /^hit$/i.test(l)));
  assert.ok(bj.startLabels.some((l) => /^stand$/i.test(l)));
  assert.ok(bj.startLabels.some((l) => /^bet$/i.test(l)));
  const hilo = byName('Hilo');
  assert.ok(hilo.startLabels.some((l) => /higher/i.test(l)));
  assert.equal(byName('Keno').pick, 'number');
  assert.equal(byName('Mines').pick, 'tile');
  assert.equal(byName('Dragon Tower').pick, 'tile');
  assert.equal(byName('Dice').resolvesAtZero, true);
  assert.equal(byName('Blackjack').resolvesAtZero, false);
  for (const a of ALL) {
    assert.ok(Array.isArray(a.startLabels) && a.startLabels.length >= 2, a.name);
  }
});

test('blackjack start_round clicks Hit when Bet is missing; no result is still ok', async () => {
  const world = new World({ game: 'Blackjack', phase: 'playing', controls: ['Hit', 'Stand'], stake: 0 });
  const planner = new Planner({ world });
  const clicks = [];
  const tools = {
    async run(name, args) {
      if (name === 'change_game') return { ok: true };
      if (name === 'click') {
        clicks.push(args.label);
        return args.label === 'Hit' ? { ok: true } : { ok: false, error: 'not found' };
      }
      return { ok: false, error: name };
    },
  };
  const c = new Controller({
    world,
    tools,
    planner,
    verifier: { async waitFor() { return { ok: false, error: 'timeout' }; } },
    game: { getReport: () => ({ url: 'https://www.housebets.com/games/housegames-blackjack' }) },
    playable: DEFAULT_PLAYABLE,
  });
  planner.setGoal({ kind: 'play', game: 'Blackjack', rounds: 1 });
  c._active = true;
  await c.tick();
  await c.tick();
  assert.ok(clicks.includes('Hit'), `clicked ${clicks.join(',')}`);
  await c.tick();
  assert.equal(planner.status().failed, false, planner.status().error);
});

test('enter_game while mid-round stays on the table instead of change_game', async () => {
  const world = new World({ game: 'Dragon Tower', phase: 'playing', controls: ['Cash out', 'Random pick'], stake: 0 });
  const planner = new Planner({ world });
  const calls = [];
  const tools = {
    async run(name, args) {
      calls.push(name);
      if (name === 'change_game') return { ok: false, error: 'cannot change game mid-round' };
      if (name === 'click') return { ok: true };
      return { ok: true };
    },
  };
  const said = [];
  const c = new Controller({
    world,
    tools,
    planner,
    verifier: { async waitFor() { return { ok: false, error: 'timeout' }; } },
    game: { getReport: () => ({ url: 'https://www.housebets.com/games/housegames-dragon-tower' }) },
    playable: DEFAULT_PLAYABLE,
    speak: (t) => said.push(t),
  });
  planner.setGoal({ kind: 'play', game: 'Plinko', rounds: 1 });
  c._active = true;
  await c.tick();
  assert.equal(calls.includes('change_game'), false, `tools=${calls.join(',')}`);
  assert.equal(planner.status().failed, false, planner.status().error);
  await c.tick();
  assert.ok(calls.includes('click'), `tools=${calls.join(',')}`);
});

test('a failed plan is logged, never spoken as plan failed', async () => {
  const world = new World({ game: 'Dice', phase: 'idle', controls: ['Bet'], stake: 0 });
  const planner = new Planner({ world });
  const said = [];
  const c = new Controller({
    world,
    tools: { async run() { return { ok: false, error: 'cannot change game mid-round' }; } },
    planner,
    verifier: { async waitFor() { return { ok: false }; } },
    game: { getReport: () => ({ url: 'https://www.housebets.com/games/housegames-dice' }) },
    playable: DEFAULT_PLAYABLE,
    speak: (t) => said.push(t),
  });
  planner.setGoal({ kind: 'play', game: 'Dice', rounds: 1 });
  c._active = true;
  for (let i = 0; i < 8; i++) await c.tick();
  assert.equal(planner.status().failed, true);
  assert.equal(said.some((t) => /plan failed/i.test(t)), false, said.join(' | '));
});

test('play click vocabulary includes GO, Random pick, Auto pick, Over, Under', () => {
  for (const need of ['GO', 'Random pick', 'Auto pick', 'Over', 'Under', 'Hit', 'Stand', 'Higher', 'Lower', 'Cash out', 'Skip', 'Same']) {
    assert.ok(PLAY_CLICK_LABELS.some((l) => l.toLowerCase() === need.toLowerCase()), need);
  }
  assert.ok(byName('Keno').startLabels.some((l) => /auto pick/i.test(l)));
  assert.ok(byName('Dragon Tower').startLabels.some((l) => /^go$/i.test(l)));
  assert.ok(byName('Hilo').startLabels.some((l) => /^skip$/i.test(l)));
});

test('a successful play click snapshots the table frame', async () => {
  const world = new World({ game: 'Keno', phase: 'idle', controls: ['Bet', 'Auto pick'], stake: 0 });
  const planner = new Planner({ world });
  const shots = [];
  const c = new Controller({
    world,
    tools: {
      async run(name, args) {
        if (name === 'change_game') return { ok: true };
        if (name === 'click') return { ok: true, text: args.label };
        return { ok: true };
      },
    },
    planner,
    verifier: { async waitFor() { return { ok: false, error: 'timeout' }; } },
    game: {
      getReport: () => ({ url: 'https://www.housebets.com/games/housegames-keno' }),
      async snapPlay(tag) { shots.push(tag); return { ok: true, tag }; },
    },
    playable: DEFAULT_PLAYABLE,
  });
  planner.setGoal({ kind: 'play', game: 'Keno', rounds: 1 });
  c._active = true;
  await c.tick();
  await c.tick();
  assert.ok(shots.length >= 1, `shots=${shots.join(',')}`);
});
