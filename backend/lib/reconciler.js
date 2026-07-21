'use strict';

const store = require('./store');
const { bybitGet, bybitPost, keySet } = require('./bybit');
const { getSettings } = require('./config');
const { addLog } = require('./tradeLog');
const { setTradingStopSafe } = require('./executor');
const { toNum } = require('./math');

// fix44b: cancel a pending Bybit order safely
// fix49h: returns a structured result instead of a bare boolean. retCode 110001 ("order not
// exists or too late to cancel") can mean ALREADY CANCELLED *or* ALREADY FILLED — callers must
// not blindly mark the trade CANCELLED on 110001, because masking a same-tick fill would orphan
// a real position from its trade record. deriveStatus on the next cycle resolves the truth.
async function cancelBybitOrder(symbol, orderId) {
  if (!orderId) return { ok: false, retCode: null, alreadyGone: false };
  try {
    const data = await bybitPost('/v5/order/cancel', { category: 'linear', symbol, orderId });
    const alreadyGone = data.retCode === 110001;
    const ok = data.retCode === 0 || alreadyGone;
    if (!ok) {
      addLog('WARN', `Cancel order failed ${symbol} ${orderId}: ${data.retMsg}`, { retCode: data.retCode });
    } else {
      addLog('CANCEL', `Order cancel ${alreadyGone ? 'no-op (already filled/cancelled)' : 'confirmed'} ${symbol} ${orderId}`, { retCode: data.retCode });
    }
    return { ok, retCode: data.retCode, alreadyGone };
  } catch (e) {
    addLog('WARN', `Cancel order threw ${symbol} ${orderId}: ${e.message}`);
    return { ok: false, retCode: null, alreadyGone: false };
  }
}

let lastSnapshot = null;
let running = false;

// fixORPHAN: BYBIT-SIDE ORPHAN SWEEP — the downtime gap closer.
// PROBLEM (live 07/18, BANKUSDT 5.76h stale fill): the waiting-limit timeout-cancel needs BOTH the
// reconciler loop running AND the local trade record present. A redeploy/restart/store-loss leaves
// bot GTC limits alive on Bybit with nobody watching; one can fill hours later into a dead setup.
// FIX: every reconcile cycle, scan the exchange's OPEN ORDERS for bot-owned orders that have NO
// matching local trade record, and cancel them. Runs every cycle (not just startup) so a record
// lost mid-session is caught within 15s, and the very first reconcile after any restart sweeps the
// downtime backlog.
// SAFETY RAILS:
//   - Only orders POSITIVELY identified as bot-owned are ever touched. Identification: orderLinkId
//     matches the deterministic builder output — tail of 'orayan_<signalId>' where signalId is
//     'v4_<SYM>_<SIDE>_<ms>'. After the 36-char tail slice that always ends '_BUY_<ms>'/'_SELL_<ms>'
//     and retains 'v4_'. Manual orders / other tools are structurally excluded (fail-CLOSED: when
//     in doubt, do NOT cancel).
//   - Open POSITIONS are never auto-closed (could be a legitimate manual trade or a fill the store
//     lost — closing it would realize a loss on the user's behalf). Unmatched bot-adjacent positions
//     are logged as ORPHAN_POSITION alarms, once per symbol per process, for the human to decide.
const _orphanPosLogged = new Set();
function isBotOrderLinkId(oli) {
  const s = String(oli || '');
  if (!s) return false;
  if (s.startsWith('orayan_') || s.startsWith('rayan_')) return true; // pre/post tail-slice prefixes
  if (/v4_[A-Z0-9]+_(BUY|SELL)_\d{10,}$/.test(s)) return true;        // structural match survives most prefix cuts
  // Review-round catch: symbols ≥17 chars (1000000BABYDOGE etc.) push the 36-char tail slice past
  // 'v4_' entirely. Fall back to the strongest remaining signature: ...USDT_<SIDE>_<13-digit ms epoch>.
  return /USDT_(BUY|SELL)_\d{13}$/.test(s);
}
async function sweepOrphanBybitOrders(snapshot, trades) {
  try {
    const orders = Array.isArray(snapshot && snapshot.orders) ? snapshot.orders : [];
    if (!orders.length && !(snapshot.positions || []).length) return;
    const knownOrderIds = new Set();
    const knownLinkIds = new Set();
    const liveSymbols = new Set();
    for (const k in (trades || {})) {
      const t = trades[k];
      if (!t) continue;
      if (t.orderId) knownOrderIds.add(String(t.orderId));
      if (t.orderLinkId) knownLinkIds.add(String(t.orderLinkId));
      if (!isTerminalTrade(t) && t.symbol) liveSymbols.add(String(t.symbol));
    }
    for (const o of orders) {
      if (!o || !o.orderId) continue;
      if (knownOrderIds.has(String(o.orderId))) continue;
      if (o.orderLinkId && knownLinkIds.has(String(o.orderLinkId))) continue;
      if (!isBotOrderLinkId(o.orderLinkId)) continue; // fail-CLOSED: never touch non-bot orders
      addLog('ORPHAN_ORDER', `Bot order on Bybit with no local record — cancelling ${o.symbol} ${o.orderId} (${o.orderLinkId})`, { symbol: o.symbol, orderId: o.orderId, orderLinkId: o.orderLinkId });
      await cancelBybitOrder(o.symbol, o.orderId); // 110001 already-gone is fine; logged inside
    }
    for (const p of (snapshot.positions || [])) {
      if (!p || !p.symbol || !(Number(p.size) > 0)) continue;
      if (liveSymbols.has(String(p.symbol))) continue;
      if (_orphanPosLogged.has(p.symbol)) continue;
      _orphanPosLogged.add(p.symbol);
      addLog('ORPHAN_POSITION', `Open Bybit position ${p.symbol} has no live local trade record — NOT auto-closing (manual review required)`, { symbol: p.symbol, size: p.size, avgPrice: p.avgPrice });
    }
  } catch (e) {
    addLog('WARN', `Orphan sweep failed: ${e.message}`);
  }
}

