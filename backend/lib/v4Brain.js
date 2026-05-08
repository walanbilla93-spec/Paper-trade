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
const MIN_RR = Math.max(1.2, Number(process.env.V4_MIN_RR || '1.9'));
const MIN_NET_TP = Math.max(0, Number(process.env.V4_MIN_NET_TP_USDT || '0.05'));
const ENTRY_TOLERANCE_ATR = Math.max(0.05, Number(process.env.V4_ENTRY_TOLERANCE_ATR || '0.45'));
const EXPIRY_MS = Math.max(5, Number(process.env.V4_SIGNAL_EXPIRY_MINUTES || process.env.SIGNAL_EXPIRY_MINUTES || 45)) * 60 * 1000;
const COOLDOWN_MS = Math.max(0, Number(process.env.V4_SYMBOL_COOLDOWN_MINUTES || process.env.COOLDOWN_MINUTES || 30)) * 60 * 1000;
const PUBLIC_BASE = process.env.V4_MARKET_BASE_URL || 'https://api.bybit.com';
const FEE_RATE = Math.max(0, Number(process.env.V4_FEE_RATE || '0.0006'));
const SLIPPAGE_RATE = Math.max(0, Number(process.env.V4_SLIPPAGE_RATE || '0.0004'));
const V4_VERSION = '4.3.0-terminal-ledger';
const SCORE_A_PLUS = Math.max(80, Number(process.env.V4_SCORE_A_PLUS || '88'));
const SCORE_A = Math.max(70, Number(process.env.V4_SCORE_A || '78'));
const SCORE_B = Math.max(60, Number(process.env.V4_SCORE_B || '68'));
const MAX_SCORE_WITH_RISK = Math.max(70, Number(process.env.V4_MAX_SCORE_WITH_RISK || '88'));
const MAX_SCORE_IF_ENTRY_FAR_ATR = Math.max(60, Number(process.env.V4_MAX_SCORE_IF_ENTRY_FAR_ATR || '82'));
const MAX_SCORE_IF_NO_FULL_TREND = Math.max(60, Number(process.env.V4_MAX_SCORE_IF_NO_FULL_TREND || '86'));

const ACTIVE_STATES = new Set(['WAITING_ENTRY', 'PAPER_ACTIVE']);
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
    minScoreToTrade: num(s.minScoreToTrade, 70),
    maxTradeUsdt: num(s.maxTradeUsdt, 10),
    leverage: Math.max(1, num(s.leverage, 1)),
    maxOpenTrades: Math.max(1, num(s.maxOpenTrades, 3)),
    safeMode: s.safeMode !== false,
    oneTradePerSymbol: s.oneTradePerSymbol !== false,
    rejectUnknownBtcRegime: s.rejectUnknownBtcRegime !== false,
    rejectTrendConflict: s.rejectTrendConflict !== false,
    rejectRsiConflict: s.rejectRsiConflict !== false,
    rejectVolumeDeltaConflict: s.rejectVolumeDeltaConflict !== false,
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
  if (trend5 === want) { score += 8; aligned++; }
  if (trend15 === want) { score += 9; aligned++; }
  if (trend1h === want) { score += 5; aligned++; }
  if (aligned === 3) score += 3;
  return { score: clamp(score, 0, 25), aligned, want };
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

  if (math.rr < MIN_RR) {
    penalties += 22;
    risks.push(`RR ${math.rr} below ${MIN_RR}`);
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
    exceptional
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
    entrySource, slSource, tpSource,
    keyLevels: { support: roundPrice(support), resistance: roundPrice(resistance), support2: roundPrice(support2), resistance2: roundPrice(resistance2), atr: roundPrice(atr) },
  };
  return { ok: true, leader };
}

