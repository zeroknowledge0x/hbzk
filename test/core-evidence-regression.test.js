// Regression tests for tools.js safety model v2.
// These tests verify the zero-stake policy, verified API contract, serialized run(),
// exact path matching for change_game, click safety, and concurrency.
//
// NOTE: The old test/core-tools.test.js expects optimistic non-zero set_stake success.
// That behavior is UNSAFE and intentionally removed. Those old assertions will fail.
// This file replaces them with safe expectations.

import assert from 'node:assert/strict';
import test from 'node:test';
import { Tools } from '../src/core/tools.js';

// --- Minimal world (no import needed, just a get/set object) ---
function makeWorld(initial = {}) {
  const state = { phase: 'betting', controls: ['Bet', 'Roll', 'Manual'], game: 'Dice', ...initial };
  return {
    get() { return { ...state }; },
    set(key, value) { state[key] = value; },
  };
}

// --- Minimal bus ---
function makeBus() {
  const events = [];
  return {
    emit(type, payload) { events.push({ type, payload }); },
    events,
  };
}

// --- Fake game with verified API envelope ---
function makeGame(overrides = {}) {
  const calls = [];
  const observed = { stake: 0, multiplier: 2, winChance: 50 };
  const game = {
    calls,
    async setStake(value) {
      calls.push(['setStake', value]); observed.stake = value;
      return { ok: true, observed: value, verified: true, settings: { stake: value } };
    },
    async setMultiplier(value) {
      calls.push(['setMultiplier', value]); observed.multiplier = value;
      return { ok: true, observed: value, verified: true, settings: { multiplier: value } };
    },
    async setWinChance(value) {
      calls.push(['setWinChance', value]); observed.winChance = value;
      return { ok: true, observed: value, verified: true, settings: { winChance: value } };
    },
    async clickText(label) {
      calls.push(['clickText', label]);
      return { ok: true, clicked: label };
    },
    async openGameByCard(name) {
      calls.push(['openGameByCard', name]);
      return { ok: true };
    },
    readSettings() {
      calls.push(['readSettings']);
      return { ...observed };
    },
    getReport() {
      return null;
    },
    ...overrides,
  };
  return game;
}

function setup(initial = {}, overrides = {}) {
  const bus = makeBus();
  const world = makeWorld(initial);
  const game = makeGame(overrides);
  const tools = new Tools({ game, world, bus });
  return { bus, world, game, tools };
}

// =============================================================================
// ZERO / NONZERO STAKE POLICY
// =============================================================================

test('set_stake rejects nonzero value even if game says success', async () => {
  const { tools, game } = setup();
  const res = await tools.run('set_stake', { value: 5 });
  assert.equal(res.ok, false);
  assert.match(res.error, /zero-stake policy/);
  assert.deepEqual(game.calls, []); // never reached game
});

test('set_stake accepts zero', async () => {
  const { tools, world, game } = setup();
  const res = await tools.run('set_stake', { value: 0 });
  assert.equal(res.ok, true);
  assert.equal(world.get().stake, 0);
  assert.ok(game.calls.some((c) => c[0] === 'setStake' && c[1] === 0));
});

test('set_stake rejects negative value', async () => {
  const { tools, game } = setup();
  const res = await tools.run('set_stake', { value: -1 });
  assert.equal(res.ok, false);
  assert.match(res.error, /zero-stake policy/);
  assert.deepEqual(game.calls, []);
});

test('set_stake rejects null/undefined value', async () => {
  const { tools } = setup();
  const res1 = await tools.run('set_stake', { value: null });
  assert.equal(res1.ok, false);
  const res2 = await tools.run('set_stake', { value: undefined });
  assert.equal(res2.ok, false);
});

// =============================================================================
// MISMATCHED SETTER (verified API returns wrong observed)
// =============================================================================

test('set_multiplier rejects when observed does not match requested', async () => {
  const { tools, world } = setup({}, {
    async setMultiplier(value) {
      return { ok: true, observed: 99, verified: true, settings: { multiplier: 99 } };
    },
    readSettings() {
      return { multiplier: 99 };
    },
  });
  const res = await tools.run('set_multiplier', { value: 2 });
  assert.equal(res.ok, false);
  assert.match(res.error, /mismatch/);
  assert.equal(world.get().multiplier, undefined); // world not updated
});

