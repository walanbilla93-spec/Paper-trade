'use strict';

const { v4: uuidv4 } = require('uuid');
const store = require('./store');
const { getSettings } = require('./config');
const { bybitPost, bybitGet } = require('./bybit');
const { normalizeSymbol, getInstrumentInfo, getBybitPrice } = require('./instruments');
const { toNum, roundToStep, floorToStep, ceilToStep, pctDistance } = require('./math');
const { addLog } = require('./tradeLog');
let qualityGate; try { qualityGate = require('./marketBrain').qualityGate; } catch(e) { qualityGate = null; }

// fix44c: cache Bybit account type at startup to skip setIsolatedMarginSafe on UTA accounts
let _cachedAccountType = null;
async function getAccountType() {
  if (_cachedAccountType) return _cachedAccountType;
  try {
    const data = await bybitPost('/v5/account/info', {});
    _cachedAccountType = data?.result?.unifiedMarginStatus === 1 ? 'UNIFIED' :
                         (data?.result?.marginMode || data?.result?.accountType || 'CLASSIC');
    addLog('INFO', `Bybit account type detected: ${_cachedAccountType}`, { result: data?.result });
  } catch (e) {
    _cachedAccountType = 'UNKNOWN';
    addLog('WARN', `Account type detection failed: ${e.message}`);
  }
  return _cachedAccountType;
}

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

  // fix49b: Entry placement + SL/TP sourcing rewrite
  //
  // PROBLEM (discovered in live trade PIPPINUSDT 2026-06-08):
  //   buildExecutionPlan was fetching bybitPrice at execution time, detecting hardDrift (>0.5%),
  //   then placing the limit at bybitPrice AND recomputing SL/TP as percentages of that new entry.
  //   Result: real Bybit order had completely different entry/SL/TP than what the UI showed.
  //   UI showed signal values; Bybit had execution-recalculated values. Silent mismatch.
  //
  // FIX — two rules:
  //   1. HARD DRIFT → REJECT. If price has moved >0.5% past signal.entry, the signal is stale.
  //      Do not chase. Throw so the caller logs and skips. Real systems never chase.
  //   2. SL/TP ARE ABSOLUTE LEVELS, not percentages. They are set by market structure (ATR,
  //      key levels). When entry is micro-adjusted (smart limit), SL and TP do NOT move with it —
  //      they stay at signal.sl / signal.tp1. Only entry shifts slightly for fill quality.
  //      Fallback to percentage-based only when signal provides no SL/TP.

  let rawEntry;
  if (useMarket) {
    rawEntry = bybitPrice;
  } else if (signal.entry > 0) {
    const drift = (bybitPrice - signal.entry) / signal.entry;
    const atr = toNum(signal.keyLevels?.atr || signal.planner?.keyLevels?.atr, 0);
    const hardDrift = side === 'BUY' ? drift > 0.005 : drift < -0.005; // >0.5% past entry
    if (hardDrift) {
      // fix49b: REJECT stale signal — do not chase. Caller catches and skips.
      const pct = (drift * 100).toFixed(2);
      addLog('ENTRY_DRIFT_REJECTED', `${signal.sym} ${side}: ${pct}% past entry (${signal.entry}) at bybitPrice ${bybitPrice} — signal too stale, skipping`);
      throw new Error(`ENTRY_DRIFT: ${signal.sym} price moved ${pct}% past signal entry — signal stale, not chasing`);
    } else if (atr > 0) {
      // Standard case: price in zone — nudge 0.15 ATR behind current price for fill quality
      const pullbackOffset = atr * 0.15;
      rawEntry = side === 'BUY'
        ? Math.max(signal.entry, bybitPrice - pullbackOffset)
        : Math.min(signal.entry, bybitPrice + pullbackOffset);
      addLog('ENTRY_SMART_LIMIT', `${signal.sym} ${side}: placing at ${rawEntry.toFixed(6)} (bybitPrice ${bybitPrice} ± 0.15 ATR ${atr.toFixed(6)})`);
    } else {
      rawEntry = signal.entry;
    }
  } else {
    rawEntry = bybitPrice;
  }

  // fix49b: SL/TP use signal's absolute levels (structure-based). Only fall back to
  // percentage math when signal provides no SL/TP (should not happen for planner signals).
  let rawTp, rawSl;
  const hasSignalLevels = signal.sl > 0 && signal.tp1 > 0;
  if (hasSignalLevels) {
    rawSl = signal.sl;
    rawTp = signal.tp1;
    addLog('LEVELS_FROM_SIGNAL', `${signal.sym} ${side}: using signal SL=${signal.sl} TP=${signal.tp1} (entry nudged to ${rawEntry})`);
  } else {
    // Fallback: percentage-based (only for manually-constructed signals with no levels)
    if (side === 'BUY') {
      rawTp = rawEntry * (1 + rewardPct);
      rawSl = rawEntry * (1 - riskPct);
    } else {
      rawTp = rawEntry * (1 - rewardPct);
      rawSl = rawEntry * (1 + riskPct);
    }
    addLog('LEVELS_PCT_FALLBACK', `${signal.sym} ${side}: no signal SL/TP — using percentage fallback SL=${rawSl.toFixed(6)} TP=${rawTp.toFixed(6)}`);
  }

  // Direction-aware rounding: TP a little less greedy, SL a little conservative.
  const entry = roundToStep(rawEntry, info.tickSize);
  const tp1 = side === 'BUY' ? floorToStep(rawTp, info.tickSize) : ceilToStep(rawTp, info.tickSize);
  const sl = side === 'BUY' ? floorToStep(rawSl, info.tickSize) : ceilToStep(rawSl, info.tickSize);

  const margin = Math.max(1, toNum(signal.margin, settings.maxTradeUsdt));
  const leverage = Math.max(1, Math.min(25, parseInt(signal.leverage || settings.leverage, 10) || settings.leverage));
  const positionUsdt = margin * leverage;   // margin ceiling — a position may never exceed this

  // ── fixSIZE: RISK-NORMALIZED POSITION SIZING (live side — mirrors calculatePaperMath) ──────────
  // Was: qty = positionUsdt / entry — FIXED NOTIONAL. See the long note in calculatePaperMath.
  // Short version: constant notional + variable stop distance = VARIABLE dollar risk per trade, so a
  // 2:1 edge in R never lands as 2:1 in the account. Size on risk instead:
  //     qty = riskPerTradeUsdt / |entry - sl|
  // min() against the margin cap means qty can only ever be <= the old value: this change is strictly
  // risk-REDUCING. Tight-stop trades bind on the margin cap and are unchanged; wide-stop trades (the
  // ones that were silently 2.5x oversized) shrink. If the cap binds, the trade risks LESS than
  // target — conservative, never more.
  const stopDistance = Math.abs(entry - sl);
  const riskPerTrade = Math.max(0, toNum(settings.v4RiskPerTradeUsdt, 0));
  const marginCapQty = positionUsdt / entry;
  let qty;
  let sizingMode = 'FIXED_NOTIONAL';
  if (riskPerTrade > 0 && stopDistance > 0) {
    const riskQty = riskPerTrade / stopDistance;
    qty = floorToStep(Math.min(riskQty, marginCapQty), info.qtyStep);
    sizingMode = riskQty > marginCapQty ? 'RISK_MARGIN_CAPPED' : 'RISK';
  } else {
    qty = floorToStep(marginCapQty, info.qtyStep);
  }

  if (info.minOrderQty && qty < info.minOrderQty) qty = ceilToStep(info.minOrderQty, info.qtyStep);
  if (info.minNotionalValue && qty * entry < info.minNotionalValue) {
    qty = ceilToStep(info.minNotionalValue / entry, info.qtyStep);
  }
  // fix49f (audit): RISK GUARD — exchange minimums (minOrderQty/minNotional) can silently bump qty
  // far above the intended margin*leverage position. Reject if effective position exceeds 2x intent:
  // better to skip an oversized trade than to take risk the user never sized for.
  const effectivePositionUsdt = qty * entry;
  if (effectivePositionUsdt > positionUsdt * 2) {
    addLog('RISK_GUARD_REJECT', `${symbol} ${side}: exchange minimums force position ${effectivePositionUsdt.toFixed(2)}U > 2x intended ${positionUsdt.toFixed(2)}U — skipping`, { qty, entry, minOrderQty: info.minOrderQty, minNotionalValue: info.minNotionalValue });
    throw new Error(`RISK_GUARD: ${symbol} exchange minimum forces ${effectivePositionUsdt.toFixed(0)}U position vs intended ${positionUsdt.toFixed(0)}U — oversized, skipping`);
  }
  if (info.maxMktOrderQty && useMarket && qty > info.maxMktOrderQty) qty = floorToStep(info.maxMktOrderQty, info.qtyStep);
  if (info.maxOrderQty && qty > info.maxOrderQty) qty = floorToStep(info.maxOrderQty, info.qtyStep);
  if (!qty || qty <= 0) throw new Error(`Invalid qty for ${symbol}`);

  // fixSIZE: the exchange minimums above (minOrderQty / minNotionalValue) can force qty UPWARD, past
  // the risk target — silently re-creating the exact oversizing this fix exists to kill. The fix49f
  // guard only catches oversize in NOTIONAL terms, which is blind to stop distance: a small notional
  // with a wide stop can still blow the risk budget. Guard in RISK terms too. Rejecting a trade we
  // cannot size correctly is always better than taking risk the account never agreed to.
  if (riskPerTrade > 0 && stopDistance > 0) {
    const actualRiskUsdt = qty * stopDistance;
    if (actualRiskUsdt > riskPerTrade * 1.5) {
      addLog('RISK_GUARD_REJECT', `${symbol} ${side}: exchange minimum forces ${actualRiskUsdt.toFixed(3)}U risk > 1.5x target ${riskPerTrade.toFixed(3)}U — skipping`, { qty, stopDistance, riskPerTrade, minOrderQty: info.minOrderQty, minNotionalValue: info.minNotionalValue });
      throw new Error(`RISK_GUARD: ${symbol} min-qty forces ${actualRiskUsdt.toFixed(3)}U risk vs ${riskPerTrade.toFixed(3)}U target — skipping`);
    }
  }

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
    sizingMode,                                                        // fixSIZE: RISK | RISK_MARGIN_CAPPED | FIXED_NOTIONAL
    riskPerTradeUsdt: riskPerTrade,                                     // fixSIZE: the target
    actualRiskUsdt: Number((qty * stopDistance).toFixed(4)),            // fixSIZE: what we actually risk
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

