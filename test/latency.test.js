import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS, coverLine, createLatency, latencyLine, noteLine, slowestStage, stats, withCover } from '../src/core/latency.js';

const T = 1_700_000_000_000;

test('a spoken line keeps only the stages that were measured', () => {
  let l = createLatency();
  l = noteLine(l, { askedAt: T, llmFirstTokenAt: T + 600, ttsFirstByteAt: T + 700, firstPcmAt: T + 820 });
  assert.equal(l.last.totalMs, 820);
  assert.equal(l.last.llmMs, 600);
  assert.equal(l.last.ttsMs, 120);
});

test('p50 and p95 come from the totals, and the ceiling is counted', () => {
  let l = createLatency();
  for (let i = 0; i < 9; i++) l = noteLine(l, { askedAt: T, firstPcmAt: T + 700 });
  l = noteLine(l, { askedAt: T, firstPcmAt: T + 4000 });
  l = noteLine(l, { askedAt: T, firstPcmAt: T + 5000 });
  const s = stats(l);
  assert.equal(s.p50, 700);
  assert.equal(s.p95, 5000);
  assert.equal(s.overBudget, 2, `target is ${TARGETS.p95Ms} ms`);
});

test('the slow stage is named instead of guessed', () => {
  let llm = createLatency();
  llm = noteLine(llm, { askedAt: T, llmFirstTokenAt: T + 1500, ttsFirstByteAt: T + 1600, firstPcmAt: T + 1700 });
  assert.equal(slowestStage(llm), 'llm');
  let tts = createLatency();
  tts = noteLine(tts, { askedAt: T, llmFirstTokenAt: T + 200, ttsFirstByteAt: T + 300, firstPcmAt: T + 1400 });
  assert.equal(slowestStage(tts), 'tts');
  assert.equal(slowestStage(createLatency()), 'unknown');
});

test('the wait is covered with something short that claims nothing', () => {
  const line = coverLine('reply');
  assert.ok(line.length > 0 && line.length < 60, line);
  assert.doesNotMatch(line, /\$|\d+x|guaranteed|win/i);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a slow call gets covered once, and a fast one never does', async () => {
  const said = [];
  const slow = new Promise(() => {});
  withCover(slow, { delayMs: 20, onCover: (l) => said.push(l) });
  await wait(60);
  assert.equal(said.length, 1);
  assert.ok(said[0].length > 0 && said[0].length < 60);

  said.length = 0;
  const fast = withCover(Promise.resolve('done'), { delayMs: 20, onCover: (l) => said.push(l) });
  assert.equal(await fast, 'done', 'the original promise is returned untouched');
  await wait(60);
  assert.deepEqual(said, [], 'nothing to cover when the answer arrives in time');
});

test('a busy mouth is not interrupted, and a rejection is not covered', async () => {
  const said = [];
  let busy = true;
  withCover(new Promise(() => {}), { delayMs: 20, isBusy: () => busy, onCover: (l) => said.push(l) });
  await wait(45);
  assert.deepEqual(said, [], 'silence is better than talking over the host');
  busy = false;
  withCover(Promise.reject(new Error('429')), { delayMs: 10, onCover: (l) => said.push(l) }).catch(() => {});
  await wait(40);
  assert.deepEqual(said, [], 'a failing call is handled by the caller, not covered');
});

test('a throwing cover cannot break the reply', async () => {
  const p = withCover(new Promise(() => {}), {
    delayMs: 10,
    cover: () => { throw new Error('pool exploded'); },
  });
  await wait(40);
  assert.ok(p instanceof Promise);
});

test('samples and the summary line stay bounded and readable', () => {
  let l = createLatency();
  for (let i = 0; i < 400; i++) l = noteLine(l, { askedAt: T, firstPcmAt: T + 800 });
  assert.equal(l.samples.length, 200);
  const line = latencyLine(l);
  assert.match(line, /MOUTH p50 0\.8s/);
  assert.match(line, /over 0\/200/);
});
