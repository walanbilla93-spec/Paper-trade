'use strict';
/**
 * lib/lifecycle.js — UNIFIED BRAIN: single-authority lifecycle decision core.
 *
 * PURE. No store I/O, no async, no side effects. Input → decision. Fully unit-testable.
 * Inert until the wiring step imports it under flag V4_UNIFIED_BRAIN. Deploying this file
 * alone changes NOTHING.
 *
 * WHY THIS EXISTS (the disease it cures):
 *   The old brain ran a paper state machine on the scanner SNAPSHOT in parallel with the
 *   reconciler's Bybit-truth machine, stitched by an async tradeId hand-off that RACED the
 *   scan loop. In the gap a scan tick saw no tradeId, ran paper revalidation, and ABANDONED
 *   real positions (BTW → STALE while Bybit ran it to SL). Journal P&L read the paper store,
 *   so a real −0.22 loss showed as 0.
 *
 * THE FIX — one authority per signal, decided by whether a real order exists:
 *   - authority PAPER  : signal never touched the exchange → snapshot may drive it (no real $).
 *   - authority BYBIT  : an order was CLAIMED/placed → ONLY the reconciled trade record drives
 *                        state. The snapshot is ignored entirely. Cannot abandon a live position.
 *
 *   The race dies by construction: ownership is claimed SYNCHRONOUSLY at placement-attempt
 *   (signal.orderClaimAt = now, set before any await). From that instant authorityOf()===BYBIT,
 *   so no concurrent/later scan tick's paper logic can touch the signal. tradeId arriving later
 *   is just metadata that links to the trade record — it is no longer the authority gate.
 *
 *   Under uncertainty: FREEZE + alarm, never abandon. The exchange-side stop protects capital.
 */

// ---- helpers (self-contained; no external deps so the core stays pure & portable) ----
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function up(v) { return String(v == null ? '' : v).toUpperCase(); }

// ---- unified state set (replaces the old dual ACTIVE_STATES / FINAL_STATES split) ----
const STATES = Object.freeze({
  CANDIDATE:        'CANDIDATE',        // generated, no order — paper authority, awaiting entry
  PAPER_ACTIVE:     'PAPER_ACTIVE',     // paper fill (snapshot) — pure-paper only, no real order
  PAPER_EXPIRED:    'PAPER_EXPIRED',    // terminal, never had an order
  PAPER_INVALID:    'PAPER_INVALIDATED',// terminal, never had an order (structure broke pre-entry)
  LIVE_PENDING:     'LIVE_PENDING',     // ownership claimed, trade record not yet confirmed (grace)
  LIVE_RESTING:     'LIVE_RESTING',     // order confirmed resting on Bybit, unfilled
  LIVE_OPEN:        'LIVE_OPEN',        // position open on Bybit (locked; snapshot cannot close it)
  CLOSED_WIN:       'CLOSED_WIN',       // position closed, real closedPnl >= 0 (terminal)
  CLOSED_LOSS:      'CLOSED_LOSS',      // position closed, real closedPnl < 0 (terminal)
  CANCELLED:        'CANCELLED',        // order cancelled/rejected, no position taken (terminal)
  FROZEN:           'FROZEN',           // authority ambiguous → action suspended + alarm (NOT terminal)
});

const TERMINAL = Object.freeze(new Set([
  STATES.PAPER_EXPIRED, STATES.PAPER_INVALID, STATES.CLOSED_WIN, STATES.CLOSED_LOSS, STATES.CANCELLED,
]));

const DEFAULTS = Object.freeze({
  claimGraceMs: 90 * 1000, // how long a claimed signal may sit without a trade record before FREEZE
});

/**
 * authorityOf(signal) — the single ownership predicate.
 * The instant ANY of these exist, the exchange owns the signal's fate.
 *   orderClaimAt : set SYNCHRONOUSLY at placement-attempt (closes the race)
 *   tradeId / orderId : set later by the placement callback (metadata)
 */
function authorityOf(signal) {
  if (!signal) return 'PAPER';
  return (signal.orderClaimAt || signal.tradeId || signal.orderId) ? 'BYBIT' : 'PAPER';
}

/**
 * decide(signal, trade, snapPrice, now, opts) → { state, authority, pnl, terminal, locked, alarm, action }
 *   signal    : the signal row
 *   trade     : the reconciled trade record (trades[signal.tradeId]) or null/undefined
 *   snapPrice : scanner snapshot price (ONLY consulted under PAPER authority)
 *   now       : Date.now()
 *   opts      : { claimGraceMs }
 */
function decide(signal, trade, snapPrice, now, opts = {}) {
  const authority = authorityOf(signal);
  return authority === 'BYBIT'
    ? decideBybit(signal, trade, now, { ...DEFAULTS, ...opts })
    : decidePaper(signal, snapPrice, now, { ...DEFAULTS, ...opts });
}

