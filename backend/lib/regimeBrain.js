'use strict';

// ORAYAN Regime Brain — fix24-a
// Replaces the simple bull/bear/mixed BTC check with a 6-state global regime
// + 4-state per-pair local regime.
//
// Global BTC regime (computed once per scan cycle, cached):
//   BULL_TREND | BEAR_TREND | BULL_RANGE | BEAR_RANGE | BREAKOUT | CHOP
//
// Per-pair local regime (computed per enrichTicker call):
//   LOCAL_BULL | LOCAL_BEAR | LOCAL_RANGE | LOCAL_CHOP
//
// Allowed-side table (what can be traded given regime combination):
//   See getAllowedSides() below.
//
// This module is OBSERVATION ONLY in fix24-a.
// It logs regime to every signal but does NOT block any trades yet.
// Blocking is introduced in fix24-b once we verify regime labels are sane.

const { bybitPublicGet } = require('./bybit');
const { addLog } = require('./tradeLog');

// ─── Helpers ────────────────────────────────────────────────────────────────

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sma(values, len) {
  if (!values.length) return 0;
  return avg(values.slice(-len));
}

function ema(values, len) {
  if (values.length < len) return sma(values, values.length);
  const k = 2 / (len + 1);
  let e = sma(values.slice(0, len), len);
  for (let i = len; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
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
  return 100 - 100 / (1 + gains / losses);
}

function calcAtr(candles, len = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const c = candles[i];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)));
  }
  return avg(trs.slice(-len));
}

// Count consecutive higher-highs or lower-lows from recent pivot-like candles
function countStructure(candles) {
  if (candles.length < 6) return { hh: 0, ll: 0, lh: 0, hl: 0 };
  // Use last 5 candle highs/lows as a lightweight pivot proxy
  const highs = candles.slice(-5).map(c => c.high);
  const lows  = candles.slice(-5).map(c => c.low);
  let hh = 0, ll = 0, lh = 0, hl = 0;
  for (let i = 1; i < highs.length; i++) {
    if (highs[i] > highs[i - 1]) hh++;
    else lh++;
    if (lows[i] < lows[i - 1]) ll++;
    else hl++;
  }
  return { hh, ll, lh, hl };
}

// ─── Kline fetcher (shared with marketBrain) ────────────────────────────────

async function fetchKline(symbol, interval = '5', limit = 60) {
  const data = await bybitPublicGet('/v5/market/kline', {
    category: 'linear', symbol, interval, limit,
  });
  const list = data.result?.list || [];
  return list
    .map(r => ({
      ts: num(r[0]), open: num(r[1]), high: num(r[2]),
      low: num(r[3]), close: num(r[4]), volume: num(r[5]),
    }))
    .sort((a, b) => a.ts - b.ts);
}

// ─── Global BTC Regime ───────────────────────────────────────────────────────
//
// Uses 15m candles (primary) + RSI + EMA20/50 + structure + volume momentum.
// Returns one of: BULL_TREND | BEAR_TREND | BULL_RANGE | BEAR_RANGE | BREAKOUT | CHOP

let _btcRegimeCache = {
  regime: 'UNKNOWN',
  label: 'Unknown',
  rsi: 50,
  ema20: 0,
  ema50: 0,
  atr: 0,
  structure: {},
  volMomentum: 'neutral',
  trend5: 'neutral',
  trend15: 'neutral',
  trend1h: 'neutral',
  updatedAt: 0,
  error: null,
};

