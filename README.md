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
