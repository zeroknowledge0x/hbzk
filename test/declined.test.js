import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { loadDeclined, saveDeclined } from '../src/core/declined.js';

let tempDir;
let file;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'declined-test-'));
  file = join(tempDir, 'declined.json');
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('declined tables', () => {
  it('round-trips a decline with its reason', () => {
    const now = 1_700_000_000_000;
    assert.equal(saveDeclined(file, 'Dice', '3 result reads in a row', now), true);
    const loaded = loadDeclined(file, now + 1000);
    assert.equal(loaded.get('Dice').reason, '3 result reads in a row');
    assert.equal(loaded.get('Dice').at, now);
  });

  it('keeps several tables', () => {
    const now = 1_700_000_000_000;
    saveDeclined(file, 'Dice', 'reads', now);
    saveDeclined(file, 'Wheel', 'reads', now);
    assert.equal(loadDeclined(file, now).size, 2);
  });

  it('expires after a day so tomorrow tries again', () => {
    const now = 1_700_000_000_000;
    saveDeclined(file, 'Dice', 'reads', now);
    assert.equal(loadDeclined(file, now + 25 * 60 * 60 * 1000).size, 0);
  });

  it('survives a corrupt file by declining nothing', () => {
    writeFileSync(file, 'not json {{{', 'utf8');
    assert.equal(loadDeclined(file, Date.now()).size, 0);
  });

  it('is a no-op for a missing file', () => {
    assert.equal(loadDeclined(join(tempDir, 'nope.json'), Date.now()).size, 0);
  });
});