// ── fix56: DUPLICATE-ORDER PREVENTION (3 layers, defense in depth) ─────────────────────────────
// Live bug (4.6.8.53): two LIT limits + a doubled H short executed simultaneously. Two root causes:
//   (1) the random orderLinkId suffix meant a re-submission of the SAME signal (next-cycle re-fire,
//       or a timeout-but-succeeded retry) reached Bybit as a brand-new id → Bybit executed both.
//   (2) no one-per-symbol guard on the live placement paths, and the local guard scanned only
//       ACTIVE_TRADE_STATES which excludes the reconciler's 'ORDER_PENDING_FILL' → resting limits
//       were invisible, so a 2nd signal on the same symbol placed a 2nd order.
//
// LAYER 1 — idempotent orderLinkId: deterministic per signal. Bybit rejects a re-submission with
//           retCode 110072 ('duplicate orderLinkId'), which we treat as a benign skip. Makes
//           double-execution of one signal structurally impossible at the exchange.
// LAYER 2 — in-flight symbol lock: blocks two placements for one symbol within the same process
//           BEFORE either is visible on Bybit (the seconds-apart race that doubled H).
// LAYER 3 — Bybit pre-placement query (authoritative): refuses if the symbol already has an open
//           order OR position. FAIL-CLOSED on any query error — a missed entry is cheap, a duplicate
//           live order is not. Local paper/PENDING state is NOT trusted (it drifts from Bybit truth).
function buildOrderLinkId(signalId) {
  return ('orayan_' + String(signalId)).replace(/[^a-zA-Z0-9_-]/g, '').slice(-36); // keep unique tail, ≤36
}
function isDuplicateOrderLinkId(data) {
  if (!data) return false;
  if (data.retCode === 110072) return true;
  const m = String(data.retMsg || '').toLowerCase();
  return m.includes('orderlinkid') && (m.includes('exist') || m.includes('duplicat'));
}
const _inFlightSymbols = new Set();
async function symbolHasLiveExposure(symbol) {
  const sym = normalizeSymbol(symbol);
  const ordRes = await bybitGet('/v5/order/realtime', { category: 'linear', symbol: sym });
  if (!ordRes || ordRes.retCode !== 0) throw new Error(`order/realtime check failed: ${ordRes && ordRes.retMsg}`);
  const liveOrders = ((ordRes.result && ordRes.result.list) || []).filter(o =>
    ['New', 'PartiallyFilled', 'Untriggered', 'Triggered'].includes(String(o.orderStatus || '')));
  if (liveOrders.length > 0) return { occupied: true, why: `${liveOrders.length} open order(s) on Bybit` };
  const posRes = await bybitGet('/v5/position/list', { category: 'linear', symbol: sym });
  if (!posRes || posRes.retCode !== 0) throw new Error(`position/list check failed: ${posRes && posRes.retMsg}`);
  const openPos = ((posRes.result && posRes.result.list) || []).filter(p => Math.abs(toNum(p.size, 0)) > 0);
  if (openPos.length > 0) return { occupied: true, why: `open position size ${openPos[0].size}` };
  return { occupied: false };
}

