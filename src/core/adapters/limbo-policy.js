import { available, isIdle } from './policy-helpers.js';
// The target preset is a setting, not a payout: choose it only when the table is idle.
export function decide({ phase, controls = [] } = {}, rand = Math.random) {
  return {
    label: available(controls, ['Bet', 'Roll'], rand),
    settings: isIdle(phase) ? available(controls, ['1.5x', '2x', '5x', '10x', '100x'], rand) : null,
  };
}