function num(v) { return toNum(v, 0); }
function arr(data) { return data?.result?.list || []; }

// ── fix58: BYBIT EVENT LEDGER ──────────────────────────────────────────────────────────────────
// Append-only ground-truth log of EVERYTHING Bybit reports — fills (incl. partials), opens, closes
// (real net P&L + fees + slippage), cancellations (with reason), rejects — joinable to the trade
// ledger + breadth log via orderLinkId/tradeId/signalId. Lets cost-aware analysis happen from data
// instead of screenshots. Uses data ALREADY fetched each reconcile cycle — no extra API calls.
// TEMPORARY by design: disable via settings.bybitEventLog=false or env V4_BYBIT_EVENT_LOG_DISABLE=1.
const _seenExecIds = new Set();
function eventLogEnabled() {
  if (String(process.env.V4_BYBIT_EVENT_LOG_DISABLE || '') === '1') return false;
  try { return getSettings().bybitEventLog !== false; } catch (_e) { return true; }
}
function logBybitEvent(event, fields) {
  if (!eventLogEnabled()) return;
  const now = Date.now();
  try { store.appendNdjson('bybit_ledger', { ts: now, iso: new Date(now).toISOString(), event, ...fields }); }
  catch (_e) { /* never let logging break the reconcile cycle */ }
}

function normOrder(o) {
  return {
    orderId: o.orderId,
    orderLinkId: o.orderLinkId,
    symbol: o.symbol,
    side: o.side,
    orderType: o.orderType,
    orderStatus: o.orderStatus,
    price: num(o.price),
    avgPrice: num(o.avgPrice),
    qty: num(o.qty),
    leavesQty: num(o.leavesQty),
    cumExecQty: num(o.cumExecQty),
    cumExecValue: num(o.cumExecValue),
    takeProfit: num(o.takeProfit),
    stopLoss: num(o.stopLoss),
    rejectReason: o.rejectReason || '',
    cancelType: o.cancelType || '',
    createdTime: Number(o.createdTime || 0),
    updatedTime: Number(o.updatedTime || 0),
    raw: o,
  };
}

function normPosition(p) {
  return {
    symbol: p.symbol,
    side: p.side,
    size: num(p.size),
    avgPrice: num(p.avgPrice),
    markPrice: num(p.markPrice),
    positionValue: num(p.positionValue),
    unrealisedPnl: num(p.unrealisedPnl),
    leverage: num(p.leverage),
    takeProfit: num(p.takeProfit),
    stopLoss: num(p.stopLoss),
    liqPrice: num(p.liqPrice),
    updatedTime: Number(p.updatedTime || 0),
    raw: p,
  };
}

function normExecution(e) {
  return {
    symbol: e.symbol,
    orderId: e.orderId,
    orderLinkId: e.orderLinkId,
    side: e.side,
    execPrice: num(e.execPrice),
    execQty: num(e.execQty),
    execValue: num(e.execValue),
    execFee: num(e.execFee),
    execPnl: num(e.execPnl),
    execTime: Number(e.execTime || 0),
    raw: e,
  };
}

