// The click is whatever the model picked after it saw the table. A random policy is not a fallback.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Controller } from '../src/core/controller.js';
import { Planner } from '../src/core/planner.js';
import { World } from '../src/core/world.js';
import { pickFromReply, compressControls, legalControls, resolveLookedClick, withBudget } from '../src/core/look-then-click.js';
test('a missing stake field waits, a non-zero readback does not', async () => {
  const world = new World({ game: 'Dice', phase: 'idle', controls: ['Bet'], stake: 0 });
  const planner = new Planner({ world });
  planner.setGoal({ game: 'Dice', rounds: 1 });
  const clicks = [];
  const make = (setStake) => new Controller({
    world, planner,
    game: { setStake, clickText: async (label) => { clicks.push(label); return { ok: true, text: label }; }, getReport: () => ({}) },
    tools: { run: async () => ({ ok: false }) },
    verifier: { waitFor: async () => ({ ok: false }) },
    log: () => {},
  });
  const waiting = await make(async () => ({ ok: false, error: 'No stake control on this table' }))
    ._executeStep({ kind: 'start_round', args: { label: 'Bet' } });
  assert.equal(waiting.deferred, true);
  const painting = await make(async () => ({ ok: false, pending: true, error: 'stake control is not ready' }))
    ._executeStep({ kind: 'start_round', args: { label: 'Bet' } });
  assert.equal(painting.deferred, true);
  assert.deepEqual(clicks, []);
  const refused = await make(async () => ({ ok: false, error: 'stake control is locked at 25' }))
    ._executeStep({ kind: 'start_round', args: { label: 'Bet' } });
  assert.equal(refused.deferred, undefined);
  assert.equal(refused.ok, false);
  assert.deepEqual(clicks, []);
});

test('an empty table waits instead of failing the round', async () => {
  const calls = [];
  const c = looked('Max Win', [], 'Bet', calls);
  const result = await c._executeStep({ kind: 'start_round', args: { label: 'Bet' } });
  assert.equal(result.deferred, true);
  assert.equal(calls.filter((x) => typeof x === 'string').length, 0);
});

test('a hung page read expires instead of freezing the click loop', async () => {
  const out = await withBudget(new Promise(() => {}), 40, 'setStake');
  assert.equal(out.pending, true);
  assert.match(out.error, /timed out/);
});

test('a sentence still resolves to the control it named, and Hit anyway beats Hit', () => {
  const controls = ['Hit', 'Stand', 'Hit anyway', 'Cancel'];
  assert.equal(pickFromReply('I would stand here.', controls), 'Stand');
  assert.equal(pickFromReply('Hit anyway, the warning is just a warning.', controls), 'Hit anyway');
  assert.equal(pickFromReply('none', controls), null);
});

test('a looked click is the label the model named, and only if it is on the table', () => {
  const controls = ['Hit', 'Stand', 'Cancel', 'Hit anyway', 'Wallet', 'Bet Amount 0.00'];
  assert.equal(resolveLookedClick({ controls, pick: 'Stand' }), 'Stand');
  assert.equal(resolveLookedClick({ controls, pick: 'Hit anyway' }), 'Hit anyway');
  assert.equal(resolveLookedClick({ controls, pick: 'Wallet' }), null);
  assert.equal(resolveLookedClick({ controls, pick: 'Bet Amount' }), null);
  assert.equal(resolveLookedClick({ controls, pick: 'Fold' }), null);
  assert.equal(resolveLookedClick({ controls, pick: '' }), null);
});

test('chrome and stake traps are not offered to the model', () => {
  const offered = legalControls([
    'Hit', 'Stand', 'Wallet', 'Bet Amount 0.00', '2× Double bet amount (S)',
    'IDR 99,674', 'Weekly Prize', 'Search', 'Account', 'Hit anyway', 'Live stats', 'Advanced', 'Instant autobet', 'Switch to Roll Under', 'Switch to Inside range', 'Casino Lobby', 'Rewards Bronze', 'More games',
  ]);
  assert.deepEqual(offered, ['Hit', 'Stand', 'Hit anyway']);
  assert.deepEqual(legalControls(['Bet', 'Manual', 'Auto', 'Add to favorites']), ['Bet']);
  assert.deepEqual(legalControls(['Cash out 0 1.00x', 'Cash out IDR 0', 'Cash out 2.40x', 'Higher']), ['Cash out 2.40x', 'Higher']);
});

