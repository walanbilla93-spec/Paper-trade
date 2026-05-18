'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// ORAYAN MARKET SENTINEL — fix29
// Self-aware market regime engine. Runs every 5 minutes independently.
//
// SOURCES:
//   A) BTC multi-timeframe regime (5m + 15m + 1h + 4h confluence score)
//   B) Market volume delta (breadth — what % of scanned pairs are bullish)
//   C) Funding rate sentiment (Binance premiumIndex top pairs)
//
// OUTPUT (getSentinel()):
//   {
//     market_regime: STRONG_BULL | BULL | CHOP | BEAR | STRONG_BEAR
//     composite_score: -6 to +6
//     allowed_sides: ['BUY','SELL'] | ['BUY'] | ['SELL'] | []
//     buy_score_gate:  70–90  (dynamic, additive on top of base 70)
//     sell_score_gate: 70–90  (dynamic, additive on top of base 70)
//     buy_rr_gate:     1.5–2.2 (dynamic, additive on top of base 1.8)
//     sell_rr_gate:    1.5–2.2 (dynamic, additive on top of base 1.8)
//     buy_wr_rolling:  % (last 20 closed BUY trades)
//     sell_wr_rolling: % (last 20 closed SELL trades)
//     btc:  { score, label, regime, trend5, trend15, trend1h, trend4h, rsi, ema_spread }
//     vol:  { score, label, bull_pct, bear_pct, neutral_pct, pair_count }
//     fund: { score, label, avg_rate, danger }
//     last_updated: ms timestamp
//     regime_since:  ms timestamp (when market_regime last flipped)
//     wr_adjusted:   boolean (true when rolling WR has pushed gates above base)
//   }
//
// GATES IN v4Brain.js — sentinel overrides are ADDITIVE:
//   minScore = Math.max(user_setting, sentinel.buy_score_gate)
//   minRR    = Math.max(user_setting, sentinel.buy_rr_gate)
//   side blocked → SENTINEL_SIDE_BLOCK added to reject reasons
// ═══════════════════════════════════════════════════════════════════════════

const { bybitPublicGet } = require('./bybit');
const store = require('./store');

// ─── Math helpers ────────────────────────────────────────────────────────────

function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function sma(vals, len) { return avg(vals.slice(-len)); }

function ema(values, len) {
  if (!values.length) return 0;
  if (values.length < len) return sma(values, values.length);
  const k = 2 / (len + 1);
  let e = sma(values.slice(0, len), len);
  for (let i = len; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function calcRsi(closes, len = 14) {
  if (closes.length < len + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / len, al = losses / len;
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (len - 1) + Math.max(d, 0)) / len;
    al = (al * (len - 1) + Math.max(-d, 0)) / len;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

// ─── Candle fetch (Bybit) ─────────────────────────────────────────────────

async function fetchKline(symbol, interval, limit) {
  try {
    const data = await bybitPublicGet('/v5/market/kline', {
      category: 'linear', symbol, interval: String(interval), limit,
    });
    return (data.result?.list || [])
      .map(r => ({ ts: num(r[0]), open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]), volume: num(r[5]) }))
      .sort((a, b) => a.ts - b.ts);
  } catch { return []; }
}

// ─── Funding rate fetch (Binance) ────────────────────────────────────────────

async function fetchFundingRates() {
  try {
    const BASE = 'https://fapi.binance.com';
    const resp = await fetch(`${BASE}/fapi/v1/premiumIndex`, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data)) return null;
    // Top liquid pairs only
    const TOP = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT',
      'MATICUSDT','LTCUSDT','UNIUSDT','ATOMUSDT','NEARUSDT','FTMUSDT','ALGOUSDT','AAVEUSDT','SHIBUSDT','TRXUSDT'];
    const filtered = data.filter(d => TOP.includes(d.symbol) && d.lastFundingRate !== undefined);
    if (!filtered.length) return null;
    const rates = filtered.map(d => num(d.lastFundingRate) * 100); // convert to %
    return { rates, avg: avg(rates), pairs: filtered.map(d => d.symbol) };
  } catch { return null; }
}

