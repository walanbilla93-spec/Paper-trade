'use strict';

// ORAYAN Backend Market Brain v3.3 Try 3
// Server-side leaderboard + signal engine + paper tracking.
// This is intentionally lightweight for 512MB RAM testing.

const store = require('./store');
const { bybitPublicGet } = require('./bybit');
const { getSettings } = require('./config');
const { addLog } = require('./tradeLog');

const LOOP_MS = Math.max(10000, parseInt(process.env.BACKEND_SCAN_INTERVAL_MS || '15000', 10));
const MAX_SCAN_SYMBOLS = Math.max(10, Math.min(120, parseInt(process.env.BACKEND_SCAN_SYMBOLS || '55', 10)));
const MAX_LEADERBOARD = Math.max(10, Math.min(150, parseInt(process.env.BACKEND_LEADERBOARD_LIMIT || '80', 10)));
const SIGNAL_EXPIRY_MS = Math.max(5, parseInt(process.env.SIGNAL_EXPIRY_MINUTES || '45', 10)) * 60 * 1000;
const TERMINAL = new Set(['WIN', 'LOSS', 'INVALID', 'EXPIRED']);
const ACTIVE = new Set(['DETECTED', 'ARMED', 'ACTIVE']);

let running = false;
let inFlight = false;
let lastError = '';
let lastScanAt = 0;
let timer = null;
let btcRegimeCache = { regime: 'unknown', trend5: 'unknown', trend15: 'unknown', trend1h: 'unknown', updatedAt: 0 };