test('a long board is compressed without dropping the decision buttons', () => {
  const board = ['Cash out 2.40x', 'Random tile'];
  for (let i = 1; i <= 25; i++) board.push(`Tile ${i}`);
  const packed = compressControls(board, 8);
  assert.ok(packed.length <= 8, String(packed.length));
  assert.ok(packed.some((c) => /cash out/i.test(c)));
  assert.ok(packed.some((c) => /random tile/i.test(c)));
  assert.ok(packed.some((c) => /more/.test(c)), packed.join(' | '));
});

function looked(name, controls, pick, calls) {
  const world = new World({ game: name, phase: 'playing', controls, stake: 0 });
  const planner = new Planner({ world });
  planner.setGoal({ game: name, rounds: 1 });
  const game = {
    setStake: async () => ({ ok: true, verified: true, observed: 0 }),
    clickText: async (label) => { calls.push(label); return { ok: true, text: label }; },
    clickMinesTile: async () => { calls.push('RANDOM-TILE'); return { ok: true }; },
    getReport: () => ({ url: '' }),
  };
  const c = new Controller({
    world, planner, game,
    tools: { run: async () => ({ ok: false }) },
    verifier: { waitFor: async () => ({ ok: false }) },
    random: () => 0,
    log: () => {},
    look: async (view) => {
      calls.push(['look', view.game, view.controls.slice()]);
      return pick;
    },
  });
  return c;
}

test('every table asks the model before it clicks, and a silent model clicks nothing', async () => {
  const clicks = [];
  const c = looked('Blackjack', ['Hit', 'Stand', 'Cancel', 'Hit anyway'], 'Stand', clicks);
  const ok = await c._executeStep({ kind: 'start_round', args: { label: 'Bet' } });
  assert.equal(ok.ok, true);
  assert.equal(clicks[0][0], 'look');
  assert.ok(clicks[0][2].includes('Hit anyway'), 'the dialog was in what the model saw');
  assert.deepEqual(clicks.slice(1), ['Stand']);

  const none = [];
  const stalled = looked('Dice', ['Bet', 'Over', 'Under', 'Inside', 'Outside'], null, none);
  const missed = await stalled._executeStep({ kind: 'start_round', args: { label: 'Bet' } });
  assert.equal(missed.ok, false);
  assert.deepEqual(none.filter((x) => typeof x === 'string'), [], 'no random chip, no random Bet');
});

test('Mines does not fall through to a random tile when the model has not looked', async () => {
  const calls = [];
  const board = ['Cash out 2.40x', 'Random tile', 'Tile 1', 'Tile 2'];
  const c = looked('Mines', board, 'Cash out 2.40x', calls);
  await c._executeStep({ kind: 'start_round', args: { label: 'Bet' } });
  assert.equal(calls.includes('RANDOM-TILE'), false);
  assert.equal(calls.at(-1), 'Cash out 2.40x');
});

test('chooseClick sends the control list to deepseek 4.1 flash and returns the named label', async () => {
  const { Brain } = await import('../src/brain.js');
  let sent = null;
  const brain = new Brain(
    { llmUrl: 'https://llm.test/v1', llmModel: 'deepseek/deepseek-v4.1-flash', llmKey: 'k' },
    {
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'Medium' } }] }) };
      },
    },
  );
  const label = await brain.chooseClick({
    game: 'Wheel', phase: 'idle', controls: ['Bet', 'Low', 'Medium', 'High'], progress: 0,
    seen: 'Hit on 20? Most cards bust a hard 20.',
  });
  assert.equal(label, 'Medium');
  assert.equal(sent.model, 'deepseek/deepseek-v4.1-flash');
  assert.match(sent.messages[1].content, /ON SCREEN: Hit on 20/);
  assert.match(sent.messages[1].content, /Wheel/);
  assert.match(sent.messages[1].content, /Medium/);
  assert.match(sent.messages[0].content, /no script/i);
  assert.match(sent.messages[1].content, /label FIRST/i, 'the answer comes first, so a cut-off reply still carries it');
});

test('the decision runs on its own model when one is configured', async () => {
  const { Brain } = await import('../src/brain.js');
  let sent = null;
  const brain = new Brain(
    {
      llmUrl: 'https://llm.test/v1',
      llmModel: 'deepseek/deepseek-v4.1-flash',
      llmDecisionModel: 'claude-sonnet-5-5',
      llmKey: 'k',
    },
    {
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'Bet' } }] }) };
      },
    },
  );
  const label = await brain.chooseClick({ game: 'Wheel', phase: 'idle', controls: ['Bet'], progress: 0 });
  assert.equal(label, 'Bet');
  assert.equal(sent.model, 'claude-sonnet-5-5');
});

