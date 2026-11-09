import { available, has, isIdle } from './policy-helpers.js';
// Keno: a risk chip and a number selection are both settings, so neither is touched mid-round.
// The pick mode tells the controller how to fill the board; the label is the click that starts
// the round, and the controller verifies it against the live page before clicking.
export function decide({ phase, controls = [] } = {}, rand = Math.random) {
  const idle = isIdle(phase);
  return {
    label: available(controls, ['Bet', 'Play'], rand) || (idle ? 'Bet' : null),
    settings: idle ? available(controls, ['Classic', 'Low', 'Medium', 'High'], rand) : null,
    pick: has(controls, 'Auto pick') ? 'auto-or-numbers' : 'numbers',
  };
}