async function detectBTCRegime() {
  try {
    const [k15, k5, k60] = await Promise.all([
      fetchKline('BTCUSDT', '15', 80),
      fetchKline('BTCUSDT', '5', 60).catch(() => []),
      fetchKline('BTCUSDT', '60', 60).catch(() => []),
    ]);

    if (k15.length < 20) {
      _btcRegimeCache = { ..._btcRegimeCache, regime: 'UNKNOWN', error: 'insufficient BTC data', updatedAt: Date.now() };
      return _btcRegimeCache;
    }

    const closes15 = k15.map(c => c.close);
    const closes5  = k5.map(c => c.close);
    const closes1h = k60.map(c => c.close);
    const vols15   = k15.map(c => c.volume);

    const price    = closes15[closes15.length - 1];
    const ema20    = ema(closes15, 20);
    const ema50    = ema(closes15, 50);
    const rsi      = calcRsi(closes15, 14);
    const atr      = calcAtr(k15, 14);
    const atrPct   = price ? (atr / price) * 100 : 0;
    const struct   = countStructure(k15);

    // Volume momentum: is recent volume rising or falling?
    const avgVol   = avg(vols15.slice(-20));
    const recentVol = avg(vols15.slice(-5));
    const volMomentum = recentVol > avgVol * 1.3 ? 'rising' : recentVol < avgVol * 0.7 ? 'falling' : 'neutral';

    // Trend per timeframe (simple EMA relation)
    const trend5  = closes5.length >= 21
      ? (ema(closes5, 9) > ema(closes5, 21) ? 'bull' : ema(closes5, 9) < ema(closes5, 21) ? 'bear' : 'neutral')
      : 'neutral';
    const trend15 = ema20 > ema50 ? 'bull' : ema20 < ema50 ? 'bear' : 'neutral';
    const trend1h = closes1h.length >= 21
      ? (ema(closes1h, 9) > ema(closes1h, 21) ? 'bull' : ema(closes1h, 9) < ema(closes1h, 21) ? 'bear' : 'neutral')
      : 'neutral';

    // EMA spread as a % of price — tight spread = ranging
    // fix48p: ema() falls back to sma(all) when values.length < len. If closes15 has <50
    // candles, ema50 becomes an SMA over a different window than ema20 → their difference
    // balloons → emaPctSpread hit 80-106% (observed in logs), which is physically impossible
    // for a real 20/50 spread (BTC never exceeds ~5%). When the spread is implausible OR we
    // lack the candles for a true ema50, the spread is UNTRUSTWORTHY — don't let it drive
    // emasTight (which gates trend detection). Treat untrusted spread as "not tight" so it
    // doesn't false-trigger range/chop, and flag it.
    const _emaHistOk    = closes15.length >= 50;            // enough candles for a real ema50
    const _rawSpread    = price ? (Math.abs(ema20 - ema50) / price) * 100 : 0;
    const _spreadValid  = _emaHistOk && _rawSpread <= 15;   // >15% = blown-up calc, not real
    const emaPctSpread  = _spreadValid ? _rawSpread : 0;    // 0 reported when untrusted
    const emasTight     = _spreadValid ? emaPctSpread < 0.3  : false; // untrusted → not "tight"
    const emasCrossing  = _spreadValid ? emaPctSpread < 0.15 : false;

    // RSI bands
    const rsiBullish  = rsi >= 52 && rsi <= 75;
    const rsiBearish  = rsi >= 25 && rsi <= 48;
    const rsiNeutral  = rsi > 45 && rsi < 55;
    const rsiExtreme  = rsi > 78 || rsi < 22;

    // Structure signals
    const bullStruct  = struct.hh >= 3 && struct.hl >= 3;  // higher-highs + higher-lows
    const bearStruct  = struct.ll >= 3 && struct.lh >= 3;  // lower-lows + lower-highs
    const choppyStruct = !bullStruct && !bearStruct && (struct.hh + struct.ll) <= 2;

    // Breakout: price recently moved > 1.5× ATR in one direction with volume
    const lastCandle  = k15[k15.length - 1];
    const prevClose   = k15[k15.length - 2]?.close || price;
    const candleMove  = Math.abs(lastCandle.close - prevClose);
    const breakoutUp  = candleMove > atr * 1.2 && lastCandle.close > lastCandle.open && volMomentum === 'rising';
    const breakoutDn  = candleMove > atr * 1.2 && lastCandle.close < lastCandle.open && volMomentum === 'rising';

    // ── Classify ──
    let regime;
    let _regimeCorrection = null; // fix48p: set when a mislabel guard rewrites the naive label

    if (breakoutUp && price > ema20) {
      regime = 'BREAKOUT';
    } else if (breakoutDn && price < ema20) {
      regime = 'BREAKOUT';
    } else if (emasCrossing && rsiNeutral && choppyStruct && atrPct < 0.4) {
      regime = 'CHOP';
    } else if (ema20 > ema50 && rsiBullish && !emasTight && (bullStruct || trend1h === 'bull')) {
      regime = 'BULL_TREND';
    } else if (ema20 < ema50 && rsiBearish && !emasTight && (bearStruct || trend1h === 'bear')) {
      regime = 'BEAR_TREND';
    } else if (ema20 >= ema50 && rsiNeutral && emasTight) {
      regime = 'BULL_RANGE';
    } else if (ema20 <= ema50 && rsiNeutral && emasTight) {
      regime = 'BEAR_RANGE';
    } else if (rsiExtreme) {
      // fix48p: RSI-EXTREME WAS BLINDLY → CHOP, which blocked ALL trading (BTC_CHOP_BLOCKS_ALL)
      // in the most directional markets. Observed: BTC RSI 9-14 (max oversold, dashboard
      // STRONG_BEAR) got labeled CHOP → 100min of NO_DIRECTION skips on valid SELLs.
      // RSI<22 in a confirmed DOWNtrend is STRONG BEAR continuation, not chop. RSI>78 in a
      // confirmed UPtrend is strong bull. Only treat extreme as chop when structure/trend
      // DON'T confirm a direction (true exhaustion in unclear structure — the original intent).
      const _extremeLow  = rsi < 22;   // oversold
      const _extremeHigh = rsi > 78;   // overbought
      const _bearConfirm = _extremeLow  && (ema20 < ema50 || bearStruct || trend1h === 'bear' || trend15 === 'bear');
      const _bullConfirm = _extremeHigh && (ema20 > ema50 || bullStruct || trend1h === 'bull' || trend15 === 'bull');
      if (_bearConfirm) {
        regime = 'BEAR_TREND';
        _regimeCorrection = `RSI_EXTREME_RECLASS: rsi ${rsi.toFixed(0)} <22 + bear confirm → BEAR_TREND (was CHOP)`;
      } else if (_bullConfirm) {
        regime = 'BULL_TREND';
        _regimeCorrection = `RSI_EXTREME_RECLASS: rsi ${rsi.toFixed(0)} >78 + bull confirm → BULL_TREND (was CHOP)`;
      } else {
        regime = 'CHOP'; // genuine exhaustion in unclear structure — original behavior
      }
    } else if (trend15 === 'bull') {
      regime = 'BULL_RANGE';   // Fallback: trending but not strong enough for BULL_TREND
    } else if (trend15 === 'bear') {
      regime = 'BEAR_RANGE';
    } else {
      regime = 'CHOP';
    }

    const LABELS = {
      BULL_TREND:  '📈 BTC Bull Trend',
      BEAR_TREND:  '📉 BTC Bear Trend',
      BULL_RANGE:  '↗ BTC Bull Range',
      BEAR_RANGE:  '↘ BTC Bear Range',
      BREAKOUT:    '⚡ BTC Breakout',
      CHOP:        '〰 BTC Chop',
      UNKNOWN:     '? Unknown',
    };

    _btcRegimeCache = {
      regime,
      label: LABELS[regime] || regime,
      rsi: Number(rsi.toFixed(1)),
      ema20: Number(ema20.toFixed(2)),
      ema50: Number(ema50.toFixed(2)),
      emaPctSpread: Number(emaPctSpread.toFixed(3)),
      atr: Number(atr.toFixed(4)),
      atrPct: Number(atrPct.toFixed(3)),
      structure: struct,
      volMomentum,
      breakoutUp,
      breakoutDn,
      trend5,
      trend15,
      trend1h,
      regimeCorrection: _regimeCorrection, // fix48p: non-null when a mislabel guard fired
      spreadValid: _spreadValid,           // fix48p: false = ema spread was untrustworthy
      updatedAt: Date.now(),
      error: null,
    };

    // fix48p: surface mislabel corrections to the log so we can audit how often the naive
    // classifier was wrong (e.g. RSI-extreme crash mislabeled CHOP, or blown-up EMA spread).
    if (_regimeCorrection) {
      addLog('BTC_REGIME_FIX', _regimeCorrection, { regime, rsi: Number(rsi.toFixed(1)), spreadValid: _spreadValid });
    }

    addLog('BTC_REGIME', `BTC regime: ${regime} | RSI ${rsi.toFixed(0)} | EMA spread ${emaPctSpread.toFixed(2)}% | vol ${volMomentum}`, {
      regime, rsi: _btcRegimeCache.rsi, trend5, trend15, trend1h,
    });

  } catch (e) {
    _btcRegimeCache = {
      ..._btcRegimeCache,
      regime: _btcRegimeCache.regime || 'UNKNOWN',
      error: e.message,
      updatedAt: Date.now(),
    };
    addLog('WARN', `BTC regime detection failed: ${e.message}`);
  }

  return _btcRegimeCache;
}

