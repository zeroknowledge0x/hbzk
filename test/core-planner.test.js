// The planner is only interesting when things fail: a plan that always works is a for
// loop. These tests drive tick()/settle() the way the host does and pin the retry →
// fallback → fail order, which is the part a rewrite is most likely to get wrong.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Bus } from '../src/core/bus.js';
import { World } from '../src/core/world.js';
import { Planner } from '../src/core/planner.js';

function setup(initial = {}) {
  const bus = new Bus();
  const world = new World({ game: 'Dice', phase: 'betting', controls: ['Bet', 'Roll'], ...initial });
  const events = [];
  bus.on('plan', (p) => events.push(p));
  const planner = new Planner({ world, bus });
  return { bus, world, events, planner };
}

// Mirrors the host loop: ask for a step, "await" the tool, report back. A step with no
// tool goes to the verifier, which the fake answers through the same respond().
function drive(planner, respond, limit = 40) {
  const seen = [];
  for (let i = 0; i < limit; i += 1) {
    const step = planner.tick();
    if (!step) break;
    const args = step.args || {};
    seen.push({ kind: step.kind, tool: step.tool, label: args.label, game: args.game });
    planner.settle(respond(step, seen.length - 1));
  }
  return seen;
}

test('a play goal walks enter_game → start_round → await_result once per round', () => {
  const { planner, events } = setup();
  const status = planner.setGoal({ kind: 'play', game: 'Dice', rounds: 2 });

  assert.equal(status.done, false);
  assert.equal(status.failed, false);
  assert.equal(status.total, 6);
  assert.deepEqual(events[0].goal, { kind: 'play', game: 'Dice', rounds: 2 });
  assert.equal(events[0].ok, true);
  assert.deepEqual(
    events[0].steps.map((s) => s.kind),
    ['enter_game', 'start_round', 'await_result', 'enter_game', 'start_round', 'await_result'],
  );

  const seen = drive(planner, () => ({ ok: true }));
  assert.deepEqual(seen.map((s) => s.kind), [
    'enter_game',
    'start_round',
    'await_result',
    'enter_game',
    'start_round',
    'await_result',
  ]);
  assert.equal(seen[0].game, 'Dice');
  assert.equal(seen[0].tool, 'change_game');
  // "Roll" is offered by the table, so the planner must prefer it over the generic "Bet".
  assert.equal(seen[1].label, 'Roll');
  assert.equal(seen[2].tool, null); // await_result belongs to the verifier, not tools.run

  assert.equal(planner.status().done, true);
  assert.equal(planner.status().failed, false);
  assert.equal(planner.tick(), null);
  assert.equal(events.at(-1).ok, true);
});

test('configure steps appear only for settings the goal actually carries', () => {
  const plain = setup();
  plain.planner.setGoal({ kind: 'play', game: 'Dice', rounds: 1 });
  assert.equal(plain.planner.status().total, 3);

  const tuned = setup();
  tuned.planner.setGoal({ kind: 'play', game: 'Dice', rounds: 1, settings: { stake: 5, multiplier: 2, winChance: 40 } });
  const steps = tuned.planner.status();
  assert.equal(steps.total, 6);
  assert.deepEqual(
    tuned.events[0].steps.map((s) => s.tool),
    ['change_game', 'set_stake', 'set_multiplier', 'set_win_chance', 'click', null],
  );
  assert.deepEqual(tuned.events[0].goal.settings, { set_stake: 5, set_multiplier: 2, set_win_chance: 40 });
});

test('a step that fails once is retried, then the round continues', () => {
  const { planner } = setup();
  planner.setGoal({ kind: 'play', game: 'Dice', rounds: 1 });
  let clicks = 0;

  const seen = drive(planner, (step) => {
    if (step.tool === 'click') {
      clicks += 1;
      return clicks === 1 ? { ok: false, error: 'not found' } : { ok: true };
    }
    return { ok: true };
  });

  assert.equal(clicks, 2);
  assert.deepEqual(seen.map((s) => s.kind), ['enter_game', 'start_round', 'start_round', 'await_result']);
  assert.equal(planner.status().done, true);
  assert.equal(planner.status().failed, false);
});

