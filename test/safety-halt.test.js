import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSafetyHalt, writeSafetyHalt, clearSafetyHalt, safetyHaltPath } from '../src/core/safety-halt.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hubie-halt-')); }

test('a safety halt is on record until it is cleared', () => {
  const cwd = tmp();
  assert.equal(readSafetyHalt(cwd), null, 'nothing on record to start with');
  const written = writeSafetyHalt('enter_game clicked 9 times without a verified result', cwd);
  assert.match(written.reason, /without a verified result/);
  const read = readSafetyHalt(cwd);
  assert.equal(read.reason, written.reason);
  assert.ok(read.at, 'an unattended halt is timestamped');
  assert.equal(clearSafetyHalt(cwd), true);
  assert.equal(readSafetyHalt(cwd), null, 'the next run is allowed');
});

test('a corrupt or empty marker never blocks the launcher', () => {
  const cwd = tmp();
  fs.mkdirSync(path.dirname(safetyHaltPath(cwd)), { recursive: true });
  fs.writeFileSync(safetyHaltPath(cwd), '{');
  assert.equal(readSafetyHalt(cwd), null);
  fs.writeFileSync(safetyHaltPath(cwd), '{"at":"2026-11-12T07:00:00Z"}');
  assert.equal(readSafetyHalt(cwd), null, 'a marker with no reason is not a halt');
});
