// Chat moderation.
//
// The channel draws follow/view bots that paste the same scam line every few minutes. Reading
// one aloud on air is the worst possible outcome (it is free advertising and it looks like the
// host endorses it), so the text is classified before it can reach the mouth.

const RULES = [
  // Observed on this channel: "Kick views, follows & chat bøts - big growth, tiny price …"
  ['scam', /\b(own\s*kick\s*\.?\s*co\s*m|kivasmm|kick\s*views|views?\s*(?:,|&|and)\s*followers?|followers?\s*(?:,|&|and)\s*chat\s*b[oø]ts?|buy\s+(?:views|followers)|sub4sub|follow4follow)\b/i],
  ['scam', /\b(?:t\.me|telegram\.me|wa\.me|bit\.ly|tinyurl\.com)\//i],
  ['spam', /\b(?:boost|grow|increase)\s+your\b[\s\S]{0,30}?\b(?:stream|channel|viewers?|audience|visibility|engagement)\b/i],
  ['spam', /\b(?:automate|automated)\s+(?:your\s+)?(?:stream|chat|traffic)\b/i],
  ['spam', /\b(?:24\/7\s+automated|non-?stop\s+viewer|ai-?powered\s+viewers)\b/i],
];

// Money requests aimed at viewers are a second class of problem: never amplified, never spoken.
const BEGGING = /\b(?:send|give|drop)\s+(?:me\s+)?(?:some\s+)?(?:crypto|btc|eth|pol|money|tips?)\b|\bcash\s*app\b|\bdonate\s+to\s+me\b/i;

export function classify(text) {
  const raw = String(text || '');
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return { verdict: 'ok', reason: 'empty' };
  for (const [verdict, re] of RULES) {
    if (re.test(t)) return { verdict, reason: re.source.slice(0, 40) };
  }
  if (BEGGING.test(t)) return { verdict: 'scam', reason: 'begging' };
  return { verdict: 'ok', reason: '' };
}

// The mouth must not repeat a scam, and the overlay must not show it either.
export function shouldReadAloud(text) {
  return classify(text).verdict === 'ok';
}

// How long a repeat offender is ignored. Bots paste on a schedule; muting 10 minutes stops
// the loop without banning a real viewer who pasted a link once.
export function timeoutMs(verdict, strikes = 1) {
  if (verdict !== 'scam' && verdict !== 'spam') return 0;
  const base = verdict === 'scam' ? 10 * 60_000 : 3 * 60_000;
  return base * Math.min(Math.max(1, strikes), 4);
}

export function moderate(text, seen = 0) {
  const { verdict, reason } = classify(text);
  const strikes = verdict === 'ok' ? 0 : seen + 1;
  return { verdict, reason, strikes, timeoutMs: timeoutMs(verdict, strikes), readAloud: verdict === 'ok' };
}
