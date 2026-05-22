'use strict';

const TERMINAL_STATES = new Set(['WIN', 'LOSS', 'INVALID', 'EXPIRED']);
const COUNTED_TERMINALS = new Set(['WIN', 'LOSS']);

function nowMs() {
  return Date.now();
}

function signalId(signal) {
  if (!signal || typeof signal !== 'object') return '';
  return String(signal.signalId || signal.id || signal._id || [signal.sym || signal.symbol || '', signal.side || '', signal.entry || ''].join('|'));
}

function isTerminalState(state) {
  return TERMINAL_STATES.has(String(state || '').toUpperCase());
}

function hasTerminal(signal) {
  if (!signal || typeof signal !== 'object') return false;
  return Boolean(
    signal.isClosed ||
    signal.terminalState ||
    signal.closedAt ||
    isTerminalState(signal.status) ||
    isTerminalState(signal.state)
  );
}

function getTerminalState(signal) {
  if (!signal || typeof signal !== 'object') return null;
  const candidates = [signal.terminalState, signal.status, signal.state];
  const found = candidates.map(c => String(c || '').toUpperCase()).filter(s => isTerminalState(s));
  // fix39/M-11: detect conflicting terminal states (e.g. status=WIN + terminalState=LOSS)
  // prefer terminalState as source of truth; log conflict for audit
  const unique = [...new Set(found)];
  if (unique.length > 1) {
    console.warn(`[stateMachine] conflicting terminal states on ${signal.sym || signal.id}: ${unique.join(' vs ')} — using ${found[0]}`);
  }
  return found[0] || null;
}

function pushHistory(signal, state, reason, at) {
  if (!signal.history) signal.history = [];
  const last = signal.history[signal.history.length - 1];
  if (last && last.state === state && last.reason === reason) return;
  signal.history.push({ at, state, reason });
}

function closeSignal(signal, terminalState, price, reason, options = {}) {
  if (!signal || typeof signal !== 'object') {
    return { changed: false, ignored: true, reason: 'missing_signal' };
  }
  const state = String(terminalState || '').toUpperCase();
  if (!isTerminalState(state)) {
    return { changed: false, ignored: true, reason: 'not_terminal_state' };
  }

  const existing = getTerminalState(signal);
  if (existing) {
    // First terminal result wins forever. Later price recovery must not rewrite truth.
    signal.status = existing;
    signal.terminalState = existing;
    signal.isClosed = true;
    return { changed: false, ignored: true, reason: 'already_terminal', terminalState: existing };
  }

  const at = options.at || options.now || nowMs();
  signal.status = state;
  signal.state = state;
  signal.terminalState = state;
  signal.terminalAt = signal.terminalAt || at;
  signal.closedAt = signal.closedAt || at;
  signal.updatedAt = at;
  signal.terminalPrice = price;
  signal.isClosed = true;
  signal.terminalReason = reason || state;
  signal.stateReason = reason || state;
  if (state === 'WIN') {
    signal.tp1Hit = signal.tp1Hit || options.winAt === 'TP1';
    signal.tp2Hit = signal.tp2Hit || options.winAt === 'TP2';
  }
  if (!signal.firstTerminalEventId) {
    signal.firstTerminalEventId = options.eventId || `${signalId(signal)}:${state}:${at}`;
  }
  pushHistory(signal, state, reason || state, at);
  return { changed: true, ignored: false, terminalState: state };
}

function hitFlags(signal, price, options = {}) {
  const side = String(signal.side || '').toUpperCase();
  const px = Number(price);
  const sl = Number(signal.sl);
  const winAt = String(options.winAt || process.env.ORAYAN_SIGNAL_WIN_AT || 'TP1').toUpperCase();
  const target = winAt === 'TP2' && signal.tp2 != null ? Number(signal.tp2) : Number(signal.tp1);
  if (!Number.isFinite(px) || !Number.isFinite(sl) || !Number.isFinite(target)) {
    return { slHit: false, tpHit: false, target, winAt };
  }
  if (side === 'BUY') {
    return { slHit: px <= sl, tpHit: px >= target, target, winAt };
  }
  if (side === 'SELL') {
    return { slHit: px >= sl, tpHit: px <= target, target, winAt };
  }
  return { slHit: false, tpHit: false, target, winAt };
}

