import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  createLedger, hoursUnattended, formatDuration, ledgerLine, loadLedger,
  noteHuman, noteStart, noteTick, saveLedger,
} from '../src/uptime.js';

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

test('the first start opens the unattended window', () => {
  const l = noteStart(createLedger(), T0);
  assert.equal(l.windowStartAt, T0);
  assert.equal(l.restarts, 0);
  assert.equal(hoursUnattended(l, T0 + 2 * HOUR), 2);
});

test('a supervised restart does not reset the unattended window', () => {
  let l = noteStart(createLedger(), T0);
  l = noteStart(l, T0 + 3 * HOUR, { restarted: true });
  assert.equal(l.windowStartAt, T0, 'window kept');
  assert.equal(l.restarts, 1);
  assert.equal(hoursUnattended(l, T0 + 4 * HOUR), 4);
});

test('a human touch closes the run and starts a new window', () => {
  let l = noteStart(createLedger(), T0);
  l = noteHuman(l, T0 + 9 * HOUR);
  assert.equal(l.windowStartAt, T0 + 9 * HOUR);
  assert.equal(l.lastHumanAt, T0 + 9 * HOUR);
  assert.equal(l.runs.length, 1);
  assert.equal(l.runs[0].hours, 9);
  assert.equal(l.bestHours, 9);
  assert.equal(hoursUnattended(l, T0 + 10 * HOUR), 1);
});

test('noteTick only ever raises the best', () => {
  let l = noteStart(createLedger(), T0);
  l = noteTick(l, T0 + 5 * HOUR);
  assert.equal(l.bestHours, 5);
  l = noteTick(l, T0 + 2 * HOUR);
  assert.equal(l.bestHours, 5);
});

test('duration formatting stays readable past a day', () => {
  assert.equal(formatDuration(0), '0h 00m');
  assert.equal(formatDuration(1.5), '1h 30m');
  assert.equal(formatDuration(36.25), '36h 15m');
});

test('the overlay line names what is being scored', () => {
  const l = noteStart(createLedger(), T0);
  assert.equal(ledgerLine(l, T0 + 3 * HOUR + 5 * 60_000),
    'UNATTENDED 3h 05m · BEST 3h 05m · RESTARTS 0');
});

test('the ledger survives a save/load round trip', () => {
  const file = path.join(os.tmpdir(), `hubie-ledger-${process.pid}.json`);
  let l = noteStart(createLedger(), T0);
  l = noteStart(l, T0 + HOUR, { restarted: true });
  assert.equal(saveLedger(file, l).ok, true);
  const back = loadLedger(file);
  assert.equal(back.windowStartAt, T0);
  assert.equal(back.restarts, 1);
});

test('a corrupt ledger file falls back to an empty one', () => {
  const file = path.join(os.tmpdir(), `hubie-ledger-bad-${process.pid}.json`);
  saveLedger(file, createLedger({ windowStartAt: T0 }));
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(loadLedger(file).runs, []);
});
