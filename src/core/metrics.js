// Engagement metrics.
//
// "20 points for talking with chat" is only improvable if the run can answer: how many
// messages came in, how many got an answer, how fast, and which questions were ignored. The
// counters are plain numbers so a restart can carry them from disk.

export function createMetrics(patch = {}) {
  return {
    messages: 0,
    replies: 0,
    scams: 0,
    unanswered: [],
    latenciesMs: [],
    firstAt: null,
    lastAt: null,
    ...patch,
  };
}

export function noteMessage(m, { text = '', verdict = 'ok', at = Date.now() } = {}) {
  const next = { ...m };
  next.messages = m.messages + 1;
  next.lastAt = at;
  next.firstAt = m.firstAt ?? at;
  if (verdict !== 'ok') next.scams = m.scams + 1;
  if (verdict === 'ok') next.pendingAt = at;
  if (text) {
    next.lastQuestion = String(text).replace(/\s+/g, ' ').trim().slice(0, 160);
    next.lastQuestionAt = at;
  }
  return next;
}

export function noteReply(m, at = Date.now()) {
  const next = { ...m, replies: m.replies + 1 };
  if (m.pendingAt) {
    next.latenciesMs = [...m.latenciesMs, Math.max(0, at - m.pendingAt)].slice(-200);
    next.pendingAt = null;
  }
  return next;
}

export function noteUnanswered(m, { text = '', why = '', at = Date.now() } = {}) {
  const entry = { text: String(text).replace(/\s+/g, ' ').trim().slice(0, 160), why: String(why).slice(0, 60), at };
  return { ...m, unanswered: [...m.unanswered, entry].slice(-50) };
}

export function median(values = []) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2);
}

export function snapshot(m, now = Date.now()) {
  const answered = m.replies;
  // A reply is sometimes made with no inbound message behind it (a greeting, an owner line), so
  // replies can exceed messages. A rate above 100% is a split counter, not a score: report it as
  // unknown rather than printing a number nobody can act on.
  const split = answered > m.messages;
  return {
    messages: m.messages,
    replies: answered,
    scams: m.scams,
    split,
    replyRate: m.messages > 0 && !split ? Number((answered / m.messages).toFixed(3)) : null,
    latencyMs: median(m.latenciesMs),
    unanswered: m.unanswered.length,
    minutes: m.firstAt ? Math.round((now - m.firstAt) / 60_000) : 0,
  };
}

export function metricsLine(m, now = Date.now()) {
  const s = snapshot(m, now);
  const rate = s.replyRate !== null
    ? `${Math.round(s.replyRate * 100)}%`
    : (s.split ? 'counters split' : '—');
  const lat = s.latencyMs === null ? '—' : `${(s.latencyMs / 1000).toFixed(1)}s`;
  return `CHAT ${s.messages} in · ${s.replies} answered (${rate}) · ${lat} · ${s.unanswered} missed`;
}