test('set_win_chance rejects when observed does not match requested', async () => {
  const { tools, world } = setup({}, {
    async setWinChance(value) {
      return { ok: true, observed: 99, verified: true, settings: { winChance: 99 } };
    },
    readSettings() {
      return { winChance: 99 };
    },
  });
  const res = await tools.run('set_win_chance', { value: 50 });
  assert.equal(res.ok, false);
  assert.match(res.error, /mismatch/);
  assert.equal(world.get().winChance, undefined);
});

test('set_stake rejects when game returns nonzero observed for zero request', async () => {
  const { tools, world } = setup({}, {
    async setStake(value) {
      return { ok: true, observed: 5, verified: true, settings: { stake: 5 } };
    },
    readSettings() {
      return { stake: 5 };
    },
  });
  const res = await tools.run('set_stake', { value: 0 });
  assert.equal(res.ok, false);
  assert.match(res.error, /mismatch|zero-stake/);
  assert.equal(world.get().stake, undefined);
});

// =============================================================================
// NO METHOD RESULT (undefined/null return)
// =============================================================================

test('set_stake fails when game method returns undefined', async () => {
  const { tools } = setup({}, {
    async setStake() {
      return undefined;
    },
  });
  const res = await tools.run('set_stake', { value: 0 });
  assert.equal(res.ok, false);
  assert.match(res.error, /returned no result/);
});

test('set_multiplier fails when game method returns null', async () => {
  const { tools } = setup({}, {
    async setMultiplier() {
      return null;
    },
  });
  const res = await tools.run('set_multiplier', { value: 2 });
  assert.equal(res.ok, false);
  assert.match(res.error, /returned no result/);
});

test('click fails when game method returns undefined', async () => {
  const { tools } = setup({}, {
    async clickText() {
      return undefined;
    },
  });
  const res = await tools.run('click', { label: 'Bet' });
  assert.equal(res.ok, false);
  assert.match(res.error, /returned no result/);
});

test('set_win_chance fails when verified is false', async () => {
  const { tools } = setup({}, {
    async setWinChance(value) {
      return { ok: true, observed: value, verified: false, settings: { winChance: value } };
    },
  });
  const res = await tools.run('set_win_chance', { value: 50 });
  assert.equal(res.ok, false);
  assert.match(res.error, /not verified/);
});

test('set_multiplier fails when observed is missing', async () => {
  const { tools } = setup({}, {
    async setMultiplier(value) {
      return { ok: true, verified: true, settings: { multiplier: value } };
    },
  });
  const res = await tools.run('set_multiplier', { value: 3 });
  assert.equal(res.ok, false);
  assert.match(res.error, /missing readback/);
});

// =============================================================================
// EXACT MULTIWORD PATH FOR CHANGE_GAME
// =============================================================================

test('change_game matches exact pathname /games/housegames-dragon-tower', async () => {
  const { tools, world } = setup({}, {
    getReport() {
      return { url: 'https://housebets.com/games/housegames-dragon-tower', game: 'Dragon Tower' };
    },
  });
  const res = await tools.run('change_game', { game: 'Dragon Tower' });
  assert.equal(res.ok, true);
  assert.equal(res.detail.changed, false);
  assert.equal(world.get().game, 'Dragon Tower');
});

test('change_game does NOT match substring: /games/housegames-dragon-tower-extra is wrong target', async () => {
  const { tools, world } = setup({}, {
    getReport() {
      return { url: 'https://housebets.com/games/housegames-dragon-tower-extra', game: 'Dragon Tower Extra' };
    },
    async openGameByCard(name) {
      return { ok: true };
    },
  });
  // Report shows wrong path, so it should NOT skip; it will try to open.
  // But since openGameByCard succeeds and getReport still shows wrong path,
  // it will fail verification.
  const res = await tools.run('change_game', { game: 'Dragon Tower' });
  assert.equal(res.ok, false);
  assert.match(res.error, /did not open/);
});