function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function roundByPrice(v) {
  const x = num(v, 0);
  if (!x) return x;
  if (x < 0.0001) return Number(x.toFixed(10));
  if (x < 0.01) return Number(x.toFixed(8));
  if (x < 1) return Number(x.toFixed(6));
  if (x < 100) return Number(x.toFixed(4));
  return Number(x.toFixed(2));
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function sma(values, len) {
  if (!values.length) return 0;
  return avg(values.slice(-len));
}

function calcRsi(closes, len = 14) {
  if (closes.length < len + 1) return 50;
  let gains = 0, losses = 0;
  const slice = closes.slice(-(len + 1));
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (!losses) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function getTrendFromCloses(closes) {
  if (!Array.isArray(closes) || closes.length < 25) return 'unknown';
  const price = closes[closes.length - 1];
  const fast = sma(closes, 9);
  const slow = sma(closes, 21);
  if (price > slow && fast >= slow) return 'bull';
  if (price < slow && fast <= slow) return 'bear';
  return 'neutral';
}

async function updateBtcRegime() {
  try {
    const k5 = await fetchKline('BTCUSDT', '5', 60);
    const k15 = await fetchKline('BTCUSDT', '15', 60).catch(() => []);
    const k60 = await fetchKline('BTCUSDT', '60', 60).catch(() => []);
    const trend5 = getTrendFromCloses(k5.map(c => c.close));
    const trend15 = getTrendFromCloses(k15.map(c => c.close));
    const trend1h = getTrendFromCloses(k60.map(c => c.close));
    let regime = 'unknown';
    const bulls = [trend5, trend15, trend1h].filter(x => x === 'bull').length;
    const bears = [trend5, trend15, trend1h].filter(x => x === 'bear').length;
    if (bulls >= 2) regime = 'bull';
    else if (bears >= 2) regime = 'bear';
    else if ([trend5, trend15, trend1h].some(x => x !== 'unknown')) regime = 'mixed';
    btcRegimeCache = { regime, trend5, trend15, trend1h, updatedAt: Date.now() };
  } catch (e) {
    btcRegimeCache = { ...btcRegimeCache, regime: btcRegimeCache.regime || 'unknown', error: e.message, updatedAt: Date.now() };
  }
  return btcRegimeCache;
}

function qualityGate(leader, settings) {
  const reasons = [];
  if (!leader || !['BUY', 'SELL'].includes(leader.side)) reasons.push('NO_DIRECTION');
  if (num(leader.score) < num(settings.minScoreToTrade, 70)) reasons.push(`SCORE_LT_${settings.minScoreToTrade}`);
  if (settings.minTurnover24h && num(leader.turnover24h) < settings.minTurnover24h) reasons.push('LOW_TURNOVER');
  if (settings.rejectUnknownBtcRegime && (!leader.btcRegime || leader.btcRegime === 'unknown')) reasons.push('BTC_REGIME_UNKNOWN');
  if (leader.side === 'BUY' && leader.btcRegime === 'bear') reasons.push('BTC_BEAR_AGAINST_LONG');
  if (leader.side === 'SELL' && leader.btcRegime === 'bull') reasons.push('BTC_BULL_AGAINST_SHORT');
  if (settings.rejectTrendConflict) {
    if (leader.side === 'BUY' && (leader.trend5 === 'bear' || leader.trend15 === 'bear')) reasons.push('TREND_CONFLICT_LONG');
    if (leader.side === 'SELL' && (leader.trend5 === 'bull' || leader.trend15 === 'bull')) reasons.push('TREND_CONFLICT_SHORT');
  }
  if (settings.rejectRsiConflict) {
    if (leader.side === 'BUY' && num(leader.rsi) >= 78) reasons.push('RSI_OVERBOUGHT_ON_LONG');
    if (leader.side === 'SELL' && num(leader.rsi) <= 22) reasons.push('RSI_OVERSOLD_ON_SHORT');
  }
  if (settings.rejectVolumeDeltaConflict) {
    if (leader.side === 'BUY' && num(leader.change24h) < -8 && num(leader.volRatio) > 1.6) reasons.push('SELL_ACCEL_AGAINST_LONG');
    if (leader.side === 'SELL' && num(leader.change24h) > 8 && num(leader.volRatio) > 1.6) reasons.push('BUY_ACCEL_AGAINST_SHORT');
  }
  return { ok: reasons.length === 0, reasons };
}

function calcPaperPnl(signal, lastPrice) {
  const entry = num(signal.entry), sl = num(signal.sl), tp = num(signal.tp1), price = num(lastPrice || signal.backendLastPrice || entry);
  const qty = num(signal.qty, 0) || (num(signal.margin, getSettings().maxTradeUsdt) * num(signal.leverage, getSettings().leverage) / (entry || 1));
  const side = signal.side;
  const pnl = side === 'SELL' ? (entry - price) * qty : (price - entry) * qty;
  const toTp = side === 'SELL' ? ((price - tp) / price) * 100 : ((tp - price) / price) * 100;
  const toSl = side === 'SELL' ? ((sl - price) / price) * 100 : ((price - sl) / price) * 100;
  return { paperPnl: Number(pnl.toFixed(4)), distanceToTpPct: Number(toTp.toFixed(3)), distanceToSlPct: Number(toSl.toFixed(3)) };
}

function normalizeTicker(raw) {
  return {
    symbol: raw.symbol,
    lastPrice: num(raw.lastPrice),
    markPrice: num(raw.markPrice),
    price24hPcnt: num(raw.price24hPcnt) * 100,
    turnover24h: num(raw.turnover24h),
    volume24h: num(raw.volume24h),
    raw,
  };
}

async function fetchTickers() {
  const data = await bybitPublicGet('/v5/market/tickers', { category: 'linear' });
  const list = data.result?.list || [];
  return list
    .filter(x => x.symbol && x.symbol.endsWith('USDT') && num(x.lastPrice) > 0)
    .map(normalizeTicker);
}

async function fetchKline(symbol, interval = '5', limit = 60) {
  const data = await bybitPublicGet('/v5/market/kline', { category: 'linear', symbol, interval, limit });
  const list = data.result?.list || [];
  return list.map(r => ({
    ts: num(r[0]), open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]), volume: num(r[5]), turnover: num(r[6])
  })).sort((a, b) => a.ts - b.ts);
}

