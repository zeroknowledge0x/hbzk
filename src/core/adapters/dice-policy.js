import { available } from './policy-helpers.js';
export function decide({ controls = [] } = {}, rand = Math.random) { return { label: available(controls, ['Bet', 'Roll'], rand), settings: available(controls, ['Over', 'Under', 'Inside', 'Outside'], rand) }; }
