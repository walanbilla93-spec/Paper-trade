'use strict';

const { v4: uuidv4 } = require('uuid');
const store = require('./store');
const { getSettings } = require('./config');
const { bybitPost } = require('./bybit');
const { normalizeSymbol, getInstrumentInfo, getBybitPrice } = require('./instruments');
const { toNum, roundToStep, floorToStep, ceilToStep, pctDistance } = require('./math');
const { addLog } = require('./tradeLog');
let qualityGate; try { qualityGate = require('./marketBrain').qualityGate; } catch(e) { qualityGate = null; }

const ACTIVE_TRADE_STATES = new Set(['PENDING', 'PARTIALLY_FILLED', 'FILLED', 'OPEN', 'ORDER_SUBMITTED', 'PAPER_ACTIVE']);

function getTrades() { return store.read('trades', {}); }
function saveTrades(trades) { store.write('trades', trades); }

function activeTrades(trades = getTrades()) {
  return Object.values(trades).filter(t => ACTIVE_TRADE_STATES.has(t.status));
}

function cleanSignal(signal) {
  const s = signal || {};
  const symbol = normalizeSymbol(s.sym || s.symbol || s.pair);
  const side = String(s.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  return {
    ...s,
    id: String(s.id || s.signalId || `manual_${Date.now()}`),
    sym: symbol,
    symbol,
    side,
    score: toNum(s.score ?? s.confidence ?? s.confPct, 0),
    entry: toNum(s.entry || s.entryPrice || s.planEntry, 0),
    sl: toNum(s.sl || s.stopLoss || s.slPrice, 0),
    tp1: toNum(s.tp1 || s.tp || s.takeProfit || s.tpPrice, 0),
  };
}

function computePercentPlan(signal, settings) {
  let entry = toNum(signal.entry, 0);
  let riskPct = settings.defaultRiskPct;
  let rewardPct = settings.defaultRewardPct;
  if (entry > 0 && settings.useSignalTpSlPercent) {
    if (signal.sl > 0) riskPct = pctDistance(entry, signal.sl) || riskPct;
    if (signal.tp1 > 0) rewardPct = pctDistance(entry, signal.tp1) || rewardPct;
  }
  riskPct = Math.max(0.001, Math.min(0.15, riskPct));
  rewardPct = Math.max(0.001, Math.min(0.30, rewardPct));
  return { riskPct, rewardPct };
}

async function buildExecutionPlan(signalInput, opts = {}) {
  const settings = { ...getSettings(), ...(opts.settings || {}) };
  const signal = cleanSignal(signalInput);
  if (!signal.sym) throw new Error('Signal symbol missing');

  const symbol = signal.sym;
  const side = signal.side;
  const bybitSide = side === 'SELL' ? 'Sell' : 'Buy';
  const info = await getInstrumentInfo(symbol);
  const bybitPrice = await getBybitPrice(symbol);
  if (!bybitPrice || bybitPrice <= 0) throw new Error(`No Bybit price for ${symbol}`);

  const { riskPct, rewardPct } = computePercentPlan(signal, settings);
  const useMarket = opts.forceMarket || (settings.testnet && settings.marketOrdersOnTestnet) || settings.orderType === 'Market';
  const rawEntry = useMarket ? bybitPrice : (signal.entry > 0 ? signal.entry : bybitPrice);

  let rawTp, rawSl;
  if (side === 'BUY') {
    rawTp = rawEntry * (1 + rewardPct);
    rawSl = rawEntry * (1 - riskPct);
  } else {
    rawTp = rawEntry * (1 - rewardPct);
    rawSl = rawEntry * (1 + riskPct);
  }

  // Direction-aware rounding: TP a little less greedy, SL a little conservative.
  const entry = roundToStep(rawEntry, info.tickSize);
  const tp1 = side === 'BUY' ? floorToStep(rawTp, info.tickSize) : ceilToStep(rawTp, info.tickSize);
  const sl = side === 'BUY' ? floorToStep(rawSl, info.tickSize) : ceilToStep(rawSl, info.tickSize);

  const margin = Math.max(1, toNum(signal.margin, settings.maxTradeUsdt));
  const leverage = Math.max(1, Math.min(25, parseInt(signal.leverage || settings.leverage, 10) || settings.leverage));
  const positionUsdt = margin * leverage;
  let qty = floorToStep(positionUsdt / entry, info.qtyStep);

  if (info.minOrderQty && qty < info.minOrderQty) qty = ceilToStep(info.minOrderQty, info.qtyStep);
  if (info.minNotionalValue && qty * entry < info.minNotionalValue) {
    qty = ceilToStep(info.minNotionalValue / entry, info.qtyStep);
  }
  if (info.maxMktOrderQty && useMarket && qty > info.maxMktOrderQty) qty = floorToStep(info.maxMktOrderQty, info.qtyStep);
  if (info.maxOrderQty && qty > info.maxOrderQty) qty = floorToStep(info.maxOrderQty, info.qtyStep);
  if (!qty || qty <= 0) throw new Error(`Invalid qty for ${symbol}`);

  const expectedProfitUsdt = Math.abs(tp1 - entry) * qty;
  const expectedLossUsdt = Math.abs(entry - sl) * qty;
  const expectedProfitPctOnMargin = margin ? (expectedProfitUsdt / margin) * 100 : 0;
  const expectedLossPctOnMargin = margin ? (expectedLossUsdt / margin) * 100 : 0;

  return {
    signal,
    symbol,
    side,
    bybitSide,
    orderType: useMarket ? 'Market' : 'Limit',
    bybitPrice,
    entry,
    tp1,
    sl,
    qty,
    margin,
    leverage,
    positionUsdt,
    riskPct,
    rewardPct,
    expectedProfitUsdt,
    expectedLossUsdt,
    expectedProfitPctOnMargin,
    expectedLossPctOnMargin,
    instrument: info,
    testnet: settings.testnet !== false,
    botMode: settings.botMode,
    createdAt: Date.now(),
  };
}

function canTradeSignal(signal, settings, trades) {
  if (!settings.tradingEnabled) return { ok: false, reason: 'Backend trading is disabled' };
  if (settings.botMode === 'LIVE_REAL_BYBIT' && process.env.CONFIRM_LIVE_TRADING !== 'true') {
    return { ok: false, reason: 'Live trading is locked. Set CONFIRM_LIVE_TRADING=true to unlock.' };
  }
  if (toNum(signal.score, 0) < settings.minScoreToTrade) {
    return { ok: false, reason: `Score ${signal.score} < MIN_SCORE_TO_TRADE ${settings.minScoreToTrade}` };
  }
  if (qualityGate) {
    const q = qualityGate(signal, settings);
    if (!q.ok) return { ok: false, reason: `Quality filter rejected: ${q.reasons.join(',')}` };
  }
  const maxAgeMs = Math.max(1, Number(settings.maxSignalAgeMinutes || 5)) * 60 * 1000;
  const sigTime = Number(signal.createdAt || signal.updatedAt || 0);
  if (sigTime && Date.now() - sigTime > maxAgeMs) {
    return { ok: false, reason: `Signal too old for auto-trade (${settings.maxSignalAgeMinutes || 5}m max)` };
  }
  const currentActive = activeTrades(trades);
  if (currentActive.length >= settings.maxOpenTrades) {
    return { ok: false, reason: `Max open trades reached (${settings.maxOpenTrades})` };
  }
  const duplicate = currentActive.find(t => t.signalId === signal.id || t.symbol === signal.sym);
  if (duplicate) {
    return { ok: false, reason: `Duplicate active trade exists for ${duplicate.symbol}` };
  }
  return { ok: true };
}

async function setLeverageSafe(symbol, leverage) {
  try {
    const data = await bybitPost('/v5/position/set-leverage', {
      category: 'linear',
      symbol,
      buyLeverage: String(leverage),
      sellLeverage: String(leverage),
    });
    if (![0, 110043].includes(data.retCode)) {
      addLog('WARN', `Leverage set warning for ${symbol}: ${data.retMsg}`, { retCode: data.retCode });
    }
    return data;
  } catch (e) {
    addLog('WARN', `Leverage set failed for ${symbol}: ${e.message}`);
    return { retCode: -1, retMsg: e.message };
  }
}

async function setTradingStopSafe(plan) {
  try {
    let data = await bybitPost('/v5/position/trading-stop', {
      category: 'linear',
      symbol: plan.symbol,
      tpslMode: 'Full',
      positionIdx: 0,
      takeProfit: String(plan.tp1),
      stopLoss: String(plan.sl),
      tpTriggerBy: 'LastPrice',
      slTriggerBy: 'LastPrice',
      tpOrderType: 'Market',
      slOrderType: 'Market',
    });

    if (data.retCode !== 0 && data.retMsg && data.retMsg.toLowerCase().includes('positionidx')) {
      // Retry with Hedge Mode index (1 for Buy, 2 for Sell)
      const isBuy = (plan.bybitSide || plan.side) === 'Buy' || plan.side === 'BUY';
      const hedgeIdx = isBuy ? 1 : 2;
      data = await bybitPost('/v5/position/trading-stop', {
        category: 'linear',
        symbol: plan.symbol,
        tpslMode: 'Full',
        positionIdx: hedgeIdx,
        takeProfit: String(plan.tp1),
        stopLoss: String(plan.sl),
        tpTriggerBy: 'LastPrice',
        slTriggerBy: 'LastPrice',
        tpOrderType: 'Market',
        slOrderType: 'Market',
      });
    }

    return { ok: data.retCode === 0, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function executeSignal(signalInput, opts = {}) {
  const settings = { ...getSettings(), ...(opts.settings || {}) };
  const trades = getTrades();
  const signal = cleanSignal(signalInput);

  const gate = opts.force ? { ok: true } : canTradeSignal(signal, settings, trades);
  if (!gate.ok) {
    addLog('SKIP', `Skipped ${signal.sym || '?'} ${signal.side || ''}: ${gate.reason}`, { signal });
    return { ok: false, skipped: true, error: gate.reason };
  }

  const plan = await buildExecutionPlan(signal, { settings, forceMarket: opts.forceMarket });
  const orderLinkId = (`orayan_${signal.id}_${uuidv4().slice(0, 8)}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36);

  // PAPER mode must never call Bybit. It only records a simulated trade plan.
  if (settings.botMode === 'PAPER_REAL_PRICE') {
    const tradeId = `paper_${Date.now()}_${uuidv4().slice(0, 8)}`;
    const trade = {
      id: tradeId,
      signalId: signal.id,
      symbol: plan.symbol,
      side: plan.side,
      bybitSide: plan.bybitSide,
      status: 'PAPER_ACTIVE',
      signalStatus: 'ACTIVE',
      orderStatus: 'NOT_SENT_PAPER',
      positionStatus: 'PAPER',
      orderType: 'Paper',
      entry: plan.entry,
      signalEntry: signal.entry || null,
      bybitPriceAtOrder: plan.bybitPrice,
      sl: plan.sl,
      tp1: plan.tp1,
      qty: plan.qty,
      margin: plan.margin,
      leverage: plan.leverage,
      positionUsdt: plan.positionUsdt,
      riskPct: plan.riskPct,
      rewardPct: plan.rewardPct,
      expectedProfitUsdt: plan.expectedProfitUsdt,
      expectedLossUsdt: plan.expectedLossUsdt,
      expectedProfitPctOnMargin: plan.expectedProfitPctOnMargin,
      expectedLossPctOnMargin: plan.expectedLossPctOnMargin,
      botMode: plan.botMode,
      testnet: plan.testnet,
      placedAt: Date.now(),
      updatedAt: Date.now(),
      source: opts.source || 'backend-paper',
      signalSnapshot: signal,
    };
    trades[tradeId] = trade;
    saveTrades(trades);
    addLog('PAPER_PLACED', `Paper trade ${plan.side} ${plan.symbol}`, { trade });
    return { ok: true, paper: true, trade, plan, orderId: null, raw: null };
  }

  await setLeverageSafe(plan.symbol, plan.leverage);

  // V3.1 safety patch:
  // Do NOT send TP/SL fields in /v5/order/create. Some Bybit accounts reject
  // tpOrderType when tpslMode is absent, and limit orders can remain unfilled.
  // Flow is now: place entry order -> reconciler confirms position -> attach TP/SL.
  const body = {
    category: 'linear',
    symbol: plan.symbol,
    side: plan.bybitSide,
    orderType: plan.orderType,
    qty: String(plan.qty),
    timeInForce: plan.orderType === 'Market' ? 'IOC' : 'GTC',
    orderLinkId,
    reduceOnly: false,
    closeOnTrigger: false,
    takeProfit: String(plan.tp1),
    stopLoss: String(plan.sl),
    tpslMode: 'Full',
    tpOrderType: 'Market',
    slOrderType: 'Market',
  };
  if (plan.orderType === 'Limit') body.price = String(plan.entry);

  addLog('PLACE_ATTEMPT', `${plan.orderType} ${plan.bybitSide} ${plan.symbol} qty ${plan.qty}`, { plan, body, note: 'TP/SL included in order request' });
  const data = await bybitPost('/v5/order/create', body);
  if (data.retCode !== 0) {
    addLog('REJECTED', `Bybit rejected ${plan.symbol}: ${data.retMsg}`, { retCode: data.retCode, body, response: data });
    return { ok: false, error: data.retMsg, retCode: data.retCode, plan, raw: data };
  }

  const orderId = data.result?.orderId || '';
  const tradeId = `tr_${Date.now()}_${uuidv4().slice(0, 8)}`;
  const trade = {
    id: tradeId,
    orderId,
    orderLinkId,
    signalId: signal.id,
    symbol: plan.symbol,
    side: plan.side,
    bybitSide: plan.bybitSide,
    status: plan.orderType === 'Market' ? 'ORDER_SUBMITTED' : 'PENDING',
    signalStatus: 'ACTIVE',
    orderStatus: 'Submitted',
    positionStatus: 'NONE',
    tpslStatus: 'WAITING_FOR_FILL',
    orderType: plan.orderType,
    entry: plan.entry,
    signalEntry: signal.entry || null,
    bybitPriceAtOrder: plan.bybitPrice,
    sl: plan.sl,
    tp1: plan.tp1,
    qty: plan.qty,
    margin: plan.margin,
    leverage: plan.leverage,
    positionUsdt: plan.positionUsdt,
    riskPct: plan.riskPct,
    rewardPct: plan.rewardPct,
    expectedProfitUsdt: plan.expectedProfitUsdt,
    expectedLossUsdt: plan.expectedLossUsdt,
    expectedProfitPctOnMargin: plan.expectedProfitPctOnMargin,
    expectedLossPctOnMargin: plan.expectedLossPctOnMargin,
    botMode: plan.botMode,
    testnet: plan.testnet,
    placedAt: Date.now(),
    updatedAt: Date.now(),
    source: opts.source || 'backend',
    signalSnapshot: signal,
  };
  trades[tradeId] = trade;
  saveTrades(trades);
  addLog('PLACED', `Placed ${plan.symbol} order ${orderId}`, { trade });

  // Orders may fill quickly, but TP/SL must only be attached after Bybit confirms a position.
  // The reconciler is the source of truth; this delayed attempt is best-effort only.
  // We attempt it for both Market and Limit orders as limit orders may also fill immediately (e.g. crossing the spread).
  setTimeout(async () => {
    const stop = await setTradingStopSafe(plan);
    const ts = getTrades();
    if (ts[tradeId]) {
      ts[tradeId].tpslSetAttemptedAt = Date.now();
      ts[tradeId].tpslAttached = !!stop.ok;
      ts[tradeId].tpslResult = stop;
      ts[tradeId].updatedAt = Date.now();
      saveTrades(ts);
      // Suppress WARN for limit orders that genuinely haven't filled yet.
      if (!stop.ok && plan.orderType === 'Market') {
        addLog('WARN', `TP/SL attach not confirmed for ${plan.symbol}`, stop);
      }
    }
  }, 1600).unref?.();

  return { ok: true, trade, plan, orderId, raw: data.result };
}

module.exports = { executeSignal, buildExecutionPlan, cleanSignal, getTrades, saveTrades, activeTrades, setTradingStopSafe };
