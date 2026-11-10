// Game capture: Chrome/Edge + CDP Page.startScreencast.
// If no URL or no browser is configured the renderer keeps its stand-in panel.
// The state below is what the agent's report tools read every second.
import { loadImage } from '@napi-rs/canvas';
import { demoStakeString } from './bet-guard.js';
import { safeTuneValue } from './chat-reply.js';
import { getBrowser } from './browser.js';
import { DesktopGrab } from './desktop-grab.js';
import { readSettings, setSetting, zeroStake } from './game-settings.js';
import { log } from './log.js';
import { isFrameBlack, shouldPumpCapture, pickLargestRect } from './capture-health.js';
import { assertAllowed } from './core/allowlist.js';
import { LocalRoundTracker, observeLocalRoundDom } from './round-events.js';

const WAIT_MS = 1500;
const UI_TTL_MS = 1000;
const UI_MAX = 40;
const BODY_CHARS = 400;

// A real game card is a short title ("Dice", "Mines"). Housebets also renders long
// marketing copy that contains the same words ("… meets the house … DICE …"), so the
// match has to be anchored and length-bounded or every click lands on the promo card.
const GAME_TITLE = /^(dice|mines?|crash|limbo|plinko|blackjack|keno|wheel|hilo|dragon\s*tower|tower|max\s*win)\b/i;
const GAME_SLUG = /dice|mines?|crash|limbo|plinko|blackjack|keno|wheel|hilo|tower|max-?win/i;
const PROMO_TEXT = /meet the house|made by|originals\b.*more|mini player|play .+ in the|in the mini/i;
const SHORT_LABEL = 40;
const MAX_LABEL = 60;

function looksBlocked(title, bodyText = '') {
  return /just a moment|attention required|cloudflare|unavailable in your region|performing security verification/i
    .test(`${title}\n${bodyText}`);
}

