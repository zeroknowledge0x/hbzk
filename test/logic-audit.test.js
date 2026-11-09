// The logic audit as a gate: every table, every phase, every control shape the host can meet.
// A policy may only propose a control that is on the table, only touch settings when idle, and
// the controller may only click what the policy asked for — with a verified zero stake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPECTED, audit, controllerSweep } from '../scripts/logic-audit.mjs';

test('no policy proposal ever leaves the table or touches a setting mid-round', () => {
  const { problems, rows } = audit({});
  assert.deepEqual(problems, [], problems.slice(0, 10).join('\n'));
  assert.ok(rows.length >= 11, 'every table was swept');
});

test('every table reaches its own key actions', () => {
  const { rows } = audit({});
  const seen = new Map();
  for (const row of rows) {
    const m = row.match(/^(\S.*?)\s+\d+ cases · actions: (.*)$/);
    if (m) seen.set(m[1].trim(), new Set(m[2].split(', ')));
  }
  for (const [table, wanted] of Object.entries(EXPECTED)) {
    const actions = seen.get(table);
    assert.ok(actions, `${table}: no audit row`);
    for (const action of wanted) assert.ok(actions.has(action), `${table} never proposes "${action}" (has: ${[...actions].join(', ')})`);
  }
});

test('the controller only clicks what the policy asked for, and never without a verified zero stake', async () => {
  const { problems, rows } = await controllerSweep();
  assert.deepEqual(problems, [], problems.slice(0, 10).join('\n'));
  assert.ok(rows.length >= 60, 'every table was driven through the controller');
});

test('Hubie\u2019s Road plays its lanes instead of stopping mid-round', async () => {
  const { ALL } = await import('../src/core/adapters/index.js');
  const road = ALL.find((a) => a.name === "Hubie's Road");
  const controls = ['Cash out $0.00', 'Lane 1', 'Lane 2', 'Lane 3'];
  const action = road.decide({ phase: 'playing', controls, progress: 0 }, () => 0.9);
  assert.equal(action.label, 'Lane 1');
});

test('Blackjack plays the hand instead of refusing insurance forever', async () => {
  const { byName } = await import('../src/core/adapters/index.js');
  const bj = byName('Blackjack');
  const withHand = bj.decide({ controls: ['Hit', 'Stand', 'No thanks'], phase: 'playing' }, () => 0);
  assert.equal(withHand.label, 'Hit');
  const insuranceOnly = bj.decide({ controls: ['No thanks', 'Insure $0.00'], phase: 'playing' }, () => 0);
  assert.equal(insuranceOnly.label, 'No thanks');
});