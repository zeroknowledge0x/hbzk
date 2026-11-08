import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { isFrameBlack, parseOps, shouldPumpCapture, pickLargestRect, OWNER_MS } from '../src/capture-health.js';
import { matchPlayClick } from '../src/core/play-labels.js';
import { OpsLoop } from '../src/ops-loop.js';

test('parseOps allowlists owner actions and maps reload to rearm', () => {
  assert.equal(parseOps('{"do":"rearm_capture"}').do, 'rearm_capture');
  assert.equal(parseOps('{"action":"reload"}').do, 'rearm_capture');
  assert.equal(parseOps('{"action":"wait"}').do, 'noop');
  assert.equal(parseOps('{"do":"rm -rf"}').do, 'noop');
  assert.equal(parseOps('not json').do, 'noop');
});

test('parseOps keeps click with the requested label', () => {
  const op = parseOps('{"do":"click","click":"Hit"}');
  assert.equal(op.do, 'click');
  assert.equal(op.click, 'Hit');
  assert.equal(parseOps('{"do":"click","label":"GO"}').click, 'GO');
  assert.equal(parseOps('{"action":"navigate"}').do, 'play_now');
});

test('owner loop ticks every 5s', () => {
  assert.equal(OWNER_MS, 5000);
});

test('matchPlayClick only returns a visible play label', () => {
  assert.equal(matchPlayClick('Hit', ['Bet', 'Hit', 'Stand']), 'Hit');
  assert.equal(matchPlayClick('Wallet', ['Bet', 'Wallet']), null);
  assert.equal(matchPlayClick('Over', ['Bet', 'Over']), null);
  assert.equal(matchPlayClick('Hit', ['Bet']), null);
});

test('shouldPumpCapture runs when the live frame is black even if age is 0', () => {
  assert.equal(shouldPumpCapture({ ageMs: 0, black: true }), true);
  assert.equal(shouldPumpCapture({ ageMs: 100, black: false }), false);
  assert.equal(shouldPumpCapture({ ageMs: 800, black: false }), true);
});

test('pickLargestRect prefers the big game iframe', () => {
  const pick = pickLargestRect([
    { id: 'ad', width: 120, height: 90 },
    { id: 'table', width: 980, height: 560 },
    { id: 'chat', width: 300, height: 400 },
  ]);
  assert.equal(pick.id, 'table');
  assert.equal(pickLargestRect([]), null);
});

test('isFrameBlack is true for a black canvas and false for a bright one', () => {
  const dark = createCanvas(64, 64);
  dark.getContext('2d').fillStyle = '#000';
  dark.getContext('2d').fillRect(0, 0, 64, 64);
  assert.equal(isFrameBlack(dark), true);
  const lit = createCanvas(64, 64);
  lit.getContext('2d').fillStyle = '#8899aa';
  lit.getContext('2d').fillRect(0, 0, 64, 64);
  assert.equal(isFrameBlack(lit), false);
  assert.equal(isFrameBlack(null), true);
});

test('ops apply play_now calls rotation.playNow', async () => {
  let n = 0;
  const ops = new OpsLoop({
    rotation: { playNow() { n += 1; } },
    log() {},
    world: { get: () => ({}) },
  });
  await ops.apply({ do: 'play_now', why: 'test' });
  assert.equal(n, 1);
  await ops.apply({ do: 'noop' });
  assert.equal(n, 1);
});

test('ops apply click only hits a visible play label', async () => {
  const clicks = [];
  const ops = new OpsLoop({
    game: { clickText: async (t) => { clicks.push(t); return { ok: true, text: t }; } },
    log() {},
    world: { get: () => ({ controls: ['Bet', 'Hit', 'Stand'], game: 'Blackjack' }) },
  });
  await ops.apply({ do: 'click', click: 'Hit' });
  await ops.apply({ do: 'click', click: 'Wallet' });
  await ops.apply({ do: 'click', click: 'Over' });
  assert.deepEqual(clicks, ['Hit']);
});

test('ops report includes Kick chat lines', () => {
  const ops = new OpsLoop({
    log() {},
    world: { get: () => ({ game: 'Hilo', controls: ['Higher'] }) },
    chat: () => [{ name: 'sam', text: 'hit' }],
  });
  const r = ops.report();
  assert.equal(r.chat[0].name, 'sam');
  assert.equal(r.game, 'Hilo');
});

test('ops click is skipped while the controller owns hands', async () => {
  const clicks = [];
  const ops = new OpsLoop({
    game: { clickText: async (t) => { clicks.push(t); return { ok: true, text: t }; } },
    controller: { status: () => ({ active: true }) },
    log() {},
    world: { get: () => ({ controls: ['Hit'] }) },
  });
  await ops.apply({ do: 'click', click: 'Hit' });
  assert.deepEqual(clicks, []);
});
