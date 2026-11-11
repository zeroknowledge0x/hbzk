// One-shot live probe: does the Jev decision model answer a click question?
// Usage: node scripts/probe-jev-click.cjs
const fs = require('fs');
const path = require('path');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

(async () => {
  const { Jev } = await import('../src/jev.js');
  const jev = new Jev({
    jevEnabled: true,
    jevUrl: process.env.JEV_URL || 'https://api.commandcode.ai/provider/v1/systemone',
    jevModel: process.env.JEV_MODEL || 'typesafe/jev',
    jevKey: process.env.JEV_API_KEY || process.env.COMMAND_CODE_API_KEY || process.env.LLM_API_KEY || '',
    jevTimeoutMs: 6000,
  });
  console.log('jev enabled', jev.enabled, 'model', jev.model);
  const views = [
    { game: 'Wheel', phase: 'idle', progress: 0, controls: ['Bet', 'Low', 'Medium', 'High'] },
    { game: 'Blackjack', phase: 'playing', progress: 0, controls: ['Hit', 'Stand', 'Hit anyway', 'Cancel'] },
    { game: 'Mines', phase: 'playing', progress: 3, controls: ['Random tile', 'Cash out 2.40x'] },
  ];
  for (const view of views) {
    const t0 = Date.now();
    const hit = await jev.chooseClick(view);
    console.log(`${view.game}: ${hit ? `${hit.label} (conf ${hit.conf.toFixed(2)})` : 'no answer'} in ${Date.now() - t0} ms`);
  }
})();
