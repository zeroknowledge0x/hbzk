import { available, isIdle } from './policy-helpers.js';
// Risk is a setting: choose it only when the table is not mid-round.
export function decide({ phase, controls = [] } = {}, rand = Math.random) {
  return {
    label: available(controls, ['Bet', 'Spin'], rand),
    settings: isIdle(phase) ? available(controls, ['Low', 'Medium', 'High'], rand) : null,
  };
}
