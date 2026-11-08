import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { isFrameBlack } from '../src/capture-health.js';
import { OpsLoop } from '../src/ops-loop.js';
import { readFile } from 'node:fs/promises';
import { GameFeed } from '../src/game.js';

async function startupFeed(options) {
  // Inject only the browser boundary; exercise the actual public startup code offline.
  const moduleUrl = new URL('../src/game.js', import.meta.url);
  const source = (await readFile(moduleUrl, 'utf8'))
    .replace("import { getBrowser } from './browser.js';", 'const getBrowser = async () => globalThis.__captureTestBrowser;')
    .replace(/from '([^']+)'/g, (_, path) => `from '${path.startsWith('.') ? new URL(path, moduleUrl).href : import.meta.resolve(path)}'`);
  const { GameFeed: OfflineFeed } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const { feed: fixture, calls } = reloadFeed(options);
  const feed = new OfflineFeed({ url: 'https://www.housebets.com/casino' });
  Object.assign(feed, { page: fixture.page, screencasting: true,
    openGameByCard: fixture.openGameByCard, ensureBetZero: fixture.ensureBetZero });
  feed.page.setViewport = feed.page.setUserAgent = async () => {};
  globalThis.__captureTestBrowser = { pages: async () => [feed.page] };
  return { feed, calls };
}

function source({ blank = false, covered = false, noise = false } = {}) {
  const canvas = createCanvas(1280, 720);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#172430';
  ctx.fillRect(0, 0, 1280, 720);
  ctx.fillStyle = '#ddeeff';
  ctx.fillRect(0, 0, 1280, 90); // A healthy header must not mask a missing game.
  if (!blank) {
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
      ctx.fillStyle = covered ? '#304455' : (x + y) % 2 ? '#61788c' : '#dfbc20';
      ctx.fillRect(420 + x * 85, 145 + y * 70, 75, 60);
    }
  } else if (noise) {
    // Deterministic near-flat compression noise, not game texture.
    for (let y = 90; y < 720; y += 4) for (let x = 0; x < 1280; x += 4) {
      const v = 30 + ((x * 7 + y * 11) % 5);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x, y, 4, 4);
    }
  }
  return canvas;
}

test('dark central panel is blank despite a bright header', () => {
  assert.equal(isFrameBlack(source({ blank: true })), true);
  assert.equal(isFrameBlack(source({ blank: true, noise: true })), true);
});

test('small isolated bright speck cannot disguise a blank dark game panel', () => {
  const img = source({ blank: true });
  const ctx = img.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(600, 280, 16, 16);
  assert.equal(isFrameBlack(img), true);
});

test('capture sampling exceptions fail closed', () => {
  assert.equal(isFrameBlack({ width: 1280, height: 720 }), true);
});

test('covered Mines tile grid is healthy without animation or selected tiles', () => {
  assert.equal(isFrameBlack(source({ covered: true })), false);
  assert.equal(isFrameBlack(source()), false);
});

async function badTicks(ops, count = 5) {
  for (let i = 0; i < count; i++) await ops.watchCapture();
}

test('persistent blank escalates rearm to reload with cooldown and no table cycle', async () => {
  let now = 100000, rearms = 0, reloads = 0, verifies = 0;
  const logs = [];
  const game = {
    frame: source({ blank: true }), frameAgeMs: 0,
    async reviveCapture() { rearms++; return { ok: false }; },
    async reload() { reloads++; return { ok: true }; },
    async waitForCapture() { verifies++; return { ok: false, error: 'blank' }; },
  };
  const ops = new OpsLoop({ game, now: () => now, log: (line) => logs.push(line),
    rotation: { playNow() { assert.fail('capture recovery must not cycle tables'); } } });
  await badTicks(ops);
  assert.equal(rearms, 1);
  assert.equal(reloads, 0);
  await badTicks(ops);
  assert.equal(reloads, 1);
  assert.equal(verifies, 1);
  assert.ok(!logs.some((line) => /recovered|restored/.test(line)));
  await badTicks(ops, 15);
  assert.equal(reloads, 1);
  now += 60001;
  await badTicks(ops);
  assert.equal(reloads, 2);
  game.frame = source({ covered: true });
  await ops.watchCapture();
  game.frame = source({ blank: true });
  await badTicks(ops);
  assert.equal(rearms, 2);
});

