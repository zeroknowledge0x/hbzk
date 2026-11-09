import { available, pick } from './policy-helpers.js';
// Dice has a writable payout field (Advanced), and the multiplier and the range are the same
// decision seen from two sides. Alternate: half the rounds turn the range chip, half write
// the multiplier, so the table never plays the same shape twice in a row.
const MULTI = [1.5, 2, 3, 5, 10];
export function decide({ controls = [] } = {}, rand = Math.random) {
  const chip = available(controls, ['Over', 'Under', 'Inside', 'Outside'], rand);
  const byMultiplier = rand() < 0.5;
  return {
    label: available(controls, ['Bet', 'Roll'], rand),
    settings: byMultiplier ? null : chip,
    multi: byMultiplier ? pick(MULTI, rand) : null,
  };
}