function canTradeSignal(signal, settings, trades) {
  if (!settings.tradingEnabled) return { ok: false, reason: 'Backend trading is disabled' };
  if (settings.botMode === 'LIVE_REAL_BYBIT' && process.env.CONFIRM_LIVE_TRADING !== 'true') {
    return { ok: false, reason: 'Live trading is locked. Set CONFIRM_LIVE_TRADING=true to unlock.' };
  }
  if (toNum(signal.score, 0) < settings.minScoreToTrade) {
    return { ok: false, reason: `Score ${signal.score} < MIN_SCORE_TO_TRADE ${settings.minScoreToTrade}` };
  }
  // fix44c: qualityGate now gated by safeFilters setting. safeFilters=false → skip gate entirely.
  // This unblocks SELL execution (BEL_BM was silently rejecting all SELLs regardless of UI toggle).
  if (qualityGate && settings.safeFilters !== false) {
    const q = qualityGate(signal, settings);
    if (!q.ok) return { ok: false, reason: `Quality filter rejected: ${q.reasons.join(',')}` };
  }
  // fix47: normalize timestamps — signal fields may be ISO strings ("2026-05-31T12:00:00Z")
  // or numeric ms. Number("2026-...") = NaN → 0 → age check silently bypassed.
  // new Date(value).getTime() handles both formats correctly.
  const maxAgeMs = Math.max(1, Number(settings.maxSignalAgeMinutes || 3)) * 60 * 1000;
  const _rawTs = signal.openedAt || signal.updatedAt || signal.createdAt || 0;
  const sigTime = _rawTs ? new Date(_rawTs).getTime() : 0;
  if (sigTime && isFinite(sigTime) && Date.now() - sigTime > maxAgeMs) {
    return { ok: false, reason: `Signal too old for auto-trade (${settings.maxSignalAgeMinutes || 3}m max)` };
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

// fix44a: hardcoded isolated margin — called before every live trade
async function setIsolatedMarginSafe(symbol, leverage) {
  try {
    const data = await bybitPost('/v5/position/switch-isolated', {
      category: 'linear',
      symbol,
      tradeMode: 1, // 1 = isolated, 0 = cross
      buyLeverage: String(leverage),
      sellLeverage: String(leverage),
    });
    // retCode 110026 = already isolated — not an error
    if (![0, 110026].includes(data.retCode)) {
      addLog('WARN', `Isolated margin set warning for ${symbol}: ${data.retMsg}`, { retCode: data.retCode });
    }
    return data;
  } catch (e) {
    addLog('WARN', `Isolated margin set failed for ${symbol}: ${e.message}`);
    return { retCode: -1, retMsg: e.message };
  }
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
  // Guard: never send 0 for TP or SL — Bybit treats "0" as "clear this level", which
  // would silently remove an existing live TP/SL and leave the position unprotected.
  if (!plan.tp1 || !plan.sl || plan.tp1 <= 0 || plan.sl <= 0) {
    addLog('WARN', `setTradingStopSafe skipped for ${plan.symbol}: tp1=${plan.tp1} sl=${plan.sl} — zero or missing level`);
    return { ok: false, error: 'ZERO_OR_MISSING_TP_SL', skipped: true };
  }
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

  // fix49b: buildExecutionPlan throws on ENTRY_DRIFT — treat as a clean skip
  let plan;
  try {
    plan = await buildExecutionPlan(signal, { settings, forceMarket: opts.forceMarket });
  } catch (e) {
    const isDriftReject = e.message && e.message.startsWith('ENTRY_DRIFT');
    addLog(isDriftReject ? 'SKIP' : 'ERROR', `buildExecutionPlan failed for ${signal.sym}: ${e.message}`, { signal });
    return { ok: false, skipped: isDriftReject, error: e.message };
  }
  const orderLinkId = buildOrderLinkId(signal.id); // fix56 LAYER 1: deterministic = exchange-level idempotency

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
    return { ok: true, paper: true, tradeId: trade.id, trade, plan, orderId: null, raw: null }; // fix59: surface tradeId so signal.tradeId links (paper ledger reconcile)
  }

  // fix56 LAYER 2+3: one-per-symbol guard for the LIVE path (paper returned above).
  const _symU = normalizeSymbol(plan.symbol);
  if (_inFlightSymbols.has(_symU)) {
    addLog('SKIP_DUPLICATE', `${_symU}: placement already in-flight — skipping (one-per-symbol)`, { signalId: signal.id });
    return { ok: false, skipped: true, error: 'SYMBOL_PLACEMENT_IN_FLIGHT' };
  }
  _inFlightSymbols.add(_symU);
  try {
    const _exp = await symbolHasLiveExposure(_symU).catch(e => ({ error: e.message }));
    if (_exp && _exp.error) {
      addLog('SKIP_GUARD_FAIL', `${_symU}: cannot verify symbol free (${_exp.error}) — failing CLOSED, skipping`, { signalId: signal.id });
      return { ok: false, skipped: true, error: `GUARD_CHECK_FAILED: ${_exp.error}` };
    }
    if (_exp && _exp.occupied) {
      addLog('SKIP_DUPLICATE', `${_symU}: already live (${_exp.why}) — skipping (one-per-symbol)`, { signalId: signal.id });
      return { ok: false, skipped: true, error: `SYMBOL_ALREADY_LIVE: ${_exp.why}` };
    }

  // fix44c: skip isolated margin for UTA (Unified Trading Account) — not supported
  const accountType = await getAccountType();
  if (accountType !== 'UNIFIED') {
    await setIsolatedMarginSafe(plan.symbol, plan.leverage);
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
  if (isDuplicateOrderLinkId(data)) {
    addLog('SKIP_DUPLICATE', `${plan.symbol}: Bybit reports orderLinkId already exists — idempotent skip (order already placed by a prior attempt)`, { orderLinkId, retMsg: data.retMsg });
    return { ok: false, skipped: true, duplicate: true, error: 'DUPLICATE_ORDERLINKID', plan, raw: data };
  }
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
    // fix39/H-6: wrapped in try/catch — unhandled rejection here left trades with no TP/SL silently
    try {
      const stop = await setTradingStopSafe(plan);
      const ts = getTrades();
      if (ts[tradeId]) {
        ts[tradeId].tpslSetAttemptedAt = Date.now();
        ts[tradeId].tpslAttached = !!stop.ok;
        ts[tradeId].tpslResult = stop;
        ts[tradeId].updatedAt = Date.now();
        saveTrades(ts);
        if (!stop.ok && plan.orderType === 'Market') {
          addLog('WARN', `TP/SL attach not confirmed for ${plan.symbol}`, stop);
        }
      }
    } catch (e) {
      addLog('ERROR', `TP/SL setTimeout threw for ${plan.symbol}: ${e.message}`, { tradeId, plan });
    }
  }, 1600).unref?.();

  return { ok: true, tradeId: trade.id, trade, plan, orderId, raw: data.result }; // fix59: surface tradeId so v4Brain sites link signal.tradeId -> fix57 live authority activates
  } finally {
    _inFlightSymbols.delete(_symU); // fix56 LAYER 2: release once the order is on Bybit (or we bailed)
  }
}

