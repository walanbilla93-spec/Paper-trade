'use strict';

/**
 * ORAYAN v4 Backend Paper Signal Engine
 *
 * The frontend is now a dashboard. This engine runs in the backend:
 * - fetches market data
 * - builds structure/SR based paper plans
 * - tracks entry, TP, SL, expiry
 * - stores paper signals and stats
 *
 * No Bybit orders are placed here. Live/testnet execution remains disabled
 * until a separate execution phase is explicitly enabled.
 */

const store = require('./store');
const axios = require('axios');
const { getSettings } = require('./config');
const { addLog } = require('./tradeLog');

const LOOP_MS = Math.max(15000, parseInt(process.env.V4_SCAN_INTERVAL_MS || process.env.BACKEND_SCAN_INTERVAL_MS || '20000', 10));
const MAX_SYMBOLS = Math.max(20, Math.min(160, parseInt(process.env.V4_SCAN_SYMBOLS || process.env.BACKEND_SCAN_SYMBOLS || '80', 10)));
const MAX_SIGNALS = Math.max(40, Math.min(250, parseInt(process.env.V4_MAX_SIGNALS || '120', 10)));
const MAX_LEDGER = Math.max(500, Math.min(20000, parseInt(process.env.V4_MAX_LEDGER || '5000', 10)));
const RECENT_LEDGER_LIMIT = Math.max(50, Math.min(1000, parseInt(process.env.V4_RECENT_LEDGER_LIMIT || '250', 10)));
const MIN_RR = Math.max(1.2, Number(process.env.V4_MIN_RR || '2.0'));
const MIN_SELL_RR = Math.max(MIN_RR, Number(process.env.V4_MIN_SELL_RR || '2.0'));
const MIN_NET_TP = Math.max(0, Number(process.env.V4_MIN_NET_TP_USDT || '0.05'));
const ENTRY_TOLERANCE_ATR = Math.max(0.05, Number(process.env.V4_ENTRY_TOLERANCE_ATR || '0.25'));
const ENTRY_TOLERANCE_MIN_PCT = Math.max(0.01, Number(process.env.V4_ENTRY_TOLERANCE_MIN_PCT || '0.08'));
const ENTRY_TOLERANCE_MAX_PCT = Math.max(0.05, Number(process.env.V4_ENTRY_TOLERANCE_MAX_PCT || '0.35'));
const ENTRY_REACTION_BPS = Math.max(1, Number(process.env.V4_ENTRY_REACTION_BPS || '8'));
const ENTRY_REACTION_ATR = Math.max(0.02, Number(process.env.V4_ENTRY_REACTION_ATR || '0.10'));
const ENTRY_CONFIRMATION_WINDOW_MS = Math.max(1000, Number(process.env.V4_ENTRY_CONFIRMATION_WINDOW_SECONDS || '10') * 1000);
const MEME_SL_ATR_MULT = Math.max(0.1, Number(process.env.V4_MEME_SL_ATR_MULT || '0.45'));
const NORMAL_SL_ATR_MULT = Math.max(0.1, Number(process.env.V4_NORMAL_SL_ATR_MULT || '0.35'));
const EXPIRY_MS = Math.max(5, Number(process.env.V4_SIGNAL_EXPIRY_MINUTES || process.env.SIGNAL_EXPIRY_MINUTES || 45)) * 60 * 1000;
const COOLDOWN_MS = Math.max(EXPIRY_MS, Math.max(0, Number(process.env.V4_SYMBOL_COOLDOWN_MINUTES || process.env.COOLDOWN_MINUTES || 60)) * 60 * 1000);
const PUBLIC_BASE = process.env.V4_MARKET_BASE_URL || 'https://api.bybit.com';
const FEE_RATE = Math.max(0, Number(process.env.V4_FEE_RATE || '0.0006'));
const SLIPPAGE_RATE = Math.max(0, Number(process.env.V4_SLIPPAGE_RATE || '0.0004'));
const V4_VERSION = '4.6.8-ledger-ui-stabilizer';
const SCORE_A_PLUS = Math.max(80, Number(process.env.V4_SCORE_A_PLUS || '90'));
const SCORE_A = Math.max(70, Number(process.env.V4_SCORE_A || '84'));
const SCORE_B = Math.max(60, Number(process.env.V4_SCORE_B || '80'));
const MAX_SCORE_WITH_RISK = Math.max(70, Number(process.env.V4_MAX_SCORE_WITH_RISK || '82'));
const MAX_SCORE_IF_ENTRY_FAR_ATR = Math.max(60, Number(process.env.V4_MAX_SCORE_IF_ENTRY_FAR_ATR || '78'));
const MAX_SCORE_IF_NO_FULL_TREND = Math.max(60, Number(process.env.V4_MAX_SCORE_IF_NO_FULL_TREND || '78'));
const MIN_SL_DISTANCE_PCT = Math.max(0, Number(process.env.V4_MIN_SL_DISTANCE_PCT || '0.60'));
const REJECT_MIXED_BTC_REGIME = String(process.env.V4_REJECT_MIXED_BTC_REGIME || 'true').toLowerCase() !== 'false';
const REJECT_MILD_EXTENSION = String(process.env.V4_REJECT_MILD_EXTENSION || 'true').toLowerCase() !== 'false';
const REJECT_MOMENTUM_CONFLICT = String(process.env.V4_REJECT_MOMENTUM_CONFLICT || 'true').toLowerCase() !== 'false';
const ENTRY_CONFIRMATION_REQUIRED = String(process.env.V4_ENTRY_CONFIRMATION_REQUIRED || 'true').toLowerCase() !== 'false';
const ELLIOTT_WAVE_FILTER = String(process.env.V4_ELLIOTT_WAVE_FILTER || 'true').toLowerCase() !== 'false';
const REJECT_ELLIOTT_CONFLICT = String(process.env.V4_REJECT_ELLIOTT_CONFLICT || 'true').toLowerCase() !== 'false';
const CLUSTER_LOSS_COUNT = Math.max(1, parseInt(process.env.V4_CLUSTER_LOSS_COUNT || '2', 10));
const CLUSTER_LOSS_WINDOW_MS = Math.max(1, Number(process.env.V4_CLUSTER_LOSS_WINDOW_MINUTES || '30')) * 60 * 1000;
const CLUSTER_LOSS_COOLDOWN_MS = Math.max(1, Number(process.env.V4_CLUSTER_LOSS_COOLDOWN_MINUTES || '30')) * 60 * 1000;
const SYMBOL_LOSS_LOCKOUT_MS = Math.max(1, Number(process.env.V4_SYMBOL_LOSS_LOCKOUT_MINUTES || '60')) * 60 * 1000;
const SYMBOL_SESSION_LOCKOUT_LOSSES = Math.max(1, parseInt(process.env.V4_SYMBOL_SESSION_LOCKOUT_LOSSES || '2', 10));

const SYMBOL_WIN_COOLDOWN_MS = Math.max(1, Number(process.env.V4_SYMBOL_WIN_COOLDOWN_MINUTES || '20')) * 60 * 1000;
const WAITING_REFRESH_MIN_SCORE_DELTA = Number(process.env.V4_WAITING_REFRESH_MIN_SCORE_DELTA || '0');
const WAITING_REFRESH_MAX_ENTRY_WORSE_PCT = Math.max(0, Number(process.env.V4_WAITING_REFRESH_MAX_ENTRY_WORSE_PCT || '0.15'));


const ACTIVE_STATES = new Set(['WAITING_ENTRY', 'WAITING_REACTION', 'PAPER_ACTIVE']);
const FINAL_STATES = new Set(['TP_HIT', 'SL_HIT', 'INVALIDATED', 'EXPIRED', 'REJECTED']);

async function publicGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = PUBLIC_BASE + path + (qs ? '?' + qs : '');
  const resp = await axios.get(url, { timeout: 10000 });
  return resp.data;
}


