'use strict';

// Orayan Backend Scanner v2
// Keeps signal lifecycle and trade execution on the server. It still accepts
// signals pushed by the browser, but execution/reconciliation is now backend-led.

const store = require('./lib/store');
const { getSettings } = require('./lib/config');
const { getBybitPrice } = require('./lib/instruments');
const { executeSignal, activeTrades, getTrades } = require('./lib/executor');
const { addLog } = require('./lib/tradeLog');

const SCAN_INTERVAL_MS = Math.max(10000, parseInt(process.env.SCAN_INTERVAL_MS || '15000', 10));
const TERMINAL = new Set(['WIN', 'LOSS', 'INVALID', 'EXPIRED']);

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }

function computeTransition(signal, price) {
  if (!price || TERMINAL.has(signal.status)) return null;

  const entry  = n(signal.entry);
  const sl     = n(signal.sl);
  const tp1    = n(signal.tp1);
  const side   = signal.side;
  const now    = Date.now();
  const age    = now - n(signal.createdAt || signal.ts || now);
  const expiry = n(signal.expireMs || 30 * 60 * 1000);
  const status = signal.status || 'DETECTED';

  if (!entry || !sl || !tp1 || !side) return null;

  if (status === 'DETECTED') {
    if (age > expiry) return { newStatus: 'EXPIRED', reason: 'BE: Setup stale', terminal: true };
    if (side === 'BUY' && price < sl)  return { newStatus: 'INVALID', reason: 'BE: Structure broken before fill', terminal: true };
    if (side === 'SELL' && price > sl) return { newStatus: 'INVALID', reason: 'BE: Structure broken before fill', terminal: true };

    const proximity = Math.max(Math.abs(entry) * 0.003, 1e-10);
    if (Math.abs(price - entry) <= proximity) {
      return { newStatus: 'ACTIVE', reason: 'BE: Entry confirmed by backend price', activateNow: true };
    }
    return null;
  }

  if (status === 'ARMED') {
    if (age > expiry) return { newStatus: 'EXPIRED', reason: 'BE: Setup stale', terminal: true };
    const proximity = Math.max(Math.abs(entry) * 0.004, 1e-10);
    if (Math.abs(price - entry) <= proximity) {
      return { newStatus: 'ACTIVE', reason: 'BE: Entry confirmed by backend price', activateNow: true };
    }
    return null;
  }

  if (status === 'ACTIVE') {
    if (side === 'BUY'  && price >= tp1) return { newStatus: 'WIN',  reason: 'BE: Signal TP hit', terminal: true, exitPx: price };
    if (side === 'SELL' && price <= tp1) return { newStatus: 'WIN',  reason: 'BE: Signal TP hit', terminal: true, exitPx: price };
    if (side === 'BUY'  && price <= sl)  return { newStatus: 'LOSS', reason: 'BE: Signal SL hit', terminal: true, exitPx: price };
    if (side === 'SELL' && price >= sl)  return { newStatus: 'LOSS', reason: 'BE: Signal SL hit', terminal: true, exitPx: price };
  }
  return null;
}

function markSignal(signal, transition) {
  signal.status = transition.newStatus;
  signal.lastTransitionAt = Date.now();
  signal.updatedAt = Date.now();
  signal.stateReason = transition.reason;
  if (transition.exitPx) signal.exitPx = transition.exitPx;
  if (!Array.isArray(signal.history)) signal.history = [];
  signal.history.push({ at: Date.now(), state: transition.newStatus, reason: transition.reason });
}

async function maybeExecute(signal, price) {
  const settings = getSettings();
  if (!settings.tradingEnabled) return;
  if (n(signal.score) < settings.minScoreToTrade) {
    addLog('SKIP', `Signal ${signal.sym} score too low for backend auto trade`, { score: signal.score, min: settings.minScoreToTrade });
    return;
  }

  const trades = getTrades();
  const dup = activeTrades(trades).find(t => t.signalId === signal.id || t.symbol === signal.sym);
  if (dup) return;

  const result = await executeSignal(signal, { source: 'backend-scanner', forceMarket: settings.testnet !== false });
  if (result.ok) {
    signal._autoTraded = true;
    signal._orderId = result.orderId;
    signal._tradeId = result.trade.id;
    signal.orderStatus = result.trade.status;
    signal.backendPlan = {
      entry: result.trade.entry,
      tp1: result.trade.tp1,
      sl: result.trade.sl,
      qty: result.trade.qty,
      margin: result.trade.margin,
      leverage: result.trade.leverage,
      expectedProfitUsdt: result.trade.expectedProfitUsdt,
      expectedLossUsdt: result.trade.expectedLossUsdt,
      bybitPriceAtOrder: result.trade.bybitPriceAtOrder,
    };
  } else {
    signal.orderStatus = 'SKIPPED_OR_REJECTED';
    signal.orderError = result.error;
  }
}

async function runScan() {
  const signals = store.read('signals', []);
  if (!Array.isArray(signals) || !signals.length) return;

  let changed = false;
  const candidates = signals.filter(s => s && s.sym && !TERMINAL.has(s.status));
  const symbols = [...new Set(candidates.map(s => s.sym))];
  const prices = {};

  for (const sym of symbols) {
    try { prices[sym] = await getBybitPrice(sym); }
    catch (e) { addLog('WARN', `No Bybit price for ${sym}: ${e.message}`); }
  }

  for (const sig of candidates) {
    const price = prices[sig.sym];
    if (!price) continue;
    sig.backendLastPrice = price;
    sig.backendPriceAt = Date.now();

    const transition = computeTransition(sig, price);
    if (!transition) continue;
    markSignal(sig, transition);
    changed = true;
    addLog('SIGNAL', `${sig.sym} ${sig.side} -> ${transition.newStatus}`, { signalId: sig.id, price, reason: transition.reason });

    if (transition.activateNow) {
      await maybeExecute(sig, price).catch(e => {
        sig.orderStatus = 'ERROR';
        sig.orderError = e.message;
        addLog('ERROR', `Auto execute failed for ${sig.sym}: ${e.message}`, { signalId: sig.id });
      });
      changed = true;
    }
  }

  if (changed) store.write('signals', signals.slice(0, 200));
}

function start() {
  setTimeout(() => runScan().catch(e => addLog('ERROR', `Scanner error: ${e.message}`)), 7000);
  setInterval(() => runScan().catch(e => addLog('ERROR', `Scanner error: ${e.message}`)), SCAN_INTERVAL_MS);
  console.log(`[scanner] Backend scanner started — interval: ${SCAN_INTERVAL_MS / 1000}s`);
}

module.exports = { start, runScan };
