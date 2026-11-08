// Measured on the Housebets tables, 2026-11-08. Stake buttons are never in here.

export function pickOne(list, rand = Math.random) {
  if (!list || !list.length) return null;
  return list[Math.floor(rand() * list.length)];
}

function hasLabel(controls, name) {
  const re = new RegExp(`^${name}\\b`, 'i');
  return (controls || []).some((c) => re.test(String(c || '').trim()));
}

/** Clicks before the round starts. Never ½, 2×, Wallet, Fair, or Bet Info. */
export function varietyClicks(game, controls, rand = Math.random) {
  const g = String(game || '');
  const chips = [];
  const take = (names) => pickOne(names.filter((n) => hasLabel(controls, n)), rand);
  if (/limbo/i.test(g)) {
    const chip = take(['1.5x', '5x', '10x', '100x', '2x']);
    if (chip) chips.push(chip);
  } else if (/plinko|wheel/i.test(g)) {
    const risk = take(['Low', 'Medium', 'High']);
    if (risk) chips.push(risk);
  } else if (/keno/i.test(g)) {
    const risk = take(['Classic', 'Low', 'Medium', 'High']);
    if (risk) chips.push(risk);
    if ((controls || []).some((c) => /auto pick/i.test(String(c))) && rand() < 0.7) chips.push('Auto pick');
  } else if (/dice/i.test(g)) {
    const side = take(['Over', 'Under', 'Inside', 'Outside']);
    if (side) chips.push(side);
  } else if (/road/i.test(g)) {
    const diff = take(['Easy', 'Medium', 'Hard', 'Daredevil']);
    if (diff) chips.push(diff);
  } else if (/tower/i.test(g)) {
    const diff = take(['Easy', 'Medium', 'Hard']);
    if (diff) chips.push(diff);
  }
  return chips;
}

/** The play click for this tick. Cash out only when the label is not $0.00. */
export function varietyPlay(game, controls, rand = Math.random) {
  const g = String(game || '');
  const list = controls || [];
  const has = (re) => list.some((c) => re.test(String(c || '')));
  const cashLive = list.some((c) => /^cash out\b/i.test(String(c)));
  if (/hilo/i.test(g)) {
    return pickOne(['Higher', 'Lower', 'Skip', 'Cash out'].filter((n) => has(new RegExp(`^${n}\\b`, 'i'))), rand) || 'Bet';
  }
  if (/blackjack/i.test(g) && has(/^no thanks$/i)) return 'No thanks';
  if (/blackjack/i.test(g) && has(/^hit$/i)) return rand() < 0.55 ? 'Hit' : 'Stand';
  if ((/tower|mines/i.test(g)) && cashLive && rand() < 0.35) return 'Cash out';
  if ((/tower|mines|road/i.test(g)) && has(/random pick/i) && !has(/^bet$/i) && !has(/^go$/i)) return 'Random pick';
  if (/road/i.test(g) && has(/^bet$/i)) return 'Bet';
  if (/road/i.test(g) && has(/^go\b/i)) return 'GO';
  if (has(/^go$/i) && !has(/^bet$/i)) return 'GO';
  return 'Bet';
}

/** 5 to 15 minutes, uniform. */
export function nextIdleMs(rand = Math.random) {
  return 5 * 60 * 1000 + Math.floor(rand() * 10 * 60 * 1000);
}

export function isBigWin(outcome) {
  if (!outcome || outcome.won !== true) return false;
  if (outcome.source === 'marker') return false;
  const multi = Number(outcome.result);
  return Number.isFinite(multi) && multi >= 3;
}