test('a step is not dispatched twice while the host is still awaiting it', () => {
  const { planner } = setup();
  planner.setGoal({ kind: 'play', game: 'Dice', rounds: 1 });

  const first = planner.tick();
  assert.equal(first.kind, 'enter_game');
  assert.equal(planner.tick(), null);
  assert.equal(planner.status().step, 0);
  assert.equal(planner.status().attempts, 0);

  planner.settle({ ok: false, error: 'nope' });
  assert.equal(planner.status().step, 0);
  assert.equal(planner.status().attempts, 1); // one retry left, same index
  assert.equal(planner.tick().kind, 'enter_game');
});

test('a step that keeps failing falls back to enter_game once, then the goal fails', () => {
  const { planner, events } = setup();
  planner.setGoal({ kind: 'play', game: 'Dice', rounds: 2 });

  const seen = drive(planner, (step) =>
    step.tool === 'click' ? { ok: false, error: 'not found' } : { ok: true },
  );

  // enter_game ok → click, retry click → fallback enter_game ok → goal failed.
  assert.deepEqual(seen.map((s) => s.kind), ['enter_game', 'start_round', 'start_round', 'enter_game']);
  assert.equal(seen.at(-1).game, 'Dice');

  const status = planner.status();
  assert.equal(status.failed, true);
  assert.equal(status.done, false);
  assert.match(status.error, /start_round/);
  assert.equal(planner.tick(), null);

  const failure = events.at(-1);
  assert.equal(failure.ok, false);
  assert.match(failure.error, /start_round/);
  assert.equal(failure.step.kind, 'start_round');
  // Exactly one plan event per goal start and one for the failure.
  assert.equal(events.filter((e) => e.ok === false).length, 1);
});

test('when everything fails the fallback is the last attempt', () => {
  const { planner, events } = setup();
  planner.setGoal({ kind: 'play', game: 'Mines', rounds: 1 });

  const seen = drive(planner, () => ({ ok: false, error: 'page gone' }));
  assert.deepEqual(seen.map((s) => s.kind), ['enter_game', 'enter_game', 'enter_game']);
  assert.deepEqual(seen.map((s) => s.game), ['Mines', 'Mines', 'Mines']);

  const status = planner.status();
  assert.equal(status.failed, true);
  assert.match(status.error, /enter_game/);
  assert.equal(events.at(-1).ok, false);
  assert.equal(events.at(-1).step.kind, 'enter_game');
});

test('a goal without a game inherits the current table, and reset() drops it', () => {
  const { planner, events } = setup();
  planner.setGoal({ kind: 'play', rounds: 1 });
  assert.equal(planner.status().goal.game, 'Dice');
  assert.equal(events[0].steps[0].args.game, 'Dice');

  const status = planner.reset('stop command');
  assert.equal(status.goal, null);
  assert.equal(planner.tick(), null);
});

test('tick(result) settles and dispatches in one call, so the host loop stays flat', () => {
  const { planner } = setup();
  planner.setGoal({ kind: 'play', game: 'Dice', rounds: 1 });

  const kinds = [];
  let result;
  let step;
  let guard = 0;
  while ((step = planner.tick(result)) && guard < 20) {
    kinds.push(step.kind);
    result = { ok: true };
    guard += 1;
  }
  assert.deepEqual(kinds, ['enter_game', 'start_round', 'await_result']);
  assert.equal(planner.status().done, true);
});

test('an unusable goal fails immediately with a plan event', () => {
  const { planner, events } = setup();
  const status = planner.setGoal({ kind: 'dance', game: 'Dice' });
  assert.equal(status.failed, true);
  assert.match(status.error, /unsupported goal/);
  assert.equal(events.at(-1).ok, false);
  assert.equal(planner.tick(), null);
});