function getBTCRegime() {
  return _btcRegimeCache;
}

// ─── Per-Pair Local Regime ───────────────────────────────────────────────────
//
// Uses candles already fetched by enrichTicker — no extra API call.
// k5: 5m candles, k15: 15m candles (both as raw candle arrays)
//
// Returns: { localRegime, localLabel, ema9, ema21, macdHist, candleBias }

function detectLocalRegime(k5, k15 = []) {
  try {
    const closes5  = k5.map(c => c.close).filter(Boolean);
    const closes15 = k15.map(c => c.close).filter(Boolean);

    if (closes5.length < 21) {
      return { localRegime: 'LOCAL_UNKNOWN', localLabel: '? Local Unknown', ema9: 0, ema21: 0, macdHist: 0, candleBias: 'neutral' };
    }

    const e9  = ema(closes5, 9);
    const e21 = ema(closes5, 21);
    const e26 = ema(closes5, 26);

    // MACD histogram proxy: EMA12 - EMA26
    const e12 = ema(closes5, 12);
    const macdLine = e12 - e26;
    // Signal: EMA9 of MACD line — approximate using last few values
    const macdHist = macdLine; // Simplified: positive = bullish momentum, negative = bearish

    // Candle body bias: last 3 candles
    const last3 = k5.slice(-3);
    let bullBodies = 0, bearBodies = 0;
    for (const c of last3) {
      if (c.close > c.open) bullBodies++;
      else if (c.close < c.open) bearBodies++;
    }
    const candleBias = bullBodies >= 2 ? 'bull' : bearBodies >= 2 ? 'bear' : 'neutral';

    // Local structure: last 3 highs/lows
    const localStruct = countStructure(k5.slice(-8));

    // EMA spread on 5m
    const price = closes5[closes5.length - 1];
    const localEmaPct = price ? (Math.abs(e9 - e21) / price) * 100 : 0;
    const localEmasTight = localEmaPct < 0.2;

    // RSI on 5m
    const rsi5 = calcRsi(closes5, 14);

    // Classify
    let localRegime;
    if (e9 > e21 && macdHist > 0 && candleBias !== 'bear' && !localEmasTight) {
      localRegime = 'LOCAL_BULL';
    } else if (e9 < e21 && macdHist < 0 && candleBias !== 'bull' && !localEmasTight) {
      localRegime = 'LOCAL_BEAR';
    } else if (localEmasTight && Math.abs(macdHist) < 0.0001 * price) {
      localRegime = 'LOCAL_CHOP';
    } else {
      localRegime = 'LOCAL_RANGE';
    }

    const LOCAL_LABELS = {
      LOCAL_BULL:    '↑ Local Bull',
      LOCAL_BEAR:    '↓ Local Bear',
      LOCAL_RANGE:   '↔ Local Range',
      LOCAL_CHOP:    '〰 Local Chop',
      LOCAL_UNKNOWN: '? Local Unknown',
    };

    return {
      localRegime,
      localLabel: LOCAL_LABELS[localRegime] || localRegime,
      ema9: Number(e9.toFixed(6)),
      ema21: Number(e21.toFixed(6)),
      macdHist: Number(macdHist.toFixed(6)),
      candleBias,
      rsi5: Number(rsi5.toFixed(1)),
      localStruct,
    };

  } catch (e) {
    return { localRegime: 'LOCAL_UNKNOWN', localLabel: '? Local Unknown', error: e.message };
  }
}

