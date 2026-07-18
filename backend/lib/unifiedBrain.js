'use strict';
/**
 * lib/unifiedBrain.js — integration layer for the single-authority lifecycle core.
 *
 * Wires lib/lifecycle.js into the running system, gated by env V4_UNIFIED_BRAIN.
 * Flag OFF (default) → every export is unused by the old brain; deploying changes NOTHING.
 *
 * Closes the BTW race with NO fragile placement-site edits, via findTradeForSignal():
 *   The executor writes trades[tradeId] = { signalId, ... } SYNCHRONOUSLY after the Bybit POST,
 *   BEFORE the async .then() that links signal.tradeId. So even in the race window (order live,
 *   s.tradeId not yet written) the real trade record already exists keyed by signalId. We resolve
 *   it by tradeId → signalId → deterministic orderLinkId, hand it to the lifecycle core, and the
 *   signal is driven by Bybit truth from the very first tick — never abandoned by snapshot logic.
 */

const L = require('./lifecycle');

function flagEnabled() {
  return String(process.env.V4_UNIFIED_BRAIN || '').toLowerCase() === 'true';
}

// deterministic orderLinkId rule — mirrors executor.buildOrderLinkId (kept in sync intentionally)
function orderLinkIdFor(signalId) {
  return ('orayan_' + String(signalId)).replace(/[^a-zA-Z0-9_-]/g, '').slice(-36);
}

/**
 * findTradeForSignal(signal, tradesById) → trade record | null
 * Resolution order: explicit tradeId → signalId match → deterministic orderLinkId match.
 * The signalId path is what closes the race (record exists before s.tradeId is written).
 */
function findTradeForSignal(signal, tradesById) {
  if (!signal || !tradesById) return null;
  if (signal.tradeId && tradesById[signal.tradeId]) return tradesById[signal.tradeId];
  const sid = signal.id;
  const oli = sid ? orderLinkIdFor(sid) : null;
  let best = null;
  for (const k in tradesById) {
    const t = tradesById[k];
    if (!t) continue;
    if (sid && t.signalId === sid) return t;                 // strongest, race-closing match
    if (oli && t.orderLinkId === oli) best = best || t;      // fallback by deterministic id
  }
  return best;
}

// synchronous ownership claim — stamps the freeze-clock start the first time a signal is order-bearing
function claimLiveOwnership(signal, now = Date.now()) {
  if (signal && !signal.orderClaimAt) signal.orderClaimAt = now;
  return signal;
}

// serialized async read-modify-write — eliminates the lost-update race across the 14 signal writers
let _chain = Promise.resolve();
function runExclusive(fn) {
  const run = _chain.then(() => fn());
  _chain = run.then(() => {}, () => {}); // never let one failure wedge the queue
  return run;
}

