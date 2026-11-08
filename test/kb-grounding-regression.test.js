import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Knowledge } from '../src/kb.js';

test('built SQLite facts cite evidence and exclude unverified fairness and payout claims', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'hbzk-kb-'));
  const file = path.join(dir, 'kb.sqlite');
  try {
    const run = spawnSync(process.execPath, ['scripts/build-kb.mjs', file], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.existsSync(file), true, 'build accepts explicit offline output');
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT * FROM facts').all();
    db.close();
    assert.ok(rows.length > 22);
    for (const row of rows) {
      assert.ok(row.source, row.id);
      assert.match(row.measured_at, /^2026-11-08$/, row.id);
      assert.doesNotMatch(row.text, /certified|licensed providers|provably fair|24\/7 support/i);
    }
    const kb = new Knowledge(file.replace(/sqlite$/, 'json'));
    assert.match(kb.search('weekly monthly rewards sliders', 1)[0].text, /weekly.*monthly.*sliders/i);
    assert.match(kb.search('website', 1)[0].text, /housebets\.com/);
    assert.match(kb.search('apa kabar', 1)[0].text, /fine|well|good/i);
    assert.ok(kb.search('website', 1)[0].source);
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows may keep the closed handle briefly. */ } }
});
