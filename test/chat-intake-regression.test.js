import assert from 'node:assert/strict';
import test from 'node:test';
import * as chat from '../src/chat-reply.js';

import { PlayQueue, parseGameRequest } from '../src/play-queue.js';

test('cross-source delivery ledger suppresses handoff duplicates without suppressing new API ids', () => {
  const ledger = chat.createKickDeliveryDedupe();
  const dom = { name: 'Ann', text: 'limbo' };
  assert.equal(ledger.accept(dom, 'dom', 0), true);
  assert.equal(ledger.accept({ ...dom, id: 'a' }, 'api', 10), false);
  assert.equal(ledger.accept({ ...dom, id: 'b' }, 'api', 20), true);
  assert.equal(ledger.accept(dom, 'dom', 30), false);
  assert.equal(ledger.accept({ name: 'Lee', text: 'limbo' }, 'dom', 40), true);
  assert.equal(ledger.accept(dom, 'dom', 30000), true);
});

test('social LLM slang is not replaced by a canned stake line', async () => {
  const result = await chat.composeChatReply({ name: 'Ann', text: 'apa kabar' }, { brain: { async say() { return { text: 'Still kicking, Ann. That wheel owes me an apology.' }; } } });
  assert.equal(result.source, 'brain');
  assert.match(result.text, /Still kicking/);
});

test('LLM owns site and kabar wording; trusted fallback answers missed questions', async () => {
  for (const [text, answer, expected] of [['website?', 'Ann, the site is housebets.com; come watch the tables.', /housebets\.com/i], ['apa kabar', "Doing well, Ann. That wheel is testing my patience.", /(?:good|fine|well)/i]]) {
    let calls = 0;
    const brain = { offline: false, async say(_kind, payload) { calls++; assert.ok(payload.trustedFacts.length); return { text: answer }; } };
    assert.equal((await chat.composeChatReply({ name: 'Ann', text }, { brain })).text, answer);
    assert.equal(calls, 1);
    const miss = await chat.composeChatReply({ name: 'Ann', text }, { brain: { offline: false, async say() { return { text: 'Heard you, Ann.', fallback: true }; } } });
    assert.match(miss.text, expected);
    assert.equal(miss.source, 'kb');
    const offline = await chat.composeChatReply({ name: 'Ann', text }, {});
    assert.match(offline.text, expected);
  }
});

test('canonical router sends all game aliases into the same FIFO and leaves settings as commands', () => {
  const queue = new PlayQueue();
  for (const [name, text, game] of [['Ann', 'main dadu dong', 'Dice'], ['Lee', 'play crash', 'Limbo'], ['Jo', "Hubie’s Road", "Hubie's Road"]]) {
    const routed = chat.routeChatRequest({ name, text }, { queue });
    assert.equal(routed.action, 'queue');
    assert.equal(routed.item.game, game);
    assert.equal(parseGameRequest(text), game);
  }
  assert.deepEqual(queue.toJSON().map(x => x.game), ['Dice', 'Limbo', "Hubie's Road"]);
  const routed = chat.routeChatRequest({ name: 'Ann', text: 'ganti multi 5' }, { queue });
  assert.equal(routed.action, 'command');
  assert.deepEqual(routed.intent, { kind: 'set_multiplier', args: { value: 5 } });
  assert.equal(queue.length, 3);
});

test('name prefix is stripped only at a delimiter boundary', () => {
  assert.deepEqual(chat.parseKickRow({ name: 'Ann', text: 'annoying table' }), { name: 'Ann', text: 'annoying table' });
  assert.deepEqual(chat.parseKickRow({ name: 'Ann', text: 'ANN: hello' }), { name: 'Ann', text: 'hello' });
  assert.deepEqual(chat.parseKickRow({ name: 'Ann', text: 'Ann hello' }), { name: 'Ann', text: 'hello' });
});

test('viewer URLs including Housebets are conversation, not sender bans', () => {
  const intake = chat.createChatIntake();
  for (const text of ['is https://www.housebets.com the site?', 'what about https://example.org/rules?', '!help']) {
    assert.equal(intake.screen({ name: 'Ann', text }).reason === 'promo', false, text);
    assert.equal(intake.isPromoSender('Ann'), false);
    assert.equal(intake.screen({ name: 'Ann', text: 'apa kabar' }).action, 'ok');
  }
});