// ─── A) BTC Multi-TF Regime ──────────────────────────────────────────────────
// Score: each TF votes +1 (bull), -1 (bear), 0 (neutral)
// 4 TFs → score -4 to +4
// STRONG_BULL: +3/+4, BULL: +1/+2, CHOP: 0, BEAR: -1/-2, STRONG_BEAR: -3/-4

async function computeBTCRegime() {
  const [k5, k15, k60, k240] = await Promise.all([
    fetchKline('BTCUSDT', '5',   80),
    fetchKline('BTCUSDT', '15',  80),
    fetchKline('BTCUSDT', '60',  60),
    fetchKline('BTCUSDT', '240', 60),
  ]);

  function tfVote(candles, short = 9, long = 21) {
    if (candles.length < long + 2) return 0;
    const closes = candles.map(c => c.close);
    const e1 = ema(closes, short);
    const e2 = ema(closes, long);
    const rsi = calcRsi(closes, 14);
    const bullEma = e1 > e2 * 1.0005; // needs a clear gap, not just touching
    const bearEma = e1 < e2 * 0.9995;
    // RSI confirmation
    const rsiConfirmBull = rsi > 52;
    const rsiConfirmBear = rsi < 48;
    if (bullEma && rsiConfirmBull) return 1;
    if (bearEma && rsiConfirmBear) return -1;
    return 0;
  }

  const vote5   = tfVote(k5,   9, 21);
  const vote15  = tfVote(k15,  9, 21);
  const vote1h  = tfVote(k60,  9, 21);
  const vote4h  = tfVote(k240, 9, 21);

  const score = vote5 + vote15 + vote1h + vote4h; // -4 to +4

  // RSI on 1h for extra context
  const rsi1h = k60.length >= 15 ? calcRsi(k60.map(c => c.close), 14) : 50;

  // EMA spread on 15m for chop detection
  const closes15 = k15.map(c => c.close);
  const price = closes15[closes15.length - 1] || 1;
  const ema20_15 = ema(closes15, 20);
  const ema50_15 = ema(closes15, 50);
  const emaSpread = price ? Math.abs(ema20_15 - ema50_15) / price * 100 : 0;

  let label, regime;
  if      (score >= 3)  { regime = 'STRONG_BULL'; label = '🟢 Strong Bull'; }
  else if (score >= 1)  { regime = 'BULL';         label = '📈 Bull'; }
  else if (score <= -3) { regime = 'STRONG_BEAR';  label = '🔴 Strong Bear'; }
  else if (score <= -1) { regime = 'BEAR';          label = '📉 Bear'; }
  else                  { regime = 'CHOP';          label = '〰 Chop'; }

  // Chop override: if EMAs are very tight and score is 0
  if (score === 0 && emaSpread < 0.25) { regime = 'CHOP'; label = '〰 Chop'; }

  return {
    score,
    regime,
    label,
    vote5, vote15, vote1h, vote4h,
    rsi1h: Number(rsi1h.toFixed(1)),
    ema_spread: Number(emaSpread.toFixed(3)),
    price: Number(price.toFixed(2)),
  };
}

// ─── B) Market Volume Delta ───────────────────────────────────────────────────
// Uses live price map from v4Brain (injected via updateVolumeDelta())
// Each pair: close > open on last 5m candle → bullish vote (weighted by volume)
// Score: -1 (bear pressure) | 0 (neutral) | +1 (bull pressure)

let _priceMapSnapshot = null; // set by updateVolumeDelta()

function updateVolumeDelta(priceMap) {
  // priceMap: { BTCUSDT: { price, open, volume, ... }, ... }
  _priceMapSnapshot = priceMap;
}

