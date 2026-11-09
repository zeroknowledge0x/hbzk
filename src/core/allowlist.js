// Navigation allowlist.
//
// The host drives a real logged-in browser, so the set of hosts it may visit is small and
// explicit: the casino it plays on and the chat it reads. Anything else is refused before a
// navigation happens, which also means a stray link in chat can never move the capture.

export const ALLOWED_HOSTS = [
  'housebets.com',
  'www.housebets.com',
  'kick.com',
  'www.kick.com',
];

export function hostOf(url) {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return '';
  }
}

export function isAllowedUrl(url) {
  const host = hostOf(url);
  if (!host) return false;
  return ALLOWED_HOSTS.includes(host);
}

export function assertAllowed(url) {
  const host = hostOf(url);
  if (!host) return { ok: false, reason: 'unparseable url' };
  if (!ALLOWED_HOSTS.includes(host)) return { ok: false, reason: `host not allowed: ${host}` };
  return { ok: true, host };
}
