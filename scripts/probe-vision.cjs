// One-shot: does the configured provider accept an image? Live probe, no side effects.
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (!m) continue;
  if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const file = process.argv[2] || path.join(__dirname, '..', 'logs', 'live-frame.jpg');
const buf = fs.readFileSync(file);
console.log('jpeg', file, buf.length, 'bytes');

const body = {
  model: process.env.LLM_MODEL,
  max_tokens: 120,
  temperature: 0,
  messages: [
    { role: 'system', content: 'Read the screenshot. Reply ONLY JSON {"game":null,"visible":[]}. Use null when unreadable. Never invent.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What game is on this screen, and which buttons can you see?' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } },
      ],
    },
  ],
};

(async () => {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(process.env.LLM_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LLM_API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
  } catch (err) {
    console.log('FETCH FAILED', err.message);
    return;
  }
  const text = await res.text();
  console.log('status', res.status, 'ms', Date.now() - t0);
  console.log(text.slice(0, 700));
})();
