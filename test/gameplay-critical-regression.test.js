import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/core/controller.js';
import { Planner } from '../src/core/planner.js';
import { World } from '../src/core/world.js';
import { PlayQueue } from '../src/play-queue.js';
import { varietyPlay } from '../src/core/variety.js';
import { inferPhase, labelMatchesPlay, matchPlayClick, preferInRoundLabels } from '../src/core/play-labels.js';

function fixture(gameName = 'Dice', controls = ['Bet'], phase = 'idle') {
  const world = new World({ game: gameName, phase, controls, stake: 0 });
  const calls = [];
  const game = {
    async setStake(value) { calls.push(['stake', value]); return { ok: true, verified: true, observed: 0, settings: { stake: 0 } }; },
    async clickText(label) { calls.push(['click', label]); return { ok: true, text: label }; },
    async clickMinesTile() { calls.push(['tile']); return { ok: true, text: 'tile' }; },
    getReport: () => ({ outcome: null }),
  };
  const tools = { async run(name, args) { calls.push([name, args]); return { ok: true }; } };
  const planner = new Planner({ world });
  planner.setGoal({ game: gameName, rounds: 1 });
  const c = new Controller({ world, game, tools, planner, verifier: { async waitFor() { return { ok: false, error: 'timeout' }; } } });
  c._active = true;
  return { c, world, game, calls, planner };
}
const start = { kind: 'start_round', args: { label: 'Bet' } };

test('recent cashout pointer does not suppress a deliberately chosen cashout', async () => {
  const f = fixture('Hilo', ['Cash out $ 0.00', 'Bet'], 'playing');
  f.game.lastPointer = { text: 'Cash out', at: Date.now() };
  await f.c._executeStep(start);
  assert.equal(f.calls.find(x => x[0] === 'click')?.[1], 'Cash out');
});

test('Road in-round GO wins even if terminal Bet label remains visible', async () => {
  const f = fixture("Hubie's Road", ['Bet', 'GO'], 'playing');
  delete f.game.clickMinesTile;
  await f.c._executeStep(start);
  assert.equal(f.calls.find(x => x[0] === 'click')?.[1], 'GO');
});

test('ordinary completed rounds do not rearm the rotation deadline', async () => {
  const f = fixture(); let arms = 0;
  f.c.rotation = { arm() { arms++; }, next() { return 'Dice'; } };
  f.c.verifier.waitFor = async () => ({ ok: true });
  await f.c.tick(); await f.c.tick(); await f.c.tick();
  assert.equal(f.c.status().completed, 1);
  assert.equal(arms, 0);
});

test('held queue request continues playing while waiting to switch', async () => {
  const f = fixture(); const q = new PlayQueue();
  q.enqueue({ name: 'a', game: 'Dice' }); q.enqueue({ name: 'b', game: 'Keno' });
  q.holdMs(Date.now()); f.c.playQueue = q; f.c._active = false;
  await f.c.tick(); await f.c.tick(); await f.c.tick();
  assert.ok(f.calls.some(x => x[0] === 'click' && x[1] === 'Bet'));
  assert.equal(q.peek().game, 'Dice');
});

test('unverified demo attempts never increment completed rounds', async () => {
  const f = fixture('Keno');
  await f.c.tick(); await f.c.tick(); await f.c.tick();
  assert.equal(f.c.status().completed, 0);
  assert.equal(f.c.status().demoAttempts, 1);
  assert.equal(f.planner.status().failed, false);
});

test('midround requested switch drains actual adapter and defers navigation until the round is settled', async () => {
  const f = fixture('Keno', ['Higher / same', 'Lower / same', 'Cash out $ 0.00'], 'playing');
  f.world.set('game', 'Hilo');
  await f.c.tick();
  assert.equal(f.calls.some(x => x[0] === 'change_game'), false);
  assert.equal(f.calls.some(x => x[0] === 'click' && /^\d+$/.test(x[1])), false);
  assert.ok(f.calls.some(x => x[0] === 'click' && /^(Higher|Lower|Cash out)$/.test(x[1])));
  assert.equal(f.planner.status().step, 0);
  f.world.set('phase', 'idle'); f.world.set('controls', ['Bet']);
  await f.c.tick();
  f.c._noteSettled();
  await f.c.tick();
  assert.ok(f.calls.some(x => x[0] === 'change_game' && x[1].game === 'Keno'));
});

