import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMetrics, median, metricsLine, noteMessage, noteReply, noteUnanswered, snapshot,
} from '../src/core/metrics.js';

const T = 1_700_000_000_000;

test('messages, replies and the reply rate add up', () => {
  let m = createMetrics();
  m = noteMessage(m, { text: 'hello', at: T });
  m = noteMessage(m, { text: 'buy followers', verdict: 'scam', at: T + 1000 });
  m = noteReply(m, T + 2000);
  const s = snapshot(m, T + 3000);
  assert.equal(s.messages, 2);
  assert.equal(s.replies, 1);
  assert.equal(s.scams, 1);
  assert.equal(s.replyRate, 0.5);
});

test('reply latency is the wait from the message, not from process start', () => {
  let m = createMetrics();
  m = noteMessage(m, { text: 'a', at: T });
  m = noteReply(m, T + 1000);
  m = noteMessage(m, { text: 'b', at: T + 5000 });
  m = noteReply(m, T + 8000);
  assert.deepEqual(m.latenciesMs, [1000, 3000]);
  assert.equal(median(m.latenciesMs), 2000);
  assert.equal(snapshot(m, T + 9000).latencyMs, 2000);
});

test('ignored questions are kept, capped, and countable', () => {
  let m = createMetrics();
  for (let i = 0; i < 60; i++) m = noteUnanswered(m, { text: `q${i}`, why: 'no time' , at: T + i });
  assert.equal(m.unanswered.length, 50);
  assert.equal(snapshot(m, T + 100).unanswered, 50);
  assert.equal(m.unanswered.at(-1).text, 'q59');
});

test('an empty window reports no rate rather than a fake zero', () => {
  const m = createMetrics();
  assert.equal(snapshot(m, T).replyRate, null);
  assert.match(metricsLine(m, T), /CHAT 0 in/);
});

test('the overlay line carries rate and latency', () => {
  let m = createMetrics();
  m = noteMessage(m, { text: 'hi', at: T });
  m = noteReply(m, T + 1000);
  const line = metricsLine(m, T + 2000);
  assert.match(line, /CHAT 1 in · 1 spoke \(100%\)/);
  assert.match(line, /1\.0s/);
});

test('a reply with no message behind it does not print a rate above 100%', () => {
  let m = createMetrics();
  m = noteMessage(m, { text: 'hi', at: T });
  for (let i = 0; i < 4; i++) m = noteReply(m, T + 1000 + i);
  const s = snapshot(m, T);
  assert.equal(s.split, true);
  assert.equal(s.replyRate, null);
  assert.match(metricsLine(m, T), /CHAT 1 in · 4 spoke \(counters split\)/);
});