module.exports = { executeSignal, placeLimitAtEntry, buildExecutionPlan, cleanSignal, getTrades, saveTrades, activeTrades, setTradingStopSafe };

// fix49c: Place a GTC limit order at signal.entry the moment a signal enters WAITING_ENTRY/WAITING_REACTION.
//
// DESIGN INTENT:
//   The current executeSignal() fires at PAPER_ACTIVE (price already confirmed entry + direction).
//   By that point, 10-30 seconds of scan lag means price has drifted from the structural entry level.
//   This function places the limit EARLIER, at the exact structure level the planner computed,
//   and parks it on Bybit as GTC. Price comes to us — no drift, maker fill, exact level.
//
// LIFECYCLE managed by reconciler.js (15s cycle):
//   PENDING          → limit sitting on Bybit, not yet filled
//   POSITION_OPEN    → Bybit filled — TP/SL already attached on order create body
//   signalInvalidated=true → reconciler cancels via cancelBybitOrder() within 15s
//   isWaitingLimit=true    → extended stale-timeout (50min vs pendingTimeoutMinutes default)
//
// CALLED FROM: v4Brain.js scanOnce() for WAITING states only.
// executeSignal() handles PAPER_ACTIVE unchanged — these two paths never overlap (liveOrderId guard).
async function placeLimitAtEntry(signalInput, opts = {}) {
  const settings = { ...getSettings(), ...(opts.settings || {}) };
  const signal = cleanSignal(signalInput);

  if (settings.botMode !== 'LIVE_REAL_BYBIT') return { ok: false, skipped: true, error: 'Not LIVE_REAL_BYBIT' };
  if (!settings.tradingEnabled) return { ok: false, skipped: true, error: 'tradingEnabled=false' };
  if (!signal.sym) return { ok: false, error: 'Symbol missing' };
  if (!(signal.entry > 0)) return { ok: false, error: 'Entry missing or zero' };
  if (!(signal.sl > 0)) return { ok: false, error: 'SL missing or zero' };
  if (!(signal.tp1 > 0)) return { ok: false, error: 'TP missing or zero' };

  const side = signal.side;
  const bybitSide = side === 'SELL' ? 'Sell' : 'Buy';

  // fix56 LAYER 2+3: one-per-symbol guard for the resting-limit path (this path had NO guard at all).
  const _symU = normalizeSymbol(signal.sym);
  if (_inFlightSymbols.has(_symU)) {
    addLog('SKIP_DUPLICATE', `${_symU}: placement already in-flight — skipping (one-per-symbol)`, { signalId: signal.id });
    return { ok: false, skipped: true, error: 'SYMBOL_PLACEMENT_IN_FLIGHT' };
  }
  _inFlightSymbols.add(_symU);
  try {
    const _exp = await symbolHasLiveExposure(_symU).catch(e => ({ error: e.message }));
    if (_exp && _exp.error) {
      addLog('SKIP_GUARD_FAIL', `${_symU}: cannot verify symbol free (${_exp.error}) — failing CLOSED, skipping`, { signalId: signal.id });
      return { ok: false, skipped: true, error: `GUARD_CHECK_FAILED: ${_exp.error}` };
    }
    if (_exp && _exp.occupied) {
      addLog('SKIP_DUPLICATE', `${_symU}: already live (${_exp.why}) — skipping (one-per-symbol)`, { signalId: signal.id });
      return { ok: false, skipped: true, error: `SYMBOL_ALREADY_LIVE: ${_exp.why}` };
    }
    const info = await getInstrumentInfo(signal.sym);

    // Use signal's absolute structural levels — no bybitPrice, no drift
    const entry = roundToStep(signal.entry, info.tickSize);
    const sl    = side === 'BUY' ? floorToStep(signal.sl,  info.tickSize) : ceilToStep(signal.sl,  info.tickSize);
    const tp1   = side === 'BUY' ? floorToStep(signal.tp1, info.tickSize) : ceilToStep(signal.tp1, info.tickSize);

    if (side === 'BUY'  && sl >= entry) throw new Error(`BUY SL ${sl} >= entry ${entry} after tick-rounding`);
    if (side === 'SELL' && sl <= entry) throw new Error(`SELL SL ${sl} <= entry ${entry} after tick-rounding`);
    if (entry <= 0 || sl <= 0 || tp1 <= 0) throw new Error(`Zero level: entry=${entry} sl=${sl} tp1=${tp1}`);

    // fix49f (audit, Option 2 from tick-gap diagnosis): log entry vs live price vs tickSize at
    // placement time. No behavior change — pure diagnostic for fill-quality analysis (how many
    // ticks the limit sits from market when placed; correlate later with fill/no-fill outcomes).
    try {
      const _livePx = await getBybitPrice(signal.sym);
      const _tick = toNum(info.tickSize, 0);
      const _gapTicks = _tick > 0 && _livePx > 0 ? ((_livePx - entry) / _tick).toFixed(1) : 'n/a';
      addLog('TICK_GAP', `${signal.sym} ${side}: entry=${entry} livePx=${_livePx} tickSize=${info.tickSize} gap=${_gapTicks} ticks`, { entry, livePx: _livePx, tickSize: info.tickSize, gapTicks: _gapTicks });
    } catch (_e) { /* diagnostic only — never block placement */ }

    const margin   = Math.max(1, toNum(signal.margin, settings.maxTradeUsdt));
    const leverage = Math.max(1, Math.min(25, parseInt(signal.leverage || settings.leverage, 10) || settings.leverage));
    const positionUsdt = margin * leverage;
    // fixSIZE: second sizing site — MUST mirror buildPlan or half the orders keep the old bug.
    // Same rule: qty = riskPerTradeUsdt / stopDistance, hard-capped by the margin ceiling, so the
    // position can only shrink relative to the old fixed-notional behaviour, never grow.
    const _stopDistance = Math.abs(entry - sl);
    const _riskPerTrade = Math.max(0, toNum(settings.v4RiskPerTradeUsdt, 0));
    const _marginCapQty = positionUsdt / entry;
    let qty = (_riskPerTrade > 0 && _stopDistance > 0)
      ? floorToStep(Math.min(_riskPerTrade / _stopDistance, _marginCapQty), info.qtyStep)
      : floorToStep(_marginCapQty, info.qtyStep);
    if (info.minOrderQty && qty < info.minOrderQty) qty = ceilToStep(info.minOrderQty, info.qtyStep);
    if (info.minNotionalValue && qty * entry < info.minNotionalValue) qty = ceilToStep(info.minNotionalValue / entry, info.qtyStep);
    if (info.maxOrderQty && qty > info.maxOrderQty) qty = floorToStep(info.maxOrderQty, info.qtyStep);
    if (!qty || qty <= 0) throw new Error(`Invalid qty for ${signal.sym}`);

    const accountType = await getAccountType();
    if (accountType !== 'UNIFIED') await setIsolatedMarginSafe(signal.sym, leverage);
    await setLeverageSafe(signal.sym, leverage);

    const orderLinkId = buildOrderLinkId(signal.id); // fix56 LAYER 1: deterministic = exchange-level idempotency

    const body = {
      category:       'linear',
      symbol:         signal.sym,
      side:           bybitSide,
      orderType:      'Limit',
      qty:            String(qty),
      price:          String(entry),
      timeInForce:    'GTC',
      orderLinkId,
      reduceOnly:     false,
      closeOnTrigger: false,
      takeProfit:     String(tp1),
      stopLoss:       String(sl),
      tpslMode:       'Full',
      tpOrderType:    'Market',
      slOrderType:    'Market',
    };

    addLog('WAITING_LIMIT_ATTEMPT', `GTC Limit ${bybitSide} ${signal.sym} @ ${entry} qty ${qty}`, { body, signalId: signal.id });
    const data = await bybitPost('/v5/order/create', body);

    if (isDuplicateOrderLinkId(data)) {
      addLog('SKIP_DUPLICATE', `${signal.sym}: Bybit reports orderLinkId already exists — idempotent skip (limit already placed by a prior attempt)`, { orderLinkId, retMsg: data.retMsg });
      return { ok: false, skipped: true, duplicate: true, error: 'DUPLICATE_ORDERLINKID' };
    }
    if (data.retCode !== 0) {
      addLog('WAITING_LIMIT_REJECTED', `Bybit rejected ${signal.sym}: ${data.retMsg}`, { retCode: data.retCode, body });
      return { ok: false, error: data.retMsg, retCode: data.retCode };
    }

    const orderId = data.result?.orderId || '';
    const tradeId = `wl_${Date.now()}_${uuidv4().slice(0, 8)}`;

    const trade = {
      id:             tradeId,
      orderId,
      orderLinkId,
      signalId:       signal.id,
      symbol:         signal.sym,
      side,
      bybitSide,
      status:         'PENDING',
      signalStatus:   'WAITING',
      orderStatus:    'Submitted',
      positionStatus: 'NONE',
      tpslStatus:     'ATTACHED_ON_ORDER',
      orderType:      'Limit',
      isWaitingLimit: true,       // tells reconciler to use 50min stale-timeout not pendingTimeoutMinutes
      entry,
      signalEntry:    signal.entry || null,
      sl,
      tp1,
      qty,
      margin,
      leverage,
      positionUsdt,
      botMode:        settings.botMode,
      testnet:        settings.testnet !== false,
      placedAt:       Date.now(),
      updatedAt:      Date.now(),
      source:         'backend-waiting-limit',
      signalSnapshot: signal,
    };

    const trades = getTrades();
    trades[tradeId] = trade;
    saveTrades(trades);
    addLog('WAITING_LIMIT_PLACED', `GTC limit placed ${signal.sym} ${side} @ ${entry}`, { tradeId, orderId, qty, sl, tp1 });

    return { ok: true, orderId, tradeId, trade };

  } catch (e) {
    addLog('WAITING_LIMIT_ERROR', `placeLimitAtEntry threw for ${signal.sym}: ${e.message}`, { signalId: signal.id });
    return { ok: false, error: e.message };
  } finally {
    _inFlightSymbols.delete(_symU); // fix56 LAYER 2: release once the order is on Bybit (or we bailed)
  }
}
