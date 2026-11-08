// Adapter contract tests: registry shape, settings capabilities, start-label choice,
// and result mapping. Run: node --test test/core-adapters.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALL, byName, names } from '../src/core/adapters/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_DIR = path.join(HERE, '..', 'src', 'core', 'adapters');
const FILES = [
  'dice.js',
  'mines.js',
  'plinko.js',
  'keno.js',
  'wheel.js',
  'limbo.js',
  'maxwin.js',
  'dragon-tower.js',
  'hubie-road.js',
  'hilo.js',
  'blackjack.js',
];
const EXPECTED = ['Dice', 'Mines', 'Plinko', 'Keno', 'Wheel', 'Limbo', 'Max Win', 'Dragon Tower', "Hubie's Road", 'Hilo', 'Blackjack'];

function countingTools() {
  const calls = { set_multiplier: [], set_win_chance: [], other: [] };
  return {
    calls,
    async set_multiplier(value) {
      calls.set_multiplier.push(value);
      return { ok: true };
    },
    async set_win_chance(value) {
      calls.set_win_chance.push(value);
      return { ok: true };
    },
    async set_stake(value) {
      calls.other.push(['set_stake', value]);
      return { ok: true };
    },
    async click(label) {
      calls.other.push(['click', label]);
      return { ok: true, label };
    },
  };
}

function clickRecorder({ available = null, controls = null } = {}) {
  const seen = [];
  const tools = {
    async click(label) {
      seen.push(label);
      if (!available) return { ok: true, label };
      const ok = available.some((item) => String(item).toLowerCase() === String(label).toLowerCase());
      return ok ? { ok: true, label } : { ok: false, label, error: 'not available' };
    },
  };
  if (controls) tools.world = { get: () => ({ controls }) };
  return { tools, seen };
}

