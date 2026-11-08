import assert from 'node:assert/strict';
import test from 'node:test';
import { KickChat } from '../src/chat-kick.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function scheduler() {
  let id = 0;
  const intervals = new Map(), timeouts = new Map();
  return { intervals, timeouts,
    setInterval(fn, ms) { intervals.set(++id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, ms) { timeouts.set(++id, { fn, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
  };
}
const response = (messages = []) => ({ ok: true, async json() { return { messages }; } });

test('DOM fallback is single-flight, shares delivery dedupe, and intentional close never restarts DOM', async () => {
  const timers = scheduler();
  const delivered = [];
  let failApi = false, nextMessages = [], closeHandler, opens = 0, evaluations = 0, releasePin;
  const page = { async setUserAgent() {}, async goto() {}, on(_event, fn) { closeHandler = fn; },
    async close() { closeHandler?.(); },
    async evaluate() { evaluations++; if (evaluations === 1) await new Promise(r => { releasePin = r; });
      return { ok: true, rows: [{ name: 'Ann', text: 'limbo' }] }; },
  };
  const chat = new KickChat({ channel: 'test', onMessage: m => delivered.push(m), timers,
    browserProvider: async () => ({ async newPage() { opens++; return page; }, async pages() { return []; } }),
    fetchImpl: async url => {
      if (!url.endsWith('/messages')) return { ok: true, async json() { return { id: 1 }; } };
      if (failApi) throw new Error('offline');
      return response(nextMessages);
    },
  });
  chat.start(); await flush(); failApi = true;
  try {
    const apiTick = [...timers.intervals.values()][0].fn;
    for (let i = 0; i < 4; i++) { apiTick(); await flush(); }
    assert.equal(opens, 1);
    const domTick = [...timers.intervals.values()][0].fn;
    domTick(); domTick(); await flush();
    assert.equal(evaluations, 1);
    releasePin(); await flush();
    assert.equal(delivered.length, 1);
    failApi = false;
    nextMessages = [{ id: 'a', sender: { username: 'Ann' }, content: 'limbo' }];
    const [recoveryId, recovery] = [...timers.timeouts.entries()].find(([, t]) => t.ms === 15000);
    timers.timeouts.delete(recoveryId); await recovery.fn(); await flush();
    assert.equal(chat.mode, 'api');
    assert.equal(delivered.length, 1, 'API recovery must not replay DOM message');
    assert.equal(timers.timeouts.size, 0, 'intentional page.close must not schedule DOM recovery');
    assert.equal(opens, 1);
  } finally { chat.stop(); }
});

test('API polling is single-flight and stop discards an in-flight result', async () => {
  const timers = scheduler();
  const delivered = [];
  let finish, requests = 0;
  const chat = new KickChat({ channel: 'test', onMessage: m => delivered.push(m), timers,
    fetchImpl: async url => {
      if (!url.endsWith('/messages')) return { ok: true, async json() { return { id: 1 }; } };
      requests++;
      return new Promise(resolve => { finish = resolve; });
    },
  });
  chat.start(); chat.start();
  try {
    await flush();
    assert.equal(requests, 1);
    const tick = [...timers.intervals.values()][0].fn;
    tick(); tick(); await flush();
    assert.equal(requests, 1);
    finish(response()); await flush();
    tick(); await flush(); assert.equal(requests, 2);
    chat.stop();
    finish(response([{ id: 'new', sender: { username: 'Ann' }, content: 'hi' }]));
    await flush();
    assert.deepEqual(delivered, []);
    assert.equal(timers.intervals.size, 0);
    assert.equal(timers.timeouts.size, 0);
  } finally { chat.stop(); }
});
