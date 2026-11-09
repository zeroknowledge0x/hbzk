import test from 'node:test';
import assert from 'node:assert/strict';
import { activeAlerts, alertLine, clearKind, createWatch, evaluate, noteAction, noteSample } from '../src/core/drift.js';

const T = 1_700_000_000_000;

test('the same action repeated inside the window is a stuck loop', () => {
  let w = createWatch();
  for (let i = 0; i < 6; i++) w = noteAction(w, { action: 'Bet', at: T + i * 1000 });
  w = evaluate(w, T + 6000);
  const kinds = activeAlerts(w, T + 6000).map((a) => a.kind);
  assert.deepEqual(kinds, ['stuck-loop']);
  assert.equal(activeAlerts(w, T + 6000)[0].action, 'Bet');
});

test('a healthy mix of actions raises nothing', () => {
  let w = createWatch();
  for (const a of ['Bet', 'Higher', 'Bet', 'Lower', 'Cash out', 'Bet']) w = noteAction(w, { action: a, at: T });
  w = evaluate(w, T + 1000);
  assert.deepEqual(activeAlerts(w, T + 1000), []);
  assert.equal(alertLine(w, T + 1000), 'DRIFT clean');
});

test('events older than the window stop counting', () => {
  let w = createWatch();
  for (let i = 0; i < 6; i++) w = noteAction(w, { action: 'Bet', at: T - 10 * 60_000 + i });
  w = evaluate(w, T);
  assert.deepEqual(activeAlerts(w, T), []);
});

test('encoder drift and a capture stall are detected from samples, not single values', () => {
  let w = createWatch();
  w = noteSample(w, { frameMs: 200, at: T });
  w = evaluate(w, T + 1);
  assert.deepEqual(activeAlerts(w, T + 1).map((a) => a.kind), [], 'one slow frame is noise');
  for (let i = 0; i < 10; i++) w = noteSample(w, { frameMs: 180, frameAgeMs: 9000, at: T + 2 + i });
  w = evaluate(w, T + 20);
  const kinds = activeAlerts(w, T + 20).map((a) => a.kind).sort();
  assert.deepEqual(kinds, ['capture-stall', 'encoder-drift']);
  assert.match(alertLine(w, T + 20), /DRIFT/);
});

test('one alert per kind per window, and a kind can be cleared', () => {
  let w = createWatch();
  for (let i = 0; i < 6; i++) w = noteAction(w, { action: 'Bet', at: T + i });
  w = evaluate(w, T + 7);
  w = evaluate(w, T + 8);
  assert.equal(activeAlerts(w, T + 8).filter((a) => a.kind === 'stuck-loop').length, 1);
  const cleared = clearKind(w, 'stuck-loop');
  assert.deepEqual(activeAlerts(cleared, T + 8), []);
});