test('recovery exposes a mutation pause through rearm and releases it on failure', async () => {
  let release;
  const game = { frame: source({ blank: true }), frameAgeMs: 0,
    reviveCapture: () => new Promise((_, reject) => { release = reject; }) };
  const ops = new OpsLoop({ game });
  const pending = ops.apply({ do: 'rearm_capture' });
  assert.equal(game.captureRecoveryInFlight, true);
  await new Promise((resolve) => setImmediate(resolve));
  release(new Error('sample failed'));
  await pending;
  assert.equal(game.captureRecoveryInFlight, false);
  assert.equal(ops.captureRecovery, null);
});

test('owner cannot treat healthy pixels on the wrong table as reload success', async () => {
  const logs = [];
  const game = { frame: source({ blank: true }), frameAgeMs: 0,
    reviveCapture: async () => ({ ok: false }),
    reload: async () => ({ ok: false, error: 'wrong table' }),
    waitForCapture: async () => { game.frame = source(); return { ok: true }; } };
  const ops = new OpsLoop({ game, log: (line) => logs.push(line) });
  await ops.apply({ do: 'rearm_capture' });
  await ops.apply({ do: 'rearm_capture' });
  assert.ok(!logs.some((line) => /restored/.test(line)));
});

test('reload remains in flight until fresh pixels are verified', async () => {
  let release, verified = false;
  const game = { frame: source({ blank: true }), frameAgeMs: 0,
    reviveCapture: async () => ({ ok: false }), reload: async () => ({ ok: true }),
    waitForCapture: () => new Promise((resolve) => { release = () => {
      game.frame = source({ covered: true }); verified = true; resolve({ ok: true });
    }; }),
  };
  const logs = [];
  const ops = new OpsLoop({ game, log: (line) => logs.push(line) });
  await badTicks(ops);
  await badTicks(ops, 4);
  const pending = ops.watchCapture();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(verified, false);
  assert.ok(ops.captureRecovery);
  assert.ok(!logs.some((line) => /restored/.test(line)));
  release();
  await pending;
  assert.ok(logs.some((line) => /restored.*verified reload/.test(line)));
  assert.equal(ops.captureRecovery, null);
});

test('owner and watchdog share one recovery flight', async () => {
  let release, attempts = 0;
  const game = { frame: source({ blank: true }), frameAgeMs: 0,
    reviveCapture: () => { attempts++; return new Promise((resolve) => { release = resolve; }); } };
  const ops = new OpsLoop({ game });
  await badTicks(ops, 4);
  const active = ops.watchCapture();
  await badTicks(ops, 10);
  const owner = ops.apply({ do: 'rearm_capture' });
  assert.equal(attempts, 1);
  release({ ok: false });
  await Promise.all([active, owner]);
});

function offlineFeed({ iframe = false } = {}) {
  const feed = new GameFeed({ url: 'https://example.invalid/games/housegames-mines' });
  const calls = [];
  const jpeg = source({ covered: true }).toBuffer('image/jpeg');
  const element = { boundingBox: async () => ({ x: 100, y: 100, width: 800, height: 500 }),
    screenshot: async () => { calls.push('element-shot'); return jpeg; }, dispose: async () => {} };
  const main = {};
  const child = { frameElement: async () => element }; // Frame.screenshot intentionally absent (Puppeteer 24).
  const client = { send: async (name) => { calls.push(name); }, on() {}, disconnect() {} };
  feed.page = { isClosed: () => false, createCDPSession: async () => client,
    bringToFront: async () => {}, on() {}, mainFrame: () => main,
    frames: () => iframe ? [main, child] : [main],
    screenshot: async () => { calls.push('page-shot'); return jpeg; } };
  return { feed, calls };
}

test('Puppeteer 24 fallback screenshots iframe element, not nonexistent Frame.screenshot', async () => {
  const { feed, calls } = offlineFeed({ iframe: true });
  try {
    const result = await feed.reviveCapture({ timeoutMs: 50 });
    assert.equal(result.ok, true);
    assert.ok(calls.includes('element-shot'));
    assert.equal(isFrameBlack(feed.frame), false);
  } finally { feed.stopped = true; clearInterval(feed.watchTimer); }
});

test('shadow-DOM game with no useful iframe falls back to page screenshot', async () => {
  const { feed, calls } = offlineFeed();
  try {
    const result = await feed.reviveCapture({ timeoutMs: 50 });
    assert.equal(result.ok, true);
    assert.ok(calls.includes('page-shot'));
  } finally { feed.stopped = true; clearInterval(feed.watchTimer); }
});

