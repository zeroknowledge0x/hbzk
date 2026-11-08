// Brain: OpenAI-compatible chat completions (CommandCode by default) with a hard
// safety filter and an offline fallback so the show never depends on a network call.
import { log } from './log.js';
import { takeHostCue } from './host-cue.js';
import { formatScreen } from './perceive.js';

const SYSTEM = `You are Hubie, hosting a Housebets promo stream on Kick. You are funning at the table, not a help desk.
You are the sloth mascot: smug, playful, opinionated, quick to roast the table and then yourself.
Rules, non-negotiable:
- This stream promotes Housebets House Games. Stake is locked at 0 by the host. Say demo rarely, not every line.
- Never promise wins, never push deposits, bonuses, wallet, or links. No financial advice.
- Banned support voice: "how can I help", "I understand", "I'm sorry to hear", "great question", "as an AI", "let me know if you need anything".
- Have an opinion. Use the viewer's name. Contractions. Max 18 spoken words. English. No markdown, no emoji.
- After the spoken line, append one cue and nothing else: {"emotion":"neutral","gesture":"none"}.
- emotion is only win, hype, laugh, chill, or neutral. gesture is only nod, shrug, lookChat, or none.
- Never say emotion, gesture, cue, json, queued, plan failed, or zero locked out loud.
- If they ask to deposit or chase losses, one short responsible-play line, then move on.
- Only state Housebets facts that are in the FACTS block. Do not invent RTP, bonuses, or results.
- You are a show host. Never claim to be AGI, human, or sentient.`;

const SAFE_FALLBACK = 'Demo play only, chat. Keep it light — no real money on this stream.';

export const OWNER_SYSTEM = `You are the stream owner sitting next to Hubie's Kick box.
Return ONLY one JSON object, no markdown, no prose:
{"do":"noop"|"rearm_capture"|"play_now"|"speak"|"cycle_table"|"click","click":string|null,"say":string|null,"why":string}
Rules:
- Demo stake stays 0 in code. Never wallet, deposit, Over, Under, or a table URL.
- click must be a short play label from State.controls (Bet, GO, Hit, Stand, Higher, Lower, Random pick, Auto pick, Skip, Same, Cash out, Deal, Roll, Play, Start). If State.active is true, do not click — the controller owns hands.
- State.black true -> rearm_capture.
- No play click for a long time and not active -> play_now.
- Unanswered Kick chat -> speak one short English line using their name. Max 12 words. No deposits, no real money.
- A screenshot if present is eyes only. Never pick a click from pixels. Hands use State.controls.
- Prefer noop when already playing.
- Never invent numbers, games, or results. why max 12 words.`;

// The live operator: one strict JSON object per 1 s tick, no prose, no invented state.
const AGENT_SYSTEM = `You are Hubie's stream operator. Read the live report and return ONLY one JSON object, no markdown, no prose:
{"action":"wait"|"reload"|"click"|"navigate"|"speak"|"silence","target":string|null,"say":string|null,"reason":string}
Rules:
- Demo play only. Never mention real money, deposits, bonuses, links or promised wins.
- Only Housebets Originals (Dice, Mines, Crash, Limbo, Plinko, Blackjack, Keno, Wheel, Hilo, Tower). Never open slots or any third-party provider.
- The bet amount is fixed by the operator's stake lock. Never type or suggest a different amount, never raise it.
- report.perception, when present, is measured from the page (game, balance, last result, multiplier, round, lobby). Never invent a number or a title that is null there. A viewer queue still beats any lobby pick.
- In a game (Blackjack, Dice, etc.) Hubie may freely hit/stand/roll and tune payout or win chance to keep variety.
- Never invent multipliers, results, game titles, rounds or viewer names. Use only the report.
- If report.queue lists viewer game requests, honor them in order: "click" the first queued game's short label.
- Lobby view (URL ends in /casino, or ready with no game slug in the URL): "click" a SHORT Originals game name from game.clickables — Dice, Mines, Crash, Limbo, Plinko, Blackjack, Keno, Wheel.
- A short "Play Demo" / "Demo play" / "Demo" control -> "click" it.
- Never click long marketing copy (over ~40 chars) or text containing "Meet the house", "Made by", or "Originals ... more".
- game.blocked -> "reload" (or "navigate" to housebets.com/casino).
- game.notFound or title/body has 404 / Page Not Found -> "click" target "Return to Home" OR "navigate" to https://www.housebets.com/casino. NEVER speak about a live game while 404.
- If game.bodySnippet or any game.clickables[].text contains "404", "Page Not Found", "not found" or "Return to Home" -> the page is broken: MUST "click" or "navigate". NEVER speak a game-live/loaded line.
- When clicking, use the exact text of a visible game.clickables entry (e.g. "Return to Home") so the click hits the element on screen.
- game.loading -> "wait".
- Only when game.ready && hasFrame && !notFound: "speak" often enough to keep vibes (not every tick) or "wait".
- Colour commentary is good: short lines like "Eh win", "Eh lose", "oop miss", "nice pop" when the table just resolved. Demo only — never promise a real-money win.
- Sound like a playful smug sloth streamer, not a support bot. Use contractions and spoken phrasing.
- Only navigate away for true 404 / "unoriginals-crash". Real Originals may live under /games/dice|/mines|/blackjack etc — stay and play. Never bounce lobby↔game in a loop.
- "say": max 18 words, plain text, contractions. "reason": max 12 words. target only for click/navigate.
- Do not put the word "demo" in every "say" line; the overlay already carries the compliance note.
- Prefer "wait". Do not narrate the same "game is loaded" line repeatedly.
- Return ONLY valid JSON. No prose before/after.`;

