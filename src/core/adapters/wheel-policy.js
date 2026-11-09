import { available } from './policy-helpers.js';
export function decide({ controls = [] } = {}, rand = Math.random) { return { label: available(controls, ['Bet', 'Spin'], rand), settings: available(controls, ['Low', 'Medium', 'High'], rand) }; }
