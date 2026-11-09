# Hubie

24/7 AI streamer for **Housebets Contest Labs**. Hubie plays House Originals in
**demo mode** (stake 0), talks to Kick chat, and streams a 1280×720 overlay with
voice.

Contest: https://www.housebets.com/contests/hubie-streamer

## Pipeline

```
Housebets (Chrome) → capture → world / planner / tools
Kick chat          → intents → controller (one owner of clicks)
TTS (xAI Atlas / Edge) + canvas overlay → ffmpeg → Kick RTMP
```

| Piece | What it does |
| --- | --- |
| Capture | Logged-in Chrome profile, SPA lobby clicks (never `page.goto` a table) |
| Play | Per-table clicks at stake 0: Dice Bet, Blackjack Hit/Stand, Keno numbers, Mines tiles, Hilo Higher/Lower |
| Chat | Kick ingest; commands like `ganti multi 5` / `ganti menang 40` / `play mines` |
| Safety | Stake locked to 0; no win promises; 18+ / gamble-responsibly on every frame |
| Voice | `TTS_ENGINE=xai` Atlas, Edge failover |

## Quick start

```bash
git clone https://github.com/zeroknowledge0x/hbzk.git
cd hbzk
npm install
cp .env.example .env   # fill keys; never commit .env
npm test
npm run setup          # prints PASS/WARN/FAIL; exits non-zero while blocked
```

Then on Windows (this contest host):

```bat
start-hubie-headed.bat
```

or `npm start` after the env and browser profile are in place.

## What git cannot carry

| Need | Where it comes from |
| --- | --- |
| `.env` | Copy `.env.example`, fill API keys, `STREAM_KEY`, `TTS_ENGINE`, `KICK_CHANNEL` |
| Chrome profile | A logged-in Housebets session. Point `CHROME_PROFILE_DIR` at it. A fresh profile is logged out and looks like Cloudflare. |
| Local TTS binaries | `npm run bootstrap` when using piper/kokoro (`vendor/`, hundreds of MB) |

A blocked egress country and a logged-out profile both look like code bugs. They are not.

## Config that matters

| Key | Role |
| --- | --- |
| `BET_STAKE` | Must stay `0` (demo). The table stake field is **POL**, not IDR. |
| `PLAYABLE_GAMES` | Comma list of House Originals to rotate |
| `CHROME_PROFILE_DIR` | Path to the logged-in Chrome profile |
| `CAPTURE_MODE` | `screencast` (CDP) on this host |
| `TTS_ENGINE` | `xai` / `edge` / `kokoro` / `piper` |
| `STREAM_KEY` / `RTMP_URL` | Kick ingest |
| `CHAT_HOST` | `kick` |
| `TELEGRAM_BOT_TOKEN` | Optional operator bot (`node scripts/telegram-bot.mjs`) |

## Tests

```bash
npm test
```

Offline unit tests. They do not need Chrome or a stream key.

## How the host plays (demo stake 0)

One measured policy per House table (`src/core/adapters/*-policy.js`); the controller asks it
for a single action and verifies that action on the live page before clicking it. Progress is
read from the board (revealed gems, cleared floors/lanes), never from a click count.

| Table | Idle | In a round | Cash out |
| --- | --- | --- | --- |
| Dice | range chip or a written multiplier (1.5x-10x), then `Bet` | one roll resolves | — |
| Mines | `Bet` | `Random tile` or one unrevealed tile | after a reveal, at most 40% of the decisions |
| Plinko | risk chip, then `Bet` | — | — |
| Keno | risk chip, `Clear table`, 2-4 numbers or `Auto pick`, then `Bet` | — | — |
| Wheel | risk chip, then `Bet` | — | — |
| Limbo | target preset (1.5x/5x/10x/100x), then `Bet` | — | — |
| Max Win | written multiplier (10x-1000x), then `Bet` | — | — |
| Dragon Tower | `Bet` | `Random pick` or a floor tile | after one floor, at most 40% |
| Hilo | `Bet` to deal | `Higher / same` or `Lower / same` | `Cash out` when no climb is offered |
| Blackjack | `Bet`/`Deal`, `No thanks` for insurance | `Hit` or `Stand` | — |
| Hubie's Road | `Bet` or `Go` | next lane | after one lane, at most 40% |

A round is `enter_game` (lobby card click, never `page.goto`) → `start_round` → `await_result`.
Rounds are 6-15 s apart, the table changes every 10-60 min, and a game a viewer asks for in
chat jumps the queue.

## Reliability and observability

| Piece | What it does |
| --- | --- |
| `src/uptime.js` | Unattended-run ledger (`data/uptime.json`): a supervisor restart keeps the clock, only a launcher a person runs resets it; prints `UNATTENDED h · BEST h · RESTARTS n` |
| `src/core/llm-chain.js` | Provider chain: a 429 parks that provider until the reset time it reports and the mouth continues on `LLM_FALLBACK_*` |
| `src/moderation.js` | Follow/view scams and automation pitches are classified and never read aloud |
| `src/core/metrics.js` | Messages in, answered, reply latency and ignored questions, written to the log each minute |
| `src/core/allowlist.js` | Only housebets.com and kick.com are navigable |
| `clickText` actionability | A click fails loudly when the target is covered, off-screen or moving, and scrolls a below-the-fold target into view first |

## Layout

```
src/           runtime (capture, core agent, overlay, encoder)
src/core/      world, planner, tools, verifier, per-table adapters
test/          node:test suite
scripts/       setup, doctor, bootstrap, Telegram bot, start/stop
start-hubie-headed.bat
.env.example
```

## Safety

- Never commit `.env`, tokens, or the Chrome profile.
- Demo only: nonzero stakes are refused.
- 18+ and “gamble responsibly” are painted every frame, not by the LLM.

## License

Contest entry. If the entry wins, Housebets owns the winning code under the
contest attestation. Until then rights remain with the author.
