import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_HOSTS, assertAllowed, hostOf, isAllowedUrl } from '../src/core/allowlist.js';

test('the casino and the chat are allowed, nothing else', () => {
  assert.equal(isAllowedUrl('https://www.housebets.com/casino'), true);
  assert.equal(isAllowedUrl('https://housebets.com/games/housegames-dice?launch=x'), true);
  assert.equal(isAllowedUrl('https://kick.com/HubieZK'), true);
  assert.equal(isAllowedUrl('https://www.kick.com/api/v2/channels/HubieZK'), true);
});

test('lookalike hosts and other sites are refused', () => {
  for (const url of [
    'https://housebets.com.evil.tld/casino',
    'https://evil.tld/housebets.com',
    'http://localhost:3000/',
    'https://google.com',
    'https://kick.com.evil.tld/',
  ]) {
    assert.equal(isAllowedUrl(url), false, url);
  }
});

test('an unparseable url is refused with a reason, not a throw', () => {
  assert.equal(isAllowedUrl('not a url'), false);
  assert.deepEqual(assertAllowed('not a url'), { ok: false, reason: 'unparseable url' });
  assert.deepEqual(assertAllowed('https://nope.example/x'), { ok: false, reason: 'host not allowed: nope.example' });
  assert.deepEqual(assertAllowed('https://housebets.com/x'), { ok: true, host: 'housebets.com' });
});

test('host extraction is case-insensitive', () => {
  assert.equal(hostOf('HTTPS://WWW.Housebets.COM/Casino'), 'www.housebets.com');
});

test('the allowlist is exactly the two services the host uses', () => {
  assert.deepEqual([...ALLOWED_HOSTS].sort(), ['housebets.com', 'kick.com', 'www.housebets.com', 'www.kick.com'].sort());
});
