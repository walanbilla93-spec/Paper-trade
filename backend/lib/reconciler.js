'use strict';

const store = require('./store');
const { bybitGet, bybitPost, keySet } = require('./bybit');
const { getSettings } = require('./config');
const { addLog } = require('./tradeLog');
const { setTradingStopSafe } = require('./executor');
const { toNum } = require('./math');

// fix44b: cancel a pending Bybit order safely
async function cancelBybitOrder(symbol, orderId) {
  if (!orderId) return false;
  try {
    const data = await bybitPost('/v5/order/cancel', { category: 'linear', symbol, orderId });
    // 0 = success, 110001 = order no longer exists (filled/already cancelled) — both are safe outcomes
    const ok = [0, 110001].includes(data.retCode);
    if (!ok) {
      addLog('WARN', `Cancel order failed ${symbol} ${orderId}: ${data.retMsg}`, { retCode: data.retCode });
    } else {
      addLog('CANCEL', `Order cancelled ${symbol} ${orderId}`, { retCode: data.retCode });
    }
    return ok;
  } catch (e) {
    addLog('WARN', `Cancel order threw ${symbol} ${orderId}: ${e.message}`);
    return false;
  }
}

let lastSnapshot = null;
let running = false;

function num(v) { return toNum(v, 0); }
function arr(data) { return data?.result?.list || []; }

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
  const closed = closedMap.get(trade.orderId) || closedMap.get(trade.orderLinkId);

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

  if (pos) {
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
    trade.positionStatus = 'NONE';
  }

  if (closed && !pos) {
    trade.status = 'POSITION_CLOSED';
    trade.positionStatus = 'CLOSED';
    trade.closedAt = trade.closedAt || (closed.updatedTime || Date.now());
    trade.closedPnl = closed.closedPnl;
    trade.avgExitPrice = closed.avgExitPrice;
    trade.avgEntryPrice = closed.avgEntryPrice || trade.avgEntryPrice;
  }

  if (trade.status === 'PENDING' || trade.status === 'ORDER_SUBMITTED' || trade.status === 'ORDER_PENDING_FILL') {
    // fix49c: isWaitingLimit = GTC limit placed at WAITING_ENTRY stage (can sit up to 45min by design).
    // Use 50min floor so reconciler never force-cancels before the signal hard-cap expires it.
    // Normal pending orders still use pendingTimeoutMinutes (default 5min).
    const timeout = trade.isWaitingLimit
      ? Math.max(50 * 60 * 1000, getSettings().pendingTimeoutMinutes * 60 * 1000)
      : getSettings().pendingTimeoutMinutes * 60 * 1000;
    if (Date.now() - Number(trade.placedAt || 0) > timeout) {
      trade.stalePending = true;
      trade.staleReason = trade.isWaitingLimit
        ? 'Waiting limit unfilled beyond 50min — signal has expired, cancelling.'
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

    const trades = store.read('trades', {});
    let changed = false;
    for (const [id, trade] of Object.entries(trades)) {
      if (!trade || !trade.symbol) continue;
      const before = JSON.stringify(trade);
      // fix46: capture status BEFORE deriveStatus mutates trade — cancel checks need original status
      const _statusBeforeDerive = trade.status;
      const status = deriveStatus(trade, snapshot);

      // fix44b: cancel pending Bybit order when signal invalidated
      // fix44e: only cancel if PAPER_ACTIVE — not unfilled limit orders (price may recover)
      // fix44f: BUT cancel immediately if paperClosed=true — paper TP/SL hit while order unfilled = dangerous
      if (
        (_statusBeforeDerive === 'PAPER_ACTIVE' || trade.paperClosed === true) &&
        !trade.cancelledByInvalidate &&
        trade.orderId &&
        trade.signalInvalidated
      ) {
        const cancelOk = await cancelBybitOrder(trade.symbol, trade.orderId);
        if (cancelOk) {
          trade.cancelledByInvalidate = true;
          trade.status = 'CANCELLED';
          trade.closeReason = trade.paperClosed ? `PAPER_${trade.paperCloseState}_BYBIT_UNFILLED` : 'SIGNAL_INVALIDATED';
          trade.closedAt = Date.now();
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
        const cancelOk = await cancelBybitOrder(trade.symbol, trade.orderId);
        if (cancelOk) {
          trade.cancelledByTimeout = true;
          trade.status = 'CANCELLED';
          trade.closeReason = 'PENDING_TIMEOUT';
          trade.closedAt = Date.now();
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
      if (status.changed) addLog('SYNC', `${trade.symbol} -> ${trade.status}`, { tradeId: id, orderId: trade.orderId });
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