test('registry exposes all eleven games with unique names and slugs', () => {
  assert.equal(ALL.length, 11);
  assert.deepEqual(names(), EXPECTED);
  assert.equal(new Set(names()).size, ALL.length);

  const nameSet = new Set(ALL.map((adapter) => adapter.name.toLowerCase()));
  const slugSet = new Set(ALL.map((adapter) => adapter.slug.toLowerCase()));
  assert.equal(nameSet.size, ALL.length);
  assert.equal(slugSet.size, ALL.length);

  for (const adapter of ALL) {
    assert.match(adapter.slug, /^housegames-[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(byName(adapter.name), adapter);
    assert.equal(byName(adapter.name.toUpperCase()), adapter);
    assert.equal(byName(adapter.slug), adapter);
  }

  assert.equal(byName('tower'), byName('Dragon Tower'));
  assert.equal(byName('crash'), byName('Limbo'));
  assert.equal(byName('road'), byName("Hubie's Road"));
  assert.equal(byName('maxwin'), byName('Max Win'));
  assert.equal(byName('no such game'), null);
  assert.equal(byName(''), null);
  assert.equal(byName(undefined), null);
});

test('every adapter has the contract shape', () => {
  for (const adapter of ALL) {
    assert.equal(typeof adapter.name, 'string');
    assert.ok(adapter.name.trim().length > 0);
    assert.equal(typeof adapter.slug, 'string');
    assert.ok(adapter.settings && typeof adapter.settings === 'object' && !Array.isArray(adapter.settings));
    for (const [setting, type] of Object.entries(adapter.settings)) {
      assert.ok(setting === 'multiplier' || setting === 'winChance', `${adapter.name}: unknown setting ${setting}`);
      assert.equal(type, 'Number');
    }

    assert.ok(Array.isArray(adapter.startLabels), `${adapter.name}: startLabels`);
    assert.ok(adapter.startLabels.length >= 2, `${adapter.name}: needs a fallback start label`);
    for (const label of adapter.startLabels) {
      assert.equal(typeof label, 'string');
      assert.ok(label.trim().length > 0);
    }
    assert.equal(
      new Set(adapter.startLabels.map((label) => label.toLowerCase())).size,
      adapter.startLabels.length,
      `${adapter.name}: duplicate start labels`,
    );

    for (const fn of ['configure', 'start', 'result']) {
      assert.equal(typeof adapter[fn], 'function', `${adapter.name}.${fn} must be a function`);
    }
  }
});

test('supported games advertise settings, the rest are deliberate no-ops', async () => {
  const supported = ALL.filter((adapter) => Object.keys(adapter.settings).length > 0).map((adapter) => adapter.name);
  const unsupported = ALL.filter((adapter) => Object.keys(adapter.settings).length === 0).map((adapter) => adapter.name);
  assert.deepEqual(supported.sort(), ['Dice', 'Keno', 'Limbo', 'Max Win', 'Plinko', 'Wheel'].sort());
  assert.deepEqual(unsupported.sort(), ['Blackjack', 'Dragon Tower', 'Hilo', "Hubie's Road", 'Mines'].sort());

  for (const adapter of ALL) {
    const tools = countingTools();
    const out = await adapter.configure(tools, { multiplier: 2.5, winChance: 40 });
    const wantsMultiplier = adapter.settings.multiplier === 'Number';
    const wantsChance = adapter.settings.winChance === 'Number';

    assert.deepEqual(tools.calls.set_multiplier, wantsMultiplier ? [2.5] : [], `${adapter.name}: multiplier call`);
    assert.deepEqual(tools.calls.set_win_chance, wantsChance ? [40] : [], `${adapter.name}: win chance call`);
    assert.deepEqual(tools.calls.other, [], `${adapter.name}: configure touched a non-settings tool`);
    assert.equal(out.ok, true);
  }
});

test('configure ignores empty wants and missing tools without throwing', async () => {
  for (const adapter of ALL) {
    const tools = countingTools();
    await adapter.configure(tools, {});
    await adapter.configure(tools, undefined);
    await adapter.configure(tools, { multiplier: null, winChance: '' });
    assert.deepEqual(tools.calls.set_multiplier, [], `${adapter.name}: empty multiplier`);
    assert.deepEqual(tools.calls.set_win_chance, [], `${adapter.name}: empty chance`);

    await adapter.configure({}, { multiplier: 2, winChance: 30 });
  }
});

test('start prefers the first available label in startLabels order', async () => {
  for (const adapter of ALL) {
    const reversed = adapter.startLabels.slice().reverse();
    const { tools, seen } = clickRecorder({ available: reversed, controls: reversed });
    const out = await adapter.start(tools);
    assert.deepEqual(seen, [adapter.startLabels[0]], `${adapter.name}: wrong first control`);
    assert.equal(out.ok, true);
    assert.equal(out.label, adapter.startLabels[0]);
  }
});

test('start falls back to the next label when the first is unavailable', async () => {
  for (const adapter of ALL) {
    const second = adapter.startLabels[1];
    const { tools, seen } = clickRecorder({ available: [second], controls: [second] });
    const out = await adapter.start(tools);
    assert.deepEqual(seen, [second], `${adapter.name}: fallback control`);
    assert.equal(out.ok, true);
    assert.equal(out.label, second);
  }
});

test('start probes labels in order when the world has no control list', async () => {
  for (const adapter of ALL) {
    const second = adapter.startLabels[1];
    const seen = [];
    const tools = {
      async click(label) {
        seen.push(label);
        return { ok: label === second, label, error: label === second ? undefined : 'missing' };
      },
    };
    const out = await adapter.start(tools);
    assert.deepEqual(seen, adapter.startLabels.slice(0, 2), `${adapter.name}: probe order`);
    assert.equal(out.ok, true);
    assert.equal(out.label, second);
  }
});

test('start reports failure when no start label is on the table', async () => {
  for (const adapter of ALL) {
    const seen = [];
    const tools = {
      world: { get: () => ({ controls: ['Something else'] }) },
      async click(label) {
        seen.push(label);
        return { ok: true, label };
      },
    };
    const out = await adapter.start(tools);
    assert.equal(out.ok, false, `${adapter.name}: should fail without a start control`);
    assert.deepEqual(seen, [], `${adapter.name}: should not click a missing control`);
  }
  assert.equal((await ALL[0].start({})).ok, false);
});

test('result maps null, win, and loss from world.lastResult', () => {
  for (const adapter of ALL) {
    assert.equal(adapter.result(null), null, `${adapter.name}: null world`);
    assert.equal(adapter.result({}), null, `${adapter.name}: empty world`);
    assert.equal(adapter.result({ lastResult: null }), null, `${adapter.name}: null result`);
    assert.equal(adapter.result({ lastResult: { value: null, won: null } }), null, `${adapter.name}: empty result`);

    assert.deepEqual(
      adapter.result({ lastResult: { value: 88.75, won: true } }),
      { value: 88.75, won: true, source: 'world' },
      `${adapter.name}: win`,
    );
    assert.deepEqual(
      adapter.result({ lastResult: { value: 0, won: false } }),
      { value: 0, won: false, source: 'world' },
      `${adapter.name}: loss`,
    );
    assert.deepEqual(
      adapter.result({ lastResult: { value: 2.5, won: true, source: 'marker' } }),
      { value: 2.5, won: true, source: 'marker' },
      `${adapter.name}: preserves source`,
    );
    assert.deepEqual(
      adapter.result({ lastResult: { value: 3 } }),
      { value: 3, won: null, source: 'world' },
      `${adapter.name}: unknown outcome`,
    );
    assert.deepEqual(
      adapter.result({ get: () => ({ lastResult: { value: 1.98, won: false } }) }),
      { value: 1.98, won: false, source: 'world' },
      `${adapter.name}: World-like object`,
    );
  }
});

test('adapters carry no game.js import and no DOM access', () => {
  for (const file of FILES) {
    const source = fs.readFileSync(path.join(ADAPTER_DIR, file), 'utf8');
    assert.doesNotMatch(source, /(?:from|import\s*\()\s*['"][^'"]*game\.js/i, `${file}: imports game.js`);
    assert.doesNotMatch(source, /\b(?:document|window|navigator|localStorage)\b/, `${file}: touches the DOM`);
    assert.doesNotMatch(source, /querySelector|createElement|innerHTML/, `${file}: manipulates the DOM`);
  }
});