// ─── Allowed-side table ──────────────────────────────────────────────────────
//
// fix24-a: this is computed and logged but NOT enforced yet.
// fix24-b will use the `blocked` flag to gate trades.
//
// Returns: { allowedBuy, allowedSell, buyStrength, sellStrength, blocked }
// Strength: 'STRONG' | 'WEAK' | 'NONE'

function getAllowedSides(btcRegime, localRegime) {
  const r  = btcRegime  || 'UNKNOWN';
  const lr = localRegime || 'LOCAL_UNKNOWN';

  // Default
  let allowedBuy   = false;
  let allowedSell  = false;
  let buyStrength  = 'NONE';
  let sellStrength = 'NONE';
  let blockReason  = null;

  switch (r) {
    case 'BULL_TREND':
      allowedBuy  = true;
      allowedSell = false;
      buyStrength  = lr === 'LOCAL_BULL' ? 'STRONG' : lr === 'LOCAL_RANGE' ? 'STRONG' : 'WEAK';
      sellStrength = 'NONE';
      blockReason  = 'BTC_BULL_TREND_BLOCKS_SELL';
      break;

    case 'BEAR_TREND':
      allowedBuy  = false;
      allowedSell = true;
      buyStrength  = 'NONE';
      sellStrength = lr === 'LOCAL_BEAR' ? 'STRONG' : lr === 'LOCAL_RANGE' ? 'STRONG' : 'WEAK';
      blockReason  = 'BTC_BEAR_TREND_BLOCKS_BUY';
      break;

    case 'BULL_RANGE':
      allowedBuy  = true;
      allowedSell = lr === 'LOCAL_BEAR' || lr === 'LOCAL_RANGE'; // sell at resistance only
      buyStrength  = lr === 'LOCAL_BULL' ? 'STRONG' : 'WEAK';
      sellStrength = lr === 'LOCAL_BEAR' ? 'WEAK' : 'NONE';
      break;

    case 'BEAR_RANGE':
      allowedBuy  = lr === 'LOCAL_BULL' || lr === 'LOCAL_RANGE'; // buy at support only
      allowedSell = true;
      buyStrength  = lr === 'LOCAL_BULL' ? 'WEAK' : 'NONE';
      sellStrength = lr === 'LOCAL_BEAR' ? 'STRONG' : 'WEAK';
      break;

    case 'BREAKOUT':
      allowedBuy  = lr !== 'LOCAL_BEAR';
      allowedSell = lr !== 'LOCAL_BULL';
      buyStrength  = lr === 'LOCAL_BULL' ? 'STRONG' : 'WEAK';
      sellStrength = lr === 'LOCAL_BEAR' ? 'STRONG' : 'WEAK';
      break;

    case 'CHOP':
      allowedBuy  = false;
      allowedSell = false;
      buyStrength  = 'NONE';
      sellStrength = 'NONE';
      blockReason  = 'BTC_CHOP_BLOCKS_ALL';
      break;

    default: // UNKNOWN
      // Don't block in UNKNOWN — let existing gates handle it
      allowedBuy  = true;
      allowedSell = true;
      buyStrength  = 'WEAK';
      sellStrength = 'WEAK';
      break;
  }

  return {
    allowedBuy,
    allowedSell,
    buyStrength,
    sellStrength,
    blocked: !allowedBuy && !allowedSell,
    blockReason: blockReason || null,
  };
}