async function enrichTicker(t) {
  const k5 = await fetchKline(t.symbol, '5', 60);
  const k15 = await fetchKline(t.symbol, '15', 60).catch(() => []);
  const closes5 = k5.map(c => c.close).filter(Boolean);
  const closes15 = k15.map(c => c.close).filter(Boolean);
  const vols5 = k5.map(c => c.volume).filter(Boolean);
  const price = num(t.markPrice || t.lastPrice || closes5[closes5.length - 1]);
  const sma9 = sma(closes5, 9), sma21 = sma(closes5, 21), sma50 = sma(closes5, 50);
  const sma15_21 = sma(closes15, 21);
  const rsi = calcRsi(closes5, 14);
  const lastVol = vols5[vols5.length - 1] || 0;
  const avgVol = avg(vols5.slice(-20));
  const volRatio = avgVol ? lastVol / avgVol : 1;
  const chg5 = closes5.length > 12 ? ((price - closes5[closes5.length - 12]) / closes5[closes5.length - 12]) * 100 : 0;
  const trend5 = price > sma21 && sma9 >= sma21 ? 'bull' : price < sma21 && sma9 <= sma21 ? 'bear' : 'neutral';
  const trend15 = closes15.length && price > sma15_21 ? 'bull' : closes15.length && price < sma15_21 ? 'bear' : 'neutral';

  let side = 'NEU';
  let score = 40;
  const reasons = [];

  const bullPoints = [];
  const bearPoints = [];
  if (trend5 === 'bull') bullPoints.push(['5m trend bull', 12]);
  if (trend5 === 'bear') bearPoints.push(['5m trend bear', 12]);
  if (trend15 === 'bull') bullPoints.push(['15m trend bull', 10]);
  if (trend15 === 'bear') bearPoints.push(['15m trend bear', 10]);
  if (price > sma50) bullPoints.push(['above 5m SMA50', 6]);
  if (price < sma50) bearPoints.push(['below 5m SMA50', 6]);
  if (chg5 > 0.25) bullPoints.push(['short momentum up', Math.min(10, chg5 * 2)]);
  if (chg5 < -0.25) bearPoints.push(['short momentum down', Math.min(10, Math.abs(chg5) * 2)]);
  if (volRatio > 1.3) { bullPoints.push(['volume expansion', 4]); bearPoints.push(['volume expansion', 4]); }
  if (rsi >= 45 && rsi <= 72) bullPoints.push(['RSI usable for long', 5]);
  if (rsi >= 28 && rsi <= 55) bearPoints.push(['RSI usable for short', 5]);
  if (rsi > 82) bullPoints.push(['RSI overbought warning', -10]);
  if (rsi < 18) bearPoints.push(['RSI oversold warning', -10]);

  const bull = bullPoints.reduce((a, p) => a + p[1], 0);
  const bear = bearPoints.reduce((a, p) => a + p[1], 0);
  if (bull >= bear + 5) {
    side = 'BUY';
    score = Math.round(Math.max(0, Math.min(100, 45 + bull - Math.max(0, bear * 0.35))));
    reasons.push(...bullPoints.filter(p => p[1] > 0).map(p => p[0]));
  } else if (bear >= bull + 5) {
    side = 'SELL';
    score = Math.round(Math.max(0, Math.min(100, 45 + bear - Math.max(0, bull * 0.35))));
    reasons.push(...bearPoints.filter(p => p[1] > 0).map(p => p[0]));
  } else {
    score = Math.round(Math.max(0, Math.min(100, 40 + Math.max(bull, bear))));
    reasons.push('mixed / no clear edge');
  }

  const settings = getSettings();
  const riskPct = num(settings.defaultRiskPct, 0.008);
  const rewardPct = num(settings.defaultRewardPct, 0.016);
  const entry = roundByPrice(price);
  const sl = side === 'SELL' ? roundByPrice(entry * (1 + riskPct)) : roundByPrice(entry * (1 - riskPct));
  const tp1 = side === 'SELL' ? roundByPrice(entry * (1 - rewardPct)) : roundByPrice(entry * (1 + rewardPct));
  const tier = score >= 80 ? 'A+' : score >= 70 ? 'A' : score >= 60 ? 'B' : score >= 50 ? 'C' : 'WATCH';

  const leader = {
    sym: t.symbol,
    symbol: t.symbol,
    price: entry,
    change24h: Number(t.price24hPcnt.toFixed(2)),
    turnover24h: t.turnover24h,
    volume24h: t.volume24h,
    volRatio: Number(volRatio.toFixed(2)),
    rsi: Number(rsi.toFixed(1)),
    trend5,
    trend15,
    btcRegime: btcRegimeCache.regime,
    btcTrend5: btcRegimeCache.trend5,
    btcTrend15: btcRegimeCache.trend15,
    btcTrend1h: btcRegimeCache.trend1h,
    score,
    compositeScore: score,
    stableScore: score,
    tier,
    side,
    signal: side,
    reasons: reasons.slice(0, 8),
    plan: { entry, sl, tp1, side, rr: riskPct ? Number((rewardPct / riskPct).toFixed(2)) : 2 },
    tf: {
      '5m': { trend: trend5, score: Math.round(score * 0.45), signals: reasons.slice(0, 3) },
      '15m': { trend: trend15, score: Math.round(score * 0.35), signals: reasons.slice(0, 3) },
      '1h': { trend: 'backend', score: Math.round(score * 0.20), signals: ['server scan'] },
    },
    source: 'backend-market-brain',
    updatedAt: Date.now(),
  };
  const q = qualityGate(leader, getSettings());
  leader.quality = q.ok ? 'PASS' : 'REJECT';
  leader.rejectReasons = q.reasons;
  return leader;
}