function normClosed(c) {
  return {
    symbol: c.symbol,
    orderId: c.orderId,
    side: c.side,
    qty: num(c.qty),
    avgEntryPrice: num(c.avgEntryPrice),
    avgExitPrice: num(c.avgExitPrice),
    closedPnl: num(c.closedPnl),
    createdTime: Number(c.createdTime || 0),
    updatedTime: Number(c.updatedTime || 0),
    raw: c,
  };
}

async function safeCall(name, fn, fallback) {
  try {
    const data = await fn();
    if (data && data.retCode !== undefined && data.retCode !== 0) {
      return { ok: false, error: data.retMsg || `${name} retCode ${data.retCode}`, retCode: data.retCode, data, value: fallback };
    }
    return { ok: true, data, value: data };
  } catch (e) {
    return { ok: false, error: e.message, value: fallback };
  }
}

async function getWallet() {
  const r = await safeCall('wallet', () => bybitGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' }), null);
  if (!r.ok) return { ok: false, error: r.error, availableBalance: 0, walletBalance: 0 };
  const coins = r.data.result?.list?.[0]?.coin || [];
  const usdt = coins.find(c => c.coin === 'USDT') || {};
  return {
    ok: true,
    availableBalance: num(usdt.availableToWithdraw || usdt.availableToBorrow || usdt.walletBalance),
    walletBalance: num(usdt.walletBalance),
    equity: num(usdt.equity),
    coins,
  };
}

async function fetchBybitSnapshot() {
  const settings = getSettings();
  if (!keySet()) {
    return {
      ok: false,
      error: 'BYBIT_API_KEY/BYBIT_API_SECRET are not set',
      mode: settings.botMode,
      testnet: settings.testnet !== false,
      ts: Date.now(),
      orders: [], positions: [], orderHistory: [], executions: [], closedPnl: [], wallet: { ok: false },
    };
  }

  const [ordersR, posR, histR, execR, closedR, wallet] = await Promise.all([
    safeCall('openOrders', () => bybitGet('/v5/order/realtime', { category: 'linear', settleCoin: 'USDT', limit: '50' }), null),
    safeCall('positions', () => bybitGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT', limit: '50' }), null),
    safeCall('orderHistory', () => bybitGet('/v5/order/history', { category: 'linear', settleCoin: 'USDT', limit: '50' }), null),
    safeCall('executions', () => bybitGet('/v5/execution/list', { category: 'linear', limit: '50' }), null),
    safeCall('closedPnl', () => bybitGet('/v5/position/closed-pnl', { category: 'linear', limit: '50' }), null),
    getWallet(),
  ]);

  const snapshot = {
    ok: true,
    mode: settings.botMode,
    testnet: settings.testnet !== false,
    tradingEnabled: settings.tradingEnabled,
    ts: Date.now(),
    iso: new Date().toISOString(),
    wallet,
    orders: arr(ordersR.data).map(normOrder),
    positions: arr(posR.data).map(normPosition).filter(p => p.size > 0),
    // fixPOSFAIL: per-endpoint health. A FAILED positions call yields an EMPTY array that is
    // indistinguishable from "no open positions" — deriveStatus then wrote positionStatus:'NONE'
    // on genuinely OPEN positions (observed live 07/21: LABUSDT flapped OPEN->NONE->OPEN six times
    // in 14 min). Worse, the `closed && !pos` branch can BOOK A FALSE CLOSE off a stale closedPnl
    // match during such a blind cycle. Consumers must now check this flag before trusting absence.
    positionsOk: posR.ok === true,
    ordersOk: ordersR.ok === true,
    orderHistory: arr(histR.data).map(normOrder),
    executions: arr(execR.data).map(normExecution),
    closedPnl: arr(closedR.data).map(normClosed),
    errors: [ordersR, posR, histR, execR, closedR].filter(x => !x.ok).map(x => x.error),
  };
  lastSnapshot = snapshot;
  store.write('bybit-live-state', snapshot);
  return snapshot;
}

function mapById(items) {
  const m = new Map();
  for (const it of items || []) {
    if (it.orderId) m.set(it.orderId, it);
    if (it.orderLinkId) m.set(it.orderLinkId, it);
  }
  return m;
}

// fix60: Bybit's closed-pnl record keys on the CLOSING order's id, which never equals our OPENING
// orderId/orderLinkId (and closed-pnl carries no custom orderLinkId), so the id-based match in
// deriveStatus always missed — trades stalled at ORDER_FILLED_NO_POSITION and the fix58 close-
// enrichment block (real closedPnl/fees/slippage) never ran, leaving closedPnl absent in the ledger.
// Safe fallback: match by symbol + time-bound. The close must have happened at/after our own fill,
// so an older or manual trade on the same symbol can never be claimed (preserves the original
// "never close on symbol alone" safety intent). Orayan runs one live trade per symbol (in-flight
// lock + dup guard) so there is at most one legitimate candidate. When our entry price is known we
// prefer the closed row whose avgEntryPrice matches within 0.5% (a strong discriminator); otherwise
// we take the most recent close inside the window (covers fast fill+close before a position is seen).
function findClosedForTrade(trade, closedList) {
  if (!trade || !Array.isArray(closedList) || !closedList.length) return null;
  const sym = trade.symbol;
  if (!sym) return null;
  const openedAt = Number(trade.filledAt || trade.placedAt || 0);
  if (!openedAt) return null; // no anchor -> refuse to guess (safety)
  const SKEW_MS = 5000; // clock-skew tolerance
  const cands = closedList.filter(c =>
    c && c.symbol === sym &&
    Number(c.updatedTime || c.createdTime || 0) >= (openedAt - SKEW_MS)
  );
  if (!cands.length) return null;
  const entry = num(trade.avgEntryPrice);
  if (entry > 0) {
    const priced = cands
      .map(c => ({ c, d: Math.abs(num(c.avgEntryPrice) - entry) / entry }))
      .filter(x => Number.isFinite(x.d) && x.d <= 0.005)
      .sort((a, b) => a.d - b.d);
    if (priced.length) return priced[0].c;
  }
  return cands.sort((a, b) => Number(b.updatedTime || b.createdTime || 0) - Number(a.updatedTime || a.createdTime || 0))[0];
}

// fixREC1: a trade whose life is over has nothing further to learn from Bybit. Re-deriving it every
// cycle made positionStatus flap CLOSED↔NONE (the closedPnl lookup window rolls, so `closed` is found
// on one pass and missed the next), and each flap emitted a no-op STATUS_CHANGE ledger row —
// 188 of 235 rows for only 4 real trades. The Bybit-Truth panel summed ROWS, so 4 wins read as
// 198W/0L / +57.81U. Freeze terminal trades: no re-derive, no churn, no phantom ledger rows.
// POSITION_CLOSED is only terminal once real closedPnl has landed — otherwise keep polling for it.
function isTerminalTrade(trade) {
  const st = String((trade && trade.status) || '').toUpperCase();
  if (st === 'POSITION_CLOSED') return Number.isFinite(Number(trade && trade.closedPnl));
  return ['ORDER_CANCELLED', 'ORDER_REJECTED', 'ORDER_DEACTIVATED', 'CANCELLED'].includes(st);
}

function deriveStatus(trade, snapshot) {
  const positionsBySymbol = new Map(snapshot.positions.map(p => [p.symbol, p]));
  const openOrderMap = mapById(snapshot.orders);
  const histMap = mapById(snapshot.orderHistory);
  const execMap = mapById(snapshot.executions);
  const closedMap = mapById(snapshot.closedPnl);
  const openOrder = openOrderMap.get(trade.orderId) || openOrderMap.get(trade.orderLinkId);
  const histOrder = histMap.get(trade.orderId) || histMap.get(trade.orderLinkId);
  const exec = execMap.get(trade.orderId) || execMap.get(trade.orderLinkId);
  const pos = positionsBySymbol.get(trade.symbol);
  // Important: never close a bot trade just because the same symbol appears in recent closed PnL.
  // Older/manual testnet trades can share a symbol. Only match closed PnL by orderId/orderLinkId.
  let closed = closedMap.get(trade.orderId) || closedMap.get(trade.orderLinkId);
  if (!closed) closed = findClosedForTrade(trade, snapshot.closedPnl); // fix60: id-match misses (closing-order id ≠ our opening id) → symbol+time fallback

  const out = { changed: false, openOrder, histOrder, exec, pos, closed };
  const before = JSON.stringify({ status: trade.status, orderStatus: trade.orderStatus, positionStatus: trade.positionStatus });

  if (openOrder) {
    trade.orderStatus = openOrder.orderStatus || 'OPEN_ORDER';
    trade.leavesQty = openOrder.leavesQty;
    trade.cumExecQty = openOrder.cumExecQty;
    trade.bybitAvgPrice = openOrder.avgPrice || trade.bybitAvgPrice;
    if (!pos) {
      trade.positionStatus = 'NONE';
      trade.status = openOrder.cumExecQty > 0 ? 'PARTIALLY_FILLED_NO_POSITION' : 'ORDER_PENDING_FILL';
    }
  }

  if (histOrder) {
    trade.orderStatus = histOrder.orderStatus || trade.orderStatus;
    trade.bybitAvgPrice = histOrder.avgPrice || trade.bybitAvgPrice;
    trade.rejectReason = histOrder.rejectReason || trade.rejectReason;
    trade.cancelType = histOrder.cancelType || trade.cancelType;
    if (['Cancelled', 'Rejected', 'Deactivated'].includes(histOrder.orderStatus)) {
      trade.status = 'ORDER_' + String(histOrder.orderStatus).toUpperCase();
      trade.positionStatus = 'NONE';
      trade.closedAt = trade.closedAt || Date.now();
      trade.closeReason = histOrder.rejectReason || histOrder.cancelType || histOrder.orderStatus;
    } else if (histOrder.orderStatus === 'Filled' && !pos) {
      trade.status = closed ? 'POSITION_CLOSED' : 'ORDER_FILLED_NO_POSITION';
    }
  }

  if (exec) {
    trade.lastExecPrice = exec.execPrice || trade.lastExecPrice;
    trade.lastExecQty = exec.execQty || trade.lastExecQty;
    trade.lastExecFee = exec.execFee || trade.lastExecFee;
    trade.lastExecPnl = exec.execPnl || trade.lastExecPnl;
    trade.lastExecTime = exec.execTime || trade.lastExecTime;
  }

  // fixPOSFAIL: BLIND-CYCLE GUARD. If the positions endpoint failed this cycle, absence proves
  // nothing — freeze the position-derived fields and skip the close-booking branch entirely.
  const _posBlind = snapshot && snapshot.positionsOk === false;
  if (!pos && _posBlind && String(trade.positionStatus || '').toUpperCase() === 'OPEN') {
    trade.posMissStreak = 0;
    const after0 = JSON.stringify({ status: trade.status, orderStatus: trade.orderStatus, positionStatus: trade.positionStatus });
    out.changed = before !== after0;
    return out;
  }

  if (pos) {
    trade.posMissStreak = 0;
    trade.status = 'POSITION_OPEN';
    trade.positionStatus = 'OPEN';
    trade.filledAt = trade.filledAt || Date.now();
    trade.avgEntryPrice = pos.avgPrice || trade.avgEntryPrice;
    trade.positionQty = pos.size;
    trade.markPrice = pos.markPrice;
    trade.unrealisedPnl = pos.unrealisedPnl;
    trade.positionValue = pos.positionValue;
    trade.bybitTakeProfit = pos.takeProfit;
    trade.bybitStopLoss = pos.stopLoss;
  } else {
    // fixPOSFAIL: DEBOUNCE. Bybit's position list is occasionally incomplete on a successful call
    // (pagination/propagation). Require POS_MISS_CONFIRM consecutive clean-cycle absences before
    // declaring a previously-OPEN position gone; a single blip no longer rewrites live state.
    const _missNeeded = Math.max(1, Number(process.env.POS_MISS_CONFIRM || '2'));
    if (String(trade.positionStatus || '').toUpperCase() === 'OPEN') {
      trade.posMissStreak = num(trade.posMissStreak) + 1;
      if (trade.posMissStreak < _missNeeded) {
        const after1 = JSON.stringify({ status: trade.status, orderStatus: trade.orderStatus, positionStatus: trade.positionStatus });
        out.changed = before !== after1;
        return out;
      }
    }
    trade.positionStatus = 'NONE';
  }

  // fixPOSFAIL: a close may only be booked from a cycle that actually SAW the position list.
  if (closed && !pos && !_posBlind) {
    trade.status = 'POSITION_CLOSED';
    trade.positionStatus = 'CLOSED';
    trade.closedAt = trade.closedAt || (closed.updatedTime || Date.now());
    trade.closedPnl = closed.closedPnl;
    trade.avgExitPrice = closed.avgExitPrice;
    trade.avgEntryPrice = closed.avgEntryPrice || trade.avgEntryPrice;
  }

  if (trade.status === 'PENDING' || trade.status === 'ORDER_SUBMITTED' || trade.status === 'ORDER_PENDING_FILL') {
    // fix49c → fixWLT30: isWaitingLimit = GTC limit placed at WAITING_ENTRY stage.
    // WAS: Math.max(50min, pendingTimeoutMinutes) — two problems: (a) 50min let a limit outlive the
    // 45-min signal hard-cap window by design margin that proved too generous (live data 07/18:
    // stale fills into dead setups), and (b) the Math.max coupling meant raising pendingTimeoutMinutes
    // silently extended waiting-limit lifetimes too. NOW: fixed, env-tunable, DECOUPLED 30-min cap.
    // Normal pending orders still use pendingTimeoutMinutes (default 5min).
    const _wltMin = Math.max(1, Number(process.env.WAITING_LIMIT_TIMEOUT_MINUTES || '30'));
    const timeout = trade.isWaitingLimit
      ? _wltMin * 60 * 1000
      : getSettings().pendingTimeoutMinutes * 60 * 1000;
    if (Date.now() - Number(trade.placedAt || 0) > timeout) {
      trade.stalePending = true;
      trade.staleReason = trade.isWaitingLimit
        ? `Waiting limit unfilled beyond ${_wltMin}min — signal has expired, cancelling.`
        : 'Pending longer than configured timeout. Not auto-deleted.';
    }
  }

  const after = JSON.stringify({ status: trade.status, orderStatus: trade.orderStatus, positionStatus: trade.positionStatus });
  out.changed = before !== after;
  return out;
}

async function reconcileOnce() {
  if (running) return lastSnapshot || store.read('bybit-live-state', null);
  running = true;
  try {
    const snapshot = await fetchBybitSnapshot();
    if (!snapshot.ok) return snapshot;

    // fix58: log every execution (incl. partial fills) exactly once, by execId — the granular fill
    // truth (catches the H-style "doubled in two fills" forensics). Dedup in-memory; ndjson is the record.
    if (eventLogEnabled()) {
      for (const e of (snapshot.executions || [])) {
        const execId = e.raw && e.raw.execId;
        if (!execId || _seenExecIds.has(execId)) continue;
        _seenExecIds.add(execId);
        logBybitEvent('EXECUTION', {
          symbol: e.symbol, side: e.side, orderId: e.orderId, orderLinkId: e.orderLinkId, execId,
          execPrice: e.execPrice, execQty: e.execQty, execValue: e.execValue,
          execFee: e.execFee, execPnl: e.execPnl, execTime: e.execTime,
        });
      }
      if (_seenExecIds.size > 5000) { const a = Array.from(_seenExecIds); _seenExecIds.clear(); a.slice(-2500).forEach(x => _seenExecIds.add(x)); }
    }

    const trades = store.read('trades', {});

    // fixORPHAN: exchange-side sweep runs BEFORE the per-trade loop, every cycle. First reconcile
    // after any restart clears the downtime backlog of unwatched bot orders (see function comment).
    await sweepOrphanBybitOrders(snapshot, trades);

    let changed = false;
    for (const [id, trade] of Object.entries(trades)) {
      if (!trade || !trade.symbol) continue;
      if (isTerminalTrade(trade)) continue; // fixREC1: frozen — see isTerminalTrade()
      const before = JSON.stringify(trade);
      // fix46: capture status BEFORE deriveStatus mutates trade — cancel checks need original status
      const _statusBeforeDerive = trade.status;
      const status = deriveStatus(trade, snapshot);

      // fix44b: cancel pending Bybit order when signal invalidated
      // fix49h(H1): REVERSED fix44e's "only cancel if PAPER_ACTIVE — price may recover" decision.
      // Live data 06/10: 2 of 6 losses were exactly this — Orayan invalidated the signal (structure
      // broke before entry), the resting GTC limit was NOT cancelled because trade.status is
      // 'PENDING' (never 'PAPER_ACTIVE' — that's a signal state, the condition could never match),
      // price retraced through entry into the broken setup, filled, and rode to SL on Bybit.
      // New rule: signalInvalidated + order UNFILLED → cancel. An unfilled limit whose structure
      // broke is precisely the order that must be pulled. Partially-filled orders are excluded —
      // a real position exists and liveStateAuthority owns it; we never touch fills here.
      const _unfilled =
        Number(trade.cumExecQty || 0) === 0 &&
        String(trade.positionStatus || '').toUpperCase() !== 'OPEN' &&
        !['POSITION_OPEN', 'POSITION_CLOSED', 'ORDER_FILLED_NO_POSITION', 'PARTIALLY_FILLED_NO_POSITION'].includes(String(_statusBeforeDerive || '').toUpperCase());
      if (
        (_statusBeforeDerive === 'PAPER_ACTIVE' || trade.paperClosed === true || _unfilled) &&
        !trade.cancelledByInvalidate &&
        trade.orderId &&
        trade.signalInvalidated
      ) {
        const cancelRes = await cancelBybitOrder(trade.symbol, trade.orderId);
        if (cancelRes.ok && !cancelRes.alreadyGone) {
          trade.cancelledByInvalidate = true;
          trade.status = 'CANCELLED';
          trade.closeReason = trade.paperClosed ? `PAPER_${trade.paperCloseState}_BYBIT_UNFILLED` : (trade.invalidateReason || 'SIGNAL_INVALIDATED');
          trade.closedAt = Date.now();
          changed = true;
        } else if (cancelRes.ok && cancelRes.alreadyGone) {
          // fix49h(H1): 110001 — order already filled OR already cancelled. Do NOT force-mark
          // CANCELLED: if it actually FILLED, a real position exists and the next deriveStatus
          // pass must classify it (POSITION_OPEN → authority takes the signal). Flag and wait.
          trade.cancelledByInvalidate = true; // don't retry the cancel
          trade.cancelRaceCheck = true;       // forensics: resolved by next deriveStatus
          addLog('CANCEL', `Invalidate-cancel no-op for ${trade.symbol} ${trade.orderId} — already gone; deriveStatus will classify fill vs cancel next cycle`);
          changed = true;
        } else {
          // Cancel failed — flag for retry next reconcile cycle, don't mark CANCELLED yet
          trade.cancelPendingInvalidate = true;
          addLog('WARN', `Cancel failed for ${trade.symbol} ${trade.orderId} — will retry next cycle`);
        }
      }

      // fix44b: cancel pending Bybit order when timeout exceeded (stalePending)
      // fix44e: extended to cover ORDER_SUBMITTED (market orders not yet confirmed)
      if (
        (_statusBeforeDerive === 'PENDING' || _statusBeforeDerive === 'ORDER_SUBMITTED') &&
        trade.stalePending &&
        !trade.cancelledByTimeout &&
        trade.orderId
      ) {
        const cancelRes = await cancelBybitOrder(trade.symbol, trade.orderId);
        if (cancelRes.ok && !cancelRes.alreadyGone) {
          trade.cancelledByTimeout = true;
          trade.status = 'CANCELLED';
          trade.closeReason = 'PENDING_TIMEOUT';
          trade.closedAt = Date.now();
          changed = true;
        } else if (cancelRes.ok && cancelRes.alreadyGone) {
          // fix49h: 110001 on timeout-cancel — already filled or already cancelled. Same rule as
          // the invalidate-cancel: never force CANCELLED over a possible fill; deriveStatus decides.
          trade.cancelledByTimeout = true;
          trade.cancelRaceCheck = true;
          addLog('CANCEL', `Timeout-cancel no-op for ${trade.symbol} ${trade.orderId} — already gone; deriveStatus will classify next cycle`);
          changed = true;
        } else {
          addLog('WARN', `Timeout cancel failed for ${trade.symbol} ${trade.orderId} — will retry next cycle`);
        }
      }

      if (status.pos && !trade.tpslAttached && (trade.tp1 || trade.sl)) {
        const stop = await setTradingStopSafe({ symbol: trade.symbol, tp1: trade.tp1, sl: trade.sl, bybitSide: trade.bybitSide, side: trade.side });
        trade.tpslSetAttemptedAt = Date.now();
        // fix44c/fix49f: treat "not modified" as success — stops retry spam every 15s.
        // Live logs (2026-06-10) proved Bybit returns "not modified" retMsg with codes outside
        // [110043,110047] (TP/SL already attached at order creation). Match code OR message.
        const _rc = stop.data?.retCode;
        const _rm = String(stop.data?.retMsg || stop.error || '').toLowerCase();
        const notModified = [110043, 110047, 34040].includes(_rc) || _rm.includes('not modified');
        trade.tpslAttached = !!stop.ok || notModified;
        trade.tpslStatus = trade.tpslAttached ? 'ATTACHED' : 'ATTACH_FAILED';
        trade.tpslResult = stop;
        if (!trade.tpslAttached) addLog('WARN', `TP/SL attach failed for ${trade.symbol}: ${stop.error || stop.data?.retMsg || 'unknown'}`, stop);
      }

      // fix44c: sync real PnL for ORDER_FILLED_NO_POSITION trades (filled+closed before reconciler saw position)
      if (trade.status === 'ORDER_FILLED_NO_POSITION' && status.closed && !trade.closedPnl) {
        trade.status = 'POSITION_CLOSED';
        trade.positionStatus = 'CLOSED';
        trade.closedPnl = status.closed.closedPnl;
        trade.avgExitPrice = status.closed.avgExitPrice;
        trade.avgEntryPrice = status.closed.avgEntryPrice || trade.avgEntryPrice;
        trade.closedAt = trade.closedAt || (status.closed.updatedTime || Date.now());
        addLog('SYNC', `PnL synced for ${trade.symbol} ORDER_FILLED_NO_POSITION: ${status.closed.closedPnl}`, { tradeId: id });
        changed = true;
      }
      trade.updatedAt = Date.now();
      if (JSON.stringify(trade) !== before) changed = true;
      if (status.changed) {
        addLog('SYNC', `${trade.symbol} -> ${trade.status}`, { tradeId: id, orderId: trade.orderId });
        // fix58: log the lifecycle transition with Bybit truth (covers invalidations, cancellations,
        // rejects, opens, partials, closes). Cancel reason is preserved; closes are enriched with
        // real net P&L, summed fees, entry slippage and duration for cost-aware analysis.
        const _ev = {
          symbol: trade.symbol, side: trade.side,
          tradeId: id, orderId: trade.orderId, orderLinkId: trade.orderLinkId, signalId: trade.signalId,
          prevStatus: _statusBeforeDerive, status: trade.status,
          orderStatus: trade.orderStatus, positionStatus: trade.positionStatus,
          qty: num(trade.qty), cumExecQty: num(trade.cumExecQty), leavesQty: num(trade.leavesQty),
          avgEntryPrice: num(trade.avgEntryPrice) || num(trade.bybitAvgPrice) || null,
          intendedEntry: num(trade.entry) || null,
          closeReason: trade.closeReason || trade.rejectReason || trade.invalidateReason || trade.staleReason || null,
        };
        if (String(trade.status).toUpperCase() === 'POSITION_CLOSED' || String(trade.positionStatus).toUpperCase() === 'CLOSED') {
          const fees = (snapshot.executions || [])
            .filter(e => e.orderId === trade.orderId || (trade.orderLinkId && e.orderLinkId === trade.orderLinkId))
            .reduce((a, e) => a + num(e.execFee), 0);
          _ev.closedPnl = num(trade.closedPnl);
          _ev.totalFees = Number(fees.toFixed(6));
          _ev.avgExitPrice = num(trade.avgExitPrice) || null;
          _ev.entrySlippage = (num(trade.avgEntryPrice) && num(trade.entry)) ? Number((num(trade.avgEntryPrice) - num(trade.entry)).toFixed(8)) : null;
          _ev.openTime = trade.filledAt || trade.placedAt || null;
          _ev.closeTime = trade.closedAt || Date.now();
          _ev.durationMs = (_ev.openTime && _ev.closeTime) ? (_ev.closeTime - _ev.openTime) : null;
        }
        logBybitEvent('STATUS_CHANGE', _ev);
      }
    }
    if (changed) store.write('trades', trades);

    const enriched = { ...snapshot, trades, tradeList: Object.values(trades).sort((a, b) => (b.placedAt || 0) - (a.placedAt || 0)) };
    store.write('bybit-live-state', enriched);
    lastSnapshot = enriched;
    return enriched;
  } finally {
    running = false;
  }
}

function getLastSnapshot() {
  return lastSnapshot || store.read('bybit-live-state', {
    ok: false, error: 'No Bybit sync yet', ts: 0, orders: [], positions: [], orderHistory: [], executions: [], closedPnl: [], trades: {}, tradeList: []
  });
}

function start(intervalMs = 15000) {
  setTimeout(() => reconcileOnce().catch(e => addLog('ERROR', `Initial reconcile failed: ${e.message}`)), 5000);
  setInterval(() => reconcileOnce().catch(e => addLog('ERROR', `Reconcile failed: ${e.message}`)), intervalMs);
  console.log(`[reconciler] Bybit live sync started — interval: ${intervalMs / 1000}s`);
}

module.exports = { fetchBybitSnapshot, reconcileOnce, getLastSnapshot, start };
