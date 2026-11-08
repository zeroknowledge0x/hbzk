import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL, byName } from '../src/core/adapters/index.js';
import { DEFAULT_PLAYABLE, isPlayable, playableList } from '../src/play-queue.js';
import { Controller } from '../src/core/controller.js';
import { Planner } from '../src/core/planner.js';
import { World } from '../src/core/world.js';

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