function signalKey(s) {
  return `${s.sym}_${s.side}`;
}

function getSignals() {
  const arr = store.read('signals', []);
  return Array.isArray(arr) ? arr : [];
}

function saveSignals(arr) {
  store.write('signals', arr.slice(0, 250));
}

function appendJournal(row) {
  const rows = store.read('journal', []);
  const key = row.signalId || `${row.coin}_${row.side}_${row.entry}_${row.sl}_${row.tp1}_${row.createdAt}`;
  const exists = rows.some(r => (r.signalId && r.signalId === row.signalId) || r._dedupeKey === key);
  if (exists) return false;
  rows.unshift({ ...row, _dedupeKey: key, id: row.id || `be_j_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` });
  store.write('journal', rows.slice(0, 1000));
  return true;
}

function createSignalFromLeader(leader) {
  return {
    id: `be_${Date.now()}_${leader.sym}_${leader.side}`,
    sym: leader.sym,
    coin: leader.sym,
    side: leader.side,
    score: leader.score,
    setupScore: leader.score,
    entry: leader.plan.entry,
    sl: leader.plan.sl,
    tp1: leader.plan.tp1,
    margin: getSettings().maxTradeUsdt,
    leverage: getSettings().leverage,
    qty: leader.plan.entry ? Number(((getSettings().maxTradeUsdt * getSettings().leverage) / leader.plan.entry).toFixed(6)) : 0,
    expectedProfitUsdt: leader.plan.entry ? Number((Math.abs(leader.plan.tp1 - leader.plan.entry) * ((getSettings().maxTradeUsdt * getSettings().leverage) / leader.plan.entry)).toFixed(4)) : 0,
    expectedLossUsdt: leader.plan.entry ? Number((Math.abs(leader.plan.entry - leader.plan.sl) * ((getSettings().maxTradeUsdt * getSettings().leverage) / leader.plan.entry)).toFixed(4)) : 0,
    status: 'ACTIVE',
    signalStatus: 'ACTIVE',
    orderStatus: 'PAPER_ONLY',
    positionStatus: 'PAPER_ACTIVE',
    paper: true,
    entryHit: true,
    source: 'backend-market-brain',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expireMs: SIGNAL_EXPIRY_MS,
    reasons: leader.reasons,
    rejectReasons: leader.rejectReasons || [],
    quality: leader.quality || 'PASS',
    btcRegime: leader.btcRegime,
    trend5: leader.trend5,
    trend15: leader.trend15,
    backendLastPrice: leader.price,
    history: [{ at: Date.now(), state: 'ACTIVE', reason: 'Backend paper signal opened' }],
  };
}

