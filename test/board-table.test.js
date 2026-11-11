import test from 'node:test';
import assert from 'node:assert/strict';

import { boardTable } from '../src/core/play-labels.js';

test('the board tells which table is really on screen', () => {
  assert.equal(boardTable(['Bet', 'Random pick', 'Pick floor 4, tile 1', 'Medium']), 'Dragon Tower');
  assert.equal(boardTable(['Bet', 'Over', 'Under', 'Inside', 'Outside']), 'Dice');
  assert.equal(boardTable(['Bet', 'Hit', 'Stand', 'No thanks']), 'Blackjack');
  assert.equal(boardTable(['Bet', 'GO']), "Hubie's Road");
  assert.equal(boardTable(['Bet']), null, 'a bare bet names no table');
  assert.equal(boardTable([]), null);
});
