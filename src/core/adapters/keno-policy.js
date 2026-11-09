import { available, has } from './policy-helpers.js';
export function decide({ controls = [] } = {}, rand = Math.random) { return { label: available(controls, ['Bet', 'Play'], rand) || 'Bet', settings: available(controls, ['Classic', 'Low', 'Medium', 'High'], rand), pick: has(controls, 'Auto pick') ? 'auto-or-numbers' : 'numbers' }; }