test('change_game does NOT fallback to stale world when report exists', async () => {
  const { tools, world } = setup({ game: 'Dice' }, {
    getReport() {
      return { url: 'https://housebets.com/games/housegames-mines', game: 'Mines' };
    },
  });
  // World says Dice, report says Mines. Requesting Dice should NOT skip
  // based on world; report shows we are on Mines.
  const res = await tools.run('change_game', { game: 'Dice' });
  // It will try to open Dice, but report still shows Mines -> fail
  assert.equal(res.ok, false);
  assert.match(res.error, /did not open/);
});

test('change_game with no getReport trusts explicit ok from fake game', async () => {
  const { tools, world } = setup({ game: 'Dice' }, {
    getReport: undefined,
    async openGameByCard(name) {
      return { ok: true };
    },
  });
  const res = await tools.run('change_game', { game: 'Mines' });
  assert.equal(res.ok, true);
  assert.equal(world.get().game, 'Mines');
});

test('change_game idempotent via report exact path match writes world', async () => {
  const { tools, world, game } = setup({ game: 'Dice' }, {
    getReport() {
      return { url: 'https://housebets.com/games/housegames-mines', game: 'Mines' };
    },
  });
  const res = await tools.run('change_game', { game: 'Mines' });
  assert.equal(res.ok, true);
  assert.equal(world.get().game, 'Mines');
  // Should not have called openGameByCard (already on target)
  assert.deepEqual(game.calls.filter((c) => c[0] === 'openGameByCard'), []);
});

// =============================================================================
// WRONG TARGET
// =============================================================================

test('change_game wrong target: report path does not match requested', async () => {
  const { tools } = setup({ game: 'Dice' }, {
    getReport() {
      return { url: 'https://housebets.com/games/crash', game: 'Crash' };
    },
    async openGameByCard(name) {
      return { ok: true };
    },
  });
  const res = await tools.run('change_game', { game: 'Mines' });
  assert.equal(res.ok, false);
  assert.match(res.error, /did not open/);
});

// =============================================================================
// CONCURRENCY (serialized run via promise queue)
// =============================================================================

test('concurrent run calls are serialized: this.current does not race', async () => {
  const { tools, world } = setup();
  const results = [];

  // Fire two set_stake calls concurrently
  const p1 = tools.run('set_stake', { value: 0 });
  const p2 = tools.run('set_stake', { value: 0 });

  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  // Both should have completed without corrupting this.current
  assert.equal(world.get().stake, 0);
});

test('concurrent mixed tools serialize correctly', async () => {
  const { tools, world } = setup({ controls: ['Bet', 'Roll', 'Manual', 'Tile 1'] });

  const p1 = tools.run('set_multiplier', { value: 2 });
  const p2 = tools.run('set_win_chance', { value: 50 });
  const p3 = tools.run('say', { text: 'hello' });

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, true);
  assert.equal(world.get().multiplier, 2);
  assert.equal(world.get().winChance, 50);
});

test('serialized run: second call sees first call world update', async () => {
  const { tools, world } = setup();

  const p1 = tools.run('set_multiplier', { value: 3 });
  const p2 = tools.run('set_win_chance', { value: 40 });

  await Promise.all([p1, p2]);

  assert.equal(world.get().multiplier, 3);
  assert.equal(world.get().winChance, 40);
});

// =============================================================================
// CLICK SAFETY (dangerous labels require zero stake)
// =============================================================================

test('click Bet blocked when readSettings shows nonzero stake', async () => {
  const { tools, game } = setup({}, {
    readSettings() {
      return { stake: 5 };
    },
  });
  const res = await tools.run('click', { label: 'Bet' });
  assert.equal(res.ok, false);
  assert.match(res.error, /blocked.*stake/);
  // clickText should NOT have been called
  assert.deepEqual(game.calls.filter((c) => c[0] === 'clickText'), []);
});

test('click Bet allowed when readSettings shows zero stake', async () => {
  const { tools, game } = setup({}, {
    readSettings() {
      return { stake: 0 };
    },
  });
  const res = await tools.run('click', { label: 'Bet' });
  assert.equal(res.ok, true);
  assert.ok(game.calls.some((c) => c[0] === 'clickText' && c[1] === 'Bet'));
});

test('click Roll blocked without readSettings when world stake nonzero', async () => {
  const { tools, world } = setup({ stake: 5 }, {
    readSettings: undefined,
  });
  const res = await tools.run('click', { label: 'Roll' });
  assert.equal(res.ok, false);
  assert.match(res.error, /blocked.*stake/);
});

