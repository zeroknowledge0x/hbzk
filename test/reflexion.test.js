import test from 'node:test';
import assert from 'node:assert/strict';
import { createScratch, exhausted, noteFailure, noteSuccess, openTask, retryContext, scratchLine } from '../src/core/reflexion.js';

test('a new task clears the scratchpad, the same task keeps it', () => {
  let s = openTask(createScratch(), 'play Mines');
  s = noteFailure(s, { step: 'Bet', error: 'no visible play control' });
  const same = openTask(s, 'play Mines');
  assert.equal(same.attempts, 1);
  const other = openTask(s, 'play Hilo');
  assert.equal(other.attempts, 0);
  assert.deepEqual(other.lessons, []);
});

test('the last lesson is carried into the retry, and giving up is explicit', () => {
  let s = openTask(createScratch(), 'play Mines');
  assert.equal(retryContext(s), '');
  s = noteFailure(s, { step: 'Random tile', error: 'tile unavailable' });
  assert.match(retryContext(s), /Random tile/);
  for (let i = 0; i < 4; i++) s = noteFailure(s, { step: 'Bet', error: 'timeout' });
  assert.equal(exhausted(s), true);
  assert.match(retryContext(s), /GIVE UP/);
});

test('lessons are capped so the prompt cannot grow without bound', () => {
  let s = openTask(createScratch(), 'x');
  for (let i = 0; i < 12; i++) s = noteFailure(s, { step: `s${i}`, error: 'e' });
  assert.ok(s.lessons.length <= 5, String(s.lessons.length));
  assert.equal(s.attempts, 12, 'attempts still count up so exhaustion is honest');
});

test('a success wipes the scratchpad', () => {
  let s = openTask(createScratch(), 'x');
  s = noteFailure(s, { step: 'a', error: 'b' });
  const clean = noteSuccess(s);
  assert.equal(clean.attempts, 0);
  assert.deepEqual(clean.lessons, []);
});

test('the scratch line says what is being retried', () => {
  assert.equal(scratchLine(createScratch()), 'REFLEXION idle');
  const s = noteFailure(openTask(createScratch(), 'play Dice'), { step: 'Bet', error: 'blocked by Cookie notice' });
  assert.match(scratchLine(s), /attempts 1\/4/);
  assert.match(scratchLine(s), /blocked by Cookie notice/);
});