function maybeOpenPaperSignals(leaders) {
  const settings = getSettings();
  const signals = getSignals();
  const activeByKey = new Set(signals.filter(s => ACTIVE.has(s.status)).map(signalKey));
  const activeSymbols = new Set(signals.filter(s => ACTIVE.has(s.status)).map(s => s.sym || s.coin));
  const recentlyClosed = new Map();
  const cooldownMs = Math.max(0, num(settings.cooldownMinutes, 30)) * 60 * 1000;
  for (const s of signals) {
    if (!TERMINAL.has(s.status)) continue;
    const k = signalKey(s);
    const t = num(s.updatedAt || s.closedAt || s.lastTransitionAt, 0);
    if (t) recentlyClosed.set(k, Math.max(recentlyClosed.get(k) || 0, t));
  }

  const activeCount = signals.filter(s => ACTIVE.has(s.status)).length;
  let slots = Math.max(0, num(settings.maxOpenTrades, 3) - activeCount);
  if (slots <= 0) return signals;

  const minScore = Math.max(0, num(settings.minScoreToTrade, 70));
  for (const l of leaders) {
    if (slots <= 0) break;
    if (!['BUY', 'SELL'].includes(l.side)) continue;
    const q = qualityGate(l, settings);
    if (!q.ok) { addLog('FILTER_SKIP', `Rejected ${l.sym} ${l.side}: ${q.reasons.join(',')}`, { score: l.score, reasons: q.reasons }); continue; }
    // FIX20b: emit CANDIDATE_SKIPPED for score gate so backend alerts match local frontend
    if (l.score < minScore) { addLog('CANDIDATE_SKIPPED', `${l.sym} ${l.side}: SCORE_LT_${minScore}`, { score: l.score, minScore }); continue; }
    if (settings.oneTradePerSymbol !== false && activeSymbols.has(l.sym)) continue;
    const k = signalKey(l);
    if (activeByKey.has(k)) continue;
    const closedAt = recentlyClosed.get(k) || 0;
    if (closedAt && Date.now() - closedAt < cooldownMs) continue;
    const sig = createSignalFromLeader(l);
    signals.unshift(sig);
    activeByKey.add(k);
    activeSymbols.add(l.sym);
    slots--;
    addLog('PAPER_OPEN', `Backend paper signal opened: ${l.sym} ${l.side}`, { score: l.score, entry: l.plan.entry, sl: l.plan.sl, tp1: l.plan.tp1 });
  }
  return signals;
}