function computeVolumeDelta() {
  if (!_priceMapSnapshot) return { score: 0, label: 'Neutral', bull_pct: 50, bear_pct: 50, neutral_pct: 0, pair_count: 0 };

  const entries = Object.values(_priceMapSnapshot).filter(p => p && p.price && p.open);
  let bull = 0, bear = 0, neutral = 0, bullVol = 0, bearVol = 0;

  for (const p of entries) {
    const vol = num(p.volume, 1);
    if (p.price > p.open * 1.0002) { bull++; bullVol += vol; }
    else if (p.price < p.open * 0.9998) { bear++; bearVol += vol; }
    else neutral++;
  }

  const total = bull + bear + neutral;
  if (!total) return { score: 0, label: 'Neutral', bull_pct: 50, bear_pct: 50, neutral_pct: 0, pair_count: 0 };

  const bull_pct = bull / total * 100;
  const bear_pct = bear / total * 100;

  // Volume-weighted delta
  const totalVol = bullVol + bearVol;
  const volDeltaPct = totalVol ? (bullVol - bearVol) / totalVol * 100 : 0;

  let score, label;
  if (bull_pct >= 65 || volDeltaPct > 20) { score = 1;  label = '🟢 Bull Pressure'; }
  else if (bear_pct >= 65 || volDeltaPct < -20) { score = -1; label = '🔴 Bear Pressure'; }
  else { score = 0; label = '⚪ Neutral'; }

  return {
    score,
    label,
    bull_pct: Number(bull_pct.toFixed(1)),
    bear_pct: Number(bear_pct.toFixed(1)),
    neutral_pct: Number((neutral / total * 100).toFixed(1)),
    vol_delta_pct: Number(volDeltaPct.toFixed(1)),
    pair_count: total,
  };
}

// ─── C) Funding Rate Sentiment ────────────────────────────────────────────────
// avg funding > +0.05% = overleveraged longs = danger for BUY (shorts incoming)
// avg funding < -0.01% = overleveraged shorts = danger for SELL (squeeze incoming)
// Score: -1 (danger for BUY) | 0 (neutral) | +1 (danger for SELL = good for BUY)

async function computeFundingSentiment() {
  const raw = await fetchFundingRates();
  if (!raw) return { score: 0, label: 'Unknown', avg_rate: 0, danger: 'none' };

  const rate = raw.avg;
  let score, label, danger;

  if (rate > 0.05) {
    // Very positive: market extremely long, squeeze risk = bad for BUY
    score = -1; label = '⚠️ Overlong (danger for BUY)'; danger = 'BUY';
  } else if (rate > 0.02) {
    // Moderately positive: longs paying, bullish lean but watch out
    score = 0; label = '🟡 Slightly Overlong'; danger = 'slight_BUY';
  } else if (rate < -0.01) {
    // Negative: shorts paying = squeeze imminent = bad for SELL
    score = 1; label = '⚠️ Overshort (danger for SELL)'; danger = 'SELL';
  } else {
    // Balanced
    score = 0; label = '⚪ Balanced Funding'; danger = 'none';
  }

  return {
    score,
    label,
    avg_rate: Number(rate.toFixed(4)),
    danger,
    pair_count: raw.rates.length,
  };
}

// ─── D) Rolling WR Engine ─────────────────────────────────────────────────────
// Track last 20 closed trades per side from v4_paper_ledger.
// BUY WR < 40% → raise buy_score_gate +5, WR < 30% → +10 + raise buy_rr_gate +0.2
// BUY WR > 60% → relax buy_score_gate -3 (floor = base 70)
// Same for SELL.

const BASE_SCORE_GATE = 70;
const BASE_RR_GATE    = 1.8;
const WR_WINDOW       = 20;