// ─── Flip Signal Detection ───────────────────────────────────────────────────
//
// Called per active SELL signal when evaluating the pair's latest candle.
// If price closes ABOVE the SELL's entry zone with volume → flip to BUY.
// Symmetric for BUY signals.
//
// Returns: null | { flip: true, newSide, reason, originalSignalId }

function detectFlip(signal, latestCandle, avgVolume) {
  if (!signal || !latestCandle) return null;
  const c = latestCandle;
  const bodyClose = c.close;
  const bodyOpen  = c.open;
  const candleVol = c.volume || 0;
  const volSpike  = avgVolume > 0 && candleVol > avgVolume * 1.5;

  if (signal.side === 'SELL') {
    // Failed SELL rejection: price closed above resistance (entry zone)
    const entry = num(signal.entry || signal.plan?.entry || 0);
    if (!entry) return null;
    const closedAbove = bodyClose > entry * 1.002 && bodyClose > bodyOpen; // body close above entry + 0.2% buffer
    if (closedAbove && volSpike) {
      return {
        flip: true,
        newSide: 'BUY',
        flipReason: 'FAILED_SELL_REJECTION',
        label: '⚡ Flip: Failed SELL rejection → BUY breakout',
        originalSignalId: signal.id,
        triggerPrice: bodyClose,
      };
    }
  }

  if (signal.side === 'BUY') {
    // Failed BUY support: price closed below support (entry zone)
    const entry = num(signal.entry || signal.plan?.entry || 0);
    if (!entry) return null;
    const closedBelow = bodyClose < entry * 0.998 && bodyClose < bodyOpen; // body close below entry - 0.2% buffer
    if (closedBelow && volSpike) {
      return {
        flip: true,
        newSide: 'SELL',
        flipReason: 'FAILED_BUY_SUPPORT',
        label: '⚡ Flip: Failed BUY support → SELL breakdown',
        originalSignalId: signal.id,
        triggerPrice: bodyClose,
      };
    }
  }

  return null;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  detectBTCRegime,
  getBTCRegime,
  detectLocalRegime,
  getAllowedSides,
  detectFlip,
};
