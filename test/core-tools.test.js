// Tools are the only place a command actually reaches the table, so the two things that
// matter are: a refused call never touches the fake game, and every call — success or
// not — lands on the bus as an 'action'. The fake game mirrors the real GameFeed methods
// (clickText / setStake / openGameByCard / readPerceptionDom) so a rename breaks here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Bus } from '../src/core/bus.js';
import { World } from '../src/core/world.js';
import { Tools } from '../src/core/tools.js';

function fakeGame(overrides = {}) {
  const calls = [];
  const game = {
    calls,
    async clickText(label) {
      calls.push(['clickText', label]);
      return { ok: true, clicked: label };
    },
    async setStake(value) {
      calls.push(['setStake', value]);
      return { ok: true, verified: true, observed: value };
    },
    async setMultiplier(value) {
      calls.push(['setMultiplier', value]);
      return { ok: true, verified: true, observed: value };
    },
    async setWinChance(value) {
      calls.push(['setWinChance', value]);
      return { ok: true, verified: true, observed: value };
    },
    async openGameByCard(name) {
      calls.push(['openGameByCard', name]);
      return { ok: true, slug: name.toLowerCase() };
    },
    async readPerceptionDom() {
      calls.push(['readPerceptionDom']);
      return { body: '' };
    },
    ...overrides,
  };
  return game;
}

function setup(initial = {}, overrides = {}) {
  const bus = new Bus();
  const world = new World({ game: 'Dice', phase: 'betting', controls: ['Bet', 'Roll', 'Manual'], ...initial });
  const game = fakeGame(overrides);
  const actions = [];
  const speech = [];
  bus.on('action', (a) => actions.push(a));
  bus.on('speak', (s) => speech.push(s));
  const tools = new Tools({ game, world, bus });
  return { bus, world, game, actions, speech, tools };
}

test('click reaches the game and reports ok', async () => {
  const { tools, game, world } = setup();
  const res = await tools.run('click', { label: 'Bet' });

  assert.equal(res.ok, true);
  assert.equal(typeof res.ms, 'number');
  assert.equal(res.error, undefined);
  assert.deepEqual(game.calls, [['clickText', 'Bet']]);
  assert.equal(world.get().game, 'Dice'); // a click must not invent state
});

test('a precondition refuses before the game is touched', async () => {
  const { tools, game, world } = setup();

  const missing = await tools.run('click', { label: 'Cash out' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not on the table/);
  assert.deepEqual(game.calls, []);

  world.set('phase', 'playing');
  const midRound = await tools.run('set_stake', { value: 0 });
  assert.equal(midRound.ok, false);
  assert.match(midRound.error, /mid-round/);
  assert.deepEqual(game.calls, []);
});

test('bad arguments are refused like any other precondition', async () => {
  const { tools, game } = setup();
  for (const [name, args] of [
    ['set_stake', { value: -1 }],
    ['set_multiplier', { value: 1 }],
    ['set_win_chance', { value: 500 }],
    ['say', { text: '' }],
    ['nonsense', {}],
  ]) {
    const res = await tools.run(name, args);
    assert.equal(res.ok, false, `${name} should be refused`);
    assert.equal(typeof res.error, 'string');
  }
  assert.deepEqual(game.calls, []);
});

test('setters write only values verified by the browser', async () => {
  const { tools, world, game } = setup();

  const stake = await tools.run('set_stake', { value: 0 });
  assert.equal(stake.ok, true);
  assert.equal(world.get().stake, 0);
  assert.deepEqual(game.calls, [['setStake', 0]]);

  const chance = await tools.run('set_win_chance', { value: 40 });
  assert.equal(chance.ok, true);
  assert.equal(world.get().winChance, 40);
});

test('change_game is idempotent: a second call is a no-op, not a reload', async () => {
  const { tools, world, game } = setup();

  const first = await tools.run('change_game', { game: 'Mines' });
  assert.equal(first.ok, true);
  assert.equal(world.get().game, 'Mines');
  assert.deepEqual(game.calls, [['openGameByCard', 'Mines']]);

  const again = await tools.run('change_game', { game: 'mines' });
  assert.equal(again.ok, true);
  assert.equal(again.detail.changed, false);
  assert.equal(game.calls.length, 1);
});

test('change_game is refused mid-round', async () => {
  const { tools, game } = setup({ phase: 'playing' });
  const res = await tools.run('change_game', { game: 'Mines' });
  assert.equal(res.ok, false);
  assert.match(res.error, /mid-round/);
  assert.deepEqual(game.calls, []);
});

test('choose_tile clicks the tile button when the table shows one', async () => {
  const { tools, game } = setup({ phase: 'playing', controls: ['Tile 1', 'Tile 2', 'Tile 3'] });
  const res = await tools.run('choose_tile', { n: 3 });
  assert.equal(res.ok, true);
  assert.equal(res.detail.clicked, 'Tile 3');
  assert.deepEqual(game.calls, [['clickText', 'Tile 3']]);
});

test('say emits speak and never touches the game', async () => {
  const { tools, game, speech } = setup();
  const res = await tools.run('say', { text: 'rolling now' });
  assert.equal(res.ok, true);
  assert.deepEqual(speech, [{ text: 'rolling now', kind: 'say' }]);
  assert.deepEqual(game.calls, []);
});

test('every call is recorded as an action, success or failure', async () => {
  const { tools, actions } = setup();

  await tools.run('click', { label: 'Bet' });
  await tools.run('click', { label: 'Nope' });

  assert.equal(actions.length, 2);
  assert.deepEqual(
    { tool: actions[0].tool, args: actions[0].args, ok: actions[0].ok },
    { tool: 'click', args: { label: 'Bet' }, ok: true },
  );
  assert.equal(typeof actions[0].ms, 'number');
  assert.deepEqual(actions[1].args, { label: 'Nope' });
  assert.equal(actions[1].ok, false);
  assert.deepEqual(Object.keys(actions[0]).sort(), ['args', 'ms', 'ok', 'tool']);
});

test('a throwing game method is an error, never an exception', async () => {
  const { tools } = setup({}, {
    async setStake() {
      throw new Error('socket closed');
    },
  });

  const res = await tools.run('set_stake', { value: 0 });
  assert.equal(res.ok, false);
  assert.match(res.error, /socket closed/);

  const missingMethod = setup({}, { setStake: undefined, setBetAmount: undefined, setStakeValue: undefined });
  const refused = await missingMethod.tools.run('set_stake', { value: 0 });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /stake input/);
});

test('the game answering ok:false fails the tool with its reason', async () => {
  const { tools } = setup({}, {
    async clickText() {
      return { ok: false, error: 'not found' };
    },
  });
  const res = await tools.run('click', { label: 'Bet' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not found');
});
