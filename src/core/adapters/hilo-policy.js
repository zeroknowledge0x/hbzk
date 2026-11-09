import { available } from './policy-helpers.js';
export function decide({ controls = [] } = {}, rand = Math.random) { return { label: available(controls, ['Higher', 'Lower', 'Skip', 'Cash out'], rand) }; }
