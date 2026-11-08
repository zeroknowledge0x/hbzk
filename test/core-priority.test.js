// Priority decides who gets answered on a stream where chat outruns the bot. The tests
// assert relative order only — exact weights are tuning, not contract.
import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreMessage, rankMessages } from '../src/core/priority.js';

const NOW = 1_700_000_000_000;
let nextId = 0;

function msg(text, over = {}) {
  nextId += 1;
  return { id: `m${nextId}`, name: 'viewer', text, at: NOW, ...over };
}

const EMPTY = { seen: new Set(), recentTexts: [], authorCounts: {}, now: NOW };

test('scores stay inside 0..100', () => {
  const lines = ['', 'gm', 'hubie bet 50', '???', 'lol lol lol', 'stop playing'];
  for (const text of lines) {
    const score = scoreMessage(msg(text), EMPTY);
    assert.ok(score >= 0 && score <= 100, `${JSON.stringify(text)} -> ${score}`);
  }
});

test('a command to the host outranks "gm"', () => {
  const command = scoreMessage(msg('hubie bet 50'), EMPTY);
  const gm = scoreMessage(msg('gm'), EMPTY);
  assert.ok(command > gm, `command ${command} should beat gm ${gm}`);
});

test('a direct mention lifts even a non-command line', () => {
  assert.ok(scoreMessage(msg('@hubie nice'), EMPTY) > scoreMessage(msg('nice'), EMPTY));
});

test('a question outranks the same statement', () => {
  const asked = scoreMessage(msg('is this dice?'), EMPTY);
  const stated = scoreMessage(msg('this is dice'), EMPTY);
  assert.ok(asked > stated, `question ${asked} should beat statement ${stated}`);
});

test("a first-time viewer's question beats a repeat 'LOL'", () => {
  const ctx = { ...EMPTY, seen: new Set(['regular']), recentTexts: ['lol'] };
  const fresh = scoreMessage(msg('how do i play this?', { name: 'newbie' }), ctx);
  const repeat = scoreMessage(msg('LOL', { name: 'regular' }), ctx);
  assert.ok(fresh > repeat, `newcomer ${fresh} should beat repeat ${repeat}`);
});

test("a spammer's fifth message scores lower than their first", () => {
  const first = scoreMessage(msg('nice roll', { name: 'spam' }), { ...EMPTY, authorCounts: { spam: 1 } });
  const fifth = scoreMessage(msg('nice roll', { name: 'spam' }), { ...EMPTY, authorCounts: { spam: 5 } });
  assert.ok(fifth < first, `fifth ${fifth} should lose to first ${first}`);
});

test('author counts also work as a Map', () => {
  const counts = new Map([['spam', 5]]);
  const spammed = scoreMessage(msg('nice roll', { name: 'spam' }), { ...EMPTY, authorCounts: counts });
  const once = scoreMessage(msg('nice roll', { name: 'spam' }), EMPTY);
  assert.ok(spammed < once);
});

test('a repeated line is penalised against a novel one', () => {
  const novel = scoreMessage(msg('that was close'), { ...EMPTY, recentTexts: ['gg'] });
  const duplicate = scoreMessage(msg('gg'), { ...EMPTY, recentTexts: ['gg', 'gg'] });
  assert.ok(duplicate < novel, `duplicate ${duplicate} should lose to novel ${novel}`);
});

test('fresh chat outranks a stale line with the same text', () => {
  const fresh = scoreMessage(msg('hello there', { at: NOW }), EMPTY);
  const stale = scoreMessage(msg('hello there', { at: NOW - 5 * 60_000 }), EMPTY);
  assert.ok(fresh > stale, `fresh ${fresh} should beat stale ${stale}`);
});

test('rankMessages sorts a mixed list and leaves the input untouched', () => {
  const list = [msg('gm'), msg('what is the balance?', { name: 'a' }), msg('hubie spin')];
  const ranked = rankMessages(list, EMPTY);
  assert.notEqual(ranked, list);
  assert.equal(ranked.length, list.length);
  assert.equal(ranked[0].text, 'hubie spin');
  assert.equal(list[0].text, 'gm', 'input order must not be mutated');
});

test('rankMessages keeps scores non-increasing', () => {
  const list = [msg('lol'), msg('@hubie nice'), msg('bet 50'), msg('why?'), msg('lol')];
  const scores = rankMessages(list, EMPTY).map((m) => scoreMessage(m, EMPTY));
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(scores[i - 1] >= scores[i], `rank ${i} out of order: ${scores.join(', ')}`);
  }
});

test('rankMessages tolerates empty and malformed input', () => {
  assert.deepEqual(rankMessages([], EMPTY), []);
  assert.deepEqual(rankMessages(null, EMPTY), []);
  assert.equal(scoreMessage(null, EMPTY), 0);
  assert.equal(scoreMessage({}, EMPTY), 0);
  assert.equal(scoreMessage({ text: 42 }, EMPTY), 0);
});
