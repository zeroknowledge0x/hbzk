import { has, available, cashoutAvailable } from './policy-helpers.js';

// Hubie's Road is a lane ladder: one start, then the next lane, and a cash out once a lane is
// behind it. The lowest lane still on screen is the next step, because cleared lanes leave
// the grid. Without this the policy had nothing to click mid-round and simply stopped.
const LANE = /^lane\s*(\d+)/i;

// The label has to be the text the table actually shows, minus its keyboard hint.
function literal(controls, label) {
  const hit = (controls || []).find((control) => has([control], label));
  return hit ? String(hit).trim().replace(/\s*\([a-z0-9]\)$/i, '').trim() : null;
}

function lanes(controls = []) {
  const out = [];
  for (const control of controls) {
    const text = String(control).trim();
    const m = text.match(LANE);
    if (!m) continue;
    out.push({ label: text.replace(/\s*\([a-z0-9]\)$/i, '').trim(), n: Number(m[1]) });
  }
  return out.sort((a, b) => a.n - b.n);
}

export function decide({ phase, controls = [], progress = 0 } = {}, rand = Math.random) {
  if (phase !== 'playing') {
    // Terminal table: `Bet` wins when it is offered, `Go` is the road's own start.
    return { label: literal(controls, 'Bet') || available(controls, ['Go', 'Play'], rand) };
  }
  if (progress > 0 && cashoutAvailable(controls) && rand() < 0.4) return { label: 'Cash out' };
  const list = lanes(controls);
  if (list.length) {
    const next = list.find((lane) => lane.n >= progress + 1) || list[0];
    return { label: next.label };
  }
  if (has(controls, 'Random pick')) return { label: 'Random pick' };
  if (cashoutAvailable(controls)) return { label: 'Cash out' };
  // Nothing on the board: the round is over and the table shows its start control again, which
  // is still better to click than standing there. Go first, then Bet.
  return { label: literal(controls, 'GO') || literal(controls, 'Bet') };
}