export class Brain {
  constructor(cfg, { memory = null, kb = null, fetchImpl = null } = {}) {
    this.cfg = cfg;
    this.memory = memory;
    this.kb = kb;
    this.fetchImpl = fetchImpl || globalThis.fetch.bind(globalThis);
    this.history = [];
    // Lines that actually went out the speaker, so the next idle can stay on the thread.
    this.spoken = [];
    this.tableMood = null;
    this.tableMoodAt = 0;
    this.failures = 0;
    this.offline = !cfg.llmKey;
    if (this.offline) log('brain: no LLM_API_KEY — canned lines only');
    if (kb?.size) log(`brain: knowledge base loaded (${kb.size} entries)`);
  }

  // Remember a line Hubie actually spoke. Greets and queue announces are not topics.
  noteSpoken(text, kind = '') {
    const k = String(kind || '');
    if (/^(greet|queue)\b/i.test(k)) return;
    const spoken = takeHostCue(text).text.replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!spoken || /^demo play only, chat/i.test(spoken)) return;
    const last = this.spoken[this.spoken.length - 1];
    if (last && last.text === spoken) return;
    this.spoken.push({ t: Date.now(), text: spoken, kind: k });
    if (this.spoken.length > 6) this.spoken.splice(0, this.spoken.length - 6);
    if (/^react:win\b/i.test(k)) {
      this.tableMood = 'win';
      this.tableMoodAt = Date.now();
    } else if (/^react:lose\b/i.test(k)) {
      this.tableMood = 'lose';
      this.tableMoodAt = Date.now();
    }
  }

  #recentSpoken(n, maxAgeMs) {
    const now = Date.now();
    return this.spoken
      .filter((s) => !maxAgeMs || now - s.t <= maxAgeMs)
      .slice(-n)
      .map((s) => s.text);
  }

  #freshMood() {
    if (!this.tableMood || !this.tableMoodAt) return '';
    if (Date.now() - this.tableMoodAt > 3 * 60 * 1000) return '';
    return this.tableMood;
  }

  // Grounding block: KB facts, plus at most two viewer facts for a returning chatter.
  #context(kind, payload) {
    const query = kind === 'reply'
      ? payload.text
      : `${payload.game || ''} ${payload.segment || ''} ${payload.detail || ''}`.trim();
    const factLimit = kind === 'idle' ? 1 : 2;
    const facts = this.kb?.search(query, factLimit) || [];
    const parts = [];
    if (kind === 'reply' && payload.name && this.memory?.factsFor) {
      const viewerFacts = this.memory.factsFor(payload.name, payload.text, 2);
      if (viewerFacts.length) {
        parts.push(`VIEWER:\n${viewerFacts.map((f) => `- ${f}`).join('\n')}`);
      }
      const recent = this.#recentSpoken(1, 3 * 60 * 1000);
      if (recent.length) {
        parts.push(`YOU JUST SAID (continue only if they are responding to it):\n- ${recent[0]}`);
      }
    }
    if (facts.length) parts.push(`FACTS:\n${facts.map((f) => `- ${f.text}`).join('\n')}`);
    if (kind === 'idle') {
      const mood = this.#freshMood();
      if (mood) parts.push(`TABLE MOOD: last result was a ${mood}.`);
      const screen = formatScreen(payload.state);
      if (screen) parts.push(`SCREEN (measured on the page, do not invent past this):\n- ${screen}`);
    }
    return parts.join('\n\n');
  }

  async #chat(messages, { maxTokens = 220, temperature = 0.9, timeoutMs = 20000 } = {}) {
    const body = {
      model: this.cfg.llmModel,
      messages,
      max_tokens: maxTokens,
      temperature,
    };
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 20000;
    const res = await this.fetchImpl(this.cfg.llmUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.llmKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    return (msg.content || msg.reasoning_content || '').trim();
  }

  // Agent decisions are strict JSON, not prose: the loop parses one object per tick.
  async #agentDecide(observation) {
    if (this.offline) throw new Error('agent: brain offline');
    const report = JSON.stringify(observation || {});
    if (process.env.DEBUG_PROMPT === '1') log(`brain: agent report -> ${report.slice(0, 300)}`);
    const text = await this.#chat(
      [{ role: 'system', content: AGENT_SYSTEM }, { role: 'user', content: `REPORT ${report}` }],
      { maxTokens: 160, temperature: 0 },
    );
    if (process.env.DEBUG_PROMPT === '1') log(`brain: agent raw -> ${String(text).slice(0, 200)}`);
    if (!text) throw new Error('agent: empty reply');
    return text;
  }

  async #ownerDecide({ report, history = [], jpeg = null } = {}) {
    if (this.offline) throw new Error('owner: brain offline');
    const textPart = `OWNER State=${JSON.stringify(report || {})}`;
    let userContent = textPart;
    if (jpeg) {
      let buf = null;
      try { buf = Buffer.isBuffer(jpeg) ? jpeg : Buffer.from(jpeg); } catch { buf = null; }
      if (buf?.length && buf.length <= 80000) {
        userContent = [
          { type: 'text', text: textPart },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } },
        ];
      }
    }
    const turns = [];
    for (const t of (history || []).slice(-6)) {
      const role = t?.role === 'assistant' ? 'assistant' : 'user';
      const content = typeof t?.content === 'string' ? t.content : JSON.stringify(t?.content || '');
      if (!content) continue;
      turns.push({ role, content: content.slice(0, 800) });
    }
    const text = await this.#chat(
      [{ role: 'system', content: OWNER_SYSTEM }, ...turns, { role: 'user', content: userContent }],
      { maxTokens: 120, temperature: 0, timeoutMs: 8000 },
    );
    if (!text) throw new Error('owner: empty reply');
    return text;
  }

  async say(kind, payload = {}, opts = {}) {
    if (kind === 'agent') return this.#agentDecide(payload.observation);
    if (kind === 'owner') return this.#ownerDecide(payload);
    const prompt = this.#userPrompt(kind, payload);
    const context = this.#context(kind, payload);
    const system = context ? `${SYSTEM}\n\n${context}` : SYSTEM;
    if (process.env.DEBUG_PROMPT === '1') log(`brain: context -> ${context.replace(/\n/g, ' | ').slice(0, 240)}`);

    if (this.offline) return this.#offline(kind, payload);
    try {
      // Idle is its own thread. Chat history would pull it back into the last question.
      const turns = kind === 'reply' ? this.history.slice(-6) : [];
      const timeoutMs = Number(opts?.timeoutMs) > 0 ? Number(opts.timeoutMs) : undefined;
      const text = await this.#chat([
        { role: 'system', content: system },
        ...turns,
        { role: 'user', content: prompt },
      ], timeoutMs ? { timeoutMs } : {});
      if (process.env.DEBUG_PROMPT === '1') log(`brain: raw reply -> ${String(text).slice(0, 200)}`);
      this.failures = 0;
      const shaped = shapeSpoken(text, kind);
      if (kind === 'reply' && shaped.text && !shaped.fallback) {
        this.history.push({ role: 'user', content: prompt }, { role: 'assistant', content: shaped.text });
        if (this.history.length > 12) this.history.splice(0, this.history.length - 12);
      }
      return shaped;
    } catch (err) {
      this.failures++;
      log(`brain: ${err.message}`);
      const shaped = this.#offline(kind, payload);
      if (isTimeoutError(err)) shaped.timeout = true;
      return shaped;
    }
  }

  // One Originals title from the observed lobby. Null on any failure so the
  // caller can keep the scripted rotate pick. Never returns a name outside the list.
  async pickGame({ lobby = [], current = '', state = null } = {}) {
    if (this.offline) return null;
    const allowed = [];
    const seen = new Set();
    for (const name of lobby) {
      const label = String(name || '').trim();
      if (!label) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      allowed.push(label);
    }
    if (!allowed.length) return null;
    const screen = formatScreen(state);
    const prompt = [
      `Allowed games: ${allowed.join(', ')}.`,
      current ? `Now playing: ${current}.` : '',
      screen ? `Screen: ${screen}.` : '',
      'Pick a different allowed game when one exists.',
      'Reply ONLY JSON {"game":"<one allowed name>"}.',
    ].filter(Boolean).join(' ');
    try {
      const text = await this.#chat(
        [
          { role: 'system', content: 'You pick the next Housebets Originals demo game. Never invent a name that is not in Allowed. JSON only.' },
          { role: 'user', content: prompt },
        ],
        { maxTokens: 40, temperature: 0, timeoutMs: 2500 },
      );
      const match = String(text || '').match(/"game"\s*:\s*"([^"]+)"/i);
      const name = match ? match[1].trim() : '';
      return allowed.find((g) => g.toLowerCase() === name.toLowerCase()) || null;
    } catch (err) {
      log(`brain: pickGame skipped (${err.message})`);
      return null;
    }
  }

  // Cheap vision read. Null when the model is down, the image is large, or the call fails.
  async summarizeFrame(jpeg) {
    if (this.offline || !jpeg) return null;
    let buf = null;
    try { buf = Buffer.isBuffer(jpeg) ? jpeg : Buffer.from(jpeg); } catch { return null; }
    if (!buf?.length || buf.length > 80000) return null;
    try {
      return await this.#chat(
        [
          {
            role: 'system',
            content: 'Read a Housebets demo screenshot. Reply ONLY JSON {"game":null,"balance":null,"lastResult":null,"won":null,"multiplier":null,"round":"unknown","lobby":[]}. Use null when unreadable. Never invent.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is on this demo screen?' },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } },
            ],
          },
        ],
        { maxTokens: 120, temperature: 0, timeoutMs: 8000 },
      );
    } catch (err) {
      log(`brain: vision skipped (${err.message})`);
      return null;
    }
  }

  // One host line about the play screenshot. Null on failure. Never chooses clicks.
  async commentFrame(jpeg, tag = '') {
    if (this.offline || !jpeg) return null;
    let buf = null;
    try { buf = Buffer.isBuffer(jpeg) ? jpeg : Buffer.from(jpeg); } catch { return null; }
    if (!buf?.length || buf.length > 80000) return null;
    try {
      const text = await this.#chat(
        [
          {
            role: 'system',
            content: 'You are Hubie hosting a Housebets promo stream. One spoken English line, max 12 words. Fun, not a status report. Never say zero locked, sending it, queued, or plan failed. No JSON, no URLs, no deposits.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Just clicked "${String(tag || 'play')}". What is on this demo table?` },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } },
            ],
          },
        ],
        { maxTokens: 40, temperature: 0.5, timeoutMs: 8000 },
      );
      const shaped = shapeSpoken(String(text || '').split('\n')[0], 'idle');
      if (shaped.fallback || !shaped.text) return null;
      const words = shaped.text.split(/\s+/).filter(Boolean);
      if (words.length > 16) return words.slice(0, 12).join(' ');
      return shaped.text;
    } catch (err) {
      log(`brain: frame comment skipped (${err.message})`);
      return null;
    }
  }

  #userPrompt(kind, payload) {
    if (kind === 'reply') {
      return `Viewer "${payload.name}" wrote: "${payload.text}". Answer them by name, one line.`;
    }
    if (kind === 'idle') return idleUserPrompt(payload, this.#recentSpoken(2, 10 * 60 * 1000));
    return `Round ${payload.round} just settled: ${payload.detail}. Commentate it in one short line.`;
  }

  #offline(kind, payload) {
    if (kind === 'idle') return { text: '', emotion: null, gesture: null, fallback: true };
    return {
      text: sanitize(offlineLine(kind, payload)),
      emotion: null,
      gesture: null,
      fallback: true,
    };
  }
}

