import assert from 'node:assert/strict';
import test from 'node:test';
import { Brain, OWNER_SYSTEM } from '../src/brain.js';

test('OWNER_SYSTEM asks for do/click JSON, not the old agent action schema', () => {
  assert.match(OWNER_SYSTEM, /"do":/);
  assert.match(OWNER_SYSTEM, /rearm_capture/);
  assert.match(OWNER_SYSTEM, /State\.controls/);
  assert.doesNotMatch(OWNER_SYSTEM, /"action":"wait"/);
  assert.doesNotMatch(OWNER_SYSTEM, /page\.goto/);
});

test('brain.say owner sends OWNER_SYSTEM, prior turns, and no image by default', async () => {
  const bodies = [];
  const brain = new Brain({ llmKey: 'x', llmUrl: 'http://x', llmModel: 'm' }, {
    fetchImpl: async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return {
        ok: true,
        async json() { return { choices: [{ message: { content: '{"do":"noop","why":"ok"}' } }] }; },
      };
    },
  });
  const text = await brain.say('owner', {
    report: { game: 'Hilo', controls: ['Higher'], black: false, active: true },
    history: [
      { role: 'user', content: 'prev-state' },
      { role: 'assistant', content: '{"do":"noop"}' },
    ],
  });
  assert.equal(text, '{"do":"noop","why":"ok"}');
  const msgs = bodies[0].messages;
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, OWNER_SYSTEM);
  assert.equal(msgs[1].content, 'prev-state');
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs[msgs.length - 1].role, 'user');
  assert.match(msgs[msgs.length - 1].content, /OWNER State=/);
  assert.match(msgs[msgs.length - 1].content, /Hilo/);
});

test('brain.say owner attaches a jpeg as eyes only', async () => {
  const bodies = [];
  const brain = new Brain({ llmKey: 'x', llmUrl: 'http://x', llmModel: 'm' }, {
    fetchImpl: async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return {
        ok: true,
        async json() { return { choices: [{ message: { content: '{"do":"speak","say":"Table is live."}' } }] }; },
      };
    },
  });
  await brain.say('owner', {
    report: { black: true },
    jpeg: Buffer.from('fakejpeg'),
  });
  const user = bodies[0].messages.at(-1).content;
  assert.equal(Array.isArray(user), true);
  assert.equal(user[0].type, 'text');
  assert.equal(user[1].type, 'image_url');
  assert.match(user[1].image_url.url, /^data:image\/jpeg;base64,/);
});