function shouldReject(leader, settings) {
  const reasons = [];
  if (!['BUY', 'SELL'].includes(leader.side)) reasons.push('NO_DIRECTION');
  if (leader.score < num(settings.minScoreToTrade, 70)) reasons.push(`SCORE_LT_${settings.minScoreToTrade}`);
  if (leader.math.rr < MIN_RR) reasons.push(`RR_LT_${MIN_RR}`);
  if (leader.math.netTpUSDT < MIN_NET_TP) reasons.push('NET_TP_TOO_SMALL');
  if (settings.rejectUnknownBtcRegime && leader.btcRegime === 'unknown') reasons.push('BTC_REGIME_UNKNOWN');
  if (leader.side === 'BUY' && leader.btcRegime === 'bear') reasons.push('BTC_BEAR_AGAINST_LONG');
  if (leader.side === 'SELL' && leader.btcRegime === 'bull') reasons.push('BTC_BULL_AGAINST_SHORT');

  const trends = [leader.trend5, leader.trend15, leader.trend1h];
  const want = leader.side === 'BUY' ? 'bull' : 'bear';
  const against = leader.side === 'BUY' ? 'bear' : 'bull';
  const aligned = trends.filter(t => t === want).length;
  const conflicts = trends.filter(t => t === against).length;
  const known = trends.filter(t => ['bull', 'bear', 'neutral'].includes(t)).length;

  if (settings.rejectTrendConflict) {
    if (leader.side === 'BUY' && (leader.trend5 === 'bear' || leader.trend15 === 'bear' || leader.trend1h === 'bear')) reasons.push('TREND_CONFLICT_LONG');
    if (leader.side === 'SELL' && (leader.trend5 === 'bull' || leader.trend15 === 'bull' || leader.trend1h === 'bull')) reasons.push('TREND_CONFLICT_SHORT');
    if (settings.safeMode !== false && aligned < 2) reasons.push('TREND_ALIGNMENT_LT_2_OF_3');
    if (settings.safeMode !== false && known >= 2 && aligned === 0 && conflicts === 0) reasons.push('ALL_NEUTRAL_TREND_STACK');
  }
  if (settings.rejectRsiConflict) {
    if (leader.side === 'BUY' && leader.rsi >= 82) reasons.push('RSI_OVERBOUGHT_ON_LONG');
    if (leader.side === 'SELL' && leader.rsi <= 18) reasons.push('RSI_OVERSOLD_ON_SHORT');
  }
  if (settings.minTurnover24h && leader.turnover24h < settings.minTurnover24h) reasons.push('LOW_TURNOVER');
  return { ok: reasons.length === 0, reasons };
}