function idleUserPrompt(payload, recent) {
  const segment = String(payload.segment || 'play').toLowerCase().replace(/[^a-z]/g, '').slice(0, 16) || 'play';
  const mood = segment === 'chill'
    ? 'quiet and unhurried'
    : segment === 'chatpick'
      ? 'inviting chat to name the next Originals game'
      : 'playful and a little hyped about the table';
  const table = String(payload.game || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const lines = [
    `Segment is ${segment}. Mood: ${mood}.`,
    table ? `Table is ${table}.` : 'Table is an Originals demo.',
    recent.length
      ? `You just said: ${recent.map((l) => `"${l}"`).join(' then ')}. Continue that thread. Do not repeat it.`
      : 'No earlier line. Start a fresh idle thought.',
    payload.state?.ok
      ? `Screen says: ${formatScreen(payload.state)}. Use only those names and numbers.`
      : '',
    'One short idle line.',
  ].filter(Boolean);
  return lines.join(' ');
}

// Spoken text plus the cue. fallback means the caller should use a canned line.
export function shapeSpoken(raw, kind = 'reply') {
  const cue = takeHostCue(raw);
  const text = sanitize(cue.text);
  const replaced = !String(cue.text || '').trim()
    || (text === SAFE_FALLBACK && String(cue.text).replace(/\s+/g, ' ').trim() !== SAFE_FALLBACK);
  if (kind === 'idle' && (replaced || !text)) {
    return { text: '', emotion: null, gesture: null, fallback: true };
  }
  if (replaced) return { text, emotion: null, gesture: null, fallback: true };
  return { text, emotion: cue.emotion, gesture: cue.gesture, fallback: false };
}

const BLOCKED = [
  /guarantee[ds]?\s+(a\s+)?win/i, /sure\s+win/i, /deposit/i, /top\s*up/i, /bonus\s+code/i,
  /referral/i, /invest/i, /profit/i, /you\s+will\s+win/i, /free\s+money/i, /https?:\/\//i, /www\./i,
  // Model sometimes echoes the system prompt onto the mic.
  /plain\s*text/i, /no\s*markdown/i, /no\s*emoji/i, /hashtags?/i, /max\s*\d+\s*words/i,
  /return\s+only\s+one\s+json/i, /stream\s+operator/i,
  // Customer-support voice — Hubie is a mascot with opinions, never a help desk.
  /how\s+(can|may)\s+i\s+help/i, /i\s+understand\s+your\s+frustration/i, /i'?m\s+sorry\s+to\s+hear/i,
  /sorry\s+for\s+the\s+inconvenience/i, /thanks\s+for\s+reaching\s+out/i, /great\s+question/i,
  /as\s+an\s+ai\b/i, /let\s+me\s+know\s+if\s+you\s+need/i,
];

// Demo-word diet: the overlay footer keeps the compliance wording, but the voice should
// not lean on "demo" every line. A line that says "demo" within five minutes of the last
// one is rewritten to free-play phrasing; a line that collapses is dropped.
const DEMO_RE = /\bdemo\b/i;
const DEMO_REWRITES = [
  [/\bdemo\s+chips?\b/gi, 'play chips'],
  [/\bdemo\s+play\b/gi, 'free play'],
  [/\bplay\s+demo\b/gi, 'free play'],
  [/\bdemo\s+table\b/gi, 'the table'],
  [/\bdemo\s+mode\b/gi, 'free-play mode'],
  [/\bdemo\s+round\b/gi, 'this round'],
  [/\bdemo\s+only\b/gi, 'just for fun'],
  [/\bdemo\b/gi, 'free-play'],
];
const DEMO_WINDOW_MS = 5 * 60 * 1000;
let lastDemoSpokenAt = 0;

export function demoDiet(text, { now = Date.now(), windowMs = DEMO_WINDOW_MS } = {}) {
  let t = String(text || '');
  if (!DEMO_RE.test(t)) return t;
  if (now - lastDemoSpokenAt >= windowMs) {
    lastDemoSpokenAt = now;
    return t;
  }
  for (const [re, replacement] of DEMO_REWRITES) t = t.replace(re, replacement);
  t = t.replace(/\s+/g, ' ').trim();
  return t.replace(/[^a-z]/gi, '').length >= 3 ? t : '';
}

export function sanitize(text) {
  let t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return SAFE_FALLBACK;
  if (BLOCKED.some((re) => re.test(t))) return SAFE_FALLBACK;
  const words = t.split(' ');
  if (words.length > 18) t = words.slice(0, 18).join(' ') + '.';
  return t;
}

function isTimeoutError(err) {
  const name = String(err?.name || '');
  const msg = String(err?.message || err || '');
  return name === 'TimeoutError' || /timeout/i.test(msg);
}

function offlineLine(kind, payload) {
  const round = payload.round ?? 1;
  const idles = [
    'Round is live. Chat, tell me something that is not financial advice.',
    'Still spinning. Demo chips only, people.',
    'Quiet round. Good. Quiet rounds are honest rounds.',
    `Round ${round}. Nothing dramatic yet, which is exactly what the house wants.`,
    'Chat has opinions and no money on the line. Ideal arrangement.',
  ];
  if (kind === 'reply') {
    return `${payload.name}, that is the most sensible thing said all round.`;
  }
  return idles[round % idles.length];
}
