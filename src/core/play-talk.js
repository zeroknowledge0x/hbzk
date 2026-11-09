// Play commentary.
//
// A streamer who shows a decision and explains it is more watchable than one who clicks in
// silence; the same click with a reason is the difference between a bot and a host. These are
// short, honest lines — they never claim a win the table has not settled.

const REASON = {
  mines: (p) => `Cashing out after ${p} reveal${p === 1 ? '' : 's'} — greed is how Mines eats you.`,
  'dragon tower': (p) => `Leaving the tower at floor ${p + 1}. One more step is someone else's story.`,
  "hubie's road": (p) => `Cash out, lane ${p + 1}. I like my demo coins breathing.`,
  hilo: () => 'Taking the cash out. The ladder did its job.',
};

export function cashoutLine(game, { progress = 0 } = {}) {
  const key = String(game || '').toLowerCase();
  const p = Math.max(0, Math.floor(Number(progress) || 0));
  const fn = REASON[key];
  if (fn) return fn(p);
  return 'Cashing out the demo. Cute number.';
}

export function betLine(game, { multiplier = null, chip = null } = {}) {
  const key = String(game || '').toLowerCase();
  if (Number.isFinite(multiplier) && multiplier > 1) return `Going for ${multiplier}x. Zero on the line, so all vibes.`;
  if (chip) return `${chip} it is. Zero locked.`;
  if (key === 'blackjack') return 'Dealing. Let the cards talk.';
  if (key === 'keno') return 'Numbers marked. Let us see what the balls think.';
  return 'Zero locked. Sending it.';
}

export function streakLine(wins = 0, losses = 0) {
  if (wins >= 3) return `${wins} in a row on the demo. I am not going to pretend that is skill.`;
  if (losses >= 3) return `${losses} straight misses. That is why the stake stays at zero.`;
  return null;
}

export function roundLine(game, { won = null, multiplier = null } = {}) {
  if (won === true && Number.isFinite(multiplier) && multiplier >= 3) {
    return `${Number(multiplier).toFixed(2)}x. That one is going in the highlight reel.`;
  }
  if (won === false) return 'No hit. Zero in, zero out — still a free show.';
  return null;
}