function computeRollingWR(ledger) {
  const closed = (ledger || []).filter(t => t.result === 'WIN' || t.result === 'LOSS');

  // Sort newest first
  const byTime = [...closed].sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));

  const result = {};
  for (const side of ['BUY', 'SELL']) {
    const recent = byTime.filter(t => t.side === side).slice(0, WR_WINDOW);
    const wins   = recent.filter(t => t.result === 'WIN').length;
    const wr     = recent.length ? wins / recent.length * 100 : 50;

    let scoreAdj = 0, rrAdj = 0, wr_label;

    if (recent.length >= 5) { // need at least 5 trades to adjust
      if (wr < 30) {
        scoreAdj = 10; rrAdj = 0.2;
        wr_label = `🔴 ${wr.toFixed(0)}% WR — gates raised aggressively`;
      } else if (wr < 40) {
        scoreAdj = 5; rrAdj = 0;
        wr_label = `🟠 ${wr.toFixed(0)}% WR — score gate raised`;
      } else if (wr > 60) {
        scoreAdj = -3; rrAdj = 0;
        wr_label = `🟢 ${wr.toFixed(0)}% WR — gates relaxed`;
      } else {
        wr_label = `🟡 ${wr.toFixed(0)}% WR — gates at base`;
      }
    } else {
      wr_label = `⚪ ${recent.length} trades — not enough data`;
    }

    result[side] = {
      wr: Number(wr.toFixed(1)),
      trades: recent.length,
      wins,
      losses: recent.length - wins,
      score_adj: scoreAdj,
      rr_adj: Number(rrAdj.toFixed(2)),
      score_gate: Math.max(BASE_SCORE_GATE, BASE_SCORE_GATE + scoreAdj),
      rr_gate:    Number(Math.max(BASE_RR_GATE - 0.3, BASE_RR_GATE + rrAdj).toFixed(2)),
      label: wr_label,
    };
  }
  return result;
}

// ─── E) Composite Sentinel ───────────────────────────────────────────────────

function compositeRegime(btcScore, volScore, fundScore) {
  // BTC weighted 2x (most reliable), vol 1x, funding 1x
  const composite = btcScore * 2 + volScore + fundScore; // -6 to +6

  let market_regime, regime_label, regime_color;
  if      (composite >= 4)  { market_regime = 'STRONG_BULL'; regime_label = '🟢 STRONG BULL'; regime_color = '#00ff88'; }
  else if (composite >= 1)  { market_regime = 'BULL';         regime_label = '📈 BULL';         regime_color = '#00c96e'; }
  else if (composite <= -4) { market_regime = 'STRONG_BEAR';  regime_label = '🔴 STRONG BEAR';  regime_color = '#ff3b3b'; }
  else if (composite <= -1) { market_regime = 'BEAR';          regime_label = '📉 BEAR';          regime_color = '#e05252'; }
  else                      { market_regime = 'CHOP';           regime_label = '〰 CHOP';          regime_color = '#888888'; }

  return { market_regime, regime_label, regime_color, composite_score: composite };
}

function computeAllowedSides(market_regime, wrData, fundDanger) {
  const sides = [];

  // Base: which sides the regime allows
  const bullRegimes = ['STRONG_BULL', 'BULL'];
  const bearRegimes = ['STRONG_BEAR', 'BEAR'];

  if (bullRegimes.includes(market_regime)) {
    sides.push('BUY');
    // SELL allowed in bull only if SELL WR is strong enough to survive
    if (wrData.SELL && wrData.SELL.wr >= 55) sides.push('SELL');
  } else if (bearRegimes.includes(market_regime)) {
    sides.push('SELL');
    // BUY allowed in bear only if BUY WR is strong enough to survive
    if (wrData.BUY && wrData.BUY.wr >= 55) sides.push('BUY');
  } else {
    // CHOP: both allowed but with higher gates (handled in gate computation)
    sides.push('BUY');
    sides.push('SELL');
  }

  // Funding override: extreme overlong = remove BUY
  if (fundDanger === 'BUY' && sides.includes('BUY')) {
    const idx = sides.indexOf('BUY');
    sides.splice(idx, 1); // remove BUY
  }
  // Extreme overshort = remove SELL
  if (fundDanger === 'SELL' && sides.includes('SELL')) {
    const idx = sides.indexOf('SELL');
    sides.splice(idx, 1);
  }

  return sides;
}

