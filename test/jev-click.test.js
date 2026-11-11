// The click decision on the cheap classifier. It answers one label out of the ones on screen, and
// abstains ("none") rather than guessing, so the LLM still owns the tables it cannot read.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Jev } from '../src/jev.js';

function jevWith(answer) {
  const jev = new Jev({ jevEnabled: true, jevKey: 'k' });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ answers: { click: answer } }),
  });
  return jev;
}

test('the classifier names a label that beats waiting, and only one from the list', async () => {
  const jev = jevWith({ choice: 'Random tile', confidence: 0.22, probabilities: { none: 0.13, 'Random tile': 0.84, 'Cash out 2.40x': 0.03 } });
  const hit = await jev.chooseClick({ game: 'Mines', phase: 'playing', controls: ['Random tile', 'Cash out 2.40x'] });
  assert.equal(hit.label, 'Random tile');

  const off = jevWith({ choice: 'Wallet', confidence: 0.99, probabilities: { none: 0.01, Wallet: 0.99 } });
  assert.equal(await off.chooseClick({ game: 'Mines', phase: 'playing', controls: ['Random tile'] }), null);
});

test('a low-confidence answer and a "none" answer both defer instead of clicking', async () => {
  const waiting = jevWith({ choice: 'Bet', confidence: 0.39, probabilities: { none: 0.4, Bet: 0.51, Low: 0.07 } });
  assert.equal((await waiting.chooseClick({ game: 'Wheel', phase: 'idle', controls: ['Bet', 'Low'] })).label, 'Bet');

  const unsure = jevWith({ choice: 'Bet', confidence: 0.2, probabilities: { none: 0.7, Bet: 0.3 } });
  assert.equal(await unsure.chooseClick({ game: 'Wheel', phase: 'idle', controls: ['Bet'] }), null);

  const none = jevWith({ choice: 'none', confidence: 0.68, probabilities: { none: 0.68, Hit: 0.25, Stand: 0.02 } });
  assert.equal(await none.chooseClick({ game: 'Blackjack', phase: 'playing', controls: ['Hit', 'Stand'] }), null);
});

test('an empty board and a dead classifier are both a no-answer', async () => {
  const jev = jevWith({ choice: 'Bet', confidence: 0.9, probabilities: { none: 0.1, Bet: 0.9 } });
  assert.equal(await jev.chooseClick({ game: 'Wheel', phase: 'idle', controls: [] }), null);

  const dead = new Jev({ jevEnabled: true, jevKey: 'k' });
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal(await dead.chooseClick({ game: 'Wheel', phase: 'idle', controls: ['Bet'] }), null);
});
