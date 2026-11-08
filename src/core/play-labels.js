// Live table vocabulary, measured 2026-11-08 on Housebets House Games (stake $0.00).
// Clicks use these labels. Vision/screenshots do not pick the next click.
//
// Keno: Classic / Low / Medium / High (risk), Auto pick, numbers, Bet — not HiLo Higher/Lower.
// Hilo: Higher / same, Lower / same, Skip, Same, Bet.
// Blackjack: Bet first; Hit / Stand only after the deal.
// Dragon Tower: Bet, Random pick, floor tiles. GO is Hubie's Road (and similar).
// Dice: Bet, Over, Under, Inside, Outside.
// Crash: no lobby card. Chat "crash" still maps to Limbo.

export const PLAY_CLICK_LABELS = [
  'Bet',
  'GO',
  'Random pick',
  'Auto pick',
  'Hit',
  'Stand',
  'Deal',
  'Roll',
  'Higher',
  'Lower',
  'Skip',
  'Same',
  'Cash out',
  'Play',
  'Start',
];

export const IN_ROUND_LABELS = ['Hit', 'Stand', 'Higher', 'Lower', 'Cash out', 'Random pick'];

export function preferInRoundLabels(labels, { phase, controls } = {}) {
  const list = Array.isArray(labels) ? [...labels] : [];
  const ctrls = (controls || []).map((c) => String(c).toLowerCase());
  const playing = phase === 'playing'
    || ctrls.some((c) => /^(hit|stand|higher|lower|cash out|random pick)\b/.test(c));
  if (!playing) return list;
  const rank = (label) => {
    const s = String(label).toLowerCase();
    if (/^(hit|stand|higher|lower|random pick)$/.test(s)) return 0;
    if (/^go$/.test(s)) return 1;
    if (/^cash out$/.test(s)) return 3;
    if (/^bet$/.test(s)) return 4;
    return 2;
  };
  return list.sort((a, b) => rank(a) - rank(b));
}

const SHOT_LINE = {
  bet: 'Zero locked. Sending it.',
  go: "GO. Let's walk the road.",
  'random pick': "Random pick. I'm not overthinking this.",
  hit: 'Hit.',
  stand: "I'll sit.",
  higher: 'Higher.',
  lower: 'Lower.',
  'cash out': 'Cashing the demo. Cute number.',
  'auto pick': 'Auto pick. Numbers go brr.',
  deal: 'Deal.',
  skip: 'Skip that card.',
  same: 'Same.',
};

export function shotLine(tag) {
  const t = String(tag || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t || /^\d+$/.test(t) || t === 'tile') return null;
  if (SHOT_LINE[t]) return SHOT_LINE[t];
  const key = Object.keys(SHOT_LINE).find((k) => t === k || t.startsWith(`${k} `) || t.startsWith(k));
  return key ? SHOT_LINE[key] : null;
}
