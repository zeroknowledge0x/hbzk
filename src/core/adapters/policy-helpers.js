// A policy returns one measured, currently available action. It never writes stake.
// Prefix matching stays narrow on purpose: the table renders "Bet Amount 0.00" and
// "2× Double bet amount (S)" beside the real Bet button, and treating either as Bet is
// how the host opened the bet editor instead of playing.
const NEVER_PLAY = /\b(info|history|rules|fair|help|amount|halve|double|wallet)\b/;

export function has(controls, label) {
  const q = String(label).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return false;
  return (controls || []).some((c) => {
    // Keyboard hints ride along in the snapshot ("Classic (Q)", "Skip card (Q)"), so the
    // comparison runs on the label without the trailing shortcut.
    const text = String(c).trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\([a-z0-9]\)$/, '');
    if (!text) return false;
    if (text === q) return true;
    if (NEVER_PLAY.test(text)) return false;
    if (!text.startsWith(q)) return false;
    const rest = text.slice(q.length).trim();
    if (!rest) return true;
    if (/^(same|card|number|tile|lane|floor)\b/.test(rest)) return true;
    return /^(random pick|auto pick|skip|cash out|higher|lower)$/.test(q);
  });
}
export function choose(items, rand = Math.random) {
  if (!items.length) return null;
  return items[Math.min(items.length - 1, Math.floor(rand() * items.length))];
}
export function available(controls, labels, rand = Math.random) {
  return choose(labels.filter((label) => has(controls, label)), rand);
}
export function cashoutAvailable(controls) { return has(controls, 'Cash out'); }
export function pick(values, rand = Math.random) { return choose(values, rand); }
