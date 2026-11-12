// Exit 0 when the launcher may start Hubie, exit 1 when a safety halt is still on record.
// `--clear` is the human start: it removes the marker so the next run may begin.
import { readSafetyHalt, clearSafetyHalt } from '../src/core/safety-halt.js';

const cwd = process.cwd();
if (process.argv.includes('--clear')) {
  clearSafetyHalt(cwd);
  console.log('[hubie] safety halt cleared');
  process.exit(0);
}

const halt = readSafetyHalt(cwd);
if (halt) {
  console.log(`[hubie] safety halt on record: ${halt.reason}`);
  console.log(`[hubie] live stays off. Fix the cause, then start with HUBIE_HUMAN_START=1 to clear it.`);
  process.exit(1);
}
process.exit(0);
