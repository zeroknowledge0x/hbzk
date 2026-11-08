import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AgentLoop, TALK_REPLY, TALK_IDLE } from '../src/agent.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { HostSpeech } from '../src/host-speech.js';

test('host idle uses real agent priority queue without overlapping speech or replacing chat', async () => {
  let speaking = true;
  let release;
  const spoken = [];
  const agent = new AgentLoop({
    brain: { offline: true },
    tools: { reportAll: () => ({ stream: { speaking } }) },
    speak: (text) => new Promise((resolve) => { spoken.push(text); release = resolve; }),
    speakCooldownMs: 0,
  });
  const h = harness();
  h.host.enqueue = (...args) => agent.enqueue(...args);
  try {
    agent.enqueue('First viewer answer.', 'reply', { chatId: 'c1' });
    agent.enqueue('Second viewer answer.', 'reply', { chatId: 'c2' });
    h.host.start();
    await h.fire();
    assert.deepEqual(agent.talkQueue.map((q) => q.priority), [TALK_REPLY, TALK_REPLY, TALK_IDLE]);
    agent.start({ talkOnly: true });
    await sleep(30);
    assert.deepEqual(spoken, []);
    speaking = false;
    await sleep(1100);
    assert.deepEqual(spoken, ['First viewer answer.']);
    await sleep(1100);
    assert.deepEqual(spoken, ['First viewer answer.'], 'unresolved playback must block idle and chat');
    release();
    await sleep(1100);
    assert.deepEqual(spoken, ['First viewer answer.', 'Second viewer answer.']);
    assert.equal(agent.talkQueue[0].priority, TALK_IDLE);
  } finally {
    h.host.stop();
    agent.stop();
    release?.();
  }
});

// Index is a boot entry point: inspect wiring without starting browser/encoder.
test('host entry routes every producer through the agent and removes direct random speech', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ HostSpeech \} from '\.\/host-speech\.js'/);
  assert.match(source, /function speak\([^]*?return agent\?\.enqueue\(text, kind, meta\)/);
  assert.match(source, /speak: \(text, kind, meta\) => deliverSpeech\(/);
  assert.match(source, /hostSpeech\.start\(\)/);
  assert.match(source, /hostSpeech\.stop\(\)/);
  assert.match(source, /hostSpeech\.observeOutcome\(report\.outcome\)/);
  assert.doesNotMatch(source, /armVibes|lastBigWin|isBigWin\(/);
});


function harness({ random = () => 0, say = async () => ({ text: 'A fresh table thought.' }) } = {}) {
  let time = 1000;
  let seq = 0;
  const jobs = new Map();
  const queued = [];
  const calls = [];
  const host = new HostSpeech({
    now: () => time, random,
    timers: {
      setTimeout(fn, ms) { const id = ++seq; jobs.set(id, { fn, ms }); return id; },
      clearTimeout(id) { jobs.delete(id); },
    },
    brain: { say: async (...args) => { calls.push(args); return say(...args); } },
    enqueue: (...args) => { queued.push(args); return true; },
    context: () => ({ game: 'Keno', segment: 'chill', viewers: 0 }),
  });
  return { host, jobs, queued, calls, advance(ms) { time += ms; }, async fire() {
    const [id, job] = jobs.entries().next().value;
    jobs.delete(id);
    time += job.ms;
    await job.fn();
  } };
}

test('equal payouts with distinct event IDs are distinct, persistent or ID-less results never invent rounds', async () => {
  const h = harness();
  h.host.start();
  const result = { source: 'local-round', local: true, confirmed: true, won: true, payoutMultiplier: 5 };
  await h.host.observeOutcome({ ...result, eventId: 'a' });
  await h.host.observeOutcome({ ...result, eventId: 'a' });
  await h.host.observeOutcome({ ...result, eventId: 'b' });
  await h.host.observeOutcome({ ...result, eventId: 'a' });
  assert.equal(h.queued.length, 2);
  await h.host.observeOutcome(result);
  await h.host.observeOutcome(null);
  h.advance(60000);
  await h.host.observeOutcome(result);
  assert.equal(h.queued.length, 3, 'missing identity is not a clock-based new event');
  h.host.stop();
});

test('big wins require a confirmed local payout and reject roll, target, generic and global rows', async () => {
  const h = harness();
  h.host.start();
  for (const source of ['marker', 'generic', 'handle-row', 'target', 'roll']) {
    await h.host.observeOutcome({ source, won: true, result: 99, confirmed: true, local: true, payoutMultiplier: 99 });
  }
  await h.host.observeOutcome({ source: 'local-round', won: true, payoutMultiplier: 99 });
  await h.host.observeOutcome({ source: 'local-round', confirmed: true, local: true, won: true, payoutMultiplier: 2.99 });
  assert.equal(h.queued.length, 0);
  await h.host.observeOutcome({ source: 'local-round', confirmed: true, local: true, won: true, payoutMultiplier: 5, eventId: 'bet-1' });
  assert.equal(h.queued.length, 1);
  assert.equal(h.queued[0][1], 'react:win');
  assert.equal(h.queued[0][2].eventAt, 1000);
  assert.match(h.calls[0][1].detail, /5x/);
  h.host.stop();
});

test('stop suppresses late generation and a failed idle slot still rearms', async () => {
  let resolve;
  const h = harness({ say: () => new Promise((r) => { resolve = r; }) });
  h.host.start();
  const pending = h.fire();
  h.host.stop();
  resolve({ text: 'Too late.' });
  await pending;
  assert.equal(h.queued.length, 0);
  assert.equal(h.jobs.size, 0);
});

test('idle slots skip empty, fallback, repeated and zero-locked lines without inventing a replacement', async () => {
  const lines = [{ text: '' }, { text: 'Fixed fallback.', fallback: true },
    { text: 'Zero locked, still spinning.' }, { text: 'A fresh thought.' }, { text: 'A fresh thought.' }];
  const h = harness({ say: async () => lines.shift() });
  h.host.start();
  for (let i = 0; i < 5; i++) await h.fire();
  assert.deepEqual(h.queued.map(([text]) => text), ['A fresh thought.']);
  assert.equal(h.jobs.size, 1);
  h.host.stop();
});

test('failed or empty idle generation rearms without canned speech', async () => {
  const h = harness({ random: () => 0.999999, say: async () => { throw new Error('offline'); } });
  h.host.start();
  assert.ok([...h.jobs.values()][0].ms < 900000);
  await assert.doesNotReject(h.fire());
  assert.equal(h.queued.length, 0);
  assert.equal(h.jobs.size, 1);
  h.host.stop();
});

test('idle speech is scheduled every 5–15 minutes with zero viewers and only enqueues', async () => {
  assert.equal(typeof HostSpeech, 'function', 'HostSpeech service must exist');
  const h = harness();
  h.host.start();
  h.host.start();
  assert.equal(h.jobs.size, 1);
  assert.equal([...h.jobs.values()][0].ms, 300000);
  await h.fire();
  assert.equal(h.queued.length, 1);
  assert.equal(h.queued[0][1], 'idle');
  assert.equal(h.calls[0][1].viewers, 0);
  assert.equal(h.calls[0][1].segment, 'chill');
  assert.equal(h.jobs.size, 1);
  h.host.stop();
  assert.equal(h.jobs.size, 0);
});
