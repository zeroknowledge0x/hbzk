import { available, isIdle, pick } from './policy-helpers.js';
// Dice has a writable payout field (Advanced), and the multiplier and the range are the same
// decision seen from two sides. Alternate: half the rounds turn the range chip, half write
// the multiplier, so the table never plays the same shape twice in a row.
const MULTI = [1.5, 2, 3, 5, 10];
export function decide({ phase, controls = [] } = {}, rand = Math.random) {
  // Both the range chip and the multiplier are *setting* changes, so they are only proposed
  // while the table is idle: a write during a live round is the one thing this table must not do.
  const idle = isIdle(phase);
  const chip = idle ? available(controls, ['Over', 'Under', 'Inside', 'Outside'], rand) : null;
  const byMultiplier = rand() < 0.5;
  return {
    label: available(controls, ['Bet', 'Roll'], rand),
    settings: byMultiplier ? null : chip,
    multi: byMultiplier && idle ? pick(MULTI, rand) : null,
  };
}
