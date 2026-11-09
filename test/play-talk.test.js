import test from 'node:test';
import assert from 'node:assert/strict';
import { betLine, cashoutLine, roundLine, streakLine } from '../src/core/play-talk.js';

test('a cashout says why, per table', () => {
  assert.match(cashoutLine('Mines', { progress: 2 }), /2 reveals/);
  assert.match(cashoutLine('Mines', { progress: 1 }), /1 reveal\b/);
  assert.match(cashoutLine('Dragon Tower', { progress: 3 }), /floor 4/);
  assert.match(cashoutLine("Hubie's Road", { progress: 1 }), /lane 2/);
  assert.match(cashoutLine('Hilo'), /cash out/i);
});

test('a cashout before any progress never claims one', () => {
  const line = cashoutLine('Mines', { progress: 0 });
  assert.doesNotMatch(line, /1 reveal|2 reveal/);
});

test('no commentary line promises a win or a result', () => {
  const lines = [
    cashoutLine('Mines', { progress: 3 }), cashoutLine('Hilo'), cashoutLine('Dice'),
    betLine('Dice', { multiplier: 5 }), betLine('Blackjack'), streakLine(4, 0), streakLine(0, 4),
    roundLine('Keno', { won: false }), roundLine('Keno', { won: true, multiplier: 4 }),
  ].filter(Boolean);
  for (const line of lines) {
    assert.doesNotMatch(line, /\b(guaranteed|surely|easy money|you will win|profit)\b/i, line);
  }
});

test('the bet line reflects the knob the host actually turned', () => {
  assert.match(betLine('Dice', { multiplier: 5 }), /5x/);
  assert.match(betLine('Keno', { chip: 'High' }), /High/);
  assert.match(betLine('Dice'), /zero/i);
});

test('streaks only speak at three or more', () => {
  assert.equal(streakLine(1, 0), null);
  assert.equal(streakLine(0, 2), null);
  assert.match(streakLine(3, 0), /3 in a row/);
  assert.match(streakLine(0, 3), /3 straight misses/);
});

test('a big settled multiplier is the only thing called a highlight', () => {
  assert.equal(roundLine('Keno', { won: true, multiplier: 2 }), null);
  assert.match(roundLine('Keno', { won: true, multiplier: 4 }), /4\.00x/);
  assert.match(roundLine('Keno', { won: false }), /No hit/);
});