test('capture recovery pauses ticks and chat mutations without consuming planner steps', async () => {
  for (const flag of ['captureRecoveryInFlight', 'recoveryInFlight']) {
    const f = fixture(); f.game[flag] = Promise.resolve();
    await f.c.tick();
    for (const kind of ['start_round', 'hit', 'set_stake', 'set_multiplier', 'change_game'])
      await f.c.handle({ kind, args: { value: 0, game: 'Mines' } });
    assert.equal(f.calls.length, 0);
    assert.equal(f.planner.status().step, 0);
    f.game[flag] = null;
    await f.c.tick();
    assert.equal(f.planner.status().step, 1);
  }
});

test('recovery beginning during stake verification prevents the subsequent click', async () => {
  const f = fixture();
  f.game.setStake = async () => { f.game.captureRecoveryInFlight = true; return { ok: true, verified: true, observed: 0 }; };
  const r = await f.c._executeStep(start);
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 0);
});

test('controller verifies setStake(0) readback before any gameplay click', async () => {
  for (const direct of [false, true]) {
    const f = fixture();
    if (direct) await f.c.handle({ kind: 'start_round' });
    else await f.c._executeStep(start);
    assert.deepEqual(f.calls[0], ['stake', 0]);
  }
});

test('positive or missing stake readback blocks all gameplay mutations', async () => {
  for (const readback of [{ ok: true, verified: true, observed: 5 }, { ok: true }, { ok: false, observed: 0 }]) {
    for (const intent of [null, { kind: 'start_round' }, { kind: 'hit' }, { kind: 'pick_tile', args: { n: 2 } }]) {
      const f = fixture('Mines');
      f.game.setStake = async () => readback;
      if (intent) await f.c.handle(intent); else assert.equal((await f.c._executeStep(start)).ok, false);
      assert.equal(f.calls.length, 0, JSON.stringify({ readback, intent, calls: f.calls }));
    }
  }
});

test('Blackjack insurance decline is recognized and played before other actions', async () => {
  assert.equal(matchPlayClick('No thanks', ['Insurance', 'No thanks']), 'No thanks');
  assert.equal(inferPhase(['No thanks', 'Bet']), 'playing');
  const f = fixture('Blackjack', ['No thanks', 'Bet'], 'playing');
  await f.c._executeStep(start);
  assert.equal(f.calls.find(x => x[0] === 'click')?.[1], 'No thanks');
});

test('Road terminal Bet is not overridden by its still-active GO', async () => {
  assert.equal(varietyPlay("Hubie's Road", ['Bet', 'GO']), 'Bet');
  const f = fixture("Hubie's Road", ['Bet', 'GO']);
  await f.c._executeStep(start);
  assert.equal(f.calls.find(x => x[0] === 'click')?.[1], 'Bet');
});

test('Hilo can choose cashout and in-round ranking preserves the chosen action', () => {
  const controls = ['Higher / same', 'Lower / same', 'Skip card', 'Cash out $ 0.00'];
  const choices = new Set([0, 0.26, 0.51, 0.76, 0.99].map(n => varietyPlay('Hilo', controls, () => n)));
  assert.equal(choices.has('Cash out'), true);
  assert.equal(preferInRoundLabels(['Cash out', 'Higher', 'Lower', 'Bet'], { phase: 'playing', controls })[0], 'Cash out');
});

test('zero-value demo cashout is an allowed visible control', () => {
  assert.equal(labelMatchesPlay('Cash out', 'Cash out $ 0.00'), true);
  assert.equal(matchPlayClick('Cash out', ['Cash out $ 0.00']), 'Cash out');
  assert.equal(varietyPlay('Mines', ['Cash out $ 0.00', 'Random pick'], () => 0), 'Cash out');
});

test('Keno picks multiple distinct spots before Bet', async () => {
  const f = fixture('Keno', ['Bet']);
  await f.c._executeStep(start);
  const labels = f.calls.filter(x => x[0] === 'click').map(x => x[1]);
  const numbers = labels.filter(x => /^\d+$/.test(x));
  assert.ok(numbers.length >= 2 && numbers.length <= 4, labels.join(','));
  assert.equal(new Set(numbers).size, numbers.length);
  assert.equal(labels.at(-1), 'Bet');
});

test('configuration chips continue to Bet in the same start step', async () => {
  const f = fixture('Wheel', ['Bet', 'Low']);
  await f.c._executeStep(start);
  assert.deepEqual(f.calls.filter(x => x[0] === 'click'), [['click', 'Low'], ['click', 'Bet']]);
});

test('Mines preselection continues to Bet in the same start step', async () => {
  const f = fixture('Mines', ['Bet', 'Random pick']);
  const r = await f.c._executeStep(start);
  assert.equal(r.ok, true);
  assert.deepEqual(f.calls.filter(x => x[0] !== 'stake'), [['tile'], ['click', 'Bet']]);
});
