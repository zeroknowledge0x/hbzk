// Safety filter: a streamed gambling bot must never promise outcomes, push deposits,
// ask for private data, insult people, or re-configure money settings mid-round.
// Patterns are deliberately blunt — a false block costs one spoken line, a false pass
// costs the channel.

const PROFIT_PROMISE = [
  /\bguarantee(?:d|s)?\b/,
  /\bsure\s*win\b/,
  /\bsure\s*profit\b/,
  /\bcan'?t\s+lose\b/,
  /\bnever\s+lose\b/,
  /\brisk[\s-]*free\b/,
  /\bfree\s+money\b/,
  /\beasy\s+money\b/,
  /\b100\s*%\s*(?:win|profit|menang)\b/,
  /\bauto\s+(?:profit|cuan|menang|win)\b/,
  /\bpasti\s+(?:menang|profit|untung|cuan|dapet)\b/,
  /\bdijamin\b/,
  /\bjamin(?:an)?\s+(?:menang|profit|untung)\b/,
  /\bgak\s+(?:mungkin|bakal)\s+(?:rugi|kalah)\b/,
];

const DEPOSIT_PUSH = [
  /\bdeposit\b/,
  /\bdepo\b/,
  /\btop\s*up\b/,
  /\bisi\s+saldo\b/,
  /\btambah\s+saldo\b/,
  /\bnaikin\s+(?:bet|taruhan|stake)\b/,
  /\b(?:bet|taruhan|stake)\s+lebih\s+besar\b/,
  /\bbet\s+more\b/,
  /\bbet\s+bigger\b/,
  /\bdouble\s+(?:your|ur)\s+bet\b/,
  /\ball[\s-]*in\b/,
  /\bgaspol\b/,
];

const PERSONAL_DATA = [
  /\b(?:nomor|no)\s*(?:hp|wa|telp|telepon|tlp|rekening|kartu)\b/,
  /\brekening\b/,
  /\bktp\b/,
  /\bnik\b/,
  /\bcvv\b/,
  /\botp\b/,
  /\bpassword\b/,
  /\bpin\s+(?:atm|kartu|kamu)\b/,
  /\b(?:credit|debit)\s+card\b/,
  /\bcard\s+number\b/,
  /\b(?:your|ur)\s+(?:address|phone|number|email|ktp|nik|password|otp)\b/,
  /\b(?:alamat|address)\s+(?:kamu|lengkap|rumah)\b/,
  /\b(?:kirim|kasih|share|send|drop)\s+(?:your\s+|yg\s+)?(?:ktp|nik|rekening|password|otp|pin|alamat|email)\b/,
  /\bwhats\s?app\s+(?:number|nomor)\b/,
];

// Minimal denylist of common English slurs and Indonesian insults. Kept short on
// purpose: every entry is a word the channel never wants spoken on stream.
const SLURS = [
  'nigger', 'nigga', 'faggot', 'retard', 'retarded', 'chink', 'spic', 'kike',
  'tranny', 'paki', 'gook', 'wetback',
  'anjing', 'bangsat', 'kontol', 'memek', 'goblok', 'tolol',
];

const SLUR_RE = new RegExp(`\\b(?:${SLURS.join('|')})\\b`);

export function checkLine(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'invalid line' };
  const line = text.trim();
  if (!line) return { ok: true };
  const low = line.toLowerCase();

  if (PROFIT_PROMISE.some((re) => re.test(low))) return { ok: false, reason: 'profit promise' };
  if (DEPOSIT_PUSH.some((re) => re.test(low))) return { ok: false, reason: 'deposit or bet-more push' };
  if (PERSONAL_DATA.some((re) => re.test(low))) return { ok: false, reason: 'personal data request' };
  if (SLUR_RE.test(low)) return { ok: false, reason: 'slur or insult' };

  return { ok: true };
}

const MONEY_KINDS = new Map([
  ['set_stake', 'stake'],
  ['set_multiplier', 'multiplier'],
  ['set_win_chance', 'win chance'],
]);

// A round that is live (or about to start) must not be re-configured underneath the
// game. 'unknown' is exempt on purpose: it is the pre-perception state, and refusing
// there would block the host's very first configure.
const LOCKED_PHASES = new Set(['playing', 'betting', 'result']);

function readPhase(world) {
  if (!world || typeof world !== 'object') return null;
  if (typeof world.phase === 'string') return world.phase;
  if (typeof world.get === 'function') {
    try {
      return world.get()?.phase ?? null;
    } catch {
      return null;
    }
  }
  if (typeof world.state?.phase === 'string') return world.state.phase;
  return null;
}

export function checkAction(intent, world) {
  if (!intent || typeof intent !== 'object') return { ok: true };
  const kind = String(intent.kind || '');
  const label = MONEY_KINDS.get(kind);
  if (!label) return { ok: true };

  const phase = readPhase(world);
  if (LOCKED_PHASES.has(phase)) return { ok: false, reason: `${label} change while ${phase}` };

  // Only validate when a value was supplied; a malformed intent is the router's job.
  const raw = intent.args?.value;
  if (raw === undefined) return { ok: true };
  const value = Number(raw);
  if (kind === 'set_stake') return value === 0 ? { ok: true } : { ok: false, reason: 'Demo stake is locked to zero' };
  if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: `invalid ${label}` };
  if (kind === 'set_win_chance' && value > 100) return { ok: false, reason: 'win chance above 100' };
  if (kind === 'set_multiplier' && value < 1) return { ok: false, reason: 'multiplier below 1' };

  return { ok: true };
}
