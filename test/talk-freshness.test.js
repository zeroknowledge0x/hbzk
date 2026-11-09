import test from 'node:test';
import assert from 'node:assert/strict';
import { talkIsStale, talkPriority } from '../src/agent.js';

const win = (extra = {}) => ({ priority: talkPriority('react:win'), reason: 'react:win', ...extra });

test('a fresh win line is spoken even when the sensor stamped it seconds ago', () => {
  const now = 1_000_000;
  const line = win({ at: now - 200, eventAt: now - 5009 });
  assert.equal(talkIsStale(line, now), false);
});

test('a win line that waited in the queue is dropped', () => {
  const now = 1_000_000;
  assert.equal(talkIsStale(win({ at: now - 5000 }), now), true);
});

test('chat replies are never dropped as stale, idle flavour is', () => {
  const now = 1_000_000;
  assert.equal(talkIsStale({ priority: talkPriority('reply'), at: now - 60_000 }, now), false);
  assert.equal(talkIsStale({ priority: talkPriority('idle'), at: now - 60_000 }, now), true);
});