test('rearm alone is not success and concurrent revival is single flight', async () => {
  const { feed, calls } = offlineFeed();
  feed.page.screenshot = async () => source({ blank: true }).toBuffer('image/jpeg');
  try {
    const results = await Promise.all([feed.reviveCapture({ timeoutMs: 30 }), feed.reviveCapture({ timeoutMs: 30 })]);
    assert.ok(results.every((r) => r.ok === false));
    assert.equal(calls.filter((c) => c === 'Page.startScreencast').length, 1);
  } finally { feed.stopped = true; clearInterval(feed.watchTimer); }
});

test('tiny about:blank iframe is ignored in favour of the shadow-DOM page', async () => {
  const { feed, calls } = offlineFeed({ iframe: true });
  feed.page.frames = () => [feed.page.mainFrame(), { frameElement: async () => ({
    boundingBox: async () => ({ width: 1, height: 1 }),
    screenshot: async () => assert.fail('must not capture 1px frame'), dispose: async () => {},
  }) }];
  try {
    assert.equal((await feed.reviveCapture({ timeoutMs: 50 })).ok, true);
    assert.ok(calls.includes('page-shot'));
  } finally { feed.stopped = true; clearInterval(feed.watchTimer); }
});

function reloadFeed({ landing = 'housegames-mines', initial = 'housegames-mines' } = {}) {
  const feed = new GameFeed({ url: 'https://www.housebets.com/casino' });
  let url = `https://www.housebets.com/games/${initial}`;
  const calls = [];
  const category = { offsetParent: {}, innerText: 'Blackjack', tagName: 'A',
    getAttribute: (name) => name === 'href' ? '/games/blackjack' : '',
    click() { calls.push('category'); url = 'https://www.housebets.com/games/blackjack'; } };
  feed.screencasting = true;
  feed.page = { isClosed: () => false, url: () => url, title: async () => 'Housebets',
    reload: async () => { calls.push('reload'); url = `https://www.housebets.com/games/${landing}`; },
    goto: async () => assert.fail('reload must never navigate to a table'),
    evaluate: async (fn, ...args) => {
      if (args[0]?.gameSrc) {
        globalThis.document = { querySelectorAll: () => [category] };
        try { return fn(...args); } finally { delete globalThis.document; }
      }
      return 'Mines table';
    },
  };
  feed.openGameByCard = async (label) => {
    calls.push(`card:${label}`); url = 'https://www.housebets.com/games/housegames-mines';
    return { ok: true, slug: 'mines' };
  };
  feed.ensureBetZero = async () => ({ ok: true });
  return { feed, calls };
}

test('public startup on a table never clicks sidebar categories', async () => {
  const { feed, calls } = await startupFeed();
  try {
    await feed.start();
    assert.equal(feed.page.url(), 'https://www.housebets.com/games/housegames-mines');
    assert.deepEqual(calls, []);
  } finally { delete globalThis.__captureTestBrowser; }
});

test('public startup on a lobby enters the intended verified card, not a category', async () => {
  const { feed, calls } = await startupFeed({ initial: 'blackjack' });
  feed.preferredGame = 'Mines';
  try {
    await feed.start();
    assert.equal(feed.page.url(), 'https://www.housebets.com/games/housegames-mines');
    assert.deepEqual(calls, ['card:Mines']);
  } finally { delete globalThis.__captureTestBrowser; }
});

test('public reload preserves the actual source table without clicking a category', async () => {
  const { feed, calls } = reloadFeed();
  const result = await feed.reload();
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://www.housebets.com/games/housegames-mines');
  assert.deepEqual(calls, ['reload']);
});

test('public reload reopens the source table by card only after a lobby fallback', async () => {
  const { feed, calls } = reloadFeed({ landing: 'blackjack' });
  feed.preferredGame = 'Blackjack';
  const result = await feed.reload();
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://www.housebets.com/games/housegames-mines');
  assert.deepEqual(calls, ['reload', 'card:Mines']);
});

test('verification requires a new healthy frame, not cached healthy pixels', async () => {
  const { feed } = offlineFeed();
  feed.frame = source();
  feed.lastFrameAt = Date.now() - 100;
  const result = await feed.waitForCapture({ after: Date.now(), timeoutMs: 20, pollMs: 5 });
  assert.equal(result.ok, false);
});
