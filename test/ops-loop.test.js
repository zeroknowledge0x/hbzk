import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { isFrameBlack, parseOps } from '../src/capture-health.js';
import { OpsLoop } from '../src/ops-loop.js';

test('parseOps allowlists owner actions and maps reload to rearm', () => {
  assert.equal(parseOps('{"do":"rearm_capture"}').do, 'rearm_capture');
  assert.equal(parseOps('{"action":"reload"}').do, 'rearm_capture');
  assert.equal(parseOps('{"action":"wait"}').do, 'noop');
  assert.equal(parseOps('{"do":"rm -rf"}').do, 'noop');
  assert.equal(parseOps('not json').do, 'noop');
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
