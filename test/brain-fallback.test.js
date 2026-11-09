import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { createChain } from '../src/core/llm-chain.js';

const BODY_429 = '{"error":{"message":"weekly usage limit. resets at 2030-01-01T00:00:00.000Z"}}';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
}

const cfg = (over = {}) => ({
  llmUrl: 'https://primary.test/v1/chat/completions',
  llmKey: 'k1',
  llmModel: 'primary-model',
  ttsVoice: 'en_US-lessac-medium',
  ...over,
});

test('a spent primary plan falls through to the configured second provider', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('primary')) return response(429, BODY_429);
    return response(200, JSON.stringify({ choices: [{ message: { content: 'still here' } }] }));
  };
  const chain = createChain([
    { name: 'primary', url: cfg().llmUrl, model: 'primary-model', key: 'k1' },
    { name: 'fallback', url: 'https://second.test/v1/chat/completions', model: 'second-model', key: 'k2' },
  ]);
  const brain = new Brain(cfg(), { chain, fetchImpl });
  const out = await brain.say('viewer', { report: {}, chat: ['hi'] });
  assert.ok(calls.some((u) => u.includes('second')), JSON.stringify(calls));
  assert.ok(chain.providers[0].coolUntil > Date.now(), 'the spent plan is parked');
  assert.equal(typeof out, 'object');
});

test('with both providers parked the brain answers from the canned table instead of hanging', async () => {
  const fetchImpl = async () => response(429, BODY_429);
  const chain = createChain([
    { name: 'primary', url: 'https://primary.test/v1/chat/completions', model: 'm', key: 'k' },
    { name: 'fallback', url: 'https://second.test/v1/chat/completions', model: 'm', key: 'k' },
  ]);
  const brain = new Brain(cfg(), { chain, fetchImpl });
  const out = await brain.say('viewer', { report: {}, chat: ['hi'] });
  assert.equal(out.fallback, true, 'the show must not go silent');
  assert.equal(chain.providers.filter((p) => p.coolUntil > Date.now()).length, 2);
});
