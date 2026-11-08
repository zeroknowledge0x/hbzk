import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { chromePath } from '../src/config.js';
import { GameFeed } from '../src/game.js';
import { Tools } from '../src/core/tools.js';

// Run the actual page.evaluate callbacks in an isolated Chromium DOM, never a live table.
let browser;
before(async () => {
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true,
    args: ['--no-sandbox', '--disable-gpu'] });
});
after(async () => { await browser?.close(); });
async function fixture(t, html) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent(html);
  const feed = new GameFeed({ url: '' });
  feed.page = page;
  return { page, feed };
}

test('ensureBetZero writes zero without activating positive minimum controls', async (t) => {
  const { page, feed } = await fixture(t, `<label>Bet amount<input aria-label="Bet amount" value="5"></label>
    <button onclick="window.minClicks=(window.minClicks||0)+1;document.querySelector('input').value='1'">Min bet</button>`);
  const out = await feed.ensureBetZero();
  assert.equal(await page.$eval('input', el => el.value), '0');
  assert.equal(await page.evaluate(() => window.minClicks || 0), 0);
  assert.equal(out.ok, true);
  assert.equal(out.verified, true);
  assert.equal(out.observed, 0);
});

test('zero verification refuses clamped or unidentified stake', async (t) => {
  for (const html of [
    `<input aria-label="Bet amount" value="5" oninput="this.value='1'">`,
    '<input value="0">',
  ]) {
    const { feed } = await fixture(t, html);
    assert.equal((await feed.ensureBetZero()).ok, false);
  }
});

for (const [name, html] of [
  ['disabled', '<button disabled>Bet</button>'],
  ['aria disabled', '<button aria-disabled="true">Bet</button>'],
  ['disabled ancestor', '<fieldset disabled><button>Bet</button></fieldset>'],
  ['aria disabled ancestor', '<div aria-disabled="true"><button>Bet</button></div>'],
  ['disabled shadow host', '<div id="host" aria-disabled="true"></div><script>host.attachShadow({mode:"open"}).innerHTML="<button>Bet</button>"</script>'],
]) {
  test(`clickText refuses ${name} and snapshot omits it`, async (t) => {
    const { page, feed } = await fixture(t, html);
    await page.evaluate(() => { window.clicks = 0; document.addEventListener('click', () => window.clicks++); });
    assert.equal((await feed.clickText('Bet')).ok, false);
    assert.equal(await page.evaluate(() => window.clicks), 0);
    assert.deepEqual((await feed.getUiSnapshot({ force: true })).clickables, []);
    assert.equal(feed.lastPointer, null);
  });
}

test('enabled zero-value demo cashout is actionable', async (t) => {
  const { page, feed } = await fixture(t, '<button onclick="window.cashed=true">Cash out $0.00</button>');
  assert.equal((await feed.clickText('Cash out')).ok, true);
  assert.equal(await page.evaluate(() => window.cashed), true);
});

test('a no-op click method cannot report a successful action', async (t) => {
  const { page, feed } = await fixture(t, '<button>Bet</button>');
  await page.$eval('button', el => { el.click = () => {}; });
  assert.equal((await feed.clickText('Bet')).ok, false);
  assert.equal(feed.lastPointer, null);
});

for (const label of ['Bet', 'Roll', 'Deal', 'Spin', 'Play', 'Cash out', 'GO', 'Start', 'Double', 'Split']) {
  test(`${label} fails closed on failed or unknown fresh stake`, async () => {
    for (const settings of [{ ok: false, stake: 0 }, { ok: true }, { ok: true, stake: null },
      { ok: true, stake: '' }, { ok: true, stake: ' ' }, { ok: true, stake: 1 }]) {
      let clicks = 0;
      const tools = new Tools({ world: { stake: 0, phase: 'playing', controls: [label] },
        game: { readSettings: async () => settings, clickText: async () => { clicks++; return { ok: true }; } } });
      assert.equal((await tools.run('click', { label })).ok, false, JSON.stringify(settings));
      assert.equal(clicks, 0);
    }
  });
}

test('missing settings and unknown world stake cannot authorize a wager', async () => {
  let clicks = 0;
  const tools = new Tools({ world: { phase: 'betting' }, game: {
    clickText: async () => { clicks++; return { ok: true }; },
  } });
  assert.equal((await tools.run('click', { label: 'Bet' })).ok, false);
  assert.equal(clicks, 0);
});

for (const label of ['Wallet', 'Deposit', 'Min', 'Min bet', 'Max', 'Max bet', 'Half', 'Half bet',
  'Halve', '1/2', '1/2 bet', '½', '2×', '2x', 'Double bet', 'Bet amount', 'Increase stake', 'Decrease wager']) {
  test(`${label} is a forbidden money/stake modifier even at zero`, async () => {
    let clicks = 0;
    const tools = new Tools({ world: { stake: 0, phase: 'betting', controls: [label] },
      game: { readSettings: async () => ({ ok: true, stake: 0 }),
        clickText: async () => { clicks++; return { ok: true }; } } });
    assert.equal((await tools.run('click', { label })).ok, false);
    assert.equal(clicks, 0);
  });
}

test('verified zero permits demo round actions including cashout and double/split', async () => {
  for (const label of ['GO', 'Start', 'Double', 'Split', 'Cash out']) {
    let clicks = 0;
    const tools = new Tools({ world: { phase: 'playing', controls: [label] }, game: {
      readSettings: async () => ({ ok: true, stake: 0 }),
      clickText: async () => { clicks++; return { ok: true }; },
    } });
    assert.equal((await tools.run('click', { label })).ok, true);
    assert.equal(clicks, 1);
  }
});
