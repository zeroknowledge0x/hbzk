// Safety gate: six lines the bot must never speak, six harmless ones it must, and the
// action guard that keeps a live round from being re-configured underneath the game.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkLine, checkAction } from '../src/core/safety.js';

const BLOCKED = [
  ['guaranteed win, just follow my signal', 'profit promise'],
  ['this strat is pasti menang, trust me', 'profit promise'],
  ['deposit dulu biar bisa ikut round', 'deposit or bet-more push'],
  ['bet more if you want to catch up', 'deposit or bet-more push'],
  ['drop your nomor rekening in chat', 'personal data request'],
  ['goblok banget sih, kalah terus', 'slur or insult'],
];

for (const [line, reason] of BLOCKED) {
  test(`blocks: ${line}`, () => {
    const out = checkLine(line);
    assert.equal(out.ok, false);
    assert.equal(out.reason, reason);
  });
}

const ALLOWED = [
  'nice roll, cash out while you are ahead',
  'your balance is looking healthy, keep it steady',
  'that was a clean 5x, good job',
  'mines is heating up, pick your tile',
  'only play with money you can afford to lose',
  'selamat pagi semua, semoga harimu menyenangkan',
];

for (const line of ALLOWED) {
  test(`allows: ${line}`, () => {
    assert.deepEqual(checkLine(line), { ok: true });
  });
}

test('a stake change mid-round is blocked', () => {
  const out = checkAction({ kind: 'set_stake', args: { value: 25 } }, { phase: 'playing' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /playing/);
});

test('a multiplier change between rounds is allowed', () => {
  assert.deepEqual(checkAction({ kind: 'set_multiplier', args: { value: 3 } }, { phase: 'idle' }), { ok: true });
});

test('cashing out mid-round is not a settings change', () => {
  assert.equal(checkAction({ kind: 'cash_out', args: {} }, { phase: 'playing' }).ok, true);
});
