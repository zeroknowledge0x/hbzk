import test from 'node:test';
import assert from 'node:assert/strict';
import { byName } from '../src/core/adapters/index.js';

for (const name of ['Dice', 'Mines', 'Plinko', 'Keno', 'Wheel', 'Limbo', 'Max Win', 'Dragon Tower', 'Hilo', 'Blackjack', "Hubie's Road"]) {
  test(`${name} owns its own policy`, () => {
    const adapter = byName(name);
    assert.equal(typeof adapter?.decide, 'function');
  });
}

test('Mines cashes out after progress instead of always selecting another tile', () => {
  const adapter = byName('Mines');
  const action = adapter.decide({ phase: 'playing', controls: ['Cash out $0.00', 'Random tile'], progress: 2 }, () => 0);
  assert.equal(action.label, 'Cash out');
});

test('Dragon Tower can cash out before the top after progress', () => {
  const adapter = byName('Dragon Tower');
  const action = adapter.decide({ phase: 'playing', controls: ['Cash out $0.00', 'Random pick'], progress: 1 }, () => 0);
  assert.equal(action.label, 'Cash out');
});

test('Dice never chooses an unrelated cashout', () => {
  const adapter = byName('Dice');
  const action = adapter.decide({ phase: 'idle', controls: ['Bet', 'Cash out $0.00'] }, () => 0);
  assert.equal(action.label, 'Bet');
});
