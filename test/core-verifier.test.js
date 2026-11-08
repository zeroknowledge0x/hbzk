// The verifier is the timing boundary of the host: it must notice a change quickly and
// give up on time. Both halves are tested — a fake world that moves after a couple of
// polls, and one that never moves, where the only acceptable outcome is a fast timeout.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Verifier } from '../src/core/verifier.js';

// Each get() hands out the next state, then keeps repeating the last one. waitFor reads
// one snapshot before the first poll, so the array is consumed from index 0.
function seqWorld(states) {
  let i = 0;
  return {
    reads: () => i,
    get() {
      const s = states[Math.min(i, states.length - 1)];
      i += 1;
      return { ...s };
    },
  };
}

const frozen = (state) => ({ get: () => ({ ...state }) });

test('round_started resolves once the phase turns playing', async () => {
  const world = seqWorld([
    { phase: 'betting', round: 4, at: 1 },
    { phase: 'betting', round: 4, at: 2 },
    { phase: 'playing', round: 4, at: 3 },
  ]);
  const v = new Verifier({ world });

  const res = await v.waitFor('round_started', { timeout: 2000 });
  assert.equal(res.ok, true);
  assert.equal(res.detail.match, 'phase');
  assert.equal(res.detail.phase, 'playing');
  assert.equal(res.detail.round, 4);
  assert.equal(typeof res.detail.ms, 'number');
});

test('round_started also accepts a new round number while already playing', async () => {
  const world = seqWorld([
    { phase: 'playing', round: 7, at: 1 },
    { phase: 'playing', round: 7, at: 2 },
    { phase: 'playing', round: 8, at: 3 },
  ]);
  const v = new Verifier({ world });

  const res = await v.waitFor('round_started', { timeout: 2000 });
  assert.equal(res.ok, true);
  assert.equal(res.detail.match, 'round');
  assert.equal(res.detail.round, 8);
});

test('round_result waits for lastResult to change', async () => {
  const world = seqWorld([
    { phase: 'playing', round: 2, lastResult: { value: 3, won: false }, at: 1 },
    { phase: 'playing', round: 2, lastResult: { value: 3, won: false }, at: 2 },
    { phase: 'result', round: 2, lastResult: { value: 6, won: true }, at: 3 },
  ]);
  const v = new Verifier({ world });

  const res = await v.waitFor('round_result', { timeout: 2000 });
  assert.equal(res.ok, true);
  assert.equal(res.detail.match, 'lastResult');
  assert.deepEqual(res.detail.lastResult, { value: 6, won: true });
});

test('round_result can fall back to the game report when the world lags', async () => {
  const started = Date.now();
  const game = {
    // The report is the tie-breaker: it flips 100ms in, while the world stays at null.
    getReport: () => ({ outcome: Date.now() - started > 100 ? { won: true } : null, ts: Date.now() }),
  };
  const v = new Verifier({ world: frozen({ phase: 'result', lastResult: null }), game });

  const res = await v.waitFor('round_result', { timeout: 1500 });
  assert.equal(res.ok, true);
  assert.equal(res.detail.match, 'outcome');
});

test('bet_zero accepts a zero stake and the configured stake, and nothing else', async () => {
  const zero = new Verifier({ world: frozen({ stake: 0 }) });
  assert.equal((await zero.waitFor('bet_zero', { timeout: 300 })).detail.match, 'stake_zero');

  const configured = new Verifier({ world: frozen({ stake: 0.01 }), stake: 0.01 });
  assert.equal((await configured.waitFor('bet_zero', { timeout: 300 })).detail.match, 'stake_config');

  const wrong = new Verifier({ world: frozen({ stake: 5 }), stake: 0.01 });
  const res = await wrong.waitFor('bet_zero', { timeout: 200 });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'timeout');
});

test('game_is matches the world and, failing that, the page title', async () => {
  const direct = new Verifier({ world: frozen({ game: 'Mines' }) });
  const hit = await direct.waitFor('game_is', { game: 'mines' });
  assert.equal(hit.ok, true);
  assert.equal(hit.detail.match, 'game');

  const titled = new Verifier({
    world: frozen({ game: null }),
    game: { getReport: () => ({ title: 'Mines — HouseBets', url: 'https://www.housebets.com/casino' }) },
  });
  const viaPage = await titled.waitFor('game_is', { value: 'Mines' });
  assert.equal(viaPage.ok, true);
  assert.equal(viaPage.detail.match, 'page');
});

test('a world that never changes times out on schedule, not later', async () => {
  const v = new Verifier({ world: frozen({ phase: 'betting', round: 1, at: 1 }), poll: 50 });

  const t0 = Date.now();
  const res = await v.waitFor('round_started', { timeout: 300 });
  const elapsed = Date.now() - t0;

  assert.equal(res.ok, false);
  assert.equal(res.error, 'timeout');
  assert.ok(elapsed >= 290, `gave up early after ${elapsed}ms`);
  assert.ok(elapsed < 300 + 250, `overshot the hard bound: ${elapsed}ms`);
});

test('a zero timeout still checks once, immediately', async () => {
  const v = new Verifier({ world: frozen({ phase: 'playing' }) });
  const t0 = Date.now();
  const res = await v.waitFor('round_started', { timeout: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'timeout');
  assert.ok(Date.now() - t0 < 100);
});

test('unknown checks and missing targets fail fast instead of polling', async () => {
  const v = new Verifier({ world: frozen({ game: 'Dice' }) });

  const t0 = Date.now();
  const unknown = await v.waitFor('round_done', { timeout: 5000 });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown check/);

  const noTarget = await v.waitFor('game_is', { timeout: 5000 });
  assert.equal(noTarget.ok, false);
  assert.match(noTarget.error, /needs a game/);
  assert.ok(Date.now() - t0 < 100);
});

test('a world that throws reads as "nothing yet" and still times out', async () => {
  const v = new Verifier({
    world: {
      get() {
        throw new Error('perception offline');
      },
    },
  });
  const t0 = Date.now();
  const res = await v.waitFor('round_result', { timeout: 150 });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'timeout');
  assert.ok(Date.now() - t0 < 150 + 250);
});