function evaluateActiveOutcome(signal, price, options = {}) {
  if (!signal || hasTerminal(signal)) return null;
  const { slHit, tpHit, winAt } = hitFlags(signal, price, options);
  if (!slHit && !tpHit) return null;

  // A single price tick cannot prove the intrabar sequence if both TP and SL are crossed.
  // Conservative default: count the trade as LOSS unless explicitly configured otherwise.
  if (slHit && tpHit) {
    const tie = String(options.sameTickPolicy || process.env.ORAYAN_SAME_TICK_POLICY || 'LOSS').toUpperCase();
    return tie === 'WIN'
      ? { terminalState: 'WIN', reason: `${winAt} hit same tick as SL`, winAt }
      : { terminalState: 'LOSS', reason: 'SL hit same tick as target - conservative first-hit rule', winAt };
  }
  if (slHit) return { terminalState: 'LOSS', reason: 'SL hit', winAt };
  return { terminalState: 'WIN', reason: `${winAt} hit`, winAt };
}

function eventTerminalState(event) {
  if (!event) return null;
  const et = String(event.eventType || '').toUpperCase();
  if (et === 'STATE_WIN' || et === 'WIN') return 'WIN';
  if (et === 'STATE_LOSS' || et === 'LOSS') return 'LOSS';
  const st = String(event.terminalState || event.state || event.status || '').toUpperCase();
  return COUNTED_TERMINALS.has(st) ? st : null;
}

function sortByTimeAsc(a, b) {
  return Number(a.ts || a.terminalAt || a.closedAt || a.updatedAt || 0) - Number(b.ts || b.terminalAt || b.closedAt || b.updatedAt || 0);
}

function firstTerminalBySignal(events = []) {
  const out = new Map();
  for (const ev of [...events].sort(sortByTimeAsc)) {
    const terminal = eventTerminalState(ev);
    if (!terminal) continue;
    const id = signalId(ev);
    if (!id || out.has(id)) continue;
    out.set(id, { ...ev, terminalState: terminal });
  }
  return out;
}

function firstTerminalStats(events = []) {
  const first = firstTerminalBySignal(events);
  const rows = [...first.values()];
  const wins = rows.filter(r => r.terminalState === 'WIN').length;
  const losses = rows.filter(r => r.terminalState === 'LOSS').length;
  const closed = wins + losses;
  return {
    wins,
    losses,
    closed,
    hitRate: closed ? wins / closed * 100 : 0,
    firstTerminalRows: rows,
  };
}

function mergeSignalPreservingTerminal(existing, incoming) {
  if (!existing) return { ...incoming };
  if (!incoming) return { ...existing };

  const existingTerminal = getTerminalState(existing);
  if (existingTerminal) {
    return {
      ...existing,
      // Allow harmless metadata refreshes, but never overwrite terminal truth.
      lastSeenAt: incoming.updatedAt || incoming.ts || Date.now(),
      status: existingTerminal,
      state: existingTerminal,
      terminalState: existingTerminal,
      isClosed: true,
    };
  }

  const incomingTerminal = getTerminalState(incoming);
  const merged = { ...existing, ...incoming };
  if (incomingTerminal) {
    closeSignal(merged, incomingTerminal, incoming.terminalPrice || incoming.price, incoming.terminalReason || incoming.reason || incoming.note || incomingTerminal, {
      at: incoming.terminalAt || incoming.closedAt || incoming.updatedAt || incoming.ts || Date.now(),
      eventId: incoming.firstTerminalEventId,
    });
  }
  return merged;
}

module.exports = {
  TERMINAL_STATES,
  COUNTED_TERMINALS,
  signalId,
  isTerminalState,
  hasTerminal,
  getTerminalState,
  closeSignal,
  hitFlags,
  evaluateActiveOutcome,
  firstTerminalBySignal,
  firstTerminalStats,
  mergeSignalPreservingTerminal,
};
