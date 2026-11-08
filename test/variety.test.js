import test from 'node:test';
import assert from 'node:assert/strict';
import { varietyClicks, varietyPlay, nextIdleMs, isBigWin } from '../src/core/variety.js';
import { labelMatchesPlay } from '../src/core/play-labels.js';
import { factReply } from '../src/chat-reply.js';

const limbo = ['Bet', '1.5x', '2x', '5x', '10x', '100x'];
const hilo = ['Higher / same 2.60x', 'Lower / same 1.44x', 'Skip card', 'Cash out $ 0.00'];

test('Limbo chip is not always 2x', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(varietyClicks('Limbo', limbo)[0]);
  assert.ok(seen.size > 1);
  assert.equal(seen.has('½'), false);
});

test('Hilo play is Higher, Lower, or Skip, never Bet Info', () => {
  const seen = new Set();
  for (let i = 0; i < 30; i++) seen.add(varietyPlay('Hilo', hilo));
  assert.ok(seen.has('Higher') || seen.has('Lower') || seen.has('Skip'));
  assert.equal(seen.has('Bet'), false);
});

test('Cash out at zero does not match', () => {
  assert.equal(labelMatchesPlay('Cash out', 'Cash out $ 0.00'), false);
  assert.equal(labelMatchesPlay('Cash out', 'Cash out $ 1.20'), true);
  assert.equal(labelMatchesPlay('Random pick', 'Random pick a random tile on the next floor (R)'), true);
  assert.equal(labelMatchesPlay('Bet', 'Bet Info'), false);
  assert.equal(labelMatchesPlay('Bet', 'Bet Amount 0.00'), false);
});

test('idle wait is 5 to 15 minutes', () => {
  for (let i = 0; i < 20; i++) {
    const ms = nextIdleMs(Math.random);
    assert.ok(ms >= 5 * 60 * 1000 && ms < 15 * 60 * 1000);
  }
});

test('big win talks from a payout, not the target field', () => {
  assert.equal(isBigWin({ won: true, result: 8, source: 'keno-payhit' }), true);
  assert.equal(isBigWin({ won: true, result: 49.5, source: 'marker' }), false);
  assert.equal(isBigWin({ won: true, result: 1.2, source: 'handle-row' }), false);
});

test('kabar and website are answered from facts', () => {
  assert.match(factReply('apa kabar', 'Ada'), /I'm good, Ada/);
  assert.match(factReply('what is the website', 'Ada'), /housebets\.com/);
  assert.equal(factReply('nice one', 'Ada'), null);
});
