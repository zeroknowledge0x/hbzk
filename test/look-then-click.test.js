// The click is whatever the model picked after it saw the table. A random policy is not a fallback.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Controller } from '../src/core/controller.js';
import { Planner } from '../src/core/planner.js';
import { World } from '../src/core/world.js';
import { pickFromReply, compressControls, legalControls, resolveLookedClick } from '../src/core/look-then-click.js';
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
    'IDR 99,674', 'Weekly Prize', 'Search', 'Account', 'Hit anyway',
  ]);
  assert.deepEqual(offered, ['Hit', 'Stand', 'Hit anyway']);
});

test('a long board is compressed without dropping the decision buttons', () => {
  const board = ['Cash out $0.00', 'Random tile'];
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
  const board = ['Cash out $0.00', 'Random tile', 'Tile 1', 'Tile 2'];
  const c = looked('Mines', board, 'Cash out', calls);
  await c._executeStep({ kind: 'start_round', args: { label: 'Bet' } });
  assert.equal(calls.includes('RANDOM-TILE'), false);
  assert.equal(calls.at(-1), 'Cash out');
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
});
