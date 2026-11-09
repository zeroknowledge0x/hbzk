import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chainLine, createChain, noteResult, parseResetAt, pickProvider, usableCount,
} from '../src/core/llm-chain.js';

const BODY_429 = '{"error":{"message":"You\'ve reached your weekly usage limit for your plan. '
  + 'Your limit resets at 2026-11-10T14:20:00.333Z. Please wait."}}';
const T = 1_700_000_000_000;

const chain = () => createChain([
  { name: 'primary', url: 'https://a', model: 'deepseek/deepseek-v4.1-flash' },
  { name: 'backup', url: 'https://b', model: 'z-ai/glm-5.3-flash' },
], { now: () => T });

test('the provider reset timestamp is read off the 429 body', () => {
  const at = parseResetAt(BODY_429, T);
  assert.equal(at, Date.parse('2026-11-10T14:20:00.333Z'));
  assert.equal(parseResetAt('no date here', T), null);
  assert.equal(parseResetAt('resets at 2020-01-01T00:00:00Z', T), null, 'past dates are not a reset');
});

test('a spent provider parks until the reset and the chain moves on', () => {
  const c = chain();
  noteResult(c, 'primary', { status: 429, body: BODY_429 }, T);
  assert.equal(pickProvider(c, T).name, 'backup');
  assert.equal(usableCount(c, T), 1);
  assert.match(chainLine(c, T), /primary: cooldown/);
  // Still parked a minute before the reset, ready right after it.
  const reset = Date.parse('2026-11-10T14:20:00.333Z');
  assert.equal(usableCount(c, reset - 60_000), 1);
  assert.equal(usableCount(c, reset + 1), 2);
});

test('a success clears the cooldown, a rejected key parks for an hour', () => {
  const c = chain();
  noteResult(c, 'primary', { status: 429, body: BODY_429 }, T);
  noteResult(c, 'primary', { status: 200, body: '{}' }, T + 1000);
  assert.equal(pickProvider(c, T + 1000).name, 'primary');
  noteResult(c, 'primary', { status: 401, body: 'bad key' }, T + 2000);
  assert.equal(usableCount(c, T + 2000), 1);
  assert.equal(usableCount(c, T + 30 * 60_000), 1, 'still parked inside the hour');
  assert.equal(usableCount(c, T + 61 * 60_000), 2);
});

test('a transport error backs off and grows with repeats', () => {
  const c = chain();
  noteResult(c, 'backup', { err: new Error('socket hang up') }, T);
  assert.equal(usableCount(c, T), 1);
  const first = c.providers[1].coolUntil - T;
  noteResult(c, 'backup', { err: new Error('socket hang up') }, T);
  const second = c.providers[1].coolUntil - T;
  assert.ok(second > first, `${second} > ${first}`);
  assert.ok(second <= 5 * 60_000);
});

test('with every provider parked the chain reports nothing usable', () => {
  const c = chain();
  noteResult(c, 'primary', { status: 429, body: BODY_429 }, T);
  noteResult(c, 'backup', { status: 500, body: 'boom' }, T);
  assert.equal(pickProvider(c, T), null);
  assert.equal(usableCount(c, T), 0);
});