function signalFromLeader(leader, settings) {
  const now = Date.now();
  const plan = leader.plan;
  const price = num(leader.price);
  const entry = num(plan.entry);
  const atr = num(leader.keyLevels.atr, Math.abs(price - entry));
  const near = Math.abs(price - entry) <= Math.max(atr * ENTRY_TOLERANCE_ATR, price * 0.002);
  const state = near ? 'PAPER_ACTIVE' : 'WAITING_ENTRY';
  const id = `v4_${leader.symbol}_${leader.side}_${now}`;
  return {
    id,
    source: 'planner-v4.1',
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
    stateReason: state === 'PAPER_ACTIVE' ? 'V4: price inside planner entry zone' : 'V4: waiting for planner entry zone',
    reasons: leader.reasons,
    risks: leader.risks,
    planner: {
      source: 'backend-planner-v4.1',
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
  return Array.isArray(data) ? data : [];
}

function saveSignals(signals) {
  store.write('v4_signals', signals.slice(0, MAX_SIGNALS));
}

function tradeKey(s) {
  return `${s.sym || s.symbol || ''}|${s.side || ''}|${s.entry ?? ''}|${s.sl ?? ''}|${s.tp1 ?? ''}`;
}

function normalizeLedgerResult(s) {
  const state = String(s.result || s.terminalState || s.paperState || s.status || '').toUpperCase();
  if (state === 'TP_HIT' || state === 'WIN') return 'WIN';
  if (state === 'SL_HIT' || state === 'LOSS') return 'LOSS';
  if (state === 'INVALIDATED' || state === 'INVALID') return 'INVALIDATED';
  if (state === 'EXPIRED') return 'EXPIRED';
  if (state === 'REJECTED') return 'REJECTED';
  if (state === 'PAPER_ACTIVE' || state === 'ACTIVE' || state === 'OPEN') return 'ACTIVE';
  if (state === 'WAITING_ENTRY' || state === 'DETECTED' || state === 'ARMED' || state === 'PENDING') return 'WAITING_ENTRY';
  return state || 'UNKNOWN';
}

function displayStateForResult(result, originalPaperState) {
  if (result === 'WIN') return 'TP_HIT';
  if (result === 'LOSS') return 'SL_HIT';
  if (result === 'ACTIVE') return 'PAPER_ACTIVE';
  if (result === 'WAITING_ENTRY') return 'WAITING_ENTRY';
  return originalPaperState || result;
}

function statusForResult(result, originalStatus) {
  if (result === 'WIN') return 'WIN';
  if (result === 'LOSS') return 'LOSS';
  if (result === 'ACTIVE') return 'ACTIVE';
  if (result === 'WAITING_ENTRY') return 'DETECTED';
  if (result === 'INVALIDATED') return 'INVALID';
  return originalStatus || result;
}

function normalizeLedgerTrade(s) {
  const key = s.key || tradeKey(s);
  const result = normalizeLedgerResult(s);
  const terminalState = result === 'WIN' || result === 'LOSS' ? result : '';
  const terminalAt = s.terminalAt || s.closedAt || (terminalState ? s.updatedAt : null);
  const terminalPrice = s.terminalPrice || s.exitPx || null;
  const lossReason = result === 'LOSS' ? (s.lossReason || s.stateReason || lastHistoryReason(s) || 'SL hit') : '';

  return {
    id: s.id || s.signalId || key,
    signalId: s.signalId || s.id || key,
    key,
    sym: s.sym || s.symbol,
    symbol: s.symbol || s.sym,
    side: s.side,
    entry: s.entry,
    sl: s.sl,
    tp1: s.tp1,
    score: s.score,
    rr: s.rr || s.rr1,
    margin: s.margin,
    leverage: s.leverage,
    position: s.position,
    status: statusForResult(result, s.status),
    paperState: displayStateForResult(result, s.paperState),
    displayState: displayStateForResult(result, s.displayState || s.paperState),
    positionStatus: terminalState ? 'CLOSED' : (result === 'ACTIVE' ? 'PAPER' : 'NONE'),
    result,
    terminalState,
    terminalAt,
    terminalPrice,
    openedAt: s.openedAt || s.createdAt || s.updatedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    closedAt: s.closedAt || terminalAt,
    exitPx: s.exitPx || terminalPrice,
    grossTpUSDT: s.grossTpUSDT || s.tp1ProfitUSDT || 0,
    grossSlUSDT: s.grossSlUSDT || s.slLossUSDT || 0,
    tp1ProfitUSDT: s.tp1ProfitUSDT || s.grossTpUSDT || 0,
    slLossUSDT: s.slLossUSDT || s.grossSlUSDT || 0,
    tp1Profit: s.tp1Profit || s.tpPct || 0,
    slPct: s.slPct || 0,
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

function isCountedTerminalResult(r) {
  return r && (r.result === 'WIN' || r.result === 'LOSS');
}

function terminalTime(r) {
  return num(r.terminalAt || r.closedAt || r.updatedAt || r.createdAt || r.openedAt);
}

function chooseLedgerRow(old, next) {
  if (!old) return next;
  if (!next) return old;

  // First WIN/LOSS is final forever. Later price recovery cannot rewrite truth.
  if (isCountedTerminalResult(old) && isCountedTerminalResult(next)) {
    return terminalTime(next) < terminalTime(old) ? next : old;
  }
  if (isCountedTerminalResult(old)) return old;
  if (isCountedTerminalResult(next)) return next;

  const oldT = num(old.updatedAt || old.closedAt || old.createdAt || old.openedAt);
  const nextT = num(next.updatedAt || next.closedAt || next.createdAt || next.openedAt);
  return nextT >= oldT ? next : old;
}

function saveLedger(rows) {
  const unique = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    const next = normalizeLedgerTrade(r);
    const key = next.key || tradeKey(next);
    unique.set(key, chooseLedgerRow(unique.get(key), next));
  }
  const sorted = [...unique.values()].sort((a, b) => num(b.createdAt || b.openedAt || b.updatedAt) - num(a.createdAt || a.openedAt || a.updatedAt)).slice(0, MAX_LEDGER);
  store.write('v4_paper_ledger', sorted);
  store.write('v4_signal_snapshot', sorted);
  return sorted;
}

function upsertLedger(signals = []) {
  const ledger = getLedger();
  const merged = saveLedger([...ledger, ...(signals || []).map(normalizeLedgerTrade)]);
  return merged;
}

function getSignalSnapshot() {
  const ledger = saveLedger(getLedger());
  return ledger;
}

function computeLedgerSummary(rows = getLedger()) {
  const unique = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    const next = normalizeLedgerTrade(r);
    const key = next.key || tradeKey(next);
    unique.set(key, chooseLedgerRow(unique.get(key), next));
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

function finalizePaperSignal(s, final, price, now) {
  if (!s || FINAL_STATES.has(s.paperState)) return false;
  s.paperState = final.state;
  s.displayState = final.state;
  s.status = final.status;
  s.terminalState = final.status === 'WIN' ? 'WIN' : final.status === 'LOSS' ? 'LOSS' : '';
  s.positionStatus = 'CLOSED';
  s.closedAt = s.closedAt || now;
  s.terminalAt = s.terminalAt || now;
  s.exitPx = roundPrice(price);
  s.terminalPrice = s.terminalPrice || s.exitPx;
  s.realizedPnl = final.state === 'TP_HIT' ? num(s.netTpUSDT) : final.state === 'SL_HIT' ? num(s.netSlUSDT) : 0;
  s.stateReason = final.reason;
  s.history = [...(s.history || []), { at: now, state: final.state, reason: final.reason, price }];
  return true;
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
      if (Math.abs(price - entry) <= Math.max(atr * ENTRY_TOLERANCE_ATR, entry * 0.0025)) {
        s.paperState = 'PAPER_ACTIVE';
        s.status = 'ACTIVE';
        s.displayState = 'PAPER_ACTIVE';
        s.positionStatus = 'PAPER';
        s.entryHit = true;
        s.stateReason = 'V4: entry zone reached';
        s.history = [...(s.history || []), { at: now, state: 'PAPER_ACTIVE', reason: s.stateReason, price }];
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
      if (final && finalizePaperSignal(s, final, price, now)) {
        changed = true;
      }
    }
  }
  return changed;
}

function canCreateForSymbol(signals, symbol, settings) {
  if (!settings.oneTradePerSymbol) return true;
  const now = Date.now();
  const active = signals.find(s => s.sym === symbol && ACTIVE_STATES.has(s.paperState));
  if (active) return false;
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
    let signals = getSignals();

    updateExistingSignals(signals, priceMap);

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
        const gate = shouldReject(leader, settings);
        leader.rejected = !gate.ok;
        leader.rejectReasons = gate.reasons;
        entries.push(leader);
        if (gate.ok && canCreateForSymbol(signals, leader.symbol, settings)) {
          const sig = signalFromLeader(leader, settings);
          signals.unshift(sig);
          addLog('V4_SIGNAL', `${leader.symbol} ${leader.side} ${sig.paperState}`, { score: leader.score, rr: leader.math.rr });
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

function getSnapshot() {
  const persisted = store.read('v4_snapshot', null);
  if (persisted && persisted.ts && (!snapshot.ts || persisted.ts > snapshot.ts)) snapshot = persisted;
  const signals = getSignals();
  const ledger = upsertLedger(signals);
  const summary = { ...computeLedgerSummary(ledger), visible: computeSummary(signals), source: 'v4_signal_snapshot' };
  return { ...snapshot, signals, visibleSignals: signals.length, ledger: ledger.slice(0, RECENT_LEDGER_LIMIT), signalSnapshot: ledger, summary, lastError };
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

function clearSignals({ archive = true, clearLedger = false, fresh = false } = {}) {
  const signals = getSignals();
  const ledgerBefore = upsertLedger(signals);
  if (archive && signals.length) {
    const sessions = getSessions();
    sessions.unshift({ at: Date.now(), summary: computeSummary(signals), ledgerSummary: computeLedgerSummary(ledgerBefore), signals });
    saveSessions(sessions);
  }
  saveSignals([]);
  if (clearLedger || fresh) saveLedger([]);
  const ledger = (clearLedger || fresh) ? [] : getLedger();
  snapshot = { ...snapshot, signals: [], visibleSignals: 0, ledger: ledger.slice(0, RECENT_LEDGER_LIMIT), summary: { ...computeLedgerSummary(ledger), visible: computeSummary([]), source: 'v4_paper_ledger' }, ts: Date.now() };
  store.write('v4_snapshot', snapshot);
  return { ok: true, archived: archive && signals.length ? 1 : 0, total: 0, ledgerTotal: ledger.length, ledgerCleared: !!(clearLedger || fresh) };
}

function freshJournal() {
  const result = clearSignals({ archive: true, clearLedger: true, fresh: true });
  store.write('journal', []);
  store.write('trade-log', []);
  return { ok: true, ...result, fresh: true };
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
  getSignalSnapshot,
  computeLedgerSummary,
  clearSignals,
  freshJournal,
  computeSummary,
  getLeaderboard,
};
