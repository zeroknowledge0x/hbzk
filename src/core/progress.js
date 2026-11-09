// Consume only explicitly observed round progress. Unknown is zero, never a click count
// and never the multiplier a table prints as a target.
const MINES_TILE = /^tile\s*\d+$/i;
const TOWER_TILE = /^floor\s*(\d+)\s*,/i;
const ROAD_LANE = /lane\s*(\d+)\b/i;
const KENO_SPOT = /^(\d{1,2})\s+number\b/i;

export function progressFromControls(game, controls = []) {
  const name = String(game || '').toLowerCase();
  const list = (controls || []).map((c) => String(c).trim());
  if (name === 'mines') {
    // Revealed tiles drop out of the snapshot, so a 25-cell board that still shows 23
    // pickable tiles has two safe reveals behind it.
    const tiles = list.filter((c) => MINES_TILE.test(c)).length;
    return tiles > 0 && tiles < 25 ? 25 - tiles : 0;
  }
  if (name === 'dragon tower' || name === "hubie's road") {
    // Cleared floors/lanes leave the grid; the lowest one still on screen is the step
    // the player is about to take, so one less than that is the progress made.
    const re = name === 'dragon tower' ? TOWER_TILE : ROAD_LANE;
    const seen = list
      .map((c) => Number((c.match(re) || [])[1]))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (!seen.length) return 0;
    const lowest = Math.min(...seen);
    return lowest > 1 ? lowest - 1 : 0;
  }
  return 0;
}

// Keno numbers come from the board actually on screen ("7 Number 7"); the 1..20 seed
// only covers the moment before the grid renders.
export function kenoNumbers(controls = []) {
  const nums = (controls || [])
    .map((c) => Number((String(c).match(KENO_SPOT) || [])[1]))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 40);
  return nums.length ? [...new Set(nums)].sort((a, b) => a - b) : Array.from({ length: 20 }, (_, i) => i + 1);
}

export function readObservedProgress(game, observation = {}) {
  const name = String(game || '').toLowerCase();
  let value = null;
  if (name === 'mines') value = observation.revealedSafeTiles;
  else if (name === 'dragon tower') value = observation.currentFloor;
  else if (name === "hubie's road") value = observation.currentLane;
  const n = Number(value);
  if (value != null && Number.isInteger(n) && n > 0 && n <= 40) return n;
  return progressFromControls(game, observation.controls);
}