function looksNotFound(title, bodyText = '') {
  return /404|page not found|not found|return to home/i.test(`${title}\n${bodyText}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// Card label for a Housebets Originals slug. The lobby is a SPA: clicking the card is a
// client-side route change and never hits Cloudflare, while page.goto() on the same URL
// does. This map is what lets the agent switch games without the challenge.
export const GAME_CARD = {
  dice: 'Dice', mines: 'Mines', plinko: 'Plinko', keno: 'Keno', wheel: 'Wheel', limbo: 'Limbo',
  'max-win': 'Max Win', hilo: 'Hilo', blackjack: 'Blackjack', 'dragon-tower': 'Dragon Tower',
  'hubie-s-road': "Hubie's Road", 'coin-flip': 'Coinflip', baccarat: 'Baccarat', roulette: 'Roulette',
};

export function gameSlugFromUrl(url) {
  const m = String(url || '').match(/\/games\/housegames-([a-z0-9-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

export class GameFeed {
  constructor({ url, fps = 10, captureMode = 'screencast', headed = true }) {
    this.url = url;
    this.fps = fps;
    this.captureMode = captureMode === 'desktop' ? 'desktop' : 'screencast';
    this.headed = headed !== false;
    this.screencastFrame = null;
    this.desktop = null;
    this.desktopDead = false;
    this.page = null;
    this.client = null;
    this.stopped = false;
    this.launching = false;
    this.screencasting = false;
    // Screencast can go silent without firing 'close' (Chrome throttling, a swallowed
    // page navigation). The watchdog below keeps pixels flowing either way.
    this.lastFrameAt = 0;
    this.watchdogLoggedAt = 0;
    this.watchInFlight = false;
    this.backoff = 5000;
    this.recoverTimer = null;
    this.blockedLogged = false;
    this.ready = false; // true once CF cleared and screencast is feeding real frames
    this.title = '';
    this.currentUrl = url || '';
    this.blocked = false;
    this.notFound = false;
    this.loading = !!url;
    this.lastError = null;
    this.viewport = { w: 1280, h: 697 };
    this.lastBody = '';
    this.ui = { at: 0, body: '', title: '', clickables: [], outcome: null };
    this.uiInFlight = false;
    this.uiAttemptAt = 0;
    this.lastPointer = null;
    this.preferredGame = null;
    // Originals cards seen on the lobby, captured before we click into a table.
    this.lobbySnapshot = null;
  }

  // In desktop mode the fresh gdigrab frame wins; otherwise the CDP screencast keeps the
  // same slot, so nothing downstream (renderer, tools, recorder) has to know the mode.
  get frame() {
    const desktop = this.desktop?.getFrame?.();
    return desktop || this.screencastFrame;
  }

  set frame(value) {
    this.screencastFrame = value;
  }

  // DOM report: visible clickables (centres in CSS px) plus the visible body text.
  // The page.evaluate is throttled to ~1 Hz and shared by getReport() and the screencast
  // loop, so the LLM sees what a viewer sees without hammering the page.
  async getUiSnapshot({ force = false } = {}) {
    return this.#refreshUi({ force });
  }

  async #refreshUi({ force = false } = {}) {
    const page = this.page;
    if (!page || page.isClosed?.()) return this.ui;
    const now = Date.now();
    if (!force && now - Math.max(this.ui.at, this.uiAttemptAt) < UI_TTL_MS) return this.ui;
    if (this.uiInFlight) return this.ui;
    this.uiInFlight = true;
    this.uiAttemptAt = now;
    try {
      const snap = await page.evaluate((max, accountHandle) => {
        // Housebets mounts the game controls inside <dice-game>, whose buttons/inputs live
        // in an open shadow root. document.querySelectorAll cannot see them, so walk every
        // element and query each root (document + every open shadow root, recursively).
        const deepAll = (sel, root = document, out = []) => {
          try { for (const n of root.querySelectorAll(sel)) out.push(n); } catch { /* bad selector */ }
          let all;
          try { all = root.querySelectorAll('*'); } catch { return out; }
          for (const el of all) if (el.shadowRoot) deepAll(sel, el.shadowRoot, out);
          return out;
        };
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          return !(r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth);
        };
        const isEnabled = (el) => {
          for (let node = el; node; node = node.parentElement || node.getRootNode?.().host) {
            if (node.disabled || node.hasAttribute?.('disabled') || node.matches?.(':disabled')
              || String(node.getAttribute?.('aria-disabled')).toLowerCase() === 'true') return false;
          }
          return true;
        };
        // Short in-game controls must survive the 40-entry cap, so collect them first.
        const CONTROL = /^(?:place\s*)?bet$|^(?:roll|hit|stand|manual|auto|deal|cash\s*out|cashout|½|1\/2|2×|2x)$/i;
        const BET_FIELD = /bet|amount|wager|stake/i;
        const bodySnippet = norm(document.body?.innerText).slice(0, 400);
        // Mines has no Bet between rounds: unrevealed tiles are the only free-play controls.
        // They are usually empty, so the generic text filter would drop them from the report.
        const isMines = /mines/i.test(`${location.href} ${document.title}`);
        const mineTile = (el, tag, r) => {
          const w = r.width, h = r.height;
          if (w < 18 || h < 18 || w > 180 || h > 180) return false;
          const ratio = w / h;
          if (ratio < 0.55 || ratio > 1.8) return false;
          if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
          const label = norm(`${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.value || ''}`);
          if (label.length > 24) return false;
          if (/cash\s*out|cashout|^bet$|^auto$|^manual$|^min$|^max$|^1\/2$|^2×$|^2x$/i.test(label)) return false;
          const meta = norm(`${el.className || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-state') || ''} ${el.getAttribute('data-status') || ''}`).toLowerCase();
          if (/opened|revealed|exploded|flagged|\bhit\b|\bsafe\b|disabled|cash/.test(meta)) return false;
          const marked = /cell|tile|mine|grid|square|spot/.test(meta);
          let inGrid = false;
          let p = el.parentElement;
          for (let i = 0; p && i < 3; i++, p = p.parentElement) {
            let kids = 0;
            try { kids = p.children?.length || 0; } catch { kids = 0; }
            let disp = '';
            try { disp = getComputedStyle(p).display || ''; } catch { disp = ''; }
            if (kids >= 9 && /grid|flex/.test(disp)) { inGrid = true; break; }
          }
          return marked || inGrid;
        };
        const sel = isMines
          ? 'a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"],[onclick],[class*="cell"],[class*="tile"],input'
          : 'a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"],[onclick],input';
        // On a table page the site chrome (nav, wallet, promotions) outnumbers the real
        // controls and used to fill the 40-slot list before the Bet/Deal button ever got
        // in — that is why "the game opens but never plays" looked like a Dice-only bug.
        const inGame = /\/games\/housegames-/.test(location.href);
        const NAV_CHROME = /^(toggle menu|rewards|search|chat|log ?in|register|casino|sports|casino lobby|house games|new releases|slots|live casino|house studios|game shows|blackjack|roulette|baccarat|providers|promotions|leaderboard|xp race|contest labs|affiliate|blog|help center|responsible gambling|live support|fair|rules|theatre mode|open mini player|normal|sound|settings|show more|scroll previous|scroll next|pure speed|account|wallet|weekly prize[^|]*|monthly prize[^|]*)$/i;
        // These sit in the same snapshot and used to fill the 40 slots before Higher/Lower/Skip.
        const SNAP_SKIP = /^(manual|auto)$|\bfavourites?\b|\bfavorites?\b|recently played|^bet amount\b|^idr\b|^usd\b|^eur\b|^pol\b|currencies|intercom|messenger|live stats|\badvanced\b|instant autobet|autobet/i;
        const priority = [];
        const dialogs = [];
        const tiles = [];
        const rest = [];
        const seen = new Set();
        for (const el of deepAll(sel)) {
          if (!isVisible(el) || !isEnabled(el)) continue;
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (tag === 'input' && !/^(number|text|tel|button|submit)$/.test(type)) continue;
          const r = el.getBoundingClientRect();
          const inner = norm(el.innerText);
          let text = norm(`${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('placeholder') || ''} ${el.value || ''}`).slice(0, 80);
          // innerText + aria-label often carry the same word twice ("Bet Bet", "Hit Hit");
          // every downstream exact-match play check then misses the control.
          if (text) { const w = text.split(' '); text = w.filter((x, k) => k === 0 || x.toLowerCase() !== w[k - 1].toLowerCase()).join(' '); }
          const tileish = isMines && mineTile(el, tag, r);
          if (!text && !tileish) continue;
          if (inGame && !tileish && (NAV_CHROME.test(text) || SNAP_SKIP.test(text))) continue;
          const key = `${text}@${Math.round(r.x)},${Math.round(r.y)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!text) text = `tile ${tiles.length + 1}`;
          const entry = {
            text,
            tag,
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
          if (tileish) entry.tile = true;
          const isBetField = tag === 'input'
            && BET_FIELD.test(`${text} ${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''}`);
          if (inGame && isBetField) continue;
          const isControl = !isBetField
            && (CONTROL.test(inner) || CONTROL.test(norm(el.getAttribute('aria-label'))));
          const inDialog = (() => {
            for (let n = el; n; n = n.parentElement || n.getRootNode?.().host) {
              const role = String(n.getAttribute?.('role') || '').toLowerCase();
              if (role === 'dialog' || role === 'alertdialog') return true;
              const cls = String(n.className || '').toLowerCase();
              if (cls.includes('modal') || cls.includes('dialog')) return true;
            }
            return false;
          })();
          const dialogLabel = /hit anyway|^cancel$|don't ask|dont ask|^close$|^no thanks$/i.test(text);
          if (inDialog || dialogLabel) dialogs.push(entry);
          else if (tileish) tiles.push(entry);
          else (isControl || isBetField ? priority : rest).push(entry);
        }
        // Dice outcome sensor: the latest result marker lives inside the shadow DOM.
        // `.hd-g-marker` carries the number ("88.75") plus `--win` / `--lose`; history
        // chips use `.hd-g-chip--*` and must not be mistaken for the live result.
        let outcome = null;
        try {
          const markers = deepAll('[class*="hd-g-marker"]')
            .filter((el) => !String(el.className || '').includes('hd-g-chip'));
          for (const el of markers) {
            const text = norm(el.textContent);
            const hit = text.match(/-?\d+(?:[.,]\d+)?/);
            if (!hit) continue;
            const result = Number(hit[0].replace(',', '.'));
            if (!Number.isFinite(result)) continue;
            const cls = String(el.className || '');
            const won = cls.includes('hd-g-marker--win')
              ? true
              : cls.includes('hd-g-marker--lose') ? false : null;
            let rollOver = null;
            for (const node of deepAll('*')) {
              const label = norm(node.textContent);
              if (!label || label.length > 60) continue;
              const th = label.match(/roll\s*(over|under)\s*:?\s*(\d+(?:[.,]\d+)?)/i);
              if (th) {
                rollOver = Number(th[2].replace(',', '.'));
                break;
              }
            }
            outcome = { result, won, rollOver, source: 'marker' };
            break;
          }
        } catch { /* no markers on this page */ }
        // Keno outcome sensor: a winning cell lights up with `.hl-g-payhit--on` and shows
        // its multiplier ("3x"); a losing round shows "0x". Only used when Dice had no hit.
        if (!outcome) {
          try {
            // Require the hits footer ("3 of 10") so we do not treat the idle pay-table highlight as a result.
            const foot = deepAll('[class*="hl-g-foot-val--hits"]')
              .map((node) => norm(node.textContent))
              .find((text) => /\d+\s*of\s*\d+/i.test(text));
            if (foot) {
              const payhits = deepAll('[class*="hl-g-payhit--on"]')
                .filter((el) => String(el.className || '').includes('hl-g-payhit--on'));
              for (const el of payhits) {
                const hit = norm(el.textContent).match(/(\d+(?:[.,]\d+)?)\s*x/i);
                if (!hit) continue;
                const mult = Number(hit[1].replace(',', '.'));
                if (!Number.isFinite(mult)) continue;
                outcome = { result: mult, won: mult > 0, hits: foot, source: 'keno-payhit' };
                break;
              }
            }
          } catch { /* no keno payhits on this page */ }
        }
        // Handle-based sensor: the live-bets feed is global, so the only row that is
        // ours is the one carrying our account name (zk0x on this account). Newest row in
        // DOM order is our latest round; the multiplier is the result.
        if (!outcome) {
          try {
            const handle = String(accountHandle || '').toLowerCase();
            if (!handle) throw new Error('No configured account handle');
            const rows = deepAll('div,li,tr,span')
              .filter((el) => {
                const t = norm(el.textContent).toLowerCase();
                if (!t.includes(handle)) return false;
                if (t.length > 160) return false;
                return /\d+(?:\.\d+)?x/.test(t);
              })
              .map((el) => ({ el, len: norm(el.textContent).length, text: norm(el.textContent), area: (() => { const r = el.getBoundingClientRect(); return r.width * r.height; })() }))
              .filter((r) => r.area > 0)
              .sort((a, b) => a.len - b.len);
            if (rows.length) {
              const m = rows[0].text.match(/(\d+(?:\.\d+)?)x/i);
              if (m) {
                const val = Number(m[1]);
                outcome = { result: val, won: val > 0, source: 'handle-row' };
              }
            }
          } catch { /* no feed on this table */ }
        }

        // Generic result sensor for the tables that have no hand-written one (Plinko,
        // Wheel, Limbo, Max Win, Dragon Tower, Hilo, Blackjack). Only accepts a short
        // visible node whose class says win/lose and that carries a number — never a
        // percentage, so "Win Chance 49.50%" cannot be mistaken for a result.
        if (!outcome) {
          try {
            const cands = deepAll('[class*="marker"],[class*="result"],[class*="outcome"],[class*="payout"]')
              .filter((el) => {
                const t = norm(el.textContent);
                return t && t.length <= 24 && t.length >= 1;
              });
            for (const el of cands) {
              const cls = String(el.className || '').toLowerCase();
              const raw = norm(el.textContent);
              if (raw.includes('%')) continue;
              const hit = raw.match(/(-?\d+(?:[.,]\d+)?)\s*x?/i);
              if (!hit) continue;
              const val = Number(hit[1].replace(',', '.'));
              if (!Number.isFinite(val) || val < 0) continue;
              let won = null;
              if (/win|success|green|profit/.test(cls)) won = true;
              else if (/lose|loss|fail|red|bust/.test(cls)) won = false;
              if (won === null) continue;
              outcome = { result: val, won, source: 'generic' };
              break;
            }
          } catch { /* no generic marker on this table */ }
        }
        let dialogText = '';
        try {
          for (const el of deepAll('[role="dialog"],[role="alertdialog"]')) {
            const t = norm(el.innerText).slice(0, 240);
            if (t) { dialogText = t; break; }
          }
        } catch { /* no dialog on this table */ }
        return { bodySnippet, title: document.title, dialogText, clickables: [...dialogs, ...priority, ...tiles, ...rest].slice(0, max), outcome };
      }, UI_MAX, process.env.HOUSEBETS_HANDLE || '');
      if (snap) {
        let outcome = snap.outcome && !['generic', 'handle-row', 'live-bets'].includes(snap.outcome.source) ? snap.outcome : null;
        try {
          this.roundTracker = this.roundTracker || new LocalRoundTracker();
          const samples = await page.evaluate(observeLocalRoundDom);
          if (Array.isArray(samples)) {
            let event = null;
            for (const sample of samples) event = this.roundTracker.observe(sample) || event;
            outcome = event;
          }
        } catch { /* keep the non-global snapshot outcome */ }
        this.ui = {
          at: Date.now(),
          body: String(snap.bodySnippet || '').slice(0, BODY_CHARS),
          title: String(snap.title || ''),
          clickables: Array.isArray(snap.clickables) ? snap.clickables : [],
          dialogText: String(snap.dialogText || '').slice(0, 240),
          outcome,
        };
      }
    } catch { /* page busy or navigating */ }
    finally { this.uiInFlight = false; }
    return this.ui;
  }

  #clearUi() {
    this.lastBody = '';
    this.ui = { at: 0, body: '', title: '', clickables: [], outcome: null };
    this.uiAttemptAt = 0;
    this.lastPointer = null;
  }

  // Lobby cards, captured while /casino is actually on screen. Failures stay quiet.
  async #snapshotLobby() {
    try {
      const ui = await this.#refreshUi({ force: true });
      const cards = [];
      for (const c of ui?.clickables || []) {
        const text = String(c?.text || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 40 || PROMO_TEXT.test(text)) continue;
        if (!GAME_TITLE.test(text)) continue;
        cards.push(text);
      }
      if (!cards.length) return;
      let url = '';
      try { url = this.page?.url?.() || ''; } catch { /* mid-navigation */ }
      this.lobbySnapshot = { at: Date.now(), clickables: (ui.clickables || []).slice(0, 40), url };
      log(`game: lobby snapshot ${cards.length} (${cards.slice(0, 6).join(', ')})`);
    } catch (err) {
      log(`game: lobby snapshot skipped (${err.message})`);
    }
  }

  // Extra DOM fields the 1 Hz clickable report does not carry: balance, multiplier, round.
  // Returns null when the page is gone. Callers treat that as "keep the last state".
  async readPerceptionDom() {
    const page = this.page;
    if (!page || page.isClosed?.()) return null;
    try {
      return await page.evaluate(() => {
        const deepAll = (sel, root = document, out = []) => {
          try { for (const n of root.querySelectorAll(sel)) out.push(n); } catch { /* bad selector */ }
          let all;
          try { all = root.querySelectorAll('*'); } catch { return out; }
          for (const el of all) if (el.shadowRoot) deepAll(sel, el.shadowRoot, out);
          return out;
        };
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const textOf = (sels) => {
          for (const sel of sels) {
            for (const el of deepAll(sel)) {
              const t = norm(el.innerText || el.textContent);
              if (t && t.length <= 48) return t;
            }
          }
          return null;
        };
        return {
          url: location.href,
          title: document.title,
          body: norm(document.body?.innerText).slice(0, 1200),
          balanceText: textOf(['[class*="balance"]', '[class*="wallet"]', '[data-testid*="balance"]']),
          multiplierText: textOf(['[class*="multiplier"]', '[class*="payout"]']),
          roundText: textOf(['[class*="status"]', '[class*="round"]', '[class*="phase"]']),
        };
      });
    } catch {
      return null;
    }
  }

  // 320x180 JPEG for the rare vision fallback. Null when there is no frame.
  async captureLowRes() {
    const img = this.frame;
    if (!img) return null;
    try {
      const { createCanvas } = await import('@napi-rs/canvas');
      const canvas = createCanvas(320, 180);
      canvas.getContext('2d').drawImage(img, 0, 0, 320, 180);
      const buf = canvas.toBuffer('image/jpeg', 40);
      if (!buf || buf.length > 80000) return null;
      return buf;
    } catch (err) {
      log(`game: low-res capture skipped (${err.message})`);
      return null;
    }
  }

  // After a play click: dump the current table frame. Does not call a vision model.
  async snapPlay(tag = 'play') {
    const img = this.frame;
    if (!img) return { ok: false, error: 'no frame' };
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { createCanvas } = await import('@napi-rs/canvas');
      const w = Number(img.width) || 1280;
      const h = Number(img.height) || 720;
      const canvas = createCanvas(Math.min(w, 1280), Math.min(h, 720));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const buf = canvas.toBuffer('image/jpeg', 55);
      if (!buf?.length) return { ok: false, error: 'empty jpeg' };
      fs.mkdirSync('logs', { recursive: true });
      fs.writeFileSync(path.join('logs', 'play-frame.jpg'), buf);
      this.lastPlayShot = { tag: String(tag || 'play').slice(0, 40), at: Date.now(), bytes: buf.length };
      log(`play: frame after ${this.lastPlayShot.tag} ${buf.length}b`);
      return { ok: true, ...this.lastPlayShot };
    } catch (err) {
      log(`play: frame skip (${err.message})`);
      return { ok: false, error: err.message };
    }
  }

  // Synchronous snapshot for tools.reportAll(). Page URL is read live; title/blocked are
  // refreshed by the screencast and the Cloudflare wait loop.
  getReport() {
    let url = this.currentUrl || this.url || null;
    try { url = this.page?.url?.() || url; } catch { /* page mid-navigation */ }
    // Keep the DOM snapshot warm without blocking the 1 Hz report; the screencast loop
    // also calls this, so a fresh page is usually already cached.
    if (Date.now() - this.ui.at >= UI_TTL_MS) this.#refreshUi().catch(() => {});
    const ui = this.ui;
    const bodySnippet = ui.body || this.lastBody || '';
    const notFound = !!this.notFound || (!!bodySnippet && looksNotFound(this.title, bodySnippet));
    return {
      ready: !!this.ready && !notFound,
      hasFrame: !!this.frame,
      url,
      title: this.title || ui.title || '',
      blocked: !!this.blocked,
      notFound,
      loading: !!this.loading,
      lastError: this.lastError || null,
      bodySnippet,
      clickables: ui.clickables.slice(0, UI_MAX),
      outcome: ui.outcome || null,
      lastPointer: this.lastPointer,
      viewport: this.viewport,
      ts: Date.now(),
    };
  }

  async start() {
    if (!this.url) {
      this.loading = false;
      log('game: HOUSEBETS_GAMES_URL empty — stand-in panel');
      return this;
    }
    await this.#launch();
    return this;
  }

  async #waitClear(page, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let title = '';
      let body = '';
      try { title = await page.title(); } catch { /* ignore */ }
      try {
        body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 800));
      } catch { /* ignore */ }
      const blocked = this.#mark(page, title, body);
      if (!blocked && !/just a moment/i.test(title)) return { ok: true, title, body };
      await delay(WAIT_MS);
    }
    this.blocked = true;
    this.loading = false;
    return { ok: false, title: this.title, body: '' };
  }

  #mark(page, title, body = '') {
    this.title = title || this.title || '';
    if (body) this.lastBody = body.replace(/\s+/g, ' ').trim().slice(0, BODY_CHARS);
    try { this.currentUrl = page?.url?.() || this.currentUrl; } catch { /* ignore */ }
    const blocked = looksBlocked(title, body);
    const notFound = looksNotFound(title, body);
    this.blocked = blocked;
    this.notFound = notFound;
    if (notFound) {
      this.ready = false;
      this.lastError = 'page_not_found';
      if (!this.notFoundLogged) {
        log(`game: 404 / not found (${this.title || 'no title'}) — need Home or navigate`);
        this.notFoundLogged = true;
      }
    } else {
      this.notFoundLogged = false;
      if (this.lastError === 'page_not_found') this.lastError = null;
    }
    this.loading = !this.ready && !blocked && !notFound;
    return blocked;
  }

  async #tryEnterDemo(page) {
    // Best-effort: open a real game from the lobby. Only short, anchored game titles
    // count; long marketing copy and promo cards are skipped outright.
    const prefer = String(this.preferredGame || '').trim();
    if (prefer) {
      try {
        const hit = await this.clickText(prefer);
        if (hit?.ok) {
          log(`game: preferred "${prefer}"`);
          this.preferredGame = null;
          await delay(4000);
          return prefer;
        }
        const viaHref = await this.#clickGameHref(prefer);
        if (viaHref?.ok) {
          log(`game: preferred "${prefer}" via href`);
          this.preferredGame = null;
          await delay(4000);
          return prefer;
        }
        // Do NOT fall through to another Originals title (was stealing Dice → Blackjack).
        log(`game: preferred "${prefer}" not visible — stay put`);
        return null;
      } catch {
        log(`game: preferred "${prefer}" failed — stay put`);
        return null;
      }
    }
    try {
      const clicked = await page.evaluate(({ gameSrc, promo, max }) => {
        const GAME = new RegExp(gameSrc, 'i');
        const PROMO = new RegExp(promo, 'i');
        const SLUG = /dice|mines?|crash|limbo|plinko|blackjack|keno|wheel|hilo|tower/i;
        const nodes = [...document.querySelectorAll('a,button,[role="button"]')];
        const scored = [];
        for (const el of nodes) {
          if (el.offsetParent === null) continue;
          const inner = (el.innerText || '').replace(/\s+/g, ' ').trim();
          const aria = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
          const title = (el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
          const href = el.getAttribute('href') || '';
          const label = inner || aria || title;
          if (!label) continue;
          if (label.length > max) continue;
          if (PROMO.test(label)) continue;
          // Prefer a short visible title; aria/title can rescue a card with an icon label.
          const short = [inner, aria, title].some((t) => t && t.length <= 40 && GAME.test(t));
          if (!short) continue;
          const isAnchor = el.tagName.toLowerCase() === 'a';
          const slugHref = isAnchor && SLUG.test(href);
          scored.push({ el, label, score: (slugHref ? 3 : 0) + (isAnchor ? 1 : 0) });
        }
        if (!scored.length) return null;
        scored.sort((a, b) => b.score - a.score);
        scored[0].el.click();
        return scored[0].label.slice(0, 80);
      }, { gameSrc: GAME_TITLE.source, promo: PROMO_TEXT.source, max: MAX_LABEL });
      if (clicked) {
        log(`game: clicked "${clicked}"`);
        await delay(4000);
        return clicked;
      }
    } catch { /* ignore */ }
    return null;
  }

  // Best short, non-promo game label from a DOM snapshot — used by the policy rotation.
  // Agent self-heal: dismiss JS dialogs, bring Housebets to front, leave Kick/other tabs.
  async healFocus() {
    if (!this.page) return { ok: false, reason: 'no page' };
    const browser = this.page.browser?.() || null;
    try {
      this.page.once?.('dialog', async (d) => { try { await d.dismiss(); } catch { /* ignore */ } });
    } catch { /* ignore */ }
    try {
      if (browser) {
        for (const p of await browser.pages()) {
          const u = p.url() || '';
          if (/kick\.com/i.test(u) && p !== this.page) {
            // Do not close — chat reader needs it — just never leave it in front.
            continue;
          }
        }
        await this.page.bringToFront();
      } else {
        await this.page.bringToFront();
      }
    } catch (err) {
      return { ok: false, reason: err.message };
    }
    const url = this.page.url?.() || '';
    if (/kick\.com/i.test(url)) {
      try {
        await this.page.goto(this.url || 'https://www.housebets.com/casino', { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (err) {
        return { ok: false, reason: err.message };
      }
    }
    log('game: healFocus → Housebets front');
    return { ok: true, url: this.page.url?.() || '' };
  }

  pickPlayable(clickables) {
    const candidates = [];
    for (const c of Array.isArray(clickables) ? clickables : []) {
      const text = String(c?.text || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > SHORT_LABEL) continue;
      if (PROMO_TEXT.test(text)) continue;
      if (!GAME_TITLE.test(text)) continue;
      candidates.push({ text, anchor: c?.tag === 'a', y: Number(c?.y) || 0 });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => (b.anchor - a.anchor) || (a.y - b.y));
    return candidates[0].text;
  }

  // Open a named game via the same click path the agent already uses.
  async openGame(name) {
    const label = String(name || '').trim();
    if (!label) return { ok: false, error: 'empty game' };
    return this.clickText(label);
  }

  // Thin alias so the agent can express "click a control inside the game".
  async clickInGame(label) {
    return this.clickText(label);
  }

  // Mines free play: click one unrevealed grid tile. Tiles are usually empty buttons in
  // the open shadow root, so clickText (label-based) cannot find them. This walks every
  // root, rejects the cash-out/bet controls by label and size, and clicks a safe tile.
  // Never clicks Cash out — the caller only ever gets a tile candidate here.
  async clickMinesTile() {
    if (!this.page || this.page.isClosed?.()) return { ok: false, reason: 'no page' };
    try {
      const hit = await this.page.evaluate(() => {
        const deepAll = (sel, root = document, out = []) => {
          try { for (const n of root.querySelectorAll(sel)) out.push(n); } catch { /* bad selector */ }
          let all;
          try { all = root.querySelectorAll('*'); } catch { return out; }
          for (const el of all) if (el.shadowRoot) deepAll(sel, el.shadowRoot, out);
          return out;
        };
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          const st = window.getComputedStyle(el);
          return !(st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0');
        };
        if (!/mines|dragon-tower|hubie-s-road|tower/i.test(`${location.href} ${document.title}`)) {
          return { ok: false, reason: 'not mines' };
        }
        const mineTile = (el, r) => {
          const w = r.width, h = r.height;
          if (w < 18 || h < 18 || w > 180 || h > 180) return false;
          const ratio = w / h;
          if (ratio < 0.55 || ratio > 1.8) return false;
          if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
          const label = norm(`${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.value || ''}`);
          if (label.length > 24) return false;
          if (/cash\s*out|cashout|^bet$|^auto$|^manual$|^min$|^max$|^1\/2$|^2×$|^2x$/i.test(label)) return false;
          const meta = norm(`${el.className || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-state') || ''} ${el.getAttribute('data-status') || ''}`).toLowerCase();
          if (/opened|revealed|exploded|flagged|\bhit\b|\bsafe\b|disabled|cash/.test(meta)) return false;
          const marked = /cell|tile|mine|grid|square|spot/.test(meta);
          let inGrid = false;
          let p = el.parentElement;
          for (let i = 0; p && i < 3; i++, p = p.parentElement) {
            let kids = 0;
            try { kids = p.children?.length || 0; } catch { kids = 0; }
            let disp = '';
            try { disp = getComputedStyle(p).display || ''; } catch { disp = ''; }
            if (kids >= 9 && /grid|flex/.test(disp)) { inGrid = true; break; }
          }
          return marked || inGrid;
        };
        const nodes = deepAll('button,[role="button"],[class*="cell"],[class*="tile"],[class*="grid"]');
        const tiles = [];
        const seen = new Set();
        for (const el of nodes) {
          if (!isVisible(el)) continue;
          const r = el.getBoundingClientRect();
          if (!mineTile(el, r)) continue;
          const key = `${Math.round(r.x)},${Math.round(r.y)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          tiles.push({
            el,
            text: norm(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 24),
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
          });
        }
        if (!tiles.length) return { ok: false, reason: 'no tiles' };
        // Prefer tiles fully inside the viewport — edge cells (x>~1280) miss the capture/HUD.
        const vw = window.innerWidth || 1280;
        const vh = window.innerHeight || 720;
        const inside = tiles.filter((t) => t.x >= 8 && t.y >= 8 && t.x <= vw - 8 && t.y <= vh - 8);
        const pool = inside.length ? inside : tiles;
        const pick = pool[Math.floor(Math.random() * pool.length)];
        try { pick.el.click(); } catch { return { ok: false, reason: 'click failed' }; }
        return { ok: true, text: pick.text || 'tile', x: pick.x, y: pick.y, total: tiles.length, inView: inside.length };
      });
      if (!hit?.ok) {
        log(`game: mines tile skipped (${hit?.reason || 'no tiles'})`);
        return hit;
      }
      this.lastPointer = { x: hit.x, y: hit.y, text: hit.text || 'tile', at: Date.now() };
      log(`game: mines tile "${hit.text || 'tile'}" @ ${hit.x},${hit.y} (${hit.total} open)`);
      await delay(500);
      return hit;
    } catch (err) {
      this.lastError = err.message;
      log(`game: mines tile failed: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  }

  async readSettings() { return readSettings(this.page); }
  async setMultiplier(value) { return setSetting(this.page, 'multiplier', value); }
  async setWinChance(value) { return setSetting(this.page, 'winChance', value); }
  async setStake(value) { return setSetting(this.page, 'stake', value); }

  // Zero only. Never click a site-provided minimum: it may be a positive real stake.
  async ensureBetZero() {
    let zero;
    try {
      zero = demoStakeString();
    } catch (err) {
      this.lastError = err.message;
      log(`game: bet guard refused a stake (${err.message})`);
      return { ok: false, set: 0, error: 'bet guard' };
    }
    if (!this.page || this.page.isClosed?.()) return { ok: false, set: 0 };
    try {
      const result = await this.page.evaluate((zero) => {
        if (String(zero) !== '0') return { set: 0, refused: true };
        // Bet/amount inputs live inside the open <dice-game> shadow root, so query every
        // root recursively instead of only the light DOM.
        const deepAll = (sel, root = document, out = []) => {
          try { for (const n of root.querySelectorAll(sel)) out.push(n); } catch { /* bad selector */ }
          let all;
          try { all = root.querySelectorAll('*'); } catch { return out; }
          for (const el of all) if (el.shadowRoot) deepAll(sel, el.shadowRoot, out);
          return out;
        };
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          const st = window.getComputedStyle(el);
          return !(st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0');
        };
        const BET = /bet|amount|wager/i;

        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const rootOf = (el) => {
          try { const r = el.getRootNode?.(); return r?.querySelector ? r : document; } catch { return document; }
        };
        const setNative = (input, value) => {
          const proto = Object.getPrototypeOf(input);
          const desc = Object.getOwnPropertyDescriptor(proto, 'value')
            || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          if (desc?.set) desc.set.call(input, value);
          else input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        };
        const nearby = (el) => {
          const bits = [];
          const root = rootOf(el);
          const id = el.getAttribute('id');
          if (id && root.querySelector) {
            const lab = root.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lab) bits.push(lab.innerText);
          }
          const wrapped = el.closest?.('label');
          if (wrapped) bits.push(wrapped.innerText);
          let node = el.parentElement;
          for (let i = 0; i < 3 && node; i++, node = node.parentElement) bits.push(node.innerText || '');
          // A custom element's label often sits outside its shadow root.
          const host = root instanceof ShadowRoot ? root.host : null;
          if (host) {
            bits.push(host.getAttribute('aria-label') || '', host.getAttribute('title') || '', host.id || '', String(host.className || ''));
            const sib = host.previousElementSibling;
            if (sib) bits.push(sib.innerText || '');
          }
          return norm(bits.join(' '));
        };
        let set = 0;
        for (const el of deepAll('input')) {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (type !== 'number' && type !== 'text' && type !== 'tel') continue;
          if (el.disabled || el.readOnly) continue;
          if (!isVisible(el)) continue;
          const attrs = `${el.getAttribute('name') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('id') || ''}`;
          if (!BET.test(`${attrs} ${nearby(el)}`)) continue;
          if (String(el.value) === '0') continue;
          setNative(el, zero);
          set++;
        }

        return { set };
      }, zero);
      if (result?.refused) {
        log('game: bet guard refused a non-zero stake');
        return { ok: false, set: 0, error: 'bet guard' };
      }
      const set = Number(result?.set) || 0;
      if (set > 0) log(`game: bet forced to 0 (${set} field${set === 1 ? '' : 's'})`);
      // Keep the native zero setter above, then require an independent exact-field
      // write/readback. A UI minimum or a clamped/unknown value is never proof of zero.
      const verified = await zeroStake(this.page);
      const settings = await this.readSettings();
      const ok = verified?.ok === true && verified?.verified === true
        && verified.observed === 0 && settings?.ok === true && settings.stake === 0;
      return { ok, set, observed: settings?.stake ?? null, verified: ok, settings,
        ...(ok ? {} : { error: verified?.error || 'zero stake readback failed' }) };
    } catch (err) {
      this.lastError = err.message;
      return { ok: false, set: 0, error: err.message };
    }
  }

  // Chat tuning used to only click "target"/"multiplier" labels, which never rewrote the
  // value inside the input. Nudge a non-bet target field through a safe demo band instead,
  // using the same native setter + events as ensureBetZero. Housebets Limbo renders its
  // multiplier as type=text (or no type at all), so text/tel fields count when the label
  // names a target; chance fields (1–99) get their own 5–95 band.
  // Bet/amount/wager inputs are skipped outright: the stake must never go above 0.
  async nudgePayoutOrTarget() {
    if (!this.page || this.page.isClosed?.()) return { ok: false, set: 0, values: [] };
    try {
      const result = await this.page.evaluate(() => {
        const deepAll = (sel, root = document, out = []) => {
          try { for (const n of root.querySelectorAll(sel)) out.push(n); } catch { /* bad selector */ }
          let all;
          try { all = root.querySelectorAll('*'); } catch { return out; }
          for (const el of all) if (el.shadowRoot) deepAll(sel, el.shadowRoot, out);
          return out;
        };
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          const st = window.getComputedStyle(el);
          return !(st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0');
        };
        const BET = /bet|amount|wager|stake/i;
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const rootOf = (el) => {
          try { const r = el.getRootNode?.(); return r?.querySelector ? r : document; } catch { return document; }
        };
        const setNative = (input, value) => {
          const proto = Object.getPrototypeOf(input);
          const desc = Object.getOwnPropertyDescriptor(proto, 'value')
            || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          if (desc?.set) desc.set.call(input, value);
          else input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        };
        const nearby = (el) => {
          const bits = [];
          const root = rootOf(el);
          const id = el.getAttribute('id');
          if (id && root.querySelector) {
            const lab = root.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lab) bits.push(lab.innerText);
          }
          const wrapped = el.closest?.('label');
          if (wrapped) bits.push(wrapped.innerText);
          let node = el.parentElement;
          for (let i = 0; i < 3 && node; i++, node = node.parentElement) bits.push(node.innerText || '');
          const host = root instanceof ShadowRoot ? root.host : null;
          if (host) {
            bits.push(host.getAttribute('aria-label') || '', host.getAttribute('title') || '', host.id || '', String(host.className || ''));
            const sib = host.previousElementSibling;
            if (sib) bits.push(sib.innerText || '');
          }
          return norm(bits.join(' '));
        };
        const TARGET = /multiplier|target|payout|win\s*chance|difficulty/i;
        const CHANCE = /win\s*chance|chance|probability|difficulty/i;
        const parseNum = (v) => {
          const hit = String(v ?? '').replace(/,/g, '.').match(/-?\d+(?:\.\d+)?/);
          return hit ? Number(hit[0]) : NaN;
        };
        const changed = [];
        for (const el of deepAll('input')) {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (type !== 'number' && type !== 'text' && type !== 'tel') continue;
          if (el.disabled || el.readOnly) continue;
          if (!isVisible(el)) continue;
          const attrs = `${el.getAttribute('name') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('id') || ''}`;
          const labels = norm(`${attrs} ${nearby(el)}`);
          // No label means we cannot prove it is not the stake — leave it alone.
          if (!labels) continue;
          if (BET.test(labels)) continue;
          const chance = CHANCE.test(labels);
          // A plain text box is only safe to rewrite when its label names a target.
          if (type !== 'number' && !TARGET.test(labels)) continue;
          const raw = String(el.value ?? '').trim();
          const cur = parseNum(raw);
          // Numeric-looking free text only; never overwrite a non-numeric label/value.
          if (raw && !Number.isFinite(cur)) continue;
          const LO = chance ? 5 : 1.5;
          const HI = chance ? 95 : 5;
          const STEP = chance ? 5 : 0.5;
          const minAttr = parseNum(el.getAttribute('min'));
          const maxAttr = parseNum(el.getAttribute('max'));
          const lo = Number.isFinite(minAttr) ? Math.max(LO, Math.min(minAttr, HI)) : LO;
          const hi = Number.isFinite(maxAttr) ? Math.max(lo, Math.min(maxAttr, HI)) : HI;
          let next;
          if (!Number.isFinite(cur) || cur < lo || cur >= hi - 1e-9) next = lo;
          else next = Math.min(hi, cur + STEP);
          const value = String(Number(next.toFixed(2)));
          if (raw === value) continue;
          setNative(el, value);
          changed.push(value);
        }
        return { set: changed.length, values: changed };
      });
      const set = Number(result?.set) || 0;
      const values = Array.isArray(result?.values) ? result.values : [];
      if (set > 0) log(`game: tune nudge (${set} field${set === 1 ? '' : 's'}) → ${values.join(', ')}`);
      return { ok: true, set, values };
    } catch (err) {
      this.lastError = err.message;
      return { ok: false, set: 0, values: [], error: err.message };
    }
  }

  // Viewer asked for a target/multiplier/chance. Apply it only inside the demo band
  // and only on a field whose label is not the stake. Bet stays 0.
  async applyViewerTune({ kind = 'target', value } = {}) {
    const decision = safeTuneValue(kind, value);
    if (!decision.ok) return { ok: false, set: 0, reason: decision.reason || 'unsafe' };
    if (!this.page || this.page.isClosed?.()) return { ok: false, set: 0, reason: 'no-page' };
    try {
      const result = await this.page.evaluate((payload) => {
        const deepAll = (sel, root = document, out = []) => {
          try { for (const n of root.querySelectorAll(sel)) out.push(n); } catch { /* bad selector */ }
          let all;
          try { all = root.querySelectorAll('*'); } catch { return out; }
          for (const el of all) if (el.shadowRoot) deepAll(sel, el.shadowRoot, out);
          return out;
        };
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          const st = window.getComputedStyle(el);
          return !(st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0');
        };
        const BET = /bet|amount|wager|stake/i;
        const TARGET = /multiplier|target|payout|win\s*chance|difficulty/i;
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const setNative = (input, next) => {
          const proto = Object.getPrototypeOf(input);
          const desc = Object.getOwnPropertyDescriptor(proto, 'value')
            || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          if (desc?.set) desc.set.call(input, next);
          else input.value = next;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const nearby = (el) => {
          const bits = [];
          let node = el.parentElement;
          for (let i = 0; i < 3 && node; i++, node = node.parentElement) bits.push(node.innerText || '');
          return norm(bits.join(' '));
        };
        const want = String(payload.value);
        let set = 0;
        for (const el of deepAll('input')) {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (type !== 'number' && type !== 'text' && type !== 'tel') continue;
          if (el.disabled || el.readOnly || !isVisible(el)) continue;
          const attrs = `${el.getAttribute('name') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('id') || ''}`;
          const labels = norm(`${attrs} ${nearby(el)}`);
          if (!labels) continue;
          if (BET.test(labels)) continue;
          if (!TARGET.test(labels)) continue;
          if (String(el.value) === want) continue;
          setNative(el, want);
          set++;
          break;
        }
        return { set };
      }, { value: decision.value, kind });
      const set = Number(result?.set) || 0;
      if (set > 0) log(`game: tune set ${kind} → ${decision.value}`);
      return { ok: true, set, value: decision.value };
    } catch (err) {
      this.lastError = err.message;
      return { ok: false, set: 0, reason: err.message };
    }
  }

  async #launch() {
    if (this.stopped || this.launching) return;
    this.launching = true;
    this.ready = false;
    this.frame = null;
    this.loading = !!this.url;
    this.#clearUi();
    try {
      const browser = await getBrowser();
      if (!browser) {
        this.loading = false;
        this.lastError = 'no browser (set CHROME_PATH)';
        return;
      }
      // Desktop capture is independent of the page; start it once the headed browser is up.
      this.#startDesktop();
      // Reuse an open housebets tab. A restart used to open a NEW tab, which is exactly
      // what Cloudflare challenges — and the 120 s wait then relaunched into another new
      // tab, so a restart could loop on "Just a moment" while the stream showed the
      // stand-in. An existing tab already carries the clearance cookie.
      const open = (await browser.pages()).filter((p) => !p.isClosed?.() && /housebets\.com/i.test(p.url() || ''));
      const reuse = open[0] || null;
      if (reuse) {
        this.page = reuse;
        log(`game: reusing open tab (${reuse.url().slice(0, 60)})`);
        // One table tab only: leftovers burn CPU on a 4 vCPU box.
        for (const extra of open.slice(1)) await extra.close().catch(() => {});
      } else {
        this.page = await browser.newPage();
      }
      // 1280x697 is the table panel's own ratio (984:536), so the capture lands in the
      // panel with no crop and no letterbox bars.
      await this.page.setViewport({ width: 1280, height: 697 });
      this.viewport = { w: 1280, h: 697 };
      await this.page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      );
      if (!reuse) {
        await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        log(`game: ${this.url} loaded — waiting for Cloudflare/geo clear`);
      }
      const clear = await this.#waitClear(this.page, 120000);
      if (!clear.ok) {
        log('game: still blocked (CF/geo) — stand-in until clear; will retry');
        this.#recover();
        return;
      }
      log(`game: ${this.url} ready (${clear.title || await this.page.title()})`);
      this.lastError = null;
      await this.#snapshotLobby();
      const slug = gameSlugFromUrl(this.page.url());
      const wanted = Object.entries(GAME_CARD).find(([, name]) =>
        name.toLowerCase() === String(this.preferredGame || '').trim().toLowerCase())?.[0];
      if (!slug) {
        if (this.preferredGame) {
          const entered = await this.openGameByCard(this.preferredGame);
          if (entered?.ok) {
            await delay(1500);
            await this.ensureBetZero();
          }
        }
      } else if (wanted && wanted !== slug) {
        const entered = await this.openGameByCard(this.preferredGame);
        if (entered?.ok) {
          await delay(1500);
          await this.ensureBetZero();
        }
      }
      await this.#startScreencast(this.page);
      this.backoff = 5000;
    } catch (err) {
      this.lastError = err.message;
      log(`game: launch failed: ${err.message}`);
      this.#recover();
    } finally {
      this.launching = false;
    }
  }

  #startDesktop() {
    if (this.captureMode !== 'desktop' || this.desktop || this.desktopDead) return;
    if (process.platform !== 'win32') {
      this.#desktopFallback(`platform ${process.platform}`);
      return;
    }
    if (!this.headed) {
      this.#desktopFallback('HUBIE_HEADED=0');
      return;
    }
    const grab = new DesktopGrab({
      fps: 10,
      onFirstFrame: () => log('capture: mode=desktop (gdigrab)'),
      onFallback: (reason) => this.#desktopFallback(reason),
    });
    this.desktop = grab;
    grab.start();
  }

  #desktopFallback(reason) {
    if (this.desktopDead) return;
    this.desktopDead = true;
    const grab = this.desktop;
    this.desktop = null;
    try { grab?.stop(); } catch { /* already stopped */ }
    // The fallback used to only log: the object kept captureMode='desktop', which silenced
    // the capture pump and made every frame wait on a grabber that had already exited.
    this.captureMode = 'screencast';
    log(`capture: mode=screencast (desktop fallback: ${reason})`);
  }

  async #startScreencast(page) {
    if (this.screencasting) return;
    this.screencasting = true;
    try {
      const client = await page.createCDPSession();
      this.client = client;
      // A backgrounded/minimised tab stops emitting screencast frames. Asking for an
      // active lifecycle + focus emulation keeps the compositor working on an RDP box
      // where the window is often behind others.
      try { await page.bringToFront(); } catch { /* ignore */ }
      this.#startFrameWatchdog();
      // A cross-process navigation (lobby -> game table) kills the old renderer, and the
      // screencast goes silent after exactly one frame while the session still looks
      // alive. Re-arm it on every main-frame navigation.
      if (!this.navBound) {
        this.navBound = true;
        page.on('framenavigated', (frame) => {
          try { if (frame !== page.mainFrame()) return; } catch { return; }
          clearTimeout(this.navTimer);
          this.navTimer = setTimeout(() => this.#cycleScreencast(page), 1500);
        });
      }
      await client.send('Page.startScreencast', {
        format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 720,
        // The DOM report still needs the session; in desktop mode the pixels come from
        // gdigrab, so a slower screencast is enough and saves CPU on a small RDP box.
        everyNthFrame: this.captureMode === 'desktop' ? 3 : 1,
      });
      log(`game: screencast live (${this.captureMode})`);
      // A session can detach silently on a cross-process navigation; without this the
      // page keeps running while the overlay shows the stand-in panel.
      client.on('disconnected', () => {
        this.screencasting = false;
        this.client = null;
        log('game: screencast session detached — reattaching');
        if (!this.stopped) setTimeout(() => { if (this.page && !this.page.isClosed?.()) this.#startScreencast(this.page).catch(() => {}); }, 800);
      });

      // ACK FIRST. Chrome only sends the next frame after the ack, and this handler used
      // to await loadImage + page.title() + page.evaluate() before acking — on a heavy
      // casino page that is 100s of ms per frame, so the screencast starved to ~0 fps and
      // the overlay fell back to the demo panel. Now the ack is synchronous, DOM reads are
      // cached for a second, and frames are dropped while one is still decoding.
      client.on('Page.screencastFrame', (f) => {
        client.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
        if (this.frameInFlight) return;
        this.frameInFlight = true;
        this.#onScreencastFrame(page, f).catch(() => {}).finally(() => { this.frameInFlight = false; });
      });
      page.on('close', () => {
        this.screencasting = false;
        this.client = null;
        this.#recover();
      });
    } catch (err) {
      this.screencasting = false;
      this.lastError = err.message;
      log(`game: screencast failed: ${err.message}`);
    }
  }

  // Tear the session down and start a fresh one: cheaper and far more reliable than
  // waiting for a dead screencast to wake up after a navigation.
  async #cycleScreencast(page) {
    if (this.stopped || !page || page.isClosed?.()) return;
    if (this.cycleInFlight) return this.cycleInFlight;
    this.cycleInFlight = (async () => {
      const old = this.client;
      this.client = null;
      try { await old?.send('Page.stopScreencast'); } catch { /* gone */ }
      try { old?.disconnect?.(); } catch { /* gone */ }
      this.screencasting = false;
      this.firstFrameLogged = false;
      this.markAt = 0;
      await this.#startScreencast(page);
      log('game: screencast re-arm completed (pixels not yet verified)');
    })().finally(() => { this.cycleInFlight = null; });
    return this.cycleInFlight;
  }

  async waitForCapture({ after = Date.now(), timeoutMs = 8000, pollMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    do {
      if (this.stopped) return { ok: false, error: 'stopped' };
      if (this.lastFrameAt >= after && this.frameAgeMs >= 0 && this.frameAgeMs <= 2500
        && !isFrameBlack(this.frame) && !this.blocked) return { ok: true, via: 'verified-frame' };
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(pollMs, remaining));
    } while (Date.now() <= deadline);
    return { ok: false, error: 'no fresh healthy capture' };
  }

  reviveCapture({ timeoutMs = 8000 } = {}) {
    if (this.reviveInFlight) return this.reviveInFlight;
    this.reviveInFlight = (async () => {
      if (this.stopped) return { ok: false, error: 'stopped' };
      const page = this.page;
      if (!page || page.isClosed?.()) return { ok: false, error: 'no page' };
      const after = Date.now();
      await this.#cycleScreencast(page);
      try {
        // Originals render in shadow DOM, not an iframe. A 1px about:blank
        // frame is not a game: use a full page capture when no useful iframe exists.
        const buf = await this.#screenshotIframe(page) || await page.screenshot({ type: 'jpeg', quality: 55 });
        if (buf) {
          const img = await loadImage(buf);
          if (!isFrameBlack(img) && !this.blocked) {
            this.frame = img;
            this.lastFrameAt = Date.now();
            this.lastGoodAt = this.lastFrameAt;
            this.ready = true;
          }
        }
      } catch (err) { this.lastError = err.message; }
      return this.waitForCapture({ after, timeoutMs });
    })().finally(() => { this.reviveInFlight = null; });
    return this.reviveInFlight;
  }

  async #screenshotIframe(page) {
    if (!page || typeof page.frames !== 'function') return null;
    const frames = page.frames();
    const main = typeof page.mainFrame === 'function' ? page.mainFrame() : null;
    const rects = [];
    const handles = [];
    try {
      for (const f of frames) {
        if (f === main) continue;
        try {
          const el = await f.frameElement();
          if (!el) continue;
          handles.push(el);
          const box = await el.boundingBox();
          if (!box || box.width < 160 || box.height < 120) continue;
          rects.push({ element: el, width: box.width, height: box.height });
        } catch { /* detached or cross-origin */ }
      }
      const best = pickLargestRect(rects);
      if (!best?.element) return null;
      // Puppeteer 24 Frame has no screenshot(); ElementHandle does.
      return await best.element.screenshot({ type: 'jpeg', quality: 55 });
    } catch (err) {
      this.lastError = `iframe capture: ${err.message}`;
      return null;
    } finally {
      for (const el of handles) { try { await el.dispose?.(); } catch { /* detached */ } }
    }
  }

  async #onScreencastFrame(page, f) {
    try {
      if (!this.firstFrameLogged) { this.firstFrameLogged = true; log('game: first screencast frame'); }
      const img = await loadImage(Buffer.from(f.data, 'base64'));
      // Title/body only on a blocked check that is due: reading the DOM per frame was
      // the expensive half of the old handler.
      const now = Date.now();
      if (!this.markAt || now - this.markAt > 1000) {
        this.markAt = now;
        let title = '';
        let body = '';
        try { title = await page.title(); } catch { /* ignore */ }
        try { body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 400)); } catch { /* ignore */ }
        this.markCache = { title, body, blocked: this.#mark(page, title, body) };
        this.#refreshUi().catch(() => {});
      }
      const blocked = this.markCache?.blocked === true;
      this.lastFrameAt = Date.now();
      if (blocked) {
        // Hold the last real table for a while: a frozen table reads far better than the
        // "connecting" stand-in, and a CF challenge usually clears in seconds.
        // Hold a real table for up to five minutes of challenge: a frozen table plus the
        // "reconnecting" chip reads far better than the stand-in panel.
        if (!this.lastGoodAt || Date.now() - this.lastGoodAt > 300000) this.frame = null;
        this.ready = false;
        if (!this.blockedLogged) {
          log(`game: frame blocked (${this.markCache?.title || 'no title'}) — demo stand-in`);
          this.blockedLogged = true;
        }
      } else {
        this.frame = img;
        this.lastGoodAt = Date.now();
        this.ready = true;
        this.loading = false;
        this.lastError = null;
        this.blockedLogged = false;
      }
    } catch { /* skip bad frame */ }
  }

  // Capture pump. The CDP screencast is the cheap path, but on this box it goes silent
  // after a single frame on a cross-process navigation, so the pump screenshots the page
  // whenever no screencast frame has landed recently. Measured: page.screenshot() is
  // ~130 ms, so the pump tops out near 7 fps — enough for a table game, and it never
  // leaves the overlay on the demo panel.
  #startFrameWatchdog() {
    if (this.watchTimer) return;
    this.shotCount = 0;
    this.watchTimer = setInterval(() => { this.#captureTick().catch(() => {}); }, 120);
    this.watchTimer.unref?.();
  }

  get frameAgeMs() { return this.lastFrameAt ? Date.now() - this.lastFrameAt : -1; }

  async #captureTick() {
    const _t0 = process.hrtime.bigint();
    try { return await this.#captureTickInner(); }
    finally {
      this.tickTotal = (this.tickTotal || 0) + Number(process.hrtime.bigint() - _t0) / 1e6;
      this.tickN = (this.tickN || 0) + 1;
    }
  }

  takeTickStats() {
    const n = this.tickN || 0;
    const avg = n ? this.tickTotal / n : 0;
    this.tickN = 0; this.tickTotal = 0;
    return { n, avg: Math.round(avg) };
  }

  async #captureTickInner() {
    if (this.stopped) return;
    const page = this.page;
    if (!page || page.isClosed?.()) return;
    const now = Date.now();
    const age = now - this.lastFrameAt;
    const black = isFrameBlack(this.frame);
    // A live screencast of a black table still has age 0. Pump anyway and try the iframe.
    if (!shouldPumpCapture({ ageMs: age, black })) return;
    if (this.watchInFlight) return;
    this.watchInFlight = true;
    try {
      if (black) {
        if (!this.iframeAttemptAt || now - this.iframeAttemptAt > 1000) {
          this.iframeAttemptAt = now;
          const iframeBuf = await this.#screenshotIframe(page);
          if (iframeBuf) {
            const img = await loadImage(iframeBuf);
            if (!isFrameBlack(img)) {
              this.frame = img;
              this.lastGoodAt = Date.now();
              this.ready = true;
              this.loading = false;
              this.lastError = null;
              this.lastFrameAt = Date.now();
              if (!this.iframeLoggedAt || now - this.iframeLoggedAt > 60000) {
                this.iframeLoggedAt = now;
                log('game: iframe capture (main frame was black)');
              }
              return;
            }
          }
        }
        if (age < 700) return;
      }
      // Reuse the persistent CDP session: measured 44 ms vs 81 ms for page.screenshot,
      // which opens a temporary session every call.
      let buf;
      if (this.client) {
        const shot = await this.client.send('Page.captureScreenshot', { format: 'jpeg', quality: 55 });
        buf = Buffer.from(shot.data, 'base64');
      } else {
        buf = await page.screenshot({ type: 'jpeg', quality: 55 });
      }
      // Title/body reads cost ~1 s on this page; they only need to gate the pixels.
      if (!this.markAt || now - this.markAt > 3000) {
        this.markAt = now;
        let title = '';
        let body = '';
        try { title = await page.title(); } catch { /* ignore */ }
        try { body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 400)); } catch { /* ignore */ }
        this.markCache = { title, body, blocked: this.#mark(page, title, body) };
      }
      const blocked = this.markCache?.blocked === true;
      if (blocked) {
        this.frame = null;
        this.ready = false;
        if (!this.blockedLogged) {
          log(`game: frame blocked (${title || 'no title'}) — demo stand-in`);
          this.blockedLogged = true;
        }
        return;
      }
      this.frame = await loadImage(buf);
      this.lastGoodAt = Date.now();
      this.ready = true;
      this.loading = false;
      this.lastError = null;
      this.lastFrameAt = Date.now();
      this.shotCount = (this.shotCount || 0) + 1;
      if (!this.watchdogLoggedAt || now - this.watchdogLoggedAt > 60000) {
        this.watchdogLoggedAt = now;
        log(`game: pump capture (screencast silent ${Math.round(age / 1000)}s)`);
      }
    } catch (err) {
      this.lastError = err.message;
    } finally {
      this.watchInFlight = false;
    }
  }

  #recover() {
    if (this.stopped) return;
    this.ready = false;
    this.frame = null;
    this.loading = !!this.url;
    this.screencasting = false;
    clearTimeout(this.recoverTimer);
    log(`game: capture lost, relaunching in ${this.backoff} ms`);
    this.recoverTimer = setTimeout(() => {
      this.recoverTimer = null;
      this.#launch();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 120000);
  }

  // Agent actions: keep the same page where possible, then wait for the same clear gate.
  async reload() {
    if (this.stopped) return { ok: false, error: 'stopped' };
    if (!this.url) {
      log('game: reload skipped (no url)');
      return { ok: false, error: 'no url' };
    }
    clearTimeout(this.recoverTimer);
    this.recoverTimer = null;
    if (!this.page || this.page.isClosed?.()) {
      log('game: reload → relaunch');
      this.#launch();
      return { ok: true, relaunch: true };
    }
    try {
      const intendedSlug = gameSlugFromUrl(this.page.url());
      this.ready = false;
      this.frame = null;
      this.loading = true;
      this.blocked = false;
      this.#clearUi();
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      log('game: reloaded');
      const clear = await this.#waitClear(this.page, 60000);
      if (clear.ok) {
        this.lastError = null;
        // A table reload is not a request to pick a game from the lobby.
        // Only reopen the intended card if the reload actually lost the table.
        if (intendedSlug && !gameSlugFromUrl(this.page.url())) {
          const label = GAME_CARD[intendedSlug];
          if (label) await this.openGameByCard(label);
        }
        if (intendedSlug && gameSlugFromUrl(this.page.url()) !== intendedSlug) {
          this.currentUrl = this.page.url();
          this.lastError = 'reload did not preserve source table';
          return { ok: false, error: this.lastError, url: this.currentUrl };
        }
        await this.#startScreencast(this.page);
      } else {
        log('game: still blocked after reload');
      }
      this.currentUrl = this.page.url();
      return { ok: clear.ok, url: this.currentUrl };
    } catch (err) {
      this.lastError = err.message;
      log(`game: reload failed: ${err.message}`);
      this.#recover();
      return { ok: false, error: err.message };
    }
  }

  async #clickGameHref(name) {
    if (!this.page || this.page.isClosed?.()) return { ok: false, error: 'no page' };
    const slug = String(name || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!slug) return { ok: false, error: 'empty' };
    try {
      const hit = await this.page.evaluate((slug) => {
        const nodes = [...document.querySelectorAll('a[href]')];
        const scored = [];
        for (const el of nodes) {
          if (el.offsetParent === null) continue;
          const href = (el.getAttribute('href') || '').toLowerCase();
          if (!href.includes(slug)) continue;
          if (/meet|promo|blog|help|affiliate/i.test(href)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const label = ((el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()).slice(0, 80);
          let score = href.endsWith('/' + slug) || href.includes('/' + slug + '/') || href.includes('/' + slug + '?') ? 50 : 10;
          if (href.includes('original')) score += 20;
          scored.push({ el, text: label || href.slice(0, 60), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), score });
        }
        if (!scored.length) return null;
        scored.sort((a, b) => b.score - a.score);
        const best = scored[0];
        best.el.click();
        return { text: best.text, x: best.x, y: best.y };
      }, slug);
      if (!hit) return { ok: false, error: 'href not found' };
      this.lastPointer = { x: hit.x, y: hit.y, text: hit.text, at: Date.now() };
      log(`game: clicked href "${hit.text}" @ ${hit.x},${hit.y}`);
      await delay(1500);
      return { ok: true, ...hit };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async clickText(target) {
    if (!this.page || this.page.isClosed?.()) return { ok: false, error: 'no page' };
    const needle = String(target || '').trim();
    if (!needle) return { ok: false, error: 'empty target' };
    try {
      const hit = await this.page.evaluate(async (want) => {
        // Same deep walk as the UI snapshot: Bet/Roll/Manual etc. sit inside the open
        // <dice-game> shadow root and are invisible to document.querySelectorAll.
        const deepAll = (sel, root = document, out = []) => {
          try { for (const n of root.querySelectorAll(sel)) out.push(n); } catch { /* bad selector */ }
          let all;
          try { all = root.querySelectorAll('*'); } catch { return out; }
          for (const el of all) if (el.shadowRoot) deepAll(sel, el.shadowRoot, out);
          return out;
        };
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          const st = window.getComputedStyle(el);
          return !(st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0');
        };
        const q = want.toLowerCase().replace(/\s+/g, ' ').trim();
        const isEnabled = (el) => {
          for (let node = el; node; node = node.parentElement || node.getRootNode?.().host) {
            if (node.disabled || node.hasAttribute?.('disabled') || node.matches?.(':disabled')
              || String(node.getAttribute?.('aria-disabled')).toLowerCase() === 'true') return false;
          }
          return true;
        };
        const PROMO = /meet the house|made by|originals\b.*more|mini player|play .+ in the|in the mini/i;
        const CTA = /\b(play|open|start|launch|watch|join)\b/i;
        const nodes = deepAll('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]');
        const scored = [];
        for (const el of nodes) {
          if (!isVisible(el) || !isEnabled(el)) continue;
          const inner = (el.innerText || '').replace(/\s+/g, ' ').trim();
          const aria = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
          const title = (el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
          const href = el.getAttribute('href') || '';
          // Prefer short visible title over long aria (aria often is "Play Dice in the mini player").
          const parts = [inner, aria, title].filter(Boolean);
          const label = parts.sort((a, b) => a.length - b.length)[0] || '';
          if (!label) continue;
          if (label.length > 80 || PROMO.test(label)) continue;
          if (CTA.test(label) && label.toLowerCase() !== q) continue;
          const low = label.toLowerCase();
          const matches = (want, seen) => {
            const q = String(want || '').toLowerCase().replace(/\s+/g, ' ').trim();
            const text = String(seen || '').toLowerCase().replace(/\s+/g, ' ').trim();
            if (!q || !text) return false;
            if (text === q) return true;
            if (/\b(info|history|rules|fair|help|amount|halve|double|wallet)\b/.test(text)) return false;
            // The snapshot glues innerText and aria into one long label. The button is the short one.
            // Four letters is not enough: "Auto pick…" must not hit the Auto mode toggle.
            if (q.startsWith(text) && text.length >= 8 && !/^(manual|auto)$/.test(text)) return true;

            if (!text.startsWith(q)) return false;
            const rest = text.slice(q.length).trim();
            if (!rest) return true;
            if (/^(same|card|number|tile|lane|floor)\b/.test(rest)) return true;
            return /^(random pick|auto pick|skip|cash out|higher|lower)$/.test(q);
          };
          if (!matches(want, label)) continue;
          let score = low === q ? 100 : 80;
          if (q.startsWith(low) && low !== q) score = 40 + Math.min(low.length, 40);
          if (el.tagName.toLowerCase() === 'a') score += 5;
          if (href && href.toLowerCase().includes(q.replace(/\s+/g, ''))) score += 15;
          score += Math.max(0, 12 - label.length); // shorter title wins ties
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          scored.push({
            el,
            text: label.slice(0, 80),
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            score,
          });
        }
        if (!scored.length) return null;
        scored.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
        const best = scored[0];
        if (!isEnabled(best.el)) return null;
        // Actionability, the agent-browser rule: a click must fail loudly when the target is
        // covered, off-screen or moving, instead of reporting a success the table never saw.
        const raf = () => new Promise((done) => { requestAnimationFrame(() => setTimeout(done, 20)); });
        const hitsSelf = (x, y) => {
          const node = document.elementFromPoint(x, y);
          if (!node) return false;
          for (let n = node; n; n = n.parentElement || n.getRootNode?.().host) if (n === best.el) return true;
          for (let n = best.el; n; n = n.parentElement || n.getRootNode?.().host) if (n === node) return true;
          return false;
        };
        const freePoint = (rect) => {
          for (const py of [0.5, 0.3, 0.7]) {
            for (const px of [0.5, 0.3, 0.7]) {
              const x = Math.round(rect.x + rect.width * px);
              const y = Math.round(rect.y + rect.height * py);
              if (x < 1 || y < 1 || x > window.innerWidth - 1 || y > window.innerHeight - 1) continue;
              if (hitsSelf(x, y)) return { x, y };
            }
          }
          return null;
        };
        let rect = best.el.getBoundingClientRect();
        let point = freePoint(rect);
        if (!point) {
          // Below the fold (Blackjack and Plinko sit low in the lobby grid): bring it up first.
          try { best.el.scrollIntoView({ block: 'center', inline: 'center' }); } catch { /* detached */ }
          await raf();
          rect = best.el.getBoundingClientRect();
          point = freePoint(rect);
        }
        if (!point) {
          const cover = document.elementFromPoint(
            Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2));
          const coverLabel = cover
            ? String(cover.innerText || cover.getAttribute?.('aria-label') || cover.tagName || '')
              .replace(/\s+/g, ' ').trim().slice(0, 40)
            : '';
          return { blocked: coverLabel || 'another element' };
        }
        // A target that keeps drifting between frames would be clicked off-centre, so sample
        // it a few times instead of trusting one frame.
        const before = point;
        let stable = false;
        for (let i = 0; i < 3 && !stable; i++) {
          await raf();
          const now = freePoint(best.el.getBoundingClientRect());
          if (now && Math.abs(now.x - before.x) <= 4 && Math.abs(now.y - before.y) <= 4) stable = true;
        }
        if (!stable) return { blocked: 'moving target' };
        // A disabled native control (or overridden no-op click) may silently return.
        // Confirm delivery, not an invented game outcome; perception verifies that later.
        let dispatched = false;
        const onClick = () => { dispatched = true; };
        best.el.addEventListener('click', onClick, { capture: true, once: true });
        try { best.el.click(); }
        finally { best.el.removeEventListener('click', onClick, true); }
        if (!dispatched) return null;
        return { text: best.text, x: point.x, y: point.y };
      }, needle);
      if (hit?.blocked) {
        log(`game: click "${needle}" blocked by ${hit.blocked}`);
        return { ok: false, error: `blocked by ${hit.blocked}` };
      }
      if (!hit) {
        log(`game: click "${needle}" not found`);
        return { ok: false, error: 'not found' };
      }
      this.lastPointer = { x: hit.x, y: hit.y, text: hit.text, at: Date.now() };
      log(`game: clicked "${hit.text}" @ ${hit.x},${hit.y}`);
      await delay(200);
      return { ok: true, x: hit.x, y: hit.y, text: hit.text, clicked: hit.text };
    } catch (err) {
      this.lastError = err.message;
      log(`game: click failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }


  // Enter a table by clicking its lobby card. Returns { ok, slug } — ok means the URL is
  // now that table AND the page is not a Cloudflare challenge.
  async openGameByCard(name) {
    if (!this.page || this.page.isClosed?.()) return { ok: false, reason: 'no page' };
    const label = String(name || '').trim();
    if (!label) return { ok: false, reason: 'no name' };
    try {
      // Step 1: back to the lobby without a document load (SPA nav link).
      if (!/housebets\.com\/casino/i.test(this.page.url())) {
        const home = await this.page.evaluate(() => {
          const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
          const deep = (sel, root = document, out = []) => {
            try { for (const n of root.querySelectorAll(sel)) out.push(n); } catch { /* bad selector */ }
            let all; try { all = root.querySelectorAll('*'); } catch { return out; }
            for (const el of all) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
            return out;
          };
          for (const el of deep('a,button,[role="button"]')) {
            const t = norm(el.innerText || el.getAttribute('aria-label') || '');
            const href = el.getAttribute?.('href') || '';
            if (/^(casino|lobby|casino lobby)$/i.test(t) || /^\/casino\/?$/i.test(href)) { el.click(); return t || href; }
          }
          return null;
        }).catch(() => null);
        if (!home) {
          const target = 'https://www.housebets.com/casino';
          const allowed = assertAllowed(target);
          if (!allowed.ok) return { ok: false, reason: allowed.reason };
          await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await this.#waitClear(this.page, 120000);
        } else {
          await delay(1200);
        }
      }

      // Step 2: House Games shelf first — Hubie's Road sits there, not in the top grid.
      await this.page.evaluate(() => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const deep = (sel, root = document, out = []) => {
          try { for (const n of root.querySelectorAll(sel)) out.push(n); } catch { /* bad selector */ }
          let all; try { all = root.querySelectorAll('*'); } catch { return out; }
          for (const el of all) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
          return out;
        };
        for (const el of deep('a,button,[role="button"],span,div')) {
          const t = norm(el.innerText || el.getAttribute('aria-label') || '');
          if (/^house games$/i.test(t)) { el.click(); return t; }
        }
        return null;
      }).catch(() => null);
      await delay(800);

      // Step 3: clicking the card. Prefer a real anchor for this slug (the lobby renders
      // each House original as a link), then fall back to exact label matching, then to a
      // scrolled retry — Blackjack/Plinko sit lower in the grid and are not in view.
      const slugForName = Object.entries(GAME_CARD).find(([, n]) => n.toLowerCase() === label.toLowerCase())?.[0] || null;
      let hit = await this.page.evaluate((gameName, slug) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 20) return false;
          const st = getComputedStyle(el);
          return !(st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0');
        };
        const deep = (sel, root = document, out = []) => {
          try { for (const n of root.querySelectorAll(sel)) out.push(n); } catch { /* bad selector */ }
          let all; try { all = root.querySelectorAll('*'); } catch { return out; }
          for (const el of all) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
          return out;
        };
        if (slug) {
          const link = deep(`a[href*="housegames-${slug}"]`)[0];
          if (link) {
            const r = link.getBoundingClientRect();
            link.click();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), via: 'href' };
          }
        }
        const cands = [];
        for (const el of deep('div,span,a,button,p,img,[role="button"]')) {
          const label = norm(el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '');
          if (!label || label.length > 24) continue;
          if (label.toLowerCase() !== gameName.toLowerCase()) continue;
          if (!vis(el)) continue;
          const r = el.getBoundingClientRect();
          cands.push({ el, area: r.width * r.height, x: r.x + r.width / 2, y: r.y + r.height / 2 });
        }
        if (!cands.length) return null;
        cands.sort((a, b) => a.area - b.area);
        cands[0].el.click();
        return { x: Math.round(cands[0].x), y: Math.round(cands[0].y), via: 'label' };
      }, label, slugForName);

      if (!hit) {
        // Scroll the lobby a few times: Hubie's Road sits on the House Games shelf.
        let again = null;
        for (let s = 0; s < 4 && !again; s++) {
          await this.page.evaluate(() => window.scrollBy(0, 700)).catch(() => {});
          await delay(700);
          again = await this.page.evaluate((gameName, slug) => {
            const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim();
            const deep = (sel, root = document, out = []) => {
              try { for (const n of root.querySelectorAll(sel)) out.push(n); } catch { /* bad selector */ }
              let all; try { all = root.querySelectorAll('*'); } catch { return out; }
              for (const el of all) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
              return out;
            };
            if (slug) {
              const link = deep(`a[href*="housegames-${slug}"]`)[0];
              if (link) { link.click(); return { via: 'href-scrolled' }; }
            }
            for (const el of deep('div,span,a,button,p,img,[role="button"]')) {
              const label = norm(el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '');
              if (label.toLowerCase() !== gameName.toLowerCase()) continue;
              const r = el.getBoundingClientRect();
              if (r.width < 20 || r.height < 20) continue;
              el.click();
              return { via: 'label-scrolled' };
            }
            return null;
          }, label, slugForName).catch(() => null);
        }
        if (!again) return { ok: false, reason: `card "${label}" not found` };
        hit = again;
      }

      // Step 3: wait for the SPA route to land on a game page.
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        await delay(700);
        const slug = gameSlugFromUrl(this.page.url());
        if (slug && slug === slugForName) {
          this.currentUrl = this.page.url();
          this.lastPointer = { x: Number(hit?.x) || 0, y: Number(hit?.y) || 0, at: Date.now(), text: label };
          log(`game: card "${label}" → ${slug}`);
          return { ok: true, slug };
        }
      }
      return { ok: false, reason: 'no route change after click' };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  async navigate(target) {
    if (!this.page || this.page.isClosed?.()) return { ok: false, error: 'no page' };
    let dest;
    try {
      const base = this.currentUrl || this.url || 'https://www.housebets.com/';
      dest = new URL(String(target), base);
    } catch {
      return { ok: false, error: 'bad url' };
    }
    if (dest.protocol !== 'http:' && dest.protocol !== 'https:') {
      return { ok: false, error: 'protocol not allowed' };
    }
    let allowedHost = null;
    try { allowedHost = this.url ? new URL(this.url).host : null; } catch { /* no base url */ }
    if (allowedHost && dest.host !== allowedHost) {
      log(`game: navigate blocked (${dest.host} != ${allowedHost})`);
      return { ok: false, error: 'host not allowed' };
    }
    clearTimeout(this.recoverTimer);
    this.recoverTimer = null;
    // Preferred path: click the lobby card. A client-side route change never triggers the
    // Cloudflare challenge that a document load does, and it is ~10x faster.
    const slug = gameSlugFromUrl(dest.href);
    if (slug && /housebets\.com/i.test(this.page.url() || '') && !/just a moment/i.test(this.title || '')) {
      const card = GAME_CARD[slug] || null;
      if (card) {
        const viaCard = await this.openGameByCard(card);
        if (viaCard.ok) {
          this.ready = false;
          this.frame = null;
          this.loading = true;
          this.blocked = false;
          this.#clearUi();
          const cleared = await this.#waitClear(this.page, 60000);
          if (cleared.ok) {
            this.lastError = null;
            await this.#snapshotLobby().catch(() => {});
            await this.#startScreencast(this.page);
            this.currentUrl = this.page.url();
            return { ok: true, url: this.currentUrl, via: 'card' };
          }
          log(`game: card entry blocked (${cleared.title || 'no title'}) — falling back to goto`);
        } else {
          log(`game: card entry failed (${viaCard.reason}) — falling back to goto`);
        }
      }
    }
    try {
      this.ready = false;
      this.frame = null;
      this.loading = true;
      this.blocked = false;
      this.#clearUi();
      await this.page.goto(dest.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
      log(`game: navigated ${dest.href}`);
      // Cloudflare on this profile solves in 60-120 s on its own. Reloading inside that
      // window resets the challenge, so wait it out once, then try one reload, then the
      // lobby bounce. Measured: a navigation blocked at 06:10 cleared by 06:11:30 with no
      // reload at all.
      let clear = await this.#waitClear(this.page, 180000);
      if (!clear.ok) {
        log(`game: blocked after navigate (${clear.title || 'no title'}) — one reload`);
        try {
          await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch { /* reload raced a redirect */ }
        clear = await this.#waitClear(this.page, 120000);
      }
      if (!clear.ok) {
        try {
          log('game: blocked — lobby bounce then retry');
          await this.page.goto('https://www.housebets.com/casino', { waitUntil: 'domcontentloaded', timeout: 60000 });
          await delay(2500);
          await this.page.goto(dest.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
          clear = await this.#waitClear(this.page, 120000);
        } catch { /* keep the previous verdict */ }
      }
      if (!clear.ok) log(`game: still blocked on ${dest.href} after retries — stand-in stays`);
      if (clear.ok) {
        this.lastError = null;
        await this.#snapshotLobby();
        // Do NOT auto-click a game here: chat queue / agent policy picks the Originals table.
        // Auto-enter was stealing Dice requests by always opening Blackjack first.
        if (this.preferredGame) {
          const entered = await this.#tryEnterDemo(this.page);
          if (entered) {
            await delay(1500);
            await this.ensureBetZero();
          }
        }
        await this.#startScreencast(this.page);
      }
      this.currentUrl = this.page.url();
      return { ok: clear.ok, url: this.currentUrl };
    } catch (err) {
      this.lastError = err.message;
      log(`game: navigate failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  async stop() {
    clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.stopped = true;
    this.ready = false;
    this.loading = false;
    this.screencasting = false;
    clearTimeout(this.recoverTimer);
    this.recoverTimer = null;
    try { this.desktop?.stop(); } catch { /* already stopped */ }
    this.desktop = null;
    try { await this.page?.close(); } catch { /* already closed */ }
    this.page = null;
    this.client = null;
    this.screencastFrame = null;
  }
}
