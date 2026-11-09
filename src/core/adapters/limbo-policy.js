import { available } from './policy-helpers.js';
export function decide({ controls = [] } = {}, rand = Math.random) { return { label: available(controls, ['Bet', 'Roll'], rand), settings: available(controls, ['1.5x', '2x', '5x', '10x', '100x'], rand) }; }