// apply a lifecycle decision onto a signal row (single place that mutates lifecycle fields)
function applyDecision(signal, decision) {
  if (!signal || !decision) return signal;
  signal.paperState = decision.state;
  signal.displayState = decision.state;
  signal.authority = decision.authority;
  signal.locked = !!decision.locked;
  if (decision.alarm) signal.frozenAlarm = decision.alarm; else delete signal.frozenAlarm;
  if (decision.terminal && !signal.closedAt) signal.closedAt = Date.now();
  // fixABANDON: keep the two authority paths in agreement. v4Brain's reclaimableFinal() uses
  // liveResolved to know Bybit has spoken and the signal must stop being reclaimed. unifiedTick runs
  // BEFORE liveStateAuthority and short-circuits it, so if only the legacy path stamped this flag,
  // a unified-brain close would loop through the reclaim pass forever.
  if (decision.terminal && decision.authority === 'BYBIT') signal.liveResolved = true;
  // A live position that was wrongly killed pre-fill by paper carries a bogus closedAt. It is OPEN.
  if (!decision.terminal && decision.authority === 'BYBIT' && signal.closedAt) signal.closedAt = null;
  if (decision.pnl != null) {
    signal.pnl = decision.pnl;
    signal.realizedPnl = decision.pnl; // fixUB1: legacy ledger/journal/divergence-detector read
                                        // realizedPnl, not pnl — without this, real Bybit P&L
                                        // silently falls back to the planned TP/SL estimate.
  }
  if (decision.exitPx != null) signal.exitPx = decision.exitPx; // fixUB1: display + downstream
                                                                  // MFE/MAE analysis need real exit
  // Legacy-compat: let the EXISTING journal/ledger (which keys on status WIN/LOSS) count these
  // unified closes with their REAL reconciled pnl — no change needed to computeLedgerSummary.
  if (decision.state === L.STATES.CLOSED_WIN) { signal.status = 'WIN'; signal.result = 'WIN'; }
  else if (decision.state === L.STATES.CLOSED_LOSS) { signal.status = 'LOSS'; signal.result = 'LOSS'; }
  // fixREASON: refresh stateReason on terminal transitions. Without this, the last waiting-phase
  // text (e.g. "WAITING_REACTION ...") survived onto closed rows (observed on the DEXE WIN 07/18) —
  // cosmetic, but a ledger row whose reason contradicts its state erodes trust in every other field.
  if (decision.state === L.STATES.CLOSED_WIN || decision.state === L.STATES.CLOSED_LOSS) {
    const _p = decision.pnl;
    signal.stateReason = `unified: Bybit position CLOSED, real P&L ${_p != null ? (_p >= 0 ? '+' : '') + _p : 'n/a'}`;
  } else if (decision.state === L.STATES.CANCELLED) {
    signal.stateReason = 'unified: Bybit order cancelled/rejected — no position taken';
  }
  signal.updatedAt = Date.now();
  return signal;
}

// unified journal summary — REAL reconciled P&L for any order-bearing signal; paper only for never-ordered
function reconciledSummary(signals, tradesById) {
  const rows = (signals || []).map(s => {
    const trade = findTradeForSignal(s, tradesById || {});
    return { state: s && s.paperState, pnl: L.realizedPnl(s, trade), authority: L.authorityOf(s) };
  });
  const closed = rows.filter(r => r.pnl != null);
  const wins = closed.filter(r => r.pnl > 0);
  const losses = closed.filter(r => r.pnl < 0);
  const net = closed.reduce((a, r) => a + r.pnl, 0);
  const gW = wins.reduce((a, r) => a + r.pnl, 0);
  const gL = Math.abs(losses.reduce((a, r) => a + r.pnl, 0));
  return {
    source: 'unified_reconciled',
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
    netPnl: Number(net.toFixed(8)),
    profitFactor: gL > 0 ? Number((gW / gL).toFixed(3)) : (gW > 0 ? 999 : 0),
    expectancy: closed.length ? Number((net / closed.length).toFixed(6)) : 0,
    open: rows.filter(r => r.pnl == null && [L.STATES.LIVE_OPEN, L.STATES.LIVE_RESTING, L.STATES.LIVE_PENDING].includes(r.state)).length,
    frozen: rows.filter(r => r.state === L.STATES.FROZEN).length,
  };
}

/**
 * unifiedTick(signal, tradesById, snapPrice, now) — the one call the wiring makes per signal.
 * Returns { handled, decision }. handled=true means Bybit authority took it; caller must skip
 * ALL paper logic for this signal. handled=false → genuinely never-ordered → run paper path.
 */
function unifiedTick(signal, tradesById, snapPrice, now = Date.now()) {
  const trade = findTradeForSignal(signal, tradesById || {});
  const orderBearing = !!(signal && (signal.tradeId || signal.orderId || signal.orderClaimAt || trade));
  if (!orderBearing) return { handled: false, decision: null };
  if (trade && !signal.tradeId) signal.tradeId = trade.id;     // late-link
  claimLiveOwnership(signal, now);                              // start freeze-clock
  const decision = L.decide(signal, trade, snapPrice, now, {});
  applyDecision(signal, decision);
  return { handled: true, decision };
}

module.exports = {
  flagEnabled, orderLinkIdFor, findTradeForSignal, claimLiveOwnership,
  runExclusive, applyDecision, reconciledSummary, unifiedTick,
};