test('click Roll allowed without readSettings when world stake is zero (test double fixture)', async () => {
  const { tools, game } = setup({ stake: 0 }, {
    readSettings: undefined,
  });
  const res = await tools.run('click', { label: 'Roll' });
  assert.equal(res.ok, true);
});

test('click Cash out blocked when readSettings shows nonzero stake', async () => {
  const { tools } = setup({controls: ['Cash out']}, {
    readSettings() {
      return { stake: 10 };
    },
  });
  const res = await tools.run('click', { label: 'Cash out' });
  assert.equal(res.ok, false);
  assert.match(res.error, /blocked.*stake/);
});

test('click Deal blocked when readSettings shows nonzero stake', async () => {
  const { tools } = setup({}, {
    readSettings() {
      return { stake: 2 };
    },
  });
  const res = await tools.run('click', { label: 'Deal' });
  assert.equal(res.ok, false);
});

test('click Spin blocked when readSettings shows nonzero stake', async () => {
  const { tools } = setup({}, {
    readSettings() {
      return { stake: 3 };
    },
  });
  const res = await tools.run('click', { label: 'Spin' });
  assert.equal(res.ok, false);
});

test('click Play blocked when readSettings shows nonzero stake', async () => {
  const { tools } = setup({}, {
    readSettings() {
      return { stake: 1 };
    },
  });
  const res = await tools.run('click', { label: 'Play' });
  assert.equal(res.ok, false);
});

test('min bet button is NOT a dangerous label and does not require zero stake', async () => {
  const { tools, game } = setup({ stake: 5, controls: ['Bet', 'Roll', 'Manual', 'Min bet'] }, {
    readSettings() {
      return { stake: 5 };
    },
  });
  const res = await tools.run('click', { label: 'Min bet' });
  assert.equal(res.ok, true);
});

test('half bet button is NOT a dangerous label', async () => {
  const { tools, game } = setup({ stake: 5, controls: ['Bet', 'Roll', 'Manual', '1/2 bet'] }, {
    readSettings() {
      return { stake: 5 };
    },
  });
  const res = await tools.run('click', { label: '1/2 bet' });
  assert.equal(res.ok, true);
});

// =============================================================================
// WORLD UPDATED ONLY WITH OBSERVED (never optimistic)
// =============================================================================

test('set_multiplier updates world with observed value from readSettings', async () => {
  const { tools, world } = setup({}, {
    async setMultiplier(value) {
      return { ok: true, observed: 4, verified: true, settings: { multiplier: 4 } };
    },
    readSettings() {
      return { multiplier: 4 };
    },
  });
  const res = await tools.run('set_multiplier', { value: 4 });
  assert.equal(res.ok, true);
  assert.equal(world.get().multiplier, 4);
});

test('set_win_chance updates world with observed from readSettings', async () => {
  const { tools, world } = setup({}, {
    async setWinChance(value) {
      return { ok: true, observed: 75, verified: true, settings: { winChance: 75 } };
    },
    readSettings() {
      return { winChance: 75 };
    },
  });
  const res = await tools.run('set_win_chance', { value: 75 });
  assert.equal(res.ok, true);
  assert.equal(world.get().winChance, 75);
});

// =============================================================================
// GAME METHOD MISSING (no method on game object)
// =============================================================================

test('set_stake fails when no stake method exists', async () => {
  const { tools } = setup({}, {
    setStake: undefined,
    setBetAmount: undefined,
    setStakeValue: undefined,
  });
  const res = await tools.run('set_stake', { value: 0 });
  assert.equal(res.ok, false);
  assert.match(res.error, /stake input/);
});

test('set_multiplier fails when no multiplier method exists', async () => {
  const { tools } = setup({}, {
    setMultiplier: undefined,
    setPayout: undefined,
  });
  const res = await tools.run('set_multiplier', { value: 2 });
  assert.equal(res.ok, false);
  assert.match(res.error, /multiplier input/);
});

test('change_game fails when no lobby method exists', async () => {
  const { tools } = setup({}, {
    openGameByCard: undefined,
    openGame: undefined,
  });
  const res = await tools.run('change_game', { game: 'Mines' });
  assert.equal(res.ok, false);
  assert.match(res.error, /no lobby/);
});