function updateSignalLifecycle(signals, priceMap) {
  let changed = false;
  for (const s of signals) {
    if (!s || TERMINAL.has(s.status)) continue;
    const price = priceMap[s.sym] || priceMap[s.coin];
    if (!price) continue;
    const entry = num(s.entry), sl = num(s.sl), tp1 = num(s.tp1);
    const side = s.side;
    if (!entry || !sl || !tp1 || !['BUY', 'SELL'].includes(side)) continue;
    const age = Date.now() - num(s.createdAt, Date.now());
    let result = null;
    if (age > num(s.expireMs, SIGNAL_EXPIRY_MS)) result = { status: 'EXPIRED', reason: 'Backend paper signal expired' };
    if (!result && side === 'BUY' && price >= tp1) result = { status: 'WIN', reason: 'Backend paper TP hit' };
    if (!result && side === 'BUY' && price <= sl) result = { status: 'LOSS', reason: 'Backend paper SL hit' };
    if (!result && side === 'SELL' && price <= tp1) result = { status: 'WIN', reason: 'Backend paper TP hit' };
    if (!result && side === 'SELL' && price >= sl) result = { status: 'LOSS', reason: 'Backend paper SL hit' };
    if (!result) {
      s.backendLastPrice = roundByPrice(price);
      Object.assign(s, calcPaperPnl(s, price));
      s.updatedAt = Date.now();
      continue;
    }
    s.status = result.status;
    s.signalStatus = result.status;
    s.positionStatus = 'PAPER_CLOSED';
    s.orderStatus = s.orderStatus || 'PAPER_ONLY';
    s.exitPx = roundByPrice(price);
    Object.assign(s, calcPaperPnl(s, price));
    s.closePrice = roundByPrice(price);
    s.closedAt = Date.now();
    s.updatedAt = Date.now();
    s.stateReason = result.reason;
    if (!Array.isArray(s.history)) s.history = [];
    s.history.push({ at: Date.now(), state: result.status, reason: result.reason, price: s.exitPx });
    changed = true;
    addLog(result.status === 'WIN' ? 'PAPER_WIN' : 'PAPER_LOSS', `${s.sym} ${side} ${result.status}`, { signalId: s.id, exitPx: s.exitPx });
    appendJournal({
      signalId: s.id,
      time: new Date().toLocaleString(),
      coin: s.sym,
      side,
      entry,
      sl,
      tp1,
      result: result.status,
      entryHit: true,
      autoSaved: true,
      paper: true,
      source: 'backend-market-brain',
      closePrice: s.exitPx,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
  }
  return changed;
}

function summarize(signals) {
  const current = signals.filter(s => s && s.source === 'backend-market-brain');
  const wins = current.filter(s => s.status === 'WIN').length;
  const losses = current.filter(s => s.status === 'LOSS').length;
  const active = current.filter(s => ACTIVE.has(s.status)).length;
  const closed = wins + losses;
  return {
    source: 'backend-market-brain',
    active,
    wins,
    losses,
    closed,
    hitRate: closed ? Math.round((wins / closed) * 100) : 0,
    total: current.length,
  };
}

async function scanOnce() {
  if (inFlight) return store.read('leaderboard', { ok: false, busy: true });
  inFlight = true;
  try {
    const started = Date.now();
    const settings = getSettings();
    await updateBtcRegime();
    const tickers = await fetchTickers();
    const sorted = tickers
      .filter(t => t.turnover24h > 0)
      .sort((a, b) => ((b.turnover24h || 0) * (1 + Math.abs(b.price24hPcnt || 0) / 100)) - ((a.turnover24h || 0) * (1 + Math.abs(a.price24hPcnt || 0) / 100)))
      .slice(0, MAX_SCAN_SYMBOLS);

    const leaders = [];
    for (const t of sorted) {
      try {
        leaders.push(await enrichTicker(t));
        await new Promise(r => setTimeout(r, 60));
      } catch (e) {
        addLog('WARN', `Backend scan skipped ${t.symbol}: ${e.message}`);
      }
    }

    leaders.sort((a, b) => (b.score + Math.abs(b.change24h) * 0.5 + b.volRatio) - (a.score + Math.abs(a.change24h) * 0.5 + a.volRatio));
    const entries = leaders.slice(0, MAX_LEADERBOARD);
    const priceMap = Object.fromEntries(entries.map(e => [e.sym, e.price]));

    let signals = getSignals();
    // Paper tracking always works in PAPER mode, even when real trading is disabled.
    if (settings.botMode === 'PAPER_REAL_PRICE') {
      signals = maybeOpenPaperSignals(entries);
    }
    updateSignalLifecycle(signals, priceMap);
    signals.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    saveSignals(signals);

    const snapshot = {
      ok: true,
      ts: Date.now(),
      durationMs: Date.now() - started,
      mode: settings.botMode,
      tradingEnabled: !!settings.tradingEnabled,
      scanIntervalMs: LOOP_MS,
      btcRegime: btcRegimeCache,
      maxScanSymbols: MAX_SCAN_SYMBOLS,
      entries,
      summary: summarize(signals),
      lastError: '',
    };
    store.write('leaderboard', snapshot);
    lastScanAt = snapshot.ts;
    lastError = '';
    return snapshot;
  } catch (e) {
    lastError = e.message;
    addLog('ERROR', `Backend market scan failed: ${e.message}`);
    const prev = store.read('leaderboard', { ok: false, entries: [] });
    const snapshot = { ...prev, ok: false, lastError, ts: prev.ts || Date.now() };
    store.write('leaderboard', snapshot);
    return snapshot;
  } finally {
    inFlight = false;
  }
}

function getSnapshot() {
  return store.read('leaderboard', { ok: false, ts: 0, entries: [], summary: summarize(getSignals()), lastError });
}

function start() {
  if (running) return;
  running = true;
  setTimeout(() => scanOnce().catch(e => addLog('ERROR', `Initial market scan failed: ${e.message}`)), 2500);
  timer = setInterval(() => scanOnce().catch(e => addLog('ERROR', `Market scan failed: ${e.message}`)), LOOP_MS);
  console.log(`[marketBrain] Backend leaderboard + paper engine started — interval: ${LOOP_MS / 1000}s, symbols: ${MAX_SCAN_SYMBOLS}`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}

module.exports = { start, stop, scanOnce, getSnapshot, summarize, qualityGate, updateBtcRegime };