let running = false;
let inFlight = false;
let timer = null;
let lastError = '';
let lastScanAt = 0;
let snapshot = {
  ok: true,
  version: V4_VERSION,
  ts: 0,
  entries: [],
  signals: [],
  summary: {},
  btcRegime: { regime: 'unknown' },
  lastError: ''
};

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function avg(arr) {
  return Array.isArray(arr) && arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function roundPrice(x) {
  x = num(x, 0);
  if (!x) return 0;
  if (Math.abs(x) < 0.0001) return Number(x.toFixed(10));
  if (Math.abs(x) < 0.01) return Number(x.toFixed(8));
  if (Math.abs(x) < 1) return Number(x.toFixed(6));
  if (Math.abs(x) < 100) return Number(x.toFixed(4));
  return Number(x.toFixed(2));
}

function calcRsi(closes, len = 14) {
  if (!Array.isArray(closes) || closes.length < len + 1) return 50;
  const slice = closes.slice(-(len + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (!losses) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function sma(values, len) {
  const a = values.slice(-len);
  return avg(a);
}

function calcAtr(candles, len = 14) {
  if (!Array.isArray(candles) || candles.length < len + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return avg(trs.slice(-len));
}

function trendFromCloses(closes) {
  if (!Array.isArray(closes) || closes.length < 30) return 'unknown';
  const price = closes[closes.length - 1];
  const fast = sma(closes, 9);
  const slow = sma(closes, 21);
  const base = sma(closes, 50) || slow;
  if (price > slow && fast >= slow && price >= base * 0.998) return 'bull';
  if (price < slow && fast <= slow && price <= base * 1.002) return 'bear';
  return 'neutral';
}

function detectSwings(candles, lr = 2) {
  const highs = [], lows = [];
  if (!Array.isArray(candles) || candles.length < lr * 2 + 5) return { highs, lows };
  for (let i = lr; i < candles.length - lr; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lr; j <= i + lr; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ price: candles[i].high, ts: candles[i].ts });
    if (isLow) lows.push({ price: candles[i].low, ts: candles[i].ts });
  }
  return { highs, lows };
}

async function fetchTickers() {
  const data = await publicGet('/v5/market/tickers', { category: 'linear' });
  const list = data.result?.list || [];
  return list
    .filter(x => x.symbol && x.symbol.endsWith('USDT') && num(x.lastPrice) > 0)
    .map(x => ({
      symbol: x.symbol,
      lastPrice: num(x.lastPrice),
      markPrice: num(x.markPrice),
      change24h: num(x.price24hPcnt) * 100,
      volume24h: num(x.volume24h),
      turnover24h: num(x.turnover24h),
    }));
}

async function fetchKline(symbol, interval = '5', limit = 100) {
  const data = await publicGet('/v5/market/kline', { category: 'linear', symbol, interval, limit });
  const list = data.result?.list || [];
  return list.map(r => ({
    ts: num(r[0]),
    open: num(r[1]),
    high: num(r[2]),
    low: num(r[3]),
    close: num(r[4]),
    volume: num(r[5]),
    turnover: num(r[6]),
  })).sort((a, b) => a.ts - b.ts);
}

async function updateBtcRegime() {
  try {
    const [k5, k15, k60] = await Promise.all([
      fetchKline('BTCUSDT', '5', 80),
      fetchKline('BTCUSDT', '15', 80),
      fetchKline('BTCUSDT', '60', 80),
    ]);
    const t5 = trendFromCloses(k5.map(c => c.close));
    const t15 = trendFromCloses(k15.map(c => c.close));
    const t1h = trendFromCloses(k60.map(c => c.close));
    const bulls = [t5, t15, t1h].filter(x => x === 'bull').length;
    const bears = [t5, t15, t1h].filter(x => x === 'bear').length;
    let regime = 'mixed';
    if (bulls >= 2) regime = 'bull';
    else if (bears >= 2) regime = 'bear';
    else if ([t5, t15, t1h].includes('unknown')) regime = 'unknown';
    return { regime, trend5: t5, trend15: t15, trend1h: t1h, updatedAt: Date.now() };
  } catch (e) {
    return { regime: 'unknown', error: e.message, updatedAt: Date.now() };
  }
}

function currentSettings() {
  const s = getSettings();
  return {
    ...s,
    version: V4_VERSION,
    minScoreToTrade: num(s.minScoreToTrade, 84),
    maxTradeUsdt: num(s.maxTradeUsdt, 10),
    leverage: Math.max(1, num(s.leverage, 1)),
    maxOpenTrades: Math.max(1, num(s.maxOpenTrades, 10)),
    safeMode: s.safeMode !== false,
    oneTradePerSymbol: s.oneTradePerSymbol !== false,
    rejectUnknownBtcRegime: s.rejectUnknownBtcRegime === true,
    rejectTrendConflict: s.rejectTrendConflict !== false,
    rejectRsiConflict: s.rejectRsiConflict !== false,
    rejectVolumeDeltaConflict: s.rejectVolumeDeltaConflict !== false,
    rejectMixedBtcRegime: s.rejectMixedBtcRegime !== false,
    rejectMildExtension: s.rejectMildExtension !== false,
    rejectMomentumConflict: s.rejectMomentumConflict !== false,
    entryConfirmationRequired: s.entryConfirmationRequired !== false,
    elliottWaveFilterEnabled: s.elliottWaveFilterEnabled !== false,
    rejectElliottConflict: s.rejectElliottConflict !== false,
    v4MinRR: Math.max(MIN_RR, num(s.v4MinRR, MIN_RR)),
    v4MinSellRR: Math.max(MIN_SELL_RR, num(s.v4MinSellRR, MIN_SELL_RR)),
    minSlDistancePct: Math.max(0, num(s.minSlDistancePct, MIN_SL_DISTANCE_PCT)),
  };
}

function calculatePaperMath(plan, settings) {
  const entry = num(plan.entry), tp = num(plan.tp1), sl = num(plan.sl);
  const margin = Math.max(1, num(settings.maxTradeUsdt, 10));
  const leverage = Math.max(1, num(settings.leverage, 1));
  const position = margin * leverage;
  const tpRaw = entry && tp ? Math.abs(tp - entry) / entry : 0;
  const slRaw = entry && sl ? Math.abs(entry - sl) / entry : 0;
  const grossTp = position * tpRaw;
  const grossSl = position * slRaw;
  const cost = position * (FEE_RATE + SLIPPAGE_RATE) * 2;
  const netTp = grossTp - cost;
  const netSl = -(grossSl + cost);
  const rr = grossSl ? grossTp / grossSl : 0;
  return {
    margin, leverage, position,
    tpPct: Number((tpRaw * 100 * leverage).toFixed(3)),
    slPct: Number((slRaw * 100 * leverage).toFixed(3)),
    grossTp: Number(grossTp.toFixed(4)),
    grossSl: Number(grossSl.toFixed(4)),
    feeEstUSDT: Number(cost.toFixed(4)),
    netTpUSDT: Number(netTp.toFixed(4)),
    netSlUSDT: Number(netSl.toFixed(4)),
    rr: Number(rr.toFixed(3)),
  };
}

function sideFromTrends(trend5, trend15, trend1h, rsi, momentumPct, volRatio) {
  let bull = 0, bear = 0;
  const reasons = [];
  if (trend5 === 'bull') { bull += 18; reasons.push('5m trend bull'); }
  if (trend5 === 'bear') { bear += 18; reasons.push('5m trend bear'); }
  if (trend15 === 'bull') { bull += 16; reasons.push('15m trend bull'); }
  if (trend15 === 'bear') { bear += 16; reasons.push('15m trend bear'); }
  if (trend1h === 'bull') { bull += 10; reasons.push('1h trend bull'); }
  if (trend1h === 'bear') { bear += 10; reasons.push('1h trend bear'); }

  if (momentumPct > 0.25) { bull += clamp(Math.abs(momentumPct) * 2, 2, 10); reasons.push('short momentum up'); }
  if (momentumPct < -0.25) { bear += clamp(Math.abs(momentumPct) * 2, 2, 10); reasons.push('short momentum down'); }

  if (volRatio > 1.25) { bull += 4; bear += 4; reasons.push('volume expansion'); }
  if (rsi >= 45 && rsi <= 72) bull += 5;
  if (rsi >= 28 && rsi <= 55) bear += 5;
  if (rsi > 82) bull -= 12;
  if (rsi < 18) bear -= 12;

  if (bull >= bear + 8) return { side: 'BUY', edge: bull - bear, reasons };
  if (bear >= bull + 8) return { side: 'SELL', edge: bear - bull, reasons };
  return { side: 'NEU', edge: Math.max(bull, bear) - Math.min(bull, bear), reasons: ['no clear directional edge', ...reasons] };
}


function alignedTrendScore(side, trend5, trend15, trend1h) {
  const want = side === 'BUY' ? 'bull' : 'bear';
  let score = 0;
  let aligned = 0;
  // Trend alignment is useful, but it was over-rewarded. Entry timing must do the work.
  if (trend5 === want) { score += 4; aligned++; }
  if (trend15 === want) { score += 5; aligned++; }
  if (trend1h === want) { score += 4; aligned++; }
  if (aligned === 3) score += 2;
  return { score: clamp(score, 0, 15), aligned, want };
}

function rsiScoreAndPenalty(side, rsi) {
  rsi = num(rsi, 50);
  if (side === 'BUY') {
    if (rsi >= 48 && rsi <= 64) return { score: 8, penalty: 0, note: 'RSI in long sweet spot' };
    if (rsi >= 42 && rsi <= 72) return { score: 5, penalty: 0, note: 'RSI acceptable for long' };
    if (rsi >= 35 && rsi <= 78) return { score: 2, penalty: 0, note: 'RSI marginal for long' };
    if (rsi > 78) return { score: 0, penalty: 12, risk: 'RSI overbought on long' };
    return { score: 0, penalty: 6, risk: 'RSI too weak for long' };
  }
  if (rsi >= 36 && rsi <= 52) return { score: 8, penalty: 0, note: 'RSI in short sweet spot' };
  if (rsi >= 28 && rsi <= 58) return { score: 5, penalty: 0, note: 'RSI acceptable for short' };
  if (rsi >= 22 && rsi <= 65) return { score: 2, penalty: 0, note: 'RSI marginal for short' };
  if (rsi < 22) return { score: 0, penalty: 12, risk: 'RSI oversold on short' };
  return { score: 0, penalty: 6, risk: 'RSI too strong for short' };
}

function rrScore(rr) {
  rr = num(rr, 0);
  if (rr >= 3.0) return 15;
  if (rr >= 2.5) return 12;
  if (rr >= 2.0) return 9;
  if (rr >= 1.6) return 5;
  if (rr >= 1.3) return 2;
  return 0;
}

function volumeScore(volRatio) {
  volRatio = num(volRatio, 1);
  if (volRatio >= 2.5) return 8;
  if (volRatio >= 1.8) return 6;
  if (volRatio >= 1.3) return 4;
  if (volRatio >= 1.1) return 2;
  return 0;
}

function liquidityScore(turnover24h) {
  turnover24h = num(turnover24h, 0);
  if (turnover24h >= 1000000000) return 5;
  if (turnover24h >= 250000000) return 4;
  if (turnover24h >= 50000000) return 3;
  if (turnover24h >= 10000000) return 1;
  return 0;
}


function elliottWaveContext(ctx, side, levels = {}) {
  const price = num(ctx.price);
  const trend5 = ctx.trend5;
  const trend15 = ctx.trend15;
  const trend1h = ctx.trend1h;
  const momentumPct = num(ctx.momentumPct, 0);
  const k5 = Array.isArray(ctx.k5) ? ctx.k5 : [];
  const recent = k5.slice(-36);
  const highs = recent.map(c => num(c.high)).filter(Boolean);
  const lows = recent.map(c => num(c.low)).filter(Boolean);
  const hi = highs.length ? Math.max(...highs) : 0;
  const lo = lows.length ? Math.min(...lows) : 0;
  const range = hi > lo ? hi - lo : 0;
  const rangePos = range ? (price - lo) / range : 0.5;
  const notes = [];
  const risks = [];
  let score = 0;
  let penalty = 0;
  let reject = false;
  let label = 'EW_NEUTRAL';

  const support = num(levels.support, 0);
  const resistance = num(levels.resistance, 0);
  const atr = Math.max(num(levels.atr, price * 0.006), price * 0.0005);
  const nearSupport = support && Math.abs(price - support) <= Math.max(atr * 0.80, price * 0.006);
  const nearResistance = resistance && Math.abs(price - resistance) <= Math.max(atr * 0.80, price * 0.006);
  const highTfBull = trend15 === 'bull' && trend1h === 'bull';
  const highTfBear = trend15 === 'bear' && trend1h === 'bear';

  if (side === 'BUY') {
    if (highTfBull && (nearSupport || rangePos <= 0.45) && trend5 !== 'bear' && momentumPct >= -0.20) {
      label = 'EW_LONG_W2_W4_PULLBACK_COMPLETE';
      score += 4;
      notes.push('EW pullback completion supports long');
    } else if (highTfBull && trend5 === 'bull' && momentumPct > 0.20 && rangePos < 0.78) {
      label = 'EW_LONG_EARLY_W3_CONTINUATION';
      score += 5;
      notes.push('EW early wave 3 long continuation');
    }
    if (rangePos > 0.86 || momentumPct > 6) {
      label = 'EW_LONG_LATE_W5_EXHAUSTION_RISK';
      penalty += 7;
      risks.push('EW late wave 5 exhaustion risk on long');
    }
    if (highTfBear || trend5 === 'bear' || momentumPct < -0.35) {
      penalty += 8;
      risks.push('EW bearish impulse/correction active against long');
      reject = true;
    }
  } else if (side === 'SELL') {
    if (highTfBear && (nearResistance || rangePos >= 0.55) && trend5 !== 'bull' && momentumPct <= 0.20) {
      label = 'EW_SHORT_W2_W4_BOUNCE_COMPLETE';
      score += 4;
      notes.push('EW bounce completion supports short');
    } else if (highTfBear && trend5 === 'bear' && momentumPct < -0.20 && rangePos > 0.22) {
      label = 'EW_SHORT_EARLY_W3_CONTINUATION';
      score += 5;
      notes.push('EW early wave 3 short continuation');
    }
    if (rangePos < 0.14 || momentumPct < -6) {
      label = 'EW_SHORT_LATE_W5_EXHAUSTION_RISK';
      penalty += 7;
      risks.push('EW late wave 5 exhaustion risk on short');
    }
    if (highTfBull || trend5 === 'bull' || momentumPct > 0.35) {
      penalty += 8;
      risks.push('EW bullish impulse/correction active against short');
      reject = true;
    }
  }

  if (!notes.length && !risks.length) notes.push('EW neutral/no clean wave edge');
  return {
    label,
    rangePos: Number(rangePos.toFixed(3)),
    scoreBonus: score,
    penalty,
    reject,
    notes,
    risks,
  };
}

function calibratedScore(ctx, decision, plan, math, btcRegime, levels) {
  const { side } = plan;
  const { price, trend5, trend15, trend1h, rsi, volRatio, momentumPct, ticker, k5 } = ctx;
  const atr = Math.max(num(levels.atr, price * 0.006), price * 0.0005);
  const entryDistanceAtr = Math.abs(num(price) - num(plan.entry)) / atr;
  const last = Array.isArray(k5) && k5.length ? k5[k5.length - 1] : null;
  const lastRangeAtr = last ? Math.abs(num(last.high) - num(last.low)) / atr : 0;

  const components = {};
  const confluence = [];
  const risks = [];
  let penalties = 0;

  components.base = 8;

  const ew = elliottWaveContext(ctx, side, levels);
  components.elliottWave = ELLIOTT_WAVE_FILTER ? ew.scoreBonus : 0;
  if (ELLIOTT_WAVE_FILTER) {
    if (ew.notes && ew.notes.length) confluence.push(...ew.notes);
    if (ew.risks && ew.risks.length) risks.push(...ew.risks);
    penalties += ew.penalty;
  }

  components.direction = clamp(num(decision.edge) * 0.65, 0, 18);
  if (components.direction >= 12) confluence.push('clear directional edge');

  const trend = alignedTrendScore(side, trend5, trend15, trend1h);
  components.trend = trend.score;
  if (trend.aligned >= 2) confluence.push(`${trend.aligned}/3 trend alignment`);
  if (trend.aligned < 2) {
    penalties += 8;
    risks.push('weak multi-timeframe alignment');
  }

  const hasStructure = !!(levels.support && levels.resistance);
  components.structure = hasStructure ? 10 : 0;
  if (hasStructure) confluence.push('support/resistance structure present');
  else {
    penalties += 20;
    risks.push('missing nearby S/R structure');
  }

  if (entryDistanceAtr <= 0.25) components.entry = 12;
  else if (entryDistanceAtr <= 0.50) components.entry = 9;
  else if (entryDistanceAtr <= 1.00) components.entry = 5;
  else if (entryDistanceAtr <= 1.80) components.entry = 2;
  else components.entry = 0;

  if (entryDistanceAtr <= 0.50) confluence.push('entry close to planner zone');
  if (entryDistanceAtr > 1.80) {
    penalties += 8;
    risks.push('entry too far from current price');
  }
  if (entryDistanceAtr > 3.00) {
    penalties += 10;
    risks.push('entry extremely far from current price');
  }

  components.rr = rrScore(math.rr);
  if (math.rr >= 2) confluence.push(`RR ${math.rr}`);

  components.volume = volumeScore(volRatio);
  if (components.volume >= 4) confluence.push('volume expansion');

  const rsiPart = rsiScoreAndPenalty(side, rsi);
  components.rsi = rsiPart.score;
  if (rsiPart.note) confluence.push(rsiPart.note);
  if (rsiPart.risk) risks.push(rsiPart.risk);
  penalties += rsiPart.penalty;

  components.liquidity = liquidityScore(num(ticker.turnover24h));

  const momo = Math.abs(num(momentumPct));
  if (momo > 10) {
    penalties += 22;
    risks.push('extreme short-term extension');
  } else if (momo > 6) {
    penalties += 14;
    risks.push('overextended move');
  } else if (momo > 3.5) {
    penalties += 6;
    risks.push('mild extension');
  }

  if (lastRangeAtr > 2.5) {
    penalties += 10;
    risks.push('last candle too large vs ATR');
  } else if (lastRangeAtr > 1.8) {
    penalties += 5;
    risks.push('large recent candle');
  }

  if (btcRegime.regime === 'unknown') {
    penalties += 4;
    risks.push('BTC regime unknown');
  }
  if (side === 'BUY' && btcRegime.regime === 'bear') {
    penalties += 14;
    risks.push('BTC bearish against long');
  }
  if (side === 'SELL' && btcRegime.regime === 'bull') {
    penalties += 14;
    risks.push('BTC bullish against short');
  }

  const requiredRR = side === 'SELL' ? MIN_SELL_RR : MIN_RR;
  if (math.rr < requiredRR) {
    penalties += 22;
    risks.push(`RR ${math.rr} below ${requiredRR}`);
  }
  if (math.netTpUSDT < MIN_NET_TP) {
    penalties += 12;
    risks.push(`net TP ${math.netTpUSDT} below ${MIN_NET_TP}`);
  }

  let raw = Object.values(components).reduce((a, b) => a + num(b), 0);
  let score = raw - penalties;

  // Hard caps make 100 rare and prevent broad trend rallies from all becoming A+.
  if (risks.length) score = Math.min(score, MAX_SCORE_WITH_RISK);
  if (entryDistanceAtr > 1.0) score = Math.min(score, MAX_SCORE_IF_ENTRY_FAR_ATR);
  if (trend.aligned < 3) score = Math.min(score, MAX_SCORE_IF_NO_FULL_TREND);
  if (math.rr < 2.0) score = Math.min(score, 82);
  if (!hasStructure) score = Math.min(score, 50);

  const exceptional =
    score >= 95 &&
    !risks.length &&
    trend.aligned === 3 &&
    math.rr >= 2.4 &&
    entryDistanceAtr <= 0.5 &&
    components.volume >= 4 &&
    components.liquidity >= 3;

  if (score > 94 && !exceptional) score = 94;

  score = clamp(Math.round(score), 0, 100);

  return {
    score,
    rawScore: Number(raw.toFixed(2)),
    penalties: Number(penalties.toFixed(2)),
    components,
    confluence,
    risks,
    entryDistanceAtr: Number(entryDistanceAtr.toFixed(3)),
    lastRangeAtr: Number(lastRangeAtr.toFixed(3)),
    exceptional,
    elliottWave: ew
  };
}

function buildStructurePlan(ctx, settings, btcRegime) {
  const { symbol, price, k5, k15, k60, trend5, trend15, trend1h, rsi, volRatio, momentumPct, ticker } = ctx;
  const decision = sideFromTrends(trend5, trend15, trend1h, rsi, momentumPct, volRatio);
  if (decision.side === 'NEU') return { ok: false, reason: 'NO_DIRECTION', leader: { symbol, score: 0, side: 'NEU' } };

  const side = decision.side;
  const swings = detectSwings(k5, 2);
  const atr = calcAtr(k5, 14) || price * 0.006;
  const minBuffer = Math.max(price * 0.0018, atr * 0.25);
  const below = swings.lows.map(x => x.price).filter(x => x < price).sort((a, b) => b - a);
  const above = swings.highs.map(x => x.price).filter(x => x > price).sort((a, b) => a - b);
  const support = below[0] || 0;
  const resistance = above[0] || 0;
  const support2 = below[1] || 0;
  const resistance2 = above[1] || 0;

  let entry, sl, tp1, entrySource, slSource, tpSource;
  if (side === 'BUY') {
    if (!support || !resistance) return { ok: false, reason: 'NO_STRUCTURE_LEVELS', leader: { symbol, score: 0, side } };
    const nearSupport = Math.abs(price - support) <= Math.max(atr * 0.75, price * 0.0075);
    entry = nearSupport ? price : Math.max(support + minBuffer * 0.35, price - atr * 0.6);
    sl = Math.min(support - minBuffer, entry - atr * 0.55);
    const structureTp = resistance;
    tp1 = structureTp > entry ? structureTp : 0;
    entrySource = nearSupport ? 'current price near support' : 'pullback toward support';
    slSource = 'below support invalidation';
    tpSource = 'nearest resistance liquidity';
  } else {
    if (!support || !resistance) return { ok: false, reason: 'NO_STRUCTURE_LEVELS', leader: { symbol, score: 0, side } };
    const nearResistance = Math.abs(price - resistance) <= Math.max(atr * 0.75, price * 0.0075);
    entry = nearResistance ? price : Math.min(resistance - minBuffer * 0.35, price + atr * 0.6);
    sl = Math.max(resistance + minBuffer, entry + atr * 0.55);
    const structureTp = support;
    tp1 = structureTp < entry ? structureTp : 0;
    entrySource = nearResistance ? 'current price near resistance' : 'pullback toward resistance';
    slSource = 'above resistance invalidation';
    tpSource = 'nearest support liquidity';
  }

  const plan = { entry: roundPrice(entry), sl: roundPrice(sl), tp1: roundPrice(tp1), side };
  const math = calculatePaperMath(plan, settings);

  const scoreInfo = calibratedScore(ctx, decision, plan, math, btcRegime, { support, resistance, support2, resistance2, atr });
  const entryTiming = computeEntryTiming(ctx, plan, side, atr);
  const score = scoreInfo.score;
  const confluence = [...new Set([...decision.reasons, ...scoreInfo.confluence])];
  const risks = [...new Set(scoreInfo.risks)];

  const leader = {
    symbol,
    price: roundPrice(price),
    side,
    score,
    tier: score >= SCORE_A_PLUS ? 'A+' : score >= SCORE_A ? 'A' : score >= SCORE_B ? 'B' : '-',
    trend5, trend15, trend1h,
    rsi: Number(rsi.toFixed(1)),
    volRatio: Number(volRatio.toFixed(2)),
    change24h: Number(num(ticker.change24h).toFixed(2)),
    turnover24h: num(ticker.turnover24h),
    btcRegime: btcRegime.regime,
    plan,
    math,
    reasons: confluence.slice(0, 8),
    risks,
    scoreInfo,
    scoring: scoreInfo,
    entryTiming,
    entrySource, slSource, tpSource,
    keyLevels: { support: roundPrice(support), resistance: roundPrice(resistance), support2: roundPrice(support2), resistance2: roundPrice(resistance2), atr: roundPrice(atr) },
  };
  return { ok: true, leader };
}


function slDistancePct(leader) {
  const entry = num(leader?.plan?.entry, num(leader?.entry));
  const sl = num(leader?.plan?.sl, num(leader?.sl));
  if (!entry || !sl) return 0;
  return Math.abs(entry - sl) / entry * 100;
}


function atrPct(price, atr) {
  price = num(price, 0); atr = num(atr, 0);
  return price ? Math.abs(atr) / price * 100 : 0;
}

function entryToleranceAbs(price, atr) {
  price = num(price, 0); atr = num(atr, 0);
  if (!price) return 0;
  const raw = atr > 0 ? atr * ENTRY_TOLERANCE_ATR : price * (ENTRY_TOLERANCE_MAX_PCT / 100);
  const min = price * (ENTRY_TOLERANCE_MIN_PCT / 100);
  const max = price * (ENTRY_TOLERANCE_MAX_PCT / 100);
  return clamp(raw, min, max);
}

function entryReactionAbs(price, atr) {
  price = num(price, 0); atr = num(atr, 0);
  if (!price) return 0;
  return Math.max(price * (ENTRY_REACTION_BPS / 10000), atr * ENTRY_REACTION_ATR);
}

function isMemeOrHighVol(symbol, price, atr) {
  const s = String(symbol || '').toUpperCase();
  const ap = atrPct(price, atr);
  return ap >= 4.5 || /(PEPE|BONK|FLOKI|SHIB|DOGE|MEME|MOG|TURBO|BRETT|WIF|PENGU|LADYS|BABY|CAT|DOG|TRUMP)/.test(s);
}

function minSlDistancePctFor(symbol, price, atr, settings = {}) {
  const base = Math.max(MIN_SL_DISTANCE_PCT, num(settings.minSlDistancePct, MIN_SL_DISTANCE_PCT));
  const ap = atrPct(price, atr);
  const mult = isMemeOrHighVol(symbol, price, atr) ? MEME_SL_ATR_MULT : NORMAL_SL_ATR_MULT;
  const floor = ap ? ap * mult : 0;
  const memeFloor = isMemeOrHighVol(symbol, price, atr) ? 0.80 : 0.60;
  return Math.max(base, floor, memeFloor);
}

function lastCandleReaction(candle, side) {
  if (!candle) return false;
  const open = num(candle.open), close = num(candle.close), high = num(candle.high), low = num(candle.low);
  const range = Math.max(0, high - low);
  if (!open || !close || !range) return false;
  if (side === 'BUY') return close > open && (close - low) >= range * 0.45;
  if (side === 'SELL') return close < open && (high - close) >= range * 0.45;
  return false;
}

function computeEntryTiming(ctx, plan, side, atr) {
  const price = num(ctx?.price, num(plan?.entry));
  const entry = num(plan?.entry);
  const tolerance = entryToleranceAbs(entry || price, atr);
  const reaction = entryReactionAbs(entry || price, atr);
  const inZone = !!(price && entry && Math.abs(price - entry) <= tolerance);
  const last = Array.isArray(ctx?.k5) ? ctx.k5[ctx.k5.length - 1] : null;
  let directional = false;
  if (inZone && lastCandleReaction(last, side)) {
    directional = side === 'BUY'
      ? num(last.close) >= Math.min(price, entry) + reaction
      : num(last.close) <= Math.max(price, entry) - reaction;
  }
  const reason = !inZone
    ? `WAITING_ENTRY: price not in tight entry zone (${roundPrice(price)} vs ${roundPrice(entry)}, tol ${roundPrice(tolerance)})`
    : directional
      ? `ENTRY_CONFIRMED: tight zone + directional reaction (${ENTRY_REACTION_BPS}bps/min ATR-aware)`
      : `WAITING_REACTION: tight zone touched, waiting for directional reaction (${ENTRY_REACTION_BPS}bps/min ATR-aware)`;
  return { inZone, directional, tolerance: roundPrice(tolerance), reaction: roundPrice(reaction), price: roundPrice(price), reason };
}

function signalEntryTiming(s, price, atr, now = Date.now()) {
  const entry = num(s?.entry);
  const tolerance = entryToleranceAbs(entry || price, atr);
  const reaction = entryReactionAbs(entry || price, atr);
  const inZone = !!(price && entry && Math.abs(price - entry) <= tolerance);
  if (!inZone) return { inZone, directional: false, tolerance, reaction, reason: 'WAITING_ENTRY: price outside tight entry zone' };
  if (!s.entryZoneTouchedAt) {
    s.entryZoneTouchedAt = now;
    s.entryZoneTouchPrice = roundPrice(price);
  }
  const touch = num(s.entryZoneTouchPrice, entry);
  const elapsed = now - num(s.entryZoneTouchedAt, now);
  let directional = false;
  if (s.side === 'BUY') directional = price >= Math.max(entry, touch) + reaction;
  if (s.side === 'SELL') directional = price <= Math.min(entry, touch) - reaction;
  const expiredWindow = elapsed > ENTRY_CONFIRMATION_WINDOW_MS;
  const reason = directional
    ? 'ENTRY_CONFIRMED: price touched zone and reacted in trade direction'
    : expiredWindow
      ? 'WAITING_REACTION: 10s window passed without directional reaction; still waiting'
      : 'WAITING_REACTION: price touched zone; waiting up to 10s/next ticks for direction';
  return { inZone, directional, tolerance, reaction, elapsed, reason };
}

function terminalStateOf(s) {
  const st = String(s?.paperState || s?.displayState || s?.status || '').toUpperCase();
  if (st === 'TP_HIT' || st === 'WIN') return 'TP_HIT';
  if (st === 'SL_HIT' || st === 'LOSS') return 'SL_HIT';
  if (st === 'INVALIDATED' || st === 'INVALID') return 'INVALIDATED';
  if (st === 'EXPIRED') return 'EXPIRED';
  if (st === 'REJECTED') return 'REJECTED';
  return '';
}

function hasRiskOrReason(leader, pattern) {
  const rx = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
  const text = [
    ...(Array.isArray(leader?.reasons) ? leader.reasons : []),
    ...(Array.isArray(leader?.risks) ? leader.risks : []),
    ...(Array.isArray(leader?.scoreInfo?.risks) ? leader.scoreInfo.risks : []),
    ...(Array.isArray(leader?.scoreInfo?.confluence) ? leader.scoreInfo.confluence : [])
  ].join(' | ');
  return rx.test(text);
}

function entryConfirmationOk(leader) {
  const scoring = leader?.scoreInfo || leader?.scoring || {};
  const timing = leader?.entryTiming || {};
  if (leader.side === 'BUY') {
    if (hasRiskOrReason(leader, /short momentum down/i)) return false;
    if (hasRiskOrReason(leader, /RSI overbought|mild extension|overextended|large recent candle|last candle too large/i)) return false;
  }
  if (leader.side === 'SELL') {
    if (hasRiskOrReason(leader, /short momentum up/i)) return false;
    if (hasRiskOrReason(leader, /RSI oversold|mild extension|overextended|large recent candle|last candle too large/i)) return false;
  }
  if (num(scoring.entryDistanceAtr, 0) > 1.0) return false;
  if (num(scoring.lastRangeAtr, 0) > 1.8) return false;
  // Important: setup quality is not enough. Immediate activation requires a directional reaction.
  return timing.directional === true;
}

function openSignalCount(signals) {
  return (signals || []).filter(s => ACTIVE_STATES.has(s.paperState)).length;
}

function clusterLossBlocked(signals, side) {
  const now = Date.now();
  const recent = (signals || [])
    .filter(s => s && s.side === side && s.paperState === 'SL_HIT')
    .map(s => num(s.closedAt || s.updatedAt || s.createdAt, 0))
    .filter(ts => ts && now - ts <= CLUSTER_LOSS_WINDOW_MS)
    .sort((a, b) => b - a);
  if (recent.length < CLUSTER_LOSS_COUNT) return false;
  return now - recent[0] <= CLUSTER_LOSS_COOLDOWN_MS;
}


function symbolLossLockoutReason(signals, leader) {
  if (!leader || !leader.symbol || !leader.side) return '';
  const reason = symbolCooldownReason(signals, leader.symbol, leader.side);
  return /LOSS_COOLDOWN|SESSION_LOCKOUT/.test(reason) ? reason : '';
}

function symbolCooldownReason(signals, symbol, side, now = Date.now()) {
  const rows = (signals || []).filter(s => s && (s.sym === symbol || s.symbol === symbol) && s.side === side);
  const active = rows.find(s => ACTIVE_STATES.has(s.paperState));
  if (active) {
    return active.paperState === 'PAPER_ACTIVE' ? 'DUPLICATE_SYMBOL_SIDE_ACTIVE' : 'DUPLICATE_SYMBOL_SIDE_WAITING';
  }
  const losses = rows
    .filter(s => s.paperState === 'SL_HIT')
    .map(s => num(s.closedAt || s.updatedAt || s.createdAt, 0))
    .filter(Boolean)
    .sort((a, b) => b - a);
  if (losses.length >= SYMBOL_SESSION_LOCKOUT_LOSSES) return `SYMBOL_${symbol}_${side}_SESSION_LOCKOUT`;
  if (losses.length && now - losses[0] <= SYMBOL_LOSS_LOCKOUT_MS) return `SYMBOL_${symbol}_${side}_LOSS_COOLDOWN`;
  const wins = rows
    .filter(s => s.paperState === 'TP_HIT')
    .map(s => num(s.closedAt || s.updatedAt || s.createdAt, 0))
    .filter(Boolean)
    .sort((a, b) => b - a);
  if (wins.length && now - wins[0] <= SYMBOL_WIN_COOLDOWN_MS) return `SYMBOL_${symbol}_${side}_WIN_COOLDOWN`;
  return '';
}

function liveSymbolSideKey(s) {
  return `${String(s?.sym || s?.symbol || '').toUpperCase()}|${String(s?.side || '').toUpperCase()}`;
}

function livePriority(s) {
  const st = String(s?.paperState || '').toUpperCase();
  if (st === 'PAPER_ACTIVE') return 1000000 + num(s.updatedAt || s.createdAt);
  if (st === 'WAITING_REACTION') return 500000 + num(s.score) * 100 + num(s.rr || s.rr1) * 10 + num(s.updatedAt || s.createdAt) / 1000000;
  if (st === 'WAITING_ENTRY') return 250000 + num(s.score) * 100 + num(s.rr || s.rr1) * 10 + num(s.updatedAt || s.createdAt) / 1000000;
  return num(s.updatedAt || s.createdAt);
}

function dedupeLiveSignals(list = []) {
  const byLive = new Map();
  const out = [];
  for (const s of list || []) {
    if (!s) continue;
    if (!ACTIVE_STATES.has(s.paperState)) { out.push(s); continue; }
    const k = liveSymbolSideKey(s);
    if (!k || k === '|') { out.push(s); continue; }
    const old = byLive.get(k);
    if (!old || livePriority(s) >= livePriority(old)) byLive.set(k, s);
  }
  const liveKeep = new Set(Array.from(byLive.values()).map(x => x.id || tradeKey(x))); // Node-safe Map iterator
  const seenLive = new Set();
  for (const s of list || []) {
    if (!s || !ACTIVE_STATES.has(s.paperState)) continue;
    const id = s.id || tradeKey(s);
    if (!liveKeep.has(id) || seenLive.has(id)) continue;
    seenLive.add(id);
    out.push(s);
  }
  return out.sort((a, b) => num(b.createdAt || b.updatedAt) - num(a.createdAt || a.updatedAt)).slice(0, MAX_SIGNALS);
}

function refreshSignalPlan(existing, candidate, reason = 'REFRESHED_WAITING_SETUP') {
  if (!existing || !candidate || existing.paperState === 'PAPER_ACTIVE') return false;
  if (!['WAITING_ENTRY', 'WAITING_REACTION'].includes(existing.paperState)) return false;
  const oldScore = num(existing.score), newScore = num(candidate.score);
  const oldRR = num(existing.rr || existing.rr1), newRR = num(candidate.rr || candidate.rr1);
  const oldEntry = num(existing.entry), newEntry = num(candidate.entry);
  const side = String(existing.side || candidate.side || '').toUpperCase();
  const oldSlPct = num(existing.slPct, oldEntry && existing.sl ? Math.abs(oldEntry - num(existing.sl)) / Math.abs(oldEntry) * 100 : 0);
  const newSlPct = num(candidate.slPct, newEntry && candidate.sl ? Math.abs(newEntry - num(candidate.sl)) / Math.abs(newEntry) * 100 : 0);
  const entryWorsePct = oldEntry && newEntry ? (side === 'BUY' ? ((newEntry - oldEntry) / oldEntry) * 100 : ((oldEntry - newEntry) / oldEntry) * 100) : 0;
  const betterScore = newScore >= oldScore + WAITING_REFRESH_MIN_SCORE_DELTA;
  const betterRR = newRR >= oldRR - 0.02;
  const riskOk = !oldSlPct || !newSlPct || newSlPct <= oldSlPct * 1.15 || newRR > oldRR + 0.15;
  const entryOk = entryWorsePct <= WAITING_REFRESH_MAX_ENTRY_WORSE_PCT || newRR > oldRR + 0.25;
  if (!(betterScore && betterRR && riskOk && entryOk)) return false;

  const preserve = {
    id: existing.id,
    createdAt: existing.createdAt,
    time: existing.time,
    history: Array.isArray(existing.history) ? existing.history.slice() : [],
    entryZoneTouchedAt: existing.entryZoneTouchedAt || null,
    entryZoneTouchPrice: existing.entryZoneTouchPrice || null,
  };
  Object.assign(existing, candidate, preserve, {
    paperState: existing.paperState,
    displayState: existing.displayState || existing.paperState,
    status: existing.status || 'DETECTED',
    positionStatus: existing.positionStatus || 'NONE',
    updatedAt: Date.now(),
    stateReason: `V4.6.8: ${reason}; refreshed waiting setup with newer/better planner data`,
  });
  existing.history.push({ at: existing.updatedAt, state: existing.paperState, reason, entry: existing.entry, sl: existing.sl, tp1: existing.tp1, score: existing.score, rr: existing.rr });
  return true;
}

function mergeLeaderIntoWaiting(signals, leader, settings) {
  const existing = (signals || []).find(s => s && (s.sym === leader.symbol || s.symbol === leader.symbol) && s.side === leader.side && ['WAITING_ENTRY', 'WAITING_REACTION'].includes(s.paperState));
  if (!existing) return false;
  const candidate = signalFromLeader(leader, settings);
  const refreshed = refreshSignalPlan(existing, candidate, 'REFRESHED_WAITING_SETUP');
  if (refreshed) addLog('V4_SIGNAL_REFRESHED', `${leader.symbol} ${leader.side} WAITING refreshed`, { score: candidate.score, rr: candidate.rr });
  return true;
}

function btcUnknownHighConfidenceOk(leader) {
  const ew = leader?.scoreInfo?.elliottWave || leader?.scoring?.elliottWave || null;
  const ewOk = !!(ew && !ew.reject && (num(ew.scoreBonus, 0) > 0 || /W2|W3|W4|PULLBACK|BOUNCE|CONTINUATION/i.test(String(ew.label || ''))));
  const volumeOk = !hasRiskOrReason(leader, /volume delta .*against|VOL_DELTA_.*_ON_/i);
  const rsiOk = !hasRiskOrReason(leader, /RSI overbought|RSI oversold|RSI too/i);
  const extensionOk = !hasRiskOrReason(leader, /mild extension|overextended|extreme short-term extension|late wave 5/i);
  const momentumOk = leader.side === 'BUY'
    ? !hasRiskOrReason(leader, /short momentum down/i)
    : !hasRiskOrReason(leader, /short momentum up/i);
  return (
    num(leader.score, 0) >= 90 &&
    leader.math && num(leader.math.rr, 0) >= 2.0 &&
    ewOk && volumeOk && rsiOk && extensionOk && momentumOk
  );
}

function shouldReject(leader, settings, signals = []) {
  const reasons = [];
  const warnings = [];
  const minScore = num(settings.minScoreToTrade, 84);
  const minRR = leader.side === 'SELL' ? Math.max(MIN_SELL_RR, num(settings.v4MinSellRR, MIN_SELL_RR)) : Math.max(MIN_RR, num(settings.v4MinRR, MIN_RR));
  const atr = num(leader?.keyLevels?.atr, 0);
  const px = num(leader?.price || leader?.plan?.entry, 0);
  const minSlPct = minSlDistancePctFor(leader?.symbol, px, atr, settings);
  const slPct = slDistancePct(leader);
  const btcUnknown = !leader.btcRegime || leader.btcRegime === 'unknown';
  const btcUnknownException = btcUnknown && btcUnknownHighConfidenceOk(leader);

  if (!['BUY', 'SELL'].includes(leader.side)) reasons.push('NO_DIRECTION');
  if (leader.score < minScore) reasons.push(`SCORE_LT_${minScore}`);
  if (leader.math.rr < minRR) reasons.push(`RR_LT_${minRR}`);
  if (leader.math.netTpUSDT < MIN_NET_TP) reasons.push('NET_TP_TOO_SMALL');
  if (slPct > 0 && slPct < minSlPct) reasons.push(`SL_TOO_TIGHT_${slPct.toFixed(2)}_LT_${minSlPct}`);

  if (btcUnknown) {
    warnings.push(btcUnknownException ? 'BTC_UNKNOWN_HIGH_CONFIDENCE_EXCEPTION' : 'BTC_REGIME_UNKNOWN_NEUTRAL');
    if (settings.rejectUnknownBtcRegime && !btcUnknownException) reasons.push('BTC_REGIME_UNKNOWN');
  }
  if ((settings.rejectMixedBtcRegime || REJECT_MIXED_BTC_REGIME) && leader.btcRegime === 'mixed') reasons.push('BTC_REGIME_MIXED');
  if (leader.side === 'BUY' && leader.btcRegime === 'bear') reasons.push('BTC_BEAR_AGAINST_LONG');
  if (leader.side === 'SELL' && leader.btcRegime === 'bull') reasons.push('BTC_BULL_AGAINST_SHORT');

  if (settings.rejectTrendConflict) {
    if (leader.side === 'BUY' && (leader.trend5 === 'bear' || leader.trend15 === 'bear' || leader.trend1h === 'bear')) reasons.push('TREND_CONFLICT_LONG');
    if (leader.side === 'SELL' && (leader.trend5 === 'bull' || leader.trend15 === 'bull' || leader.trend1h === 'bull')) reasons.push('TREND_CONFLICT_SHORT');
  }

  if (settings.rejectRsiConflict) {
    if (leader.side === 'BUY' && leader.rsi >= 78) reasons.push('RSI_OVERBOUGHT_ON_LONG');
    if (leader.side === 'SELL' && leader.rsi <= 22) reasons.push('RSI_OVERSOLD_ON_SHORT');
  }

  if ((settings.rejectMildExtension || REJECT_MILD_EXTENSION) && hasRiskOrReason(leader, /mild extension|overextended|extreme short-term extension/i)) reasons.push('EXTENSION_RISK');
  if ((settings.rejectMomentumConflict || REJECT_MOMENTUM_CONFLICT)) {
    if (leader.side === 'BUY' && hasRiskOrReason(leader, /short momentum down/i)) reasons.push('MOMENTUM_CONFLICT_LONG');
    if (leader.side === 'SELL' && hasRiskOrReason(leader, /short momentum up/i)) reasons.push('MOMENTUM_CONFLICT_SHORT');
  }

  const ew = leader?.scoreInfo?.elliottWave || leader?.scoring?.elliottWave || null;
  if ((settings.rejectElliottConflict || REJECT_ELLIOTT_CONFLICT) && ew && ew.reject) reasons.push('ELLIOTT_WAVE_CONFLICT');
  if ((settings.entryConfirmationRequired || ENTRY_CONFIRMATION_REQUIRED) && !entryConfirmationOk(leader)) warnings.push('ENTRY_CONFIRMATION_PENDING');
  const lockout = symbolLossLockoutReason(signals, leader);
  if (lockout) reasons.push(lockout);
  if (clusterLossBlocked(signals, leader.side)) reasons.push(`CLUSTER_${leader.side}_LOSSES_COOLDOWN`);
  if (settings.minTurnover24h && leader.turnover24h < settings.minTurnover24h) reasons.push('LOW_TURNOVER');
  return { ok: reasons.length === 0, reasons, warnings };
}

function signalFromLeader(leader, settings) {
  const now = Date.now();
  const plan = leader.plan;
  const price = num(leader.price);
  const entry = num(plan.entry);
  const atr = num(leader.keyLevels?.atr, Math.abs(price - entry));
  const timing = leader.entryTiming || { inZone: false, directional: false, reason: 'WAITING_ENTRY: no entry timing context' };
  const state = timing.inZone && timing.directional ? 'PAPER_ACTIVE' : 'WAITING_ENTRY';
  const id = `v4_${leader.symbol}_${leader.side}_${now}`;
  return {
    id,
    source: 'backend-planner-v4.6.8',
    plannerVersion: V4_VERSION,
    sym: leader.symbol,
    symbol: leader.symbol,
    side: leader.side,
    status: state === 'PAPER_ACTIVE' ? 'ACTIVE' : 'DETECTED',
    paperState: state,
    displayState: state,
    positionStatus: state === 'PAPER_ACTIVE' ? 'PAPER' : 'NONE',
    orderStatus: 'NOT_SENT_PAPER',
    score: leader.score,
    setupScore: leader.score,
    tier: leader.tier,
    entry: plan.entry,
    sl: plan.sl,
    tp1: plan.tp1,
    rr: leader.math.rr,
    rr1: leader.math.rr,
    margin: leader.math.margin,
    leverage: leader.math.leverage,
    position: leader.math.position,
    tp1Profit: leader.math.tpPct,
    slPct: leader.math.slPct,
    tp1ProfitUSDT: leader.math.grossTp,
    slLossUSDT: leader.math.grossSl,
    netTpUSDT: leader.math.netTpUSDT,
    netSlUSDT: leader.math.netSlUSDT,
    feeEstUSDT: leader.math.feeEstUSDT,
    paperPnl: 0,
    entryHit: state === 'PAPER_ACTIVE',
    tp1Hit: false,
    time: new Date(now).toLocaleTimeString().slice(0, 5),
    createdAt: now,
    updatedAt: now,
    expireMs: EXPIRY_MS,
    stateReason: state === 'PAPER_ACTIVE' ? `V4.6.8: ${timing.reason}` : `V4.6.8: ${timing.reason}`,
    reasons: leader.reasons,
    risks: leader.risks,
    entryTiming: timing,
    entryZoneTouchedAt: timing.inZone ? now : null,
    entryZoneTouchPrice: timing.inZone ? roundPrice(price) : null,
    planner: {
      source: 'backend-planner-v4.6.8',
      entrySource: leader.entrySource,
      slSource: leader.slSource,
      tpSource: leader.tpSource,
      keyLevels: leader.keyLevels,
      confluence: leader.reasons,
      risks: leader.risks,
      feeModel: { feeRate: FEE_RATE, slippageRate: SLIPPAGE_RATE },
      btcRegime: leader.btcRegime,
      scoring: leader.scoreInfo || leader.scoring || null,
    },
    history: [{ at: now, state, reason: state === 'PAPER_ACTIVE' ? 'Entry active from backend planner' : 'Planner created and waiting entry' }],
  };
}

function getSignals() {
  const data = store.read('v4_signals', []);
  if (!Array.isArray(data)) return [];
  const now = Date.now();
  let changed = false;
  const normalized = data.map(s => {
    if (!s) return s;
    if ((s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION') && now - num(s.createdAt || s.updatedAt, now) > num(s.expireMs, EXPIRY_MS)) {
      changed = true;
      return { ...s, paperState: 'EXPIRED', displayState: 'EXPIRED', status: 'EXPIRED', positionStatus: 'NONE', updatedAt: now, closedAt: now, stateReason: 'V4.6.8: stale waiting setup expired' };
    }
    return s;
  });
  const deduped = dedupeLiveSignals(normalized);
  if (changed || deduped.length !== data.length) store.write('v4_signals', deduped.slice(0, MAX_SIGNALS));
  return deduped;
}

function saveSignals(signals) {
  store.write('v4_signals', dedupeLiveSignals(signals || []).slice(0, MAX_SIGNALS));
}

function tradeKey(s) {
  return `${s.sym}|${s.side}|${s.entry}|${s.sl}|${s.tp1}`;
}

function normalizeLedgerTrade(s) {
  const key = tradeKey(s);
  const result =
    s.paperState === 'TP_HIT' || s.status === 'WIN' ? 'WIN' :
    s.paperState === 'SL_HIT' || s.status === 'LOSS' ? 'LOSS' :
    s.paperState === 'INVALIDATED' ? 'INVALIDATED' :
    s.paperState === 'EXPIRED' ? 'EXPIRED' :
    s.paperState === 'REJECTED' ? 'REJECTED' :
    s.paperState === 'PAPER_ACTIVE' ? 'ACTIVE' :
    (s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION') ? s.paperState : (s.paperState || s.status || 'UNKNOWN');

  const lossReason =
    result === 'LOSS'
      ? (s.lossReason || s.stateReason || lastHistoryReason(s) || 'SL hit')
      : '';

  return {
    id: s.id || key,
    key,
    sym: s.sym,
    symbol: s.sym,
    side: s.side,
    entry: s.entry,
    sl: s.sl,
    tp1: s.tp1,
    score: s.score,
    rr: s.rr || s.rr1,
    margin: s.margin,
    leverage: s.leverage,
    position: s.position,
    status: s.status,
    paperState: s.paperState,
    result,
    openedAt: s.openedAt || s.createdAt || s.updatedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    closedAt: s.closedAt || (FINAL_STATES.has(s.paperState) ? s.updatedAt : null),
    exitPx: s.exitPx || null,
    grossTpUSDT: s.tp1ProfitUSDT || 0,
    grossSlUSDT: s.slLossUSDT || 0,
    netTpUSDT: s.netTpUSDT || 0,
    netSlUSDT: s.netSlUSDT || 0,
    realizedPnl: num(s.realizedPnl, result === 'WIN' ? num(s.netTpUSDT) : result === 'LOSS' ? num(s.netSlUSDT) : 0),
    stateReason: s.stateReason || '',
    lossReason,
    rejectionReason: result === 'REJECTED' ? (s.stateReason || s.rejectReason || '') : '',
    reasons: s.reasons || [],
    risks: s.risks || [],
    planner: s.planner || {},
    history: s.history || []
  };
}

function lastHistoryReason(s) {
  const h = Array.isArray(s.history) ? s.history : [];
  const last = h.length ? h[h.length - 1] : null;
  return last && last.reason ? last.reason : '';
}

function getLedger() {
  const data = store.read('v4_paper_ledger', []);
  return Array.isArray(data) ? data : [];
}

function saveLedger(rows) {
  const now = Date.now();
  const prepared = (rows || []).map(r => {
    if (!r) return r;
    const age = now - num(r.createdAt || r.openedAt || r.updatedAt, now);
    const state = String(r.paperState || r.result || '').toUpperCase();
    if ((state === 'WAITING_ENTRY' || state === 'WAITING_REACTION') && age > num(r.expireMs, EXPIRY_MS)) {
      return { ...r, paperState: 'EXPIRED', displayState: 'EXPIRED', status: 'EXPIRED', result: 'EXPIRED', updatedAt: now, closedAt: now, stateReason: r.stateReason || 'V4.6.8: stale waiting setup expired by ledger cleanup' };
    }
    return r;
  });
  const unique = new Map();
  const liveBySymbolSide = new Map();
  for (const r of prepared) {
    if (!r) continue;
    const st = String(r.paperState || r.result || '').toUpperCase();
    if (st === 'WAITING_ENTRY' || st === 'WAITING_REACTION' || st === 'PAPER_ACTIVE') {
      const k = `${String(r.sym || r.symbol || '').toUpperCase()}|${String(r.side || '').toUpperCase()}|${st === 'PAPER_ACTIVE' ? 'ACTIVE' : 'WAIT'}`;
      const old = liveBySymbolSide.get(k);
      const oldPr = old ? livePriority(old) : -Infinity;
      if (!old || livePriority(r) >= oldPr) liveBySymbolSide.set(k, r);
      continue;
    }
  }
  const liveKeep = new Set([...liveBySymbolSide.values()].map(r => r.key || tradeKey(r)));
  for (const r of prepared) {
    if (!r) continue;
    const liveState = String(r.paperState || r.result || '').toUpperCase();
    const key = r.key || tradeKey(r);
    if ((liveState === 'WAITING_ENTRY' || liveState === 'WAITING_REACTION' || liveState === 'PAPER_ACTIVE') && !liveKeep.has(key)) continue;
    const old = unique.get(key);
    const next = normalizeLedgerTrade(r);
    if (!old || num(next.updatedAt || next.closedAt || next.createdAt) >= num(old.updatedAt || old.closedAt || old.createdAt)) {
      unique.set(key, next);
    }
  }
  const sorted = [...unique.values()].sort((a, b) => num(b.createdAt || b.openedAt) - num(a.createdAt || a.openedAt)).slice(0, MAX_LEDGER);
  store.write('v4_paper_ledger', sorted);
  return sorted;
}

function upsertLedger(signals = []) {
  const ledger = getLedger();
  const merged = saveLedger([...ledger, ...(signals || []).map(normalizeLedgerTrade)]);
  return merged;
}

function computeLedgerSummary(rows = getLedger()) {
  const unique = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    const key = r.key || tradeKey(r);
    unique.set(key, r);
  }
  const list = [...unique.values()];
  const wins = list.filter(r => r.result === 'WIN').length;
  const losses = list.filter(r => r.result === 'LOSS').length;
  const waiting = list.filter(r => r.result === 'WAITING_ENTRY').length;
  const active = list.filter(r => r.result === 'ACTIVE').length;
  const invalidated = list.filter(r => r.result === 'INVALIDATED').length;
  const expired = list.filter(r => r.result === 'EXPIRED').length;
  const rejected = list.filter(r => r.result === 'REJECTED').length;
  const net = list.reduce((a, r) => a + (r.result === 'WIN' || r.result === 'LOSS' ? num(r.realizedPnl) : 0), 0);
  const grossWins = list.filter(r => r.result === 'WIN').reduce((a, r) => a + num(r.netTpUSDT), 0);
  const grossLosses = list.filter(r => r.result === 'LOSS').reduce((a, r) => a + num(r.netSlUSDT), 0);
  const completed = wins + losses;
  const hitRate = completed ? Math.round((wins / completed) * 100) : 0;

  const lossReasons = {};
  for (const r of list.filter(x => x.result === 'LOSS')) {
    const reason = r.lossReason || r.stateReason || 'SL hit';
    lossReasons[reason] = (lossReasons[reason] || 0) + 1;
  }

  return {
    source: 'v4_paper_ledger',
    unique: list.length,
    total: list.length,
    completed,
    open: waiting + active,
    waiting,
    active,
    wins,
    losses,
    invalidated,
    expired,
    rejected,
    hitRate,
    winRate: hitRate,
    netPnl: Number(net.toFixed(4)),
    grossWins: Number(grossWins.toFixed(4)),
    grossLosses: Number(grossLosses.toFixed(4)),
    lossReasons: Object.entries(lossReasons)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    recent: list.slice(0, RECENT_LEDGER_LIMIT)
  };
}

function getSessions() {
  const data = store.read('v4_sessions', []);
  return Array.isArray(data) ? data : [];
}

function saveSessions(sessions) {
  store.write('v4_sessions', sessions.slice(0, 50));
}

function computeSummary(signals = getSignals()) {
  const unique = new Map();
  for (const s of signals) unique.set(`${s.sym}|${s.side}|${s.entry}|${s.sl}|${s.tp1}`, s);
  const rows = [...unique.values()];
  const wins = rows.filter(s => s.paperState === 'TP_HIT' || s.status === 'WIN').length;
  const losses = rows.filter(s => s.paperState === 'SL_HIT' || s.status === 'LOSS').length;
  const waiting = rows.filter(s => s.paperState === 'WAITING_ENTRY').length;
  const active = rows.filter(s => s.paperState === 'PAPER_ACTIVE').length;
  const invalidated = rows.filter(s => s.paperState === 'INVALIDATED').length;
  const expired = rows.filter(s => s.paperState === 'EXPIRED').length;
  const rejected = rows.filter(s => s.paperState === 'REJECTED').length;
  const net = rows.reduce((a, s) => a + (s.paperState === 'TP_HIT' ? num(s.netTpUSDT) : s.paperState === 'SL_HIT' ? num(s.netSlUSDT) : 0), 0);
  const hitRate = (wins + losses) ? Math.round((wins / (wins + losses)) * 100) : 0;
  return {
    source: 'visible_signals',
    unique: rows.length,
    total: rows.length,
    open: waiting + active,
    waiting,
    active,
    wins,
    losses,
    invalidated,
    expired,
    rejected,
    hitRate,
    netPnl: Number(net.toFixed(4)),
    ledger: computeLedgerSummary()
  };
}

function updateExistingSignals(signals, priceMap) {
  const now = Date.now();
  let changed = false;
  for (const s of signals) {
    if (!s || FINAL_STATES.has(s.paperState)) continue;
    const price = num(priceMap.get(s.sym)?.markPrice || priceMap.get(s.sym)?.lastPrice || s.backendLastPrice);
    if (!price) continue;

    s.backendLastPrice = roundPrice(price);
    s.updatedAt = now;

    const entry = num(s.entry), sl = num(s.sl), tp = num(s.tp1);
    const side = s.side;
    const age = now - num(s.createdAt, now);
    const atr = num(s.planner?.keyLevels?.atr, Math.abs(entry - sl));

    if (s.paperState === 'WAITING_ENTRY') {
      if (age > num(s.expireMs, EXPIRY_MS)) {
        s.paperState = 'EXPIRED';
        s.status = 'EXPIRED';
        s.displayState = 'EXPIRED';
        s.positionStatus = 'NONE';
        s.stateReason = 'V4: setup expired before entry';
        s.history = [...(s.history || []), { at: now, state: 'EXPIRED', reason: s.stateReason }];
        changed = true;
        continue;
      }
      if (side === 'BUY' && price <= sl) {
        s.paperState = 'INVALIDATED';
        s.status = 'INVALID';
        s.displayState = 'INVALIDATED';
        s.positionStatus = 'NONE';
        s.stateReason = 'V4: structure broke before entry';
        s.history = [...(s.history || []), { at: now, state: 'INVALIDATED', reason: s.stateReason, price }];
        changed = true;
        continue;
      }
      if (side === 'SELL' && price >= sl) {
        s.paperState = 'INVALIDATED';
        s.status = 'INVALID';
        s.displayState = 'INVALIDATED';
        s.positionStatus = 'NONE';
        s.stateReason = 'V4: structure broke before entry';
        s.history = [...(s.history || []), { at: now, state: 'INVALIDATED', reason: s.stateReason, price }];
        changed = true;
        continue;
      }
      const timing = signalEntryTiming(s, price, atr, now);
      if (timing.inZone && timing.directional) {
        s.paperState = 'PAPER_ACTIVE';
        s.status = 'ACTIVE';
        s.displayState = 'PAPER_ACTIVE';
        s.positionStatus = 'PAPER';
        s.entryHit = true;
        s.openedAt = now;
        s.stateReason = 'V4.6.8: ' + timing.reason;
        s.history = [...(s.history || []), { at: now, state: 'PAPER_ACTIVE', reason: s.stateReason, price }];
        changed = true;
      } else if (timing.inZone) {
        s.stateReason = 'V4.6.8: ' + timing.reason;
        changed = true;
      }
      continue;
    }

    if (s.paperState === 'PAPER_ACTIVE') {
      let final = null;
      if (side === 'BUY' && price >= tp) final = { state: 'TP_HIT', status: 'WIN', reason: 'V4: TP hit' };
      if (side === 'SELL' && price <= tp) final = { state: 'TP_HIT', status: 'WIN', reason: 'V4: TP hit' };
      if (side === 'BUY' && price <= sl) final = { state: 'SL_HIT', status: 'LOSS', reason: 'V4: SL hit' };
      if (side === 'SELL' && price >= sl) final = { state: 'SL_HIT', status: 'LOSS', reason: 'V4: SL hit' };
      if (final) {
        s.paperState = final.state;
        s.displayState = final.state;
        s.status = final.status;
        s.positionStatus = 'CLOSED';
        s.closedAt = now;
        s.exitPx = roundPrice(price);
        s.realizedPnl = final.state === 'TP_HIT' ? num(s.netTpUSDT) : num(s.netSlUSDT);
        s.stateReason = final.reason;
        s.history = [...(s.history || []), { at: now, state: final.state, reason: final.reason, price }];
        changed = true;
      }
    }
  }
  return changed;
}

function canCreateForSymbol(signals, symbol, settings, side = '') {
  if (!settings.oneTradePerSymbol) return true;
  const reason = symbolCooldownReason(signals, symbol, side || null);
  if (reason) return false;
  const now = Date.now();
  const recentClosed = signals.find(s => s.sym === symbol && FINAL_STATES.has(s.paperState) && (now - num(s.closedAt || s.updatedAt || s.createdAt)) < COOLDOWN_MS);
  return !recentClosed;
}

async function enrich(ticker) {
  const [k5, k15, k60] = await Promise.all([
    fetchKline(ticker.symbol, '5', 100),
    fetchKline(ticker.symbol, '15', 100).catch(() => []),
    fetchKline(ticker.symbol, '60', 100).catch(() => []),
  ]);
  const closes5 = k5.map(c => c.close);
  const closes15 = k15.map(c => c.close);
  const closes60 = k60.map(c => c.close);
  const price = num(ticker.markPrice || ticker.lastPrice || closes5[closes5.length - 1]);
  const volNow = num(k5[k5.length - 1]?.volume);
  const volAvg = avg(k5.slice(-20).map(c => c.volume));
  const volRatio = volAvg ? volNow / volAvg : 1;
  const momentumPct = closes5.length > 12 ? ((price - closes5[closes5.length - 12]) / closes5[closes5.length - 12]) * 100 : 0;
  return {
    symbol: ticker.symbol,
    price,
    k5, k15, k60,
    trend5: trendFromCloses(closes5),
    trend15: trendFromCloses(closes15),
    trend1h: trendFromCloses(closes60),
    rsi: calcRsi(closes5, 14),
    volRatio,
    momentumPct,
    ticker,
  };
}

async function scanOnce() {
  if (inFlight) return snapshot;
  inFlight = true;
  const startedAt = Date.now();
  try {
    const settings = currentSettings();
    const [tickers, btcRegime] = await Promise.all([fetchTickers(), updateBtcRegime()]);
    const priceMap = new Map(tickers.map(t => [t.symbol, t]));
    let signals = dedupeLiveSignals(getSignals());

    updateExistingSignals(signals, priceMap);
    signals = dedupeLiveSignals(signals);

    const universe = tickers
      .filter(t => t.symbol !== 'BTCUSDT' && t.symbol.endsWith('USDT') && num(t.turnover24h) > 0)
      .sort((a, b) => num(b.turnover24h) - num(a.turnover24h))
      .slice(0, MAX_SYMBOLS);

    const entries = [];
    for (const t of universe) {
      try {
        const ctx = await enrich(t);
        const built = buildStructurePlan(ctx, settings, btcRegime);
        if (!built.ok) {
          entries.push({ symbol: t.symbol, side: built.leader?.side || 'NEU', score: 0, rejected: true, rejectReasons: [built.reason], price: roundPrice(t.lastPrice) });
          continue;
        }
        const leader = built.leader;
        const gate = shouldReject(leader, settings, signals);
        leader.rejected = !gate.ok;
        leader.rejectReasons = gate.reasons;
        leader.rejectWarnings = gate.warnings || [];
        entries.push(leader);
        if (gate.ok && openSignalCount(signals) >= settings.maxOpenTrades) {
          leader.rejected = true;
          leader.rejectReasons = ['MAX_OPEN_TRADES_REACHED'];
        }
        if (gate.ok && openSignalCount(signals) < settings.maxOpenTrades) {
          const dupReason = symbolCooldownReason(signals, leader.symbol, leader.side);
          if (dupReason === 'DUPLICATE_SYMBOL_SIDE_WAITING') {
            mergeLeaderIntoWaiting(signals, leader, settings);
          } else if (!dupReason && canCreateForSymbol(signals, leader.symbol, settings, leader.side)) {
            const sig = signalFromLeader(leader, settings);
            signals.unshift(sig);
            addLog('V4_SIGNAL', `${leader.symbol} ${leader.side} ${sig.paperState}`, { score: leader.score, rr: leader.math.rr });
          } else if (dupReason && dupReason !== 'DUPLICATE_SYMBOL_SIDE_ACTIVE') {
            leader.rejected = true;
            leader.rejectReasons = [dupReason];
          }
        }
      } catch (e) {
        entries.push({ symbol: t.symbol, side: 'NEU', score: 0, rejected: true, rejectReasons: ['ENRICH_ERROR:' + e.message], price: roundPrice(t.lastPrice) });
      }
    }

    // Persist every signal state into the permanent paper ledger before trimming the visible table.
    const ledger = upsertLedger(signals);

    signals = signals
      .sort((a, b) => num(b.createdAt) - num(a.createdAt))
      .slice(0, MAX_SIGNALS);
    saveSignals(signals);

    const visibleSummary = computeSummary(signals);
    const ledgerSummary = computeLedgerSummary(ledger);
    const summary = { ...ledgerSummary, visible: visibleSummary, source: 'v4_paper_ledger' };
    snapshot = {
      ok: true,
      version: V4_VERSION,
      ts: Date.now(),
      scanMs: Date.now() - startedAt,
      entries: entries.sort((a, b) => num(b.score) - num(a.score)).slice(0, 120),
      signals,
      visibleSignals: signals.length,
      ledger: ledger.slice(0, RECENT_LEDGER_LIMIT),
      summary,
      btcRegime,
      settings: {
        botMode: settings.botMode,
        tradingEnabled: settings.tradingEnabled,
        minScoreToTrade: settings.minScoreToTrade,
        maxTradeUsdt: settings.maxTradeUsdt,
        leverage: settings.leverage,
        maxOpenTrades: settings.maxOpenTrades,
        safeMode: settings.safeMode,
        rejectMixedBtcRegime: settings.rejectMixedBtcRegime,
        rejectMildExtension: settings.rejectMildExtension,
        rejectMomentumConflict: settings.rejectMomentumConflict,
        minSlDistancePct: settings.minSlDistancePct,
        entryConfirmationRequired: settings.entryConfirmationRequired,
      },
      lastError: ''
    };
    store.write('v4_snapshot', snapshot);
    lastScanAt = snapshot.ts;
    lastError = '';
    return snapshot;
  } catch (e) {
    lastError = e.message;
    snapshot = { ...snapshot, ok: false, lastError, ts: Date.now() };
    addLog('V4_ERROR', e.message);
    return snapshot;
  } finally {
    inFlight = false;
  }
}


function ingestCandidate(payload = {}) {
  const settings = currentSettings();
  const symbol = String(payload.symbol || payload.sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const side = String(payload.side || '').toUpperCase();
  const scoreInputs = [payload.score, payload.confidence, payload.setupScore, payload.agentConfidence, payload.coinScore]
    .map(v => num(v, NaN))
    .filter(v => Number.isFinite(v));
  const score = scoreInputs.length ? Math.max(...scoreInputs) : 0;
  const entryTimingScore = num(payload.entryTimingScore || payload.timingScore || payload.entryScore, 0);
  const entry = roundPrice(payload.entry || payload.plan?.entry);
  const sl = roundPrice(payload.sl || payload.plan?.sl);
  const tp1 = roundPrice(payload.tp1 || payload.plan?.tp1 || payload.tp || payload.plan?.tp);
  const rr = num(payload.rr || payload.plan?.rr || (entry && sl && tp1 ? Math.abs(tp1 - entry) / Math.abs(entry - sl) : 0), 0);
  const btcRegime = String(payload.btcRegime || payload.btc || '').toLowerCase();
  const reasons = [];
  const warnings = [];

  if (!symbol || !symbol.endsWith('USDT')) reasons.push('BAD_SYMBOL');
  if (!['BUY', 'SELL'].includes(side)) reasons.push('NO_DIRECTION');
  if (!entry || !sl || !tp1) reasons.push('PLAN_MISSING');
  if (side === 'BUY' && !(sl < entry && tp1 > entry)) reasons.push('BUY_PLAN_DIRECTION_INVALID');
  if (side === 'SELL' && !(sl > entry && tp1 < entry)) reasons.push('SELL_PLAN_DIRECTION_INVALID');

  const minScore = num(settings.minScoreToTrade, 84);
  const minRR = side === 'SELL' ? Math.max(MIN_SELL_RR, num(settings.v4MinSellRR, MIN_SELL_RR)) : Math.max(MIN_RR, num(settings.v4MinRR, MIN_RR));
  const slPct = entry && sl ? Math.abs(entry - sl) / Math.abs(entry) * 100 : 0;
  const minSlPct = Math.max(MIN_SL_DISTANCE_PCT, num(settings.minSlDistancePct, MIN_SL_DISTANCE_PCT));

  if (score < minScore) reasons.push(`SCORE_LT_${minScore}`);
  if (entryTimingScore > 0 && entryTimingScore < 45) warnings.push(`ENTRY_TIMING_LOW_${entryTimingScore}`);
  if (rr < minRR) reasons.push(`RR_LT_${minRR}`);
  if (slPct > 0 && slPct < minSlPct) reasons.push(`SL_TOO_TIGHT_${slPct.toFixed(2)}_LT_${minSlPct}`);

  if (btcRegime === 'mixed' || btcRegime === 'chop') reasons.push('BTC_REGIME_MIXED');
  if (side === 'BUY' && btcRegime === 'bear') reasons.push('BTC_BEAR_AGAINST_LONG');
  if (side === 'SELL' && btcRegime === 'bull') reasons.push('BTC_BULL_AGAINST_SHORT');
  if (!btcRegime || btcRegime === 'unknown' || btcRegime === 'neutral') warnings.push('BTC_UNKNOWN_OR_NEUTRAL_CANDIDATE');

  const text = String([payload.reason, payload.reasons, payload.risks, payload.confluence, payload.elliott, payload.wave, payload.volumeDelta, payload.debug].flat().join(' '));
  if (/watch/i.test(String(payload.state || payload.plannerState || '')) && !/ready/i.test(String(payload.state || payload.plannerState || ''))) reasons.push('NOT_READY_WATCH_ONLY');
  if (side === 'BUY' && /short momentum down|bearish divergence|sell[-\s]?accel/i.test(text)) reasons.push('MOMENTUM_OR_VOLUME_CONFLICT_LONG');
  if (side === 'SELL' && /short momentum up|bullish divergence|buy[-\s]?accel/i.test(text)) reasons.push('MOMENTUM_OR_VOLUME_CONFLICT_SHORT');
  if (/mild extension|strong extension|overextended|late wave 5/i.test(text)) reasons.push('EXTENSION_RISK');
  if (settings.rejectElliottConflict !== false) {
    if (side === 'BUY' && /impulse down|bearish impulse|correction down|bounce sell/i.test(text)) reasons.push('ELLIOTT_WAVE_CONFLICT_LONG');
    if (side === 'SELL' && /impulse up|bullish impulse|correction up|pullback buy/i.test(text)) reasons.push('ELLIOTT_WAVE_CONFLICT_SHORT');
  }

  let signals = dedupeLiveSignals(getSignals());
  const duplicateReason = settings.oneTradePerSymbol !== false ? symbolCooldownReason(signals, symbol, side) : '';
  const waitingDuplicate = duplicateReason === 'DUPLICATE_SYMBOL_SIDE_WAITING';
  if (duplicateReason && !waitingDuplicate) reasons.push(duplicateReason);
  if (!waitingDuplicate && openSignalCount(signals) >= settings.maxOpenTrades) reasons.push('MAX_OPEN_TRADES_REACHED');

  const rejected = reasons.length > 0;
  if (rejected) {
    addLog('V4_CANDIDATE_REJECTED', `${symbol || 'UNKNOWN'} ${side || 'NEU'} ${reasons.slice(0,3).join(',')}`, {score, rr, slPct, btcRegime, warnings});
    return { ok: false, rejected: true, reasons, warnings };
  }

  const now = Date.now();
  const leverage = Math.max(1, num(settings.leverage, 5));
  const margin = Math.max(1, num(settings.maxTradeUsdt, 10));
  const position = margin * leverage;
  const tpPct = Math.abs(tp1 - entry) / Math.abs(entry) * 100;
  const grossTp = position * tpPct / 100;
  const grossSl = position * slPct / 100;
  const feeEst = num(settings.roundTripFeePct || process.env.ROUND_TRIP_FEE_PCT, 0.12) / 100 * position;
  const sig = {
    id: `v4c_${symbol}_${side}_${now}`,
    source: 'frontend-candidate-v4.6.8',
    plannerVersion: V4_VERSION,
    sym: symbol,
    symbol,
    side,
    status: 'DETECTED',
    paperState: 'WAITING_ENTRY',
    displayState: 'WAITING_ENTRY',
    positionStatus: 'NONE',
    orderStatus: 'NOT_SENT_PAPER',
    score,
    setupScore: score,
    entryTimingScore,
    tier: payload.tier || '',
    entry,
    sl,
    tp1,
    rr,
    rr1: rr,
    margin,
    leverage,
    position,
    tp1Profit: tpPct,
    slPct,
    tp1ProfitUSDT: grossTp,
    slLossUSDT: grossSl,
    netTpUSDT: grossTp - feeEst,
    netSlUSDT: -(grossSl + feeEst),
    feeEstUSDT: feeEst,
    btcRegime: btcRegime || 'unknown',
    rejectWarnings: warnings,
    reasons: Array.isArray(payload.reasons) ? payload.reasons.slice(0, 8) : [],
    risks: Array.isArray(payload.risks) ? payload.risks.slice(0, 8) : [],
    planner: {
      source: 'frontend-search-modal',
      entrySource: payload.entrySource || payload.plan?.entrySource || 'frontend candidate entry',
      slSource: payload.slSource || payload.plan?.slSource || 'frontend candidate SL',
      tpSource: payload.tpSource || payload.plan?.tpSource || 'frontend candidate TP',
      confluence: Array.isArray(payload.confluence) ? payload.confluence.slice(0, 10) : [],
      risks: Array.isArray(payload.risks) ? payload.risks.slice(0, 10) : [],
      keyLevels: payload.keyLevels || {},
    },
    entryHit: false,
    stateReason: 'V4.6.8: READY setup captured as WAITING_ENTRY; activation requires tight entry zone + directional reaction',
    history: [{ at: now, state: 'WAITING_ENTRY', reason: 'Frontend READY candidate captured; waiting for tight entry zone + directional reaction' }],
    time: new Date(now).toLocaleTimeString().slice(0,5),
    createdAt: now,
    updatedAt: now,
  };
  if (waitingDuplicate) {
    const existing = signals.find(s => s && (s.sym === symbol || s.symbol === symbol) && s.side === side && ['WAITING_ENTRY', 'WAITING_REACTION'].includes(s.paperState));
    if (existing && refreshSignalPlan(existing, sig, 'REFRESHED_WAITING_SETUP_FROM_FRONTEND')) {
      saveSignals(signals);
      const ledger = upsertLedger(signals);
      snapshot = { ...snapshot, ok: true, ts: now, version: V4_VERSION, signals, ledger: ledger.slice(0, RECENT_LEDGER_LIMIT), summary: { ...computeLedgerSummary(ledger), visible: computeSummary(signals), source: 'v4_paper_ledger' } };
      store.write('v4_snapshot', snapshot);
      addLog('V4_CANDIDATE_REFRESHED', `${symbol} ${side} WAITING refreshed`, {score, rr, slPct, btcRegime, warnings});
      return { ok: true, refreshed: true, signal: existing, summary: snapshot.summary, warnings };
    }
    return { ok: true, skipped: true, reason: 'DUPLICATE_SYMBOL_SIDE_WAITING_NOT_BETTER', warnings };
  }
  signals.unshift(sig);
  signals = dedupeLiveSignals(signals).sort((a,b)=>num(b.createdAt)-num(a.createdAt)).slice(0, MAX_SIGNALS);
  saveSignals(signals);
  const ledger = upsertLedger(signals);
  snapshot = { ...snapshot, ok: true, ts: now, version: V4_VERSION, signals, ledger: ledger.slice(0, RECENT_LEDGER_LIMIT), summary: { ...computeLedgerSummary(ledger), visible: computeSummary(signals), source: 'v4_paper_ledger' } };
  store.write('v4_snapshot', snapshot);
  addLog('V4_CANDIDATE_CAPTURED', `${symbol} ${side} WAITING_ENTRY`, {score, rr, slPct, btcRegime, warnings});
  return { ok: true, signal: sig, summary: snapshot.summary, warnings };
}

function getSnapshot() {
  const persisted = store.read('v4_snapshot', null);
  if (persisted && persisted.ts && (!snapshot.ts || persisted.ts > snapshot.ts)) snapshot = persisted;
  const signals = getSignals(); const ledger = upsertLedger(signals); return { ...snapshot, signals, visibleSignals: signals.length, ledger: ledger.slice(0, RECENT_LEDGER_LIMIT), summary: { ...computeLedgerSummary(ledger), visible: computeSummary(signals), source: 'v4_paper_ledger' }, lastError };
}

function start() {
  if (running) return;
  running = true;
  console.log('[Orayan v4] Backend paper signal engine starting');
  scanOnce().catch(e => console.error('[Orayan v4] first scan failed:', e.message));
  timer = setInterval(() => scanOnce().catch(e => console.error('[Orayan v4] scan failed:', e.message)), LOOP_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}

function clearSignals({ archive = true, clearLedger = false } = {}) {
  const signals = getSignals();
  const ledgerBefore = upsertLedger(signals);
  if (archive && signals.length) {
    const sessions = getSessions();
    sessions.unshift({ at: Date.now(), summary: computeSummary(signals), ledgerSummary: computeLedgerSummary(ledgerBefore), signals });
    saveSessions(sessions);
  }
  saveSignals([]);
  if (clearLedger) saveLedger([]);
  const ledger = clearLedger ? [] : getLedger();
  snapshot = { ...snapshot, signals: [], visibleSignals: 0, ledger: ledger.slice(0, RECENT_LEDGER_LIMIT), summary: { ...computeLedgerSummary(ledger), visible: computeSummary([]), source: 'v4_paper_ledger' }, ts: Date.now() };
  store.write('v4_snapshot', snapshot);
  return { ok: true, archived: archive && signals.length ? 1 : 0, total: 0, ledgerTotal: ledger.length, ledgerCleared: !!clearLedger };
}


function freshJournal() {
  saveSignals([]);
  saveLedger([]);
  store.write('v4_candidate_rejections', []);
  store.write('legacy_browser_signals', { at: Date.now(), total: 0, note: 'cleared by v4.6.8 freshJournal' });
  snapshot = { ...snapshot, ts: Date.now(), signals: [], visibleSignals: 0, ledger: [], summary: computeLedgerSummary([]) };
  store.write('v4_snapshot', snapshot);
  return { ok: true, cleared: true, source: 'v4.6.8 freshJournal' };
}

function getLeaderboard() {
  return getSnapshot().entries || [];
}

module.exports = {
  start,
  stop,
  scanOnce,
  getSnapshot,
  getSignals,
  getLedger,
  computeLedgerSummary,
  clearSignals,
  computeSummary,
  getLeaderboard,
  freshJournal,
  ingestCandidate,
};
