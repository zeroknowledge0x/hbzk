import { has, available } from './policy-helpers.js';
export function decide({ controls = [] } = {}, rand = Math.random) {
  if (has(controls, 'No thanks')) return { label: 'No thanks' };
  const hand = available(controls, ['Hit', 'Stand'], rand);
  return { label: hand || available(controls, ['Bet', 'Deal'], rand) };
}