// ---- BYBIT authority: ONLY the reconciled trade record may move state. Snapshot ignored. ----
function decideBybit(signal, trade, now, opts) {
  const base = { authority: 'BYBIT', locked: true };

  if (!trade) {
    // Claimed an order but the reconciler hasn't produced a record yet.
    const claimedAt = num(signal.orderClaimAt, now);
    if (now - claimedAt > opts.claimGraceMs) {
      // Past grace with no record → do NOT abandon; freeze + alarm. (old brain went STALE here)
      return { ...base, state: STATES.FROZEN, pnl: null, terminal: false,
               alarm: 'CLAIM_NO_TRADE_RECORD', action: 'ALARM' };
    }
    return { ...base, state: STATES.LIVE_PENDING, pnl: null, terminal: false, action: 'HOLD' };
  }

  const st = up(trade.status);
  const pos = up(trade.positionStatus);

  if (pos === 'OPEN' || st === 'POSITION_OPEN' || st.includes('PARTIALLY_FILLED')) {
    return { ...base, state: STATES.LIVE_OPEN, pnl: num(trade.unrealisedPnl, null), terminal: false, action: 'LOCK' };
  }
  if (st === 'POSITION_CLOSED' || pos === 'CLOSED') {
    const p = num(trade.closedPnl, 0);
    return { ...base, state: p >= 0 ? STATES.CLOSED_WIN : STATES.CLOSED_LOSS,
             pnl: p, exitPx: num(trade.avgExitPrice, null) || null, terminal: true, action: 'CLOSE' };
  }
  if (st.includes('CANCELLED') || st.includes('REJECTED') || st.includes('DEACTIVATED')) {
    return { ...base, state: STATES.CANCELLED, pnl: 0, terminal: true, action: 'CLOSE' };
  }
  if (st === 'ORDER_PENDING_FILL' || st === 'PENDING' || st === 'NEW' || st === 'ORDER_SUBMITTED' || st === 'UNTRIGGERED') {
    return { ...base, state: STATES.LIVE_RESTING, pnl: null, terminal: false, action: 'HOLD' };
  }
  // Unknown/garbled status → never guess. Freeze + alarm.
  return { ...base, state: STATES.FROZEN, pnl: null, terminal: false,
           alarm: 'UNKNOWN_TRADE_STATUS:' + st, action: 'ALARM' };
}

// ---- PAPER authority: never-ordered signal. Snapshot may drive it (no real money at risk). ----
function decidePaper(signal, snapPrice, now, opts) {
  const base = { authority: 'PAPER', locked: false, terminal: false };
  const side = up(signal.side);
  const entry = num(signal.entry);
  const sl = num(signal.sl);
  const tp = num(signal.tp1);
  const price = num(snapPrice, null);
  const cur = up(signal.paperState);

  // Already resolved terminally in paper — keep it.
  if (cur === STATES.PAPER_EXPIRED) return { ...base, state: STATES.PAPER_EXPIRED, pnl: num(signal.pnl), terminal: true };
  if (cur === STATES.PAPER_INVALID) return { ...base, state: STATES.PAPER_INVALID, pnl: num(signal.pnl), terminal: true };
  if (cur === STATES.CLOSED_WIN || cur === STATES.CLOSED_LOSS)
    return { ...base, state: cur, pnl: num(signal.pnl), terminal: true };

  // Pre-fill structure break → invalidate (no fill, no loss taken).
  if (price != null && (cur === STATES.CANDIDATE || cur === '' || cur === 'WAITING_ENTRY' || cur === 'WAITING_REACTION')) {
    if (side === 'BUY' && price <= sl) return { ...base, state: STATES.PAPER_INVALID, pnl: 0, terminal: true, action: 'INVALIDATE' };
    if (side === 'SELL' && price >= sl) return { ...base, state: STATES.PAPER_INVALID, pnl: 0, terminal: true, action: 'INVALIDATE' };
  }

  const active = cur === STATES.PAPER_ACTIVE || signal.entryHit === true;

  // Paper fill detection.
  if (!active && price != null) {
    const hitEntry = side === 'BUY' ? price <= entry : price >= entry;
    if (hitEntry) return { ...base, state: STATES.PAPER_ACTIVE, pnl: null, action: 'PAPER_FILL' };
    return { ...base, state: STATES.CANDIDATE, pnl: null, action: 'WAIT' };
  }

  // Paper TP/SL resolution.
  if (active && price != null) {
    if (side === 'BUY') {
      if (price >= tp) return { ...base, state: STATES.CLOSED_WIN, pnl: paperPnl(signal, tp), terminal: true, action: 'CLOSE' };
      if (price <= sl) return { ...base, state: STATES.CLOSED_LOSS, pnl: paperPnl(signal, sl), terminal: true, action: 'CLOSE' };
    } else {
      if (price <= tp) return { ...base, state: STATES.CLOSED_WIN, pnl: paperPnl(signal, tp), terminal: true, action: 'CLOSE' };
      if (price >= sl) return { ...base, state: STATES.CLOSED_LOSS, pnl: paperPnl(signal, sl), terminal: true, action: 'CLOSE' };
    }
    return { ...base, state: STATES.PAPER_ACTIVE, pnl: null, action: 'HOLD' };
  }

  // No price → cannot adjudicate; hold current (never abandon on missing data).
  return { ...base, state: cur || STATES.CANDIDATE, pnl: null, action: 'WAIT' };
}

// Paper-only nominal PnL (per-unit * qty proxy). Real PnL ALWAYS comes from the trade record.
function paperPnl(signal, exitPx) {
  const entry = num(signal.entry), qty = num(signal.qty, 1);
  const dir = up(signal.side) === 'BUY' ? 1 : -1;
  return Number(((exitPx - entry) * dir * qty).toFixed(8));
}

/**
 * realizedPnl(signal, trade) — single P&L source of truth.
 * Order-bearing signal → reconciled real closedPnl. Pure-paper → paper estimate. Never both.
 */
function realizedPnl(signal, trade) {
  if (authorityOf(signal) === 'BYBIT') {
    if (trade && (up(trade.status) === 'POSITION_CLOSED' || up(trade.positionStatus) === 'CLOSED')) {
      return num(trade.closedPnl, 0);
    }
    return null; // open/pending/frozen → not yet realized
  }
  // pure paper, only if terminally resolved
  const cur = up(signal.paperState);
  if (cur === STATES.CLOSED_WIN || cur === STATES.CLOSED_LOSS) return num(signal.pnl, 0);
  return null;
}

module.exports = { STATES, TERMINAL, DEFAULTS, authorityOf, decide, decideBybit, decidePaper, realizedPnl, paperPnl };
