import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalRoundTracker, observeLocalRoundDom } from '../src/round-events.js';
import vm from 'node:vm';
import { GameFeed } from '../src/game.js';
import { Verifier } from '../src/core/verifier.js';

// Minimal observed-DOM contract, not a claimed production HTML fixture.
// Production selectors are inherited from game.js/game-settings.js.


const observation = (patch = {}) => ({ scope: 'document-1:dice', game: 'dice', seq: 1,
  busy: false, resultRevision: 0, settingsMultiplier: 4,
  outcome: { sensor: 'dice-marker', result: 88.75, won: true }, ...patch });

test('fresh Dice start and result produces a trusted local event, never uses roll as payout', () => {
  const tracker = new LocalRoundTracker();
  assert.equal(tracker.observe(observation()), null, 'startup marker is stale');
  assert.equal(tracker.observe(observation({ seq: 2, busy: true })), null);
  const event = tracker.observe(observation({ seq: 3, resultRevision: 1 }));
  assert.equal(event.source, 'local-round');
  assert.equal(event.confirmed, true);
  assert.equal(event.local, true);
  assert.equal(event.game, 'dice');
  assert.equal(event.result, 88.75);
  assert.equal(event.payoutMultiplier, 4);
  assert.ok(event.eventId);
  assert.equal(tracker.observe(observation({ seq: 4, resultRevision: 1 })), event);
});

test('verifier rejects reserialized local event with the same identity', async () => {
  const event = { source: 'local-round', confirmed: true, local: true, game: 'dice',
    eventId: 'one', result: 88.75, won: true, payoutMultiplier: 4 };
  const before = { game: 'Dice', report: { outcome: event } };
  const world = { game: 'Dice', report: { outcome: { ...event, observedAt: 100 } } };
  assert.equal((await new Verifier({ world }).waitFor('round_result', { before, timeout: 0 })).ok, false);
});

function domFixture(game = 'dice') {
  let notify;
  const node = (textContent, className = '') => ({ textContent, className, value: '', disabled: false,
    tagName: 'SPAN', parentElement: null,
    getAttribute(name) { return name === 'class' ? this.className : null; },
    hasAttribute() { return false; }, matches() { return false; },
    getBoundingClientRect: () => ({ width: 50, height: 30 }),
    getRootNode: () => root });
  const marker = node('88.75', 'hd-g-marker hd-g-marker--win');
  const payhit = node('5x', 'hl-g-payhit hl-g-payhit--on');
  const foot = node('3 of 10', 'hl-g-foot-val--hits');
  const button = node('Bet'); button.tagName = 'BUTTON';
  const multiplier = node(''); multiplier.value = '4'; multiplier.id = 'hd-g-in-mult';
  const nodes = game === 'dice' ? [marker, button, multiplier] : [payhit, foot, button];
  const root = { host: null, querySelectorAll(sel) {
    if (sel === '*') return nodes;
    return nodes.filter(n => sel.includes('button') && n === button
      || sel.includes('hd-g-marker') && n === marker
      || sel.includes('hl-g-payhit') && n === payhit
      || sel.includes('hl-g-foot-val--hits') && n === foot
      || sel.includes('hd-g-in-mult') && n === multiplier);
  }};
  const host = { tagName: `${game.toUpperCase()}-GAME`, shadowRoot: root,
    getBoundingClientRect: () => ({ width: 500, height: 500 }) };
  root.host = host;
  const context = vm.createContext({ document: { querySelectorAll: sel => sel === '*' ? [host] : [] },
    location: { href: `https://housebets.com/games/housegames-${game}` },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { constructor(fn) { notify = fn; } observe() {} disconnect() {} },
    window: {}, performance: { timeOrigin: 123 },
  });
  const read = () => vm.runInContext(`(${observeLocalRoundDom.toString()})()`, context);
  return { read, button, marker, payhit, foot, mutate: records => notify(records) };
}

test('DOM bridge witnesses scoped busy and marker mutation between polls; equal rounds have new IDs', () => {
  const dom = domFixture();
  const tracker = new LocalRoundTracker();
  for (const s of dom.read()) assert.equal(tracker.observe(s), null);
  const round = () => {
    dom.button.disabled = true;
    dom.mutate([{ type: 'attributes', attributeName: 'disabled', target: dom.button }]);
    dom.marker.textContent = '88.75';
    dom.button.disabled = false;
    dom.mutate([{ type: 'characterData', target: { parentElement: dom.marker } },
      { type: 'attributes', attributeName: 'disabled', target: dom.button }]);
    let event;
    for (const s of dom.read()) event = tracker.observe(s);
    return event;
  };
  const first = round();
  assert.equal(first.payoutMultiplier, 4);
  const second = round();
  assert.notEqual(first.eventId, second.eventId);
  assert.equal(second.result, 88.75);
  assert.equal(tracker.observe(dom.read().at(-1)).eventId, second.eventId);
});

test('GameFeed refresh assembly consumes sensor observations rather than raw global outcomes', async () => {
  const feed = new GameFeed({ url: '' });
  let samples = [observation()];
  feed.page = { isClosed: () => false, evaluate: async fn => fn.name === 'observeLocalRoundDom'
    ? samples : { bodySnippet: '', clickables: [], outcome: { source: 'handle-row', result: 100 } } };
  assert.equal((await feed.getUiSnapshot({ force: true })).outcome, null);
  samples = [observation({ seq: 2, busy: true }), observation({ seq: 3, resultRevision: 1 })];
  const event = (await feed.getUiSnapshot({ force: true })).outcome;
  assert.equal(event.source, 'local-round');
  assert.equal(event.payoutMultiplier, 4);
});
