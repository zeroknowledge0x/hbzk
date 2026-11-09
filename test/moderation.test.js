import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, moderate, shouldReadAloud, timeoutMs } from '../src/moderation.js';

// Real strings this channel received (data/viewers.json, 2026-11-09).
const SCAMS = [
  'Kick views, follows & chat bøts - big growth, tiny price, energize your live stream!',
  'Kick views, followers & chat bøts - start small, test it out, scale when you\'re ready!',
  'Kick views, follows & chat bøts - no forced packages, pay as you go!',
  'Own kick. co m',
  'Bring legendary energy to your stream with kivasmm com',
  'Make your live stream fire today with "kivasmm com"',
  'Buy followers cheap at t.me/somechannel',
];

const SPAM = [
  'Boost your overall channel visibility and audience engagement with cutting-edge automation.',
  'Stand out in the directory with reliable viewer counts and automated chat activity that looks completely natural.',
  'Dominate your streaming category with non-stop viewer support, community perks, and daily rewards.',
];

const REAL_CHAT = [
  'change game',
  'Cmon play blackjack',
  'wen?',
  'Hello',
  'how are you? what website is that?',
  'change deagon tower',
  'what game is that lol',
  'ayo dice lagi',
];

test('every scam line the channel actually saw is classified as scam', () => {
  for (const line of SCAMS) {
    assert.equal(classify(line).verdict, 'scam', line);
    assert.equal(shouldReadAloud(line), false, line);
  }
});

test('automation pitches are spam, not silence', () => {
  for (const line of SPAM) assert.equal(classify(line).verdict, 'spam', line);
});

test('real viewer chat still gets through, including Indonesian', () => {
  for (const line of REAL_CHAT) {
    assert.equal(classify(line).verdict, 'ok', line);
    assert.equal(shouldReadAloud(line), true, line);
  }
});

test('a money request aimed at viewers is never amplified', () => {
  assert.equal(classify('send me some crypto').verdict, 'scam');
  assert.equal(classify('donate to me please').verdict, 'scam');
});

test('repeats are muted longer, and the mute is bounded', () => {
  assert.equal(timeoutMs('ok'), 0);
  assert.equal(timeoutMs('spam', 1), 3 * 60_000);
  assert.equal(timeoutMs('scam', 1), 10 * 60_000);
  assert.ok(timeoutMs('scam', 3) > timeoutMs('scam', 1));
  assert.equal(timeoutMs('scam', 99), 40 * 60_000, 'capped at four strikes');
});

test('moderate() counts strikes and keeps real chat readable', () => {
  const first = moderate(SCAMS[0], 0);
  assert.equal(first.verdict, 'scam');
  assert.equal(first.strikes, 1);
  assert.equal(first.readAloud, false);
  const second = moderate(SCAMS[0], first.strikes);
  assert.equal(second.strikes, 2);
  assert.equal(moderate('halo hubie', 5).strikes, 0);
});
