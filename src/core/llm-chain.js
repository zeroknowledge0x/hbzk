// LLM provider chain with a quota cooldown.
//
// The mouth degrades to canned lines when the only provider answers 429, and the provider is
// usually explicit about when it resets. That timestamp is worth more than a fixed backoff:
// the chain parks the provider until then and moves to the next one, so one spent plan does
// not mute the host.

export const DEFAULT_COOLDOWN_MS = 5 * 60_000;

// "…your limit resets at 2026-11-10T14:20:00.333Z…" -> epoch ms, or null.
export function parseResetAt(text, now = Date.now()) {
  const m = String(text || '').match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (!m) return null;
  const at = Date.parse(m[0]);
  if (!Number.isFinite(at)) return null;
  return at > now ? at : null;
}

export function createChain(providers = [], { now = Date.now } = {}) {
  return {
    now,
    providers: providers.map((p) => ({ ...p, coolUntil: 0, fails: 0, ok: 0 })),
  };
}

export function pickProvider(chain, now = chain.now?.() ?? Date.now()) {
  return chain.providers.find((p) => p.coolUntil <= now) || null;
}

// status: HTTP status, body: raw body text, err: thrown error.
export function noteResult(chain, name, { status = 0, body = '', err = null } = {}, now = chain.now?.() ?? Date.now()) {
  const p = chain.providers.find((x) => x.name === name);
  if (!p) return chain;
  if (!err && status >= 200 && status < 300) {
    p.ok += 1;
    p.fails = 0;
    p.coolUntil = 0;
    return chain;
  }
  p.fails += 1;
  if (status === 429) {
    p.coolUntil = parseResetAt(body, now) ?? now + DEFAULT_COOLDOWN_MS;
  } else if (status === 401 || status === 403) {
    // A rejected key stays rejected until someone fixes it; do not burn retries on it.
    p.coolUntil = now + 60 * 60_000;
  } else {
    p.coolUntil = now + Math.min(DEFAULT_COOLDOWN_MS, 5_000 * 2 ** Math.min(p.fails, 6));
  }
  return chain;
}

export function chainLine(chain, now = chain.now?.() ?? Date.now()) {
  return chain.providers
    .map((p) => {
      if (p.coolUntil > now) {
        const mins = Math.ceil((p.coolUntil - now) / 60_000);
        return `${p.name}: cooldown ${mins}m`;
      }
      return `${p.name}: ready`;
    })
    .join(' · ');
}

export function usableCount(chain, now = chain.now?.() ?? Date.now()) {
  return chain.providers.filter((p) => p.coolUntil <= now).length;
}