function computeGates(market_regime, wrData) {
  const chopRegimes = ['CHOP'];
  const isChop = chopRegimes.includes(market_regime);
  const isStrong = market_regime === 'STRONG_BULL' || market_regime === 'STRONG_BEAR';

  // For BUY in BEAR regime or SELL in BULL regime: extra +8 score requirement (against-trend trades)
  const buyAgainstTrend = ['BEAR', 'STRONG_BEAR'].includes(market_regime);
  const sellAgainstTrend = ['BULL', 'STRONG_BULL'].includes(market_regime);

  const buyBase  = BASE_SCORE_GATE + (buyAgainstTrend ? 8 : 0) + (isChop ? 4 : 0) + (wrData.BUY?.score_adj || 0);
  const sellBase = BASE_SCORE_GATE + (sellAgainstTrend ? 8 : 0) + (isChop ? 4 : 0) + (wrData.SELL?.score_adj || 0);

  const buyRR   = Number((BASE_RR_GATE + (isChop ? 0.2 : 0) + (buyAgainstTrend ? 0.2 : 0) + (wrData.BUY?.rr_adj || 0)).toFixed(2));
  const sellRR  = Number((BASE_RR_GATE + (isChop ? 0.2 : 0) + (sellAgainstTrend ? 0.2 : 0) + (wrData.SELL?.rr_adj || 0)).toFixed(2));

  return {
    buy_score_gate:  Math.max(BASE_SCORE_GATE, Math.min(90, buyBase)),
    sell_score_gate: Math.max(BASE_SCORE_GATE, Math.min(90, sellBase)),
    buy_rr_gate:     Math.max(1.5, Math.min(2.5, buyRR)),
    sell_rr_gate:    Math.max(1.5, Math.min(2.5, sellRR)),
    wr_adjusted:     (wrData.BUY?.score_adj !== 0) || (wrData.SELL?.score_adj !== 0),
  };
}

// ─── History log ─────────────────────────────────────────────────────────────

const HISTORY_KEY = 'sentinel_history';
const MAX_HISTORY = 500;

function appendHistory(prev, next) {
  if (!prev || prev === next.market_regime) return; // no flip
  try {
    const history = store.read(HISTORY_KEY, []);
    history.unshift({
      ts: Date.now(),
      ts_str: new Date().toISOString(),
      from_regime: prev,
      to_regime: next.market_regime,
      btc_score: next.btc?.score,
      btc_regime: next.btc?.regime,
      vol_score: next.vol?.score,
      vol_bull_pct: next.vol?.bull_pct,
      fund_score: next.fund?.score,
      fund_avg_rate: next.fund?.avg_rate,
      composite: next.composite_score,
      buy_gate: next.buy_score_gate,
      sell_gate: next.sell_score_gate,
      buy_wr: next.buy_wr_rolling,
      sell_wr: next.sell_wr_rolling,
    });
    store.write(HISTORY_KEY, history.slice(0, MAX_HISTORY));
  } catch (e) { /* non-critical */ }
}

// ─── State ───────────────────────────────────────────────────────────────────

let _sentinel = {
  market_regime:    'UNKNOWN',
  regime_label:     '? Unknown',
  regime_color:     '#888888',
  composite_score:  0,
  allowed_sides:    ['BUY', 'SELL'],
  buy_score_gate:   BASE_SCORE_GATE,
  sell_score_gate:  BASE_SCORE_GATE,
  buy_rr_gate:      BASE_RR_GATE,
  sell_rr_gate:     BASE_RR_GATE,
  buy_wr_rolling:   50,
  sell_wr_rolling:  50,
  btc:              { score: 0, regime: 'UNKNOWN', label: 'Unknown', vote5: 0, vote15: 0, vote1h: 0, vote4h: 0, rsi1h: 50, ema_spread: 0 },
  vol:              { score: 0, label: 'Neutral', bull_pct: 50, bear_pct: 50, pair_count: 0 },
  fund:             { score: 0, label: 'Unknown', avg_rate: 0, danger: 'none' },
  wr:               { BUY: { wr: 50, trades: 0, score_gate: BASE_SCORE_GATE, rr_gate: BASE_RR_GATE }, SELL: { wr: 50, trades: 0, score_gate: BASE_SCORE_GATE, rr_gate: BASE_RR_GATE } },
  last_updated:     0,
  regime_since:     0,
  wr_adjusted:      false,
};