test('a table switch waits for the round that is already on the table', async () => {
  const calls = [];
  const changed = [];
  let clock = 1000000;
  const world = new World({ game: 'Mines', phase: 'idle', controls: ['Random tile', 'Cash out 2.40x', 'Bet'], stake: 0 });
  const planner = new Planner({ world });
  planner.setGoal({ game: 'Mines', rounds: 1 });
  const c = new Controller({
    world,
    planner,
    game: {
      setStake: async () => ({ ok: true, verified: true, observed: 0 }),
      clickText: async (label) => { calls.push(label); return { ok: true, text: label }; },
      getReport: () => ({ url: '' }),
    },
    tools: { run: async (name, args) => { if (name === 'change_game') changed.push(args?.game); return { ok: true }; } },
    verifier: { waitFor: async () => ({ ok: false }) },
    random: () => 0,
    now: () => clock,
    log: () => {},
    look: async () => 'Random tile',
  });
  const bet = await c._executeStep({ kind: 'start_round', args: { label: 'Bet' } });
  assert.equal(bet.ok, true);

  // A planner step aimed at another table must not walk off mid-round.
  const step = await c._executeStep({ kind: 'enter_game', args: { game: 'Dice' } });
  assert.equal(changed.includes('Dice'), false, 'no switch while the bet is live');
  assert.equal(step.deferred, true);

  const said = [];
  c.speak = (line) => said.push(line);
  await c.handle({ kind: 'change_game', args: { game: 'Dice' } }, {});
  assert.equal(changed.includes('Dice'), false);
  assert.equal(c._deferredGame, 'Dice', 'the switch is kept, not dropped');
  assert.ok(said.some((l) => /finishing/i.test(l)), said.join(' | '));

  // Once the round settles the deferred switch runs by itself.
  clock += 5000;
  c._noteSettled();
  await c.tick();
  assert.equal(c._deferredGame, null);
  assert.equal(planner.status().goal.game, 'Dice');
});

test('a fallback held by the same bet leaves the table instead of spinning', async () => {
  const changed = [];
  let clock = 500000;
  const world = new World({ game: 'Hilo', phase: 'idle', controls: ['Higher / same', 'Lower / same', 'Bet'], stake: 0 });
  const planner = new Planner({ world });
  planner.setGoal({ game: 'Hilo', rounds: 1 });
  const c = new Controller({
    world,
    planner,
    game: {
      setStake: async () => ({ ok: true, verified: true, observed: 0 }),
      clickText: async (label) => ({ ok: true, text: label }),
      getReport: () => ({ url: '' }),
    },
    tools: { run: async (name, args) => { if (name === 'change_game') changed.push(args?.game); return { ok: true }; } },
    verifier: { waitFor: async () => ({ ok: false }) },
    random: () => 0,
    now: () => clock,
    log: () => {},
    look: async () => 'Bet',
  });
  await c._executeStep({ kind: 'start_round', args: { label: 'Bet' } });

  const step = { kind: 'enter_game', tool: 'change_game', args: { game: 'Dice' }, fallback: true };
  const first = await c._executeStep(step);
  const second = await c._executeStep(step);
  assert.equal(changed.includes('Dice'), false, 'the first holds still wait for the round');
  assert.equal(first.deferred, true);
  assert.equal(second.deferred, true);
  const third = await c._executeStep(step);
  assert.equal(changed.includes('Dice'), true, 'a round that never settles is abandoned');
  assert.equal(c._roundLive(), false);
  assert.equal(third.ok, true);
});

test('a second wait on the same table is short', async () => {
  let clock = 0;
  const world = new World({ game: 'Dragon Tower', phase: 'idle', controls: ['Bet'], stake: 0 });
  const planner = new Planner({ world });
  const c = new Controller({
    world,
    planner,
    game: {
      setStake: async () => ({ ok: false, error: 'stake control is not ready' }),
      clickText: async () => ({ ok: false }),
      getReport: () => ({}),
    },
    tools: { run: async () => ({ ok: false }) },
    verifier: { waitFor: async () => ({ ok: false }) },
    now: () => clock,
    log: () => {},
  });
  clock = 13000;
  const firstPass = await c._verifyZeroStake();
  assert.equal(firstPass.deferred, true, 'the long wait starts as a wait');
  clock = 26000;
  const first = await c._verifyZeroStake();
  assert.equal(first.skipped, true, 'the long wait ends in a skipped write, not a failed round');

  clock = 27500;
  const waiting = await c._verifyZeroStake();
  assert.equal(waiting.deferred, true, 'a short wait is still a wait');

  clock = 29100;
  const second = await c._verifyZeroStake();
  assert.equal(second.skipped, true, '1.5s is enough the second time, not another 12s');
});

