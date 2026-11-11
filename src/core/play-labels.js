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
  'No thanks',
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

// What gives a table away on screen. "Bet" is on every table, so these are labels only one table
// shows. Measured on Housebets House Games (2026-11-08).
const TABLE_TELL = [
  ['Dice', [/\bover\b/i, /\bunder\b/i, /^inside$/i, /^outside$/i]],
  ['Hilo', [/^higher\b/i, /^lower\b/i, /^skip$/i]],
  ['Blackjack', [/^hit$/i, /^stand$/i, /^no thanks$/i]],
  ['Dragon Tower', [/^random pick\b/i, /^pick floor\b/i]],
  ["Hubie's Road", [/^go$/i]],
  ['Keno', [/^auto pick$/i]],
];

// Which table is really in front of the host, judged from the controls alone. The page URL can say
// one table while the board still shows the previous one. null means "no idea" — callers must not
// read that as a mismatch.
export function boardTable(controls = []) {
  const list = (controls || []).map((c) => String(c));
  const hit = TABLE_TELL.find(([, tells]) => list.some((c) => tells.some((re) => re.test(c))));
  return hit ? hit[0] : null;
}

export function inferPhase(controls = []) {
  const list = (controls || []).map((c) => String(c).toLowerCase().replace(/\s+/g, ' ').trim());
  const has = (re) => list.some((c) => re.test(c));
  if (has(/^(hit|stand|no thanks)$/)) return 'playing';
  const start = has(/^(bet|roll|deal|spin|play|go)$/);
  const mid = has(/^(cash out|random pick|higher|lower)\b/);
  if (mid && !start) return 'playing';
  if (start) return 'idle';
  return 'unknown';
}

export function preferInRoundLabels(labels, { phase, controls } = {}) {
  const list = Array.isArray(labels) ? [...labels] : [];
  const ctrls = (controls || []).map((c) => String(c).toLowerCase());
  const playing = phase === 'playing'
    || ctrls.some((c) => /^(hit|stand|no thanks)$/.test(c));
  if (!playing) return list;
  const rank = (label) => {
    const s = String(label).toLowerCase();
    if (/^(no thanks|hit|stand|higher|lower|skip|same|random pick|cash out)$/.test(s)) return 0;
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

export function labelMatchesPlay(want, label) {
  const strip = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/\s*\([a-z0-9]\)$/, '');
  const q = strip(want);
  const low = strip(label);
  if (!q || !low) return false;
  if (low === q) return true;
  if (/\b(info|history|rules|fair|help|amount|halve|double|wallet)\b/.test(low)) return false;
  if (!low.startsWith(q)) return false;
  const rest = low.slice(q.length).trim();
  if (!rest) return true;
  if (/^(same|card|number|tile|lane|floor)\b/.test(rest)) return true;
  return /^(random pick|auto pick|skip|cash out|higher|lower)$/.test(q);
}

export function matchPlayClick(want, controls) {
  const q = String(want || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return null;
  const allowed = PLAY_CLICK_LABELS.find((label) => {
    const s = label.toLowerCase();
    return q === s || q.startsWith(`${s} `) || s.startsWith(q);
  });
  if (!allowed) return null;
  const list = Array.isArray(controls) ? controls : [];
  const visible = list.some((c) => labelMatchesPlay(allowed, c));
  return visible ? allowed : null;
}