let _running = false;
let _timer   = null;

// ─── Main update ─────────────────────────────────────────────────────────────

async function runSentinel() {
  if (_running) return;
  _running = true;

  try {
    const prevRegime = _sentinel.market_regime;

    // Fetch all sources in parallel
    const [btc, fund] = await Promise.all([
      computeBTCRegime(),
      computeFundingSentiment(),
    ]);

    // Volume delta from in-memory price snapshot (no API call)
    const vol = computeVolumeDelta();

    // Composite regime
    const { market_regime, regime_label, regime_color, composite_score } = compositeRegime(btc.score, vol.score, fund.score);

    // Rolling WR from ledger
    const ledger = (() => { try { return store.read('v4_paper_ledger', []); } catch { return []; } })();
    const wrData = computeRollingWR(ledger);

    // Allowed sides
    const allowed_sides = computeAllowedSides(market_regime, wrData, fund.danger);

    // Gate computation
    const gates = computeGates(market_regime, wrData);

    // History logging on flip
    const regime_since = market_regime !== prevRegime ? Date.now() : (_sentinel.regime_since || Date.now());
    appendHistory(prevRegime === 'UNKNOWN' ? null : prevRegime, { market_regime, btc, vol, fund, composite_score, buy_score_gate: gates.buy_score_gate, sell_score_gate: gates.sell_score_gate, buy_wr_rolling: wrData.BUY?.wr, sell_wr_rolling: wrData.SELL?.wr });

    _sentinel = {
      market_regime,
      regime_label,
      regime_color,
      composite_score,
      allowed_sides,
      buy_score_gate:   gates.buy_score_gate,
      sell_score_gate:  gates.sell_score_gate,
      buy_rr_gate:      gates.buy_rr_gate,
      sell_rr_gate:     gates.sell_rr_gate,
      buy_wr_rolling:   wrData.BUY?.wr ?? 50,
      sell_wr_rolling:  wrData.SELL?.wr ?? 50,
      btc,
      vol,
      fund,
      wr: wrData,
      last_updated: Date.now(),
      regime_since,
      wr_adjusted: gates.wr_adjusted,
    };

  } catch (e) {
    // Non-fatal — keep last known state, just log
    console.error('[Sentinel] update failed:', e.message);
  } finally {
    _running = false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

function getSentinel() { return _sentinel; }

function getHistory() {
  try { return store.read(HISTORY_KEY, []); } catch { return []; }
}

function getHistoryCSV() {
  const rows = getHistory();
  if (!rows.length) return 'ts_str,from_regime,to_regime,btc_score,vol_score,fund_score,composite,buy_gate,sell_gate,buy_wr,sell_wr\n';
  const header = Object.keys(rows[0]).join(',');
  const body   = rows.map(r => Object.values(r).join(',')).join('\n');
  return header + '\n' + body + '\n';
}

function start(intervalMs = 5 * 60 * 1000) {
  if (_timer) return;
  // First run after 10s (let v4Brain finish initial scan first)
  setTimeout(() => runSentinel().catch(() => {}), 10000);
  _timer = setInterval(() => runSentinel().catch(() => {}), intervalMs);
  console.log(`[Sentinel] started — regime refresh every ${intervalMs / 60000} min`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// Called by v4Brain after each scan cycle with the live price map
function injectPriceMap(priceMap) {
  if (priceMap && typeof priceMap === 'object') updateVolumeDelta(priceMap);
}

// Immediate refresh (called from route on demand)
function refresh() { return runSentinel(); }

module.exports = { getSentinel, getHistory, getHistoryCSV, start, stop, injectPriceMap, refresh };
