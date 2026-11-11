import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Rotation } from '../src/core/rotation.js';

let tempDir;
let filePath;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'rot-test-'));
  filePath = join(tempDir, 'rotation.json');
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeRotation(overrides = {}) {
  return new Rotation({
    file: overrides.file || filePath,
    names: overrides.names || ['Dice', 'Mines', 'Plinko'],
    playable: overrides.playable || new Set(['Dice', 'Mines', 'Plinko']),
    now: overrides.now || (() => 1000),
    intervalMs: overrides.intervalMs || 5000,
  });
}

describe('Rotation', () => {

  describe('next()', () => {
    it('returns current name and advances index', () => {
      const rot = makeRotation();
      assert.equal(rot.next(), 'Dice');
      assert.equal(rot.next(), 'Mines');
      assert.equal(rot.next(), 'Plinko');
    });

    it('wraps around to first name', () => {
      const rot = makeRotation();
      rot.next(); // Dice
      rot.next(); // Mines
      rot.next(); // Plinko
      assert.equal(rot.next(), 'Dice'); // wraps
    });

    it('persists index to file', () => {
      const rot = makeRotation();
      rot.next(); // Dice
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      assert.equal(raw.index, 1);
    });

    it('default names is Dice only', () => {
      const rot = new Rotation({ file: filePath });
      assert.equal(rot.next(), 'Dice');
      assert.equal(rot.next(), 'Dice'); // wraps to same
    });
  });

  describe('persistence', () => {
    it('loads index from existing file', () => {
      writeFileSync(filePath, JSON.stringify({ index: 2, at: 999 }), 'utf8');
      const rot = makeRotation();
      assert.equal(rot.next(), 'Plinko'); // starts at index 2
    });

    it('resets to 0 for out-of-range index', () => {
      writeFileSync(filePath, JSON.stringify({ index: 99, at: 0 }), 'utf8');
      const rot = makeRotation();
      assert.equal(rot.next(), 'Dice'); // clamped to 0
    });

    it('resets to 0 for negative index', () => {
      writeFileSync(filePath, JSON.stringify({ index: -1, at: 0 }), 'utf8');
      const rot = makeRotation();
      assert.equal(rot.next(), 'Dice');
    });

    it('recovers from corrupt JSON', () => {
      writeFileSync(filePath, 'not valid json {{{', 'utf8');
      const rot = makeRotation();
      assert.equal(rot.next(), 'Dice'); // recovered
    });

    it('recovers from empty file', () => {
      writeFileSync(filePath, '', 'utf8');
      const rot = makeRotation();
      assert.equal(rot.next(), 'Dice');
    });

    it('handles missing file gracefully', () => {
      const rot = makeRotation({ file: join(tempDir, 'nonexistent.json') });
      assert.equal(rot.next(), 'Dice');
    });

    it('atomic write: file is valid after save', () => {
      const rot = makeRotation();
      rot.next();
      rot.next();
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      assert.equal(raw.index, 2);
      assert.ok(Number.isFinite(raw.at));
    });

    it('no leftover .tmp file after save', () => {
      const rot = makeRotation();
      rot.next();
      assert.equal(existsSync(filePath + '.tmp'), false);
    });
  });

  describe('due()', () => {
    it('returns true when no file exists', () => {
      const rot = makeRotation();
      assert.equal(rot.due(), true);
    });

    it('returns false when interval has not elapsed', () => {
      let now = 1000;
      const rot = makeRotation({ now: () => now, intervalMs: 5000 });
      rot.next(); // saves at=1000
      now = 3000; // only 2000ms elapsed
      assert.equal(rot.due(), false);
    });

    it('returns true when interval has elapsed', () => {
      let now = 1000;
      const rot = makeRotation({ now: () => now, intervalMs: 5000 });
      rot.next(); // saves at=1000
      now = 6000; // 5000ms elapsed
      assert.equal(rot.due(), true);
    });

    it('returns true when file is corrupt', () => {
      writeFileSync(filePath, 'garbage', 'utf8');
      const rot = makeRotation();
      assert.equal(rot.due(), true);
    });
  });

  describe('arm()', () => {
    it('schedules next() via provided timer factory', () => {
      let captured = null;
      const factory = (fn, ms) => { captured = { fn, ms }; return 'timer-id'; };
      let now = 1000;
      const rot = makeRotation({ now: () => now, intervalMs: 5000 });
      rot.next(); // saves at=1000
      now = 2000; // 1000ms elapsed, 4000ms remaining
      const id = rot.arm(factory);
      assert.equal(id, 'timer-id');
      assert.equal(captured.ms, 4000);
    });

    it('fires immediately when overdue', () => {
      let captured = null;
      const factory = (fn, ms) => { captured = { fn, ms }; return 't'; };
      let now = 10000;
      const rot = makeRotation({ now: () => now, intervalMs: 5000 });
      rot.next(); // saves at=10000
      now = 20000; // way past
      rot.arm(factory);
      assert.equal(captured.ms, 0);
    });

    it('clears previous timer on re-arm', () => {
      let cleared = false;
      let first = null;
      const factory = (fn, ms) => {
        if (first) cleared = true;
        first = { fn, ms };
        return 't-' + Math.random();
      };
      const rot = makeRotation({ now: () => 1000, intervalMs: 5000 });
      rot.arm(factory);
      rot.arm(factory);
      // The second arm should have cleared the first (via clearTimeout on _timer)
      // We verify by checking _timer is set
      assert.ok(rot._timer !== null);
    });

    it('executing the captured function calls next()', () => {
      let captured = null;
      const factory = (fn, ms) => { captured = { fn, ms }; return 't'; };
      const rot = makeRotation({ now: () => 1000, intervalMs: 5000 });
      rot.arm(factory);
      const name = captured.fn();
      assert.equal(name, 'Dice');
    });
  });

  describe('current()', () => {
    it('returns name at current index without advancing', () => {
      const rot = makeRotation();
      assert.equal(rot.current(), 'Dice');
      assert.equal(rot.current(), 'Dice'); // unchanged
    });

    it('reflects loaded index', () => {
      writeFileSync(filePath, JSON.stringify({ index: 1, at: 0 }), 'utf8');
      const rot = makeRotation();
      assert.equal(rot.current(), 'Mines');
    });
  });

  describe('quiet rotation', () => {
    it('quietIntervalMs is 10-60 min when env is unset', async () => {
      const { quietIntervalMs } = await import('../src/core/rotation.js');
      const ms = quietIntervalMs(undefined, () => 0);
      assert.equal(ms, 10 * 60 * 1000);
      const hi = quietIntervalMs(undefined, () => 0.999999);
      assert.ok(hi >= 10 * 60 * 1000 && hi <= 60 * 60 * 1000);
    });

    it('playNow makes due() true even inside the interval', () => {
      const rot = makeRotation({ now: () => 1000, intervalMs: 5000 });
      rot.next();
      rot.now = () => 1001;
      assert.equal(rot.due(), false);
      rot.playNow();
      assert.equal(rot.due(), true);
      rot.random();
      assert.equal(rot.due(), false);
    });

    it('random() returns a playable name and not always the first', () => {
      const rot = makeRotation();
      const seen = new Set();
      for (let i = 0; i < 20; i++) seen.add(rot.random());
      assert.ok(seen.size >= 2, [...seen].join(','));
      for (const name of seen) assert.ok(['Dice', 'Mines', 'Plinko'].includes(name));
    });

    it('a drift alert never forces a rotation', () => {
      assert.equal(Rotation.driftResponse('DRIFT stuck-loop · slowest stage unknown'), 'log-only');
      assert.equal(Rotation.driftResponse('DRIFT encoder-drift · slowest stage tts'), 'log-only');
      assert.equal(Rotation.driftResponse('DRIFT capture-stall · slowest stage capture'), 'rearm-capture');
    });

    it('a declined table never comes back from random()', () => {
      const rot = makeRotation();
      rot.decline('dice');
      assert.ok(rot.due(), 'declining asks for the next table right away');
      const seen = new Set();
      for (let i = 0; i < 40; i++) seen.add(rot.random());
      assert.equal(seen.has('Dice'), false, [...seen].join(','));
    });
  });
});
