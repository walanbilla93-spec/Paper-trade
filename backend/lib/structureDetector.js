'use strict';

// ─── structureDetector.js ────────────────────────────────────────────────────
// fix44f: Backend port of frontend market structure detectors.
// fix48b: RSI standardised to match v4Brain; hasVol zero-fallback tightened; zigzagPivots lr→3.
// Detects squeeze, BOS, CHoCH, trap, divergence from raw candle arrays.
// Used by buildStructurePlan to generate context-aware signals instead of
// blocking dead hours. "Dead hours" are often squeeze→release or trap conditions
// — the RIGHT signal exists, the system just wasn't detecting it.
// ─────────────────────────────────────────────────────────────────────────────

// ── ATR ───────────────────────────────────────────────────────────────────────
function calcAtrArr(candles, len = 14) {
  if (!Array.isArray(candles) || candles.length < len) return [];
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const out = []; let sum = trs.slice(0, len).reduce((a, b) => a + b, 0);
  out.push(sum / len);
  for (let i = len; i < trs.length; i++) {
    sum = out[out.length - 1] * (len - 1) + trs[i];
    out.push(sum / len);
  }
  return out;
}

// ── Squeeze: ATR compression ──────────────────────────────────────────────────
// Squeeze = recent ATR < 70% of lookback ATR (volatility contracting)
// Release = not squeezed AND last ATR > prev ATR by 10% (volatility expanding)
function detectSqueeze(candles) {
  const atr = calcAtrArr(candles, 14);
  if (atr.length < 20) return { squeeze: false, release: false };
  const recent = atr.slice(-5);
  const lookback = atr.slice(-20, -5);
  const aR = recent.reduce((a, b) => a + b, 0) / recent.length;
  const aL = lookback.reduce((a, b) => a + b, 0) / lookback.length;
  const squeeze = aR < aL * 0.70;
  const release = !squeeze && atr[atr.length - 1] > atr[atr.length - 2] * 1.10;
  return { squeeze, release, atrRatio: aL > 0 ? aR / aL : 1 };
}

// ── Swing detection ───────────────────────────────────────────────────────────
function swingHighs(candles, lr = 3) {
  const out = [];
  for (let i = lr; i < candles.length - lr; i++) {
    const c = candles[i];
    let isHigh = true;
    for (let j = 1; j <= lr; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) { isHigh = false; break; }
    }
    if (isHigh) out.push({ level: c.high, idx: i });
  }
  return out;
}

function swingLows(candles, lr = 3) {
  const out = [];
  for (let i = lr; i < candles.length - lr; i++) {
    const c = candles[i];
    let isLow = true;
    for (let j = 1; j <= lr; j++) {
      if (candles[i - j].low <= c.low || candles[i + j].low <= c.low) { isLow = false; break; }
    }
    if (isLow) out.push({ level: c.low, idx: i });
  }
  return out;
}

// ── BOS: Break of Structure ───────────────────────────────────────────────────
// Bull BOS: candle body closes above last swing high with volume
// Bear BOS: candle body closes below last swing low with volume
//
// fixSTRUCT (4.6.8.70): converted from single-last-candle EVENT detector to a
// PERSISTENCE-WINDOW detector. The old code only inspected candles[-1] — a BOS
// that printed 2 candles ago was invisible at scan time, which (with trap/CHoCH
// sharing the flaw) left the F2 structure family voting DIVERGENCE-or-nothing on
// 616 logged trades (CHoCH: 0 fires, TRAP: ~1 fire). Now the last `scanBars`
// CLOSED candles are each evaluated against only the swings/volume that existed
// BEFORE them (no lookahead), newest-first; the most recent qualifying event is
// returned with `barsAgo` so consumers can weight by staleness. scanBars=1
// reproduces the old behavior exactly. Thresholds unchanged — a fired detector
// means the same thing it always did; only the window we look through widened.
function evalBosAt(candles, i) {
  // Evaluate candle i as a potential BOS against structure known strictly before i.
  if (i < 10) return null;
  const prior = candles.slice(0, i);
  const sH = swingHighs(prior, 3);
  const sL = swingLows(prior, 3);
  const last = candles[i];
  const bH = Math.max(last.open, last.close);
  const bL = Math.min(last.open, last.close);
  const rng = last.high - last.low;
  if (rng > 0 && (bH - bL) / rng < 0.40) return null; // weak body
  const volWin = candles.slice(Math.max(0, i - 19), i);
  const volAvg = volWin.length ? volWin.reduce((a, c) => a + (c.volume || 0), 0) / volWin.length : 0;
  if (volAvg > 0 && (last.volume || 0) < volAvg * 1.1) return null; // low volume

  const M = 0.001;
  if (sH.length && bH > sH[sH.length - 1].level * (1 + M) && bL > sH[sH.length - 1].level) {
    return { type: 'bull', level: sH[sH.length - 1].level };
  }
  if (sL.length && bL < sL[sL.length - 1].level * (1 - M) && bH < sL[sL.length - 1].level) {
    return { type: 'bear', level: sL[sL.length - 1].level };
  }
  return null;
}

function detectBOS(candles, scanBars = 1) {
  if (!Array.isArray(candles) || candles.length < 10) return null;
  const lastIdx = candles.length - 1;
  const span = Math.min(Math.max(1, scanBars), candles.length - 1);
  for (let back = 0; back < span; back++) {   // newest first — most recent event wins
    const hit = evalBosAt(candles, lastIdx - back);
    if (hit) return { ...hit, barsAgo: back };
  }
  return null;
}

// ── CHoCH: Change of Character ────────────────────────────────────────────────
// In a bear trend: bull candle body closes above last swing high = CHoCH bull
// In a bull trend: bear candle body closes below last swing low = CHoCH bear
// fixSTRUCT (4.6.8.70): same persistence-window conversion as detectBOS — see its comment.
// CHoCH never fired ONCE across 616 logged trades under the last-candle-only design.
function evalChochAt(candles, i, trend) {
  if (i < 10) return null;
  const prior = candles.slice(0, i);
  const sH = swingHighs(prior, 3);
  const sL = swingLows(prior, 3);
  if (sH.length < 2 || sL.length < 2) return null;
  const last = candles[i];
  const bH = Math.max(last.open, last.close);
  const bL = Math.min(last.open, last.close);
  const rng = last.high - last.low;
  if (rng > 0 && (bH - bL) / rng < 0.40) return null;
  const volWin = candles.slice(Math.max(0, i - 19), i);
  const volAvg = volWin.length ? volWin.reduce((a, c) => a + (c.volume || 0), 0) / volWin.length : 0;
  if (volAvg > 0 && (last.volume || 0) < volAvg * 1.1) return null;

  const M = 0.001;
  if (trend === 'bear' && sH.length) {
    const iH = sH[sH.length - 1];
    if (bH > iH.level * (1 + M) && bL > iH.level) return { type: 'bull', level: iH.level };
  }
  if (trend === 'bull' && sL.length) {
    const iL = sL[sL.length - 1];
    if (bL < iL.level * (1 - M) && bH < iL.level) return { type: 'bear', level: iL.level };
  }
  return null;
}

function detectCHoCH(candles, trend, scanBars = 1) {
  if (!Array.isArray(candles) || candles.length < 10 || trend === 'neutral') return null;
  const lastIdx = candles.length - 1;
  const span = Math.min(Math.max(1, scanBars), candles.length - 1);
  for (let back = 0; back < span; back++) {
    const hit = evalChochAt(candles, lastIdx - back, trend);
    if (hit) return { ...hit, barsAgo: back };
  }
  return null;
}

// ── Trap detection ────────────────────────────────────────────────────────────
// Bull trap: wick above swing high but close below it (fake breakout → SELL)
// Bear trap: wick below swing low but close above it (fake breakdown → BUY)
// fixSTRUCT (4.6.8.70): two defects fixed, thresholds untouched.
// (1) Persistence window — same as detectBOS/detectCHoCH (was last-candle-only; ~1 fire in 616 trades).
// (2) TEMPORAL IMPOSSIBILITY for fresh levels: swingHighs(lr=3) can never confirm a swing inside the
//     most recent 3 candles, but traps typically pierce the MOST RECENT high. Old logic: pierce a
//     fresh high → level not yet a confirmed swing → invisible; wait 3 candles for confirmation →
//     the trap candle is no longer "last" → still invisible. Traps against recent structure were
//     undetectable BY CONSTRUCTION. Now each candidate candle is also tested against the running
//     recent extreme (highest high / lowest low of the 10 candles before it, levelType:'recent'),
//     alongside the confirmed-swing test (levelType:'swing'). Both sides symmetric.
function evalTrapAt(candles, i) {
  if (i < 5) return null;
  const prior = candles.slice(0, i);
  const sH = swingHighs(prior, 3);
  const sL = swingLows(prior, 3);
  const last = candles[i];
  const rng = last.high - last.low;
  if (!rng) return null;
  const volWin = candles.slice(Math.max(0, i - 19), i);
  const volAvg = volWin.length ? volWin.reduce((a, c) => a + (c.volume || 0), 0) / volWin.length : 0;
  const hasVol = volAvg > 0 ? (last.volume || 0) > volAvg * 1.2 : false; // fix48b: unknown volume = don't confirm trap
  if (!hasVol) return null;

  const recent = prior.slice(-10);
  const recentHigh = recent.length ? Math.max(...recent.map(c => c.high)) : null;
  const recentLow  = recent.length ? Math.min(...recent.map(c => c.low))  : null;

  // Bull trap: wick pierced a high but body closed back below = fake breakout → SELL
  const upperWick = last.high - Math.max(last.open, last.close);
  const uwRatio = upperWick / rng;
  const highLevels = [];
  if (sH.length) highLevels.push({ level: sH[sH.length - 1].level, levelType: 'swing' });
  if (recentHigh != null && (!sH.length || recentHigh > sH[sH.length - 1].level)) {
    highLevels.push({ level: recentHigh, levelType: 'recent' });
  }
  for (const { level, levelType } of highLevels) {
    const wickPct = (last.high - level) / level * 100;
    if (last.high > level && last.close < level * 0.9995 && wickPct > 0.15 && uwRatio > 0.30) {
      return { type: 'bull-trap', level, levelType, tradeSide: 'SELL', strength: uwRatio };
    }
  }

  // Bear trap: wick pierced a low but body closed back above = fake breakdown → BUY
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const lwRatio = lowerWick / rng;
  const lowLevels = [];
  if (sL.length) lowLevels.push({ level: sL[sL.length - 1].level, levelType: 'swing' });
  if (recentLow != null && (!sL.length || recentLow < sL[sL.length - 1].level)) {
    lowLevels.push({ level: recentLow, levelType: 'recent' });
  }
  for (const { level, levelType } of lowLevels) {
    const wickPct = (level - last.low) / level * 100;
    if (last.low < level && last.close > level * 1.0005 && wickPct > 0.15 && lwRatio > 0.30) {
      return { type: 'bear-trap', level, levelType, tradeSide: 'BUY', strength: lwRatio };
    }
  }
  return null;
}

function detectTrap(candles, scanBars = 1) {
  if (!Array.isArray(candles) || candles.length < 5) return null;
  const lastIdx = candles.length - 1;
  const span = Math.min(Math.max(1, scanBars), candles.length - 1);
  for (let back = 0; back < span; back++) {
    const hit = evalTrapAt(candles, lastIdx - back);
    if (hit) return { ...hit, barsAgo: back };
  }
  return null;
}

// ── RSI divergence ────────────────────────────────────────────────────────────
// fix48b: standardised RSI — simple average of first `len` bars, no Wilder smoothing.
// Matches v4Brain.js calcRsi() so scoring and divergence detection agree on RSI state.
// Using candle .close array directly — same data source as v4Brain enrich().
function calcRSI(candles, len = 14) {
  if (!Array.isArray(candles) || candles.length < len + 1) return null;
  const closes = candles.map(c => c.close);
  const slice = closes.slice(-(len + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (!losses) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function detectDivergence(candles) {
  if (candles.length < 30) return null;
  const mid = candles.slice(-30, -15);
  const last = candles.slice(-15);
  const rsiMid = calcRSI(mid, 7);
  const rsiLast = calcRSI(last, 7);
  if (rsiMid === null || rsiLast === null) return null;

  // Bearish divergence: price higher high but RSI lower high → SELL
  const priceHigher = Math.max(...last.map(c => c.high)) > Math.max(...mid.map(c => c.high));
  const rsiLower = rsiLast < rsiMid - 3;
  if (priceHigher && rsiLower) return { type: 'bearish', tradeSide: 'SELL', strength: Math.round(rsiMid - rsiLast) };

  // Bullish divergence: price lower low but RSI higher low → BUY
  const priceLower = Math.min(...last.map(c => c.low)) < Math.min(...mid.map(c => c.low));
  const rsiHigher = rsiLast > rsiMid + 3;
  if (priceLower && rsiHigher) return { type: 'bullish', tradeSide: 'BUY', strength: Math.round(rsiLast - rsiMid) };

  return null;
}

// ── Master: analyzeStructure ──────────────────────────────────────────────────
// Returns a unified structure context for a symbol given k5 + trend5.
// Called from buildStructurePlan after enrich().
// NOTE: Bybit kline includes current open (unfinished) candle as last element.
// All detectors use candles[0..-2] — only closed candles for signal reliability.
// fixSTRUCT (4.6.8.70): three changes.
// (1) Persistence windows: BOS/CHoCH/trap now scan the last SCAN_BARS_5M (6 = 30min) / SCAN_BARS_15M
//     (3 = 45min) closed candles instead of only the very last one — see detectBOS comment for why.
// (2) RANKING FIX [the real bug]: SQUEEZE/SQUEEZE_RELEASE are NON-directional context but outranked
//     DIVERGENCE in `dominant`. Any pair in volatility contraction (very common in quiet alts) with a
//     valid RSI divergence reported dominant='SQUEEZE' → determineDirection's F2 chain had no case →
//     the structure family SILENTLY ABSTAINED and a real 2-family signal died to NEU. Directional
//     evidence now always outranks non-directional context; squeeze state remains exposed as its own
//     fields (squeeze/squeezeRelease) for any consumer that wants the context.
// (3) trend15 param: choch15 was evaluated against trend5. 15m structure vs 5m trend is a category
//     error; falls back to trend5 if trend15 not supplied (old call sites unaffected).
const SCAN_BARS_5M  = Math.max(1, Number(process.env.V4_STRUCT_SCAN_BARS_5M  || '6'));
const SCAN_BARS_15M = Math.max(1, Number(process.env.V4_STRUCT_SCAN_BARS_15M || '3'));

function analyzeStructure(k5, k15, trend5, trend15) {
  // Exclude last candle (current open/unfinished) — prevents false BOS/CHoCH on open candles
  const k5c  = k5.length  > 1 ? k5.slice(0, -1)  : k5;
  const k15c = k15.length > 1 ? k15.slice(0, -1) : k15;
  const squeeze    = detectSqueeze(k5c);
  const bos5       = detectBOS(k5c, SCAN_BARS_5M);
  const bos15      = k15c.length ? detectBOS(k15c, SCAN_BARS_15M) : null;
  const choch5     = detectCHoCH(k5c, trend5, SCAN_BARS_5M);
  const choch15    = k15c.length ? detectCHoCH(k15c, trend15 || trend5, SCAN_BARS_15M) : null;
  const trap5      = detectTrap(k5c, SCAN_BARS_5M);
  const trap15     = k15c.length ? detectTrap(k15c, SCAN_BARS_15M) : null;
  const divergence = detectDivergence(k5c);

  // Trap: prefer 15m (more reliable), fallback to 5m
  const trap = trap15 || trap5;
  // CHoCH: require 5m + prefer 15m confirmation
  const choch = choch5 || null;
  const chochConfirmed = !!(choch5 && choch15 && choch5.type === choch15.type);
  // BOS: 15m BOS is high conviction
  const bos = bos15 || bos5;

  return {
    squeeze: squeeze.squeeze,
    squeezeRelease: squeeze.release,
    atrRatio: squeeze.atrRatio,
    bos,
    choch,
    chochConfirmed,
    trap,
    divergence,
    // Summary: dominant DIRECTIONAL structure signal first; non-directional squeeze context last.
    dominant: trap ? 'TRAP' :
              (choch && chochConfirmed) ? 'CHOCH_CONFIRMED' :
              choch ? 'CHOCH' :
              bos ? 'BOS' :
              divergence ? 'DIVERGENCE' :
              squeeze.release ? 'SQUEEZE_RELEASE' :
              squeeze.squeeze ? 'SQUEEZE' :
              'NONE',
  };
}

// ── Elliott Wave Detection ─────────────────────────────────────────────────────
// Ported from frontend detectElliott + zigzagPivots.
// W5 IMPULSE = end of move → trade the REVERSAL
// W3 IMPULSE = middle of move → trade the CONTINUATION

function zigzagPivots(candles, lookback = 2) {
  if (candles.length < 4) return [];
  const pivots = [];
  const lb = Math.min(lookback, Math.floor(candles.length / 3));
  for (let i = lb; i < candles.length - lb; i++) {
    let hi = true, lo = true;
    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) hi = false;
      if (candles[j].low  <= candles[i].low)  lo = false;
    }
    if (hi) pivots.push({ type: 'H', i, price: candles[i].high });
    if (lo) pivots.push({ type: 'L', i, price: candles[i].low  });
  }
  pivots.sort((a, b) => a.i - b.i);
  const cleaned = [];
  for (const p of pivots) {
    if (!cleaned.length) { cleaned.push(p); continue; }
    const prev = cleaned[cleaned.length - 1];
    if (prev.type === p.type) {
      if ((p.type === 'H' && p.price > prev.price) || (p.type === 'L' && p.price < prev.price)) {
        cleaned[cleaned.length - 1] = p;
      }
    } else {
      cleaned.push(p);
    }
  }
  return cleaned.slice(-8);
}

function detectElliottWave(candles) {
  if (!candles || candles.length < 6) return null;
  const pivots = zigzagPivots(candles, 3); // fix48: was lr=1 (too noisy); lr=3 produces reliable swing pivots
  const seq = pivots.slice(-6);
  const closes = candles.slice(-6).map(c => c.close);
  const up = closes.length >= 2 ? closes[closes.length - 1] > closes[0] : false;
  if (seq.length < 2) return { trend: up ? 'UP' : 'DOWN', phase: 'EARLY', label: 'W1', lastMove: up ? 'RISING' : 'FALLING' };

  let rises = 0, falls = 0;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].price > seq[i - 1].price) rises++; else falls++;
  }
  const trend = rises > falls ? 'UP' : falls > rises ? 'DOWN' : (up ? 'UP' : 'DOWN');
  const directional = [];
  for (let i = 1; i < seq.length; i++) directional.push(seq[i].price > seq[i - 1].price ? 'U' : 'D');
  const ups   = directional.filter(x => x === 'U').length;
  const downs = directional.filter(x => x === 'D').length;

  let phase = 'EARLY', label = 'W1';
  if (seq.length >= 5) {
    if ((trend === 'UP' && ups >= 3) || (trend === 'DOWN' && downs >= 3)) {
      phase = 'IMPULSE';
      label = seq.length >= 6 ? 'W5' : 'W3';
    } else {
      phase = 'CORRECTION'; label = 'ABC';
    }
  } else if (seq.length >= 3) {
    phase = 'CORRECTION'; label = 'ABC';
  }
  const lastMove = seq[seq.length - 1].price > seq[seq.length - 2].price ? 'RISING' : 'FALLING';
  return { trend, phase, label, lastMove, pivots: seq };
}

// Analyse wave across timeframes and determine trade signal
// W5 = end of move → trade reversal. W3 = continuation → trade with trend.
function analyzeElliottWaves(k5, k15, k60) {
  const w5  = detectElliottWave(k5);
  const w15 = detectElliottWave(k15);
  const w60 = detectElliottWave(k60);

  const waves = { '5m': w5, '15m': w15, '1h': w60 };

  // Count how many TFs agree on W5 exhaustion
  const w5Count = [w5, w15, w60].filter(w => w && w.label === 'W5' && w.phase === 'IMPULSE').length;
  const w3Count = [w5, w15, w60].filter(w => w && w.label === 'W3' && w.phase === 'IMPULSE').length;

  let signal = null;

  if (w5Count >= 2) {
    // W5 confirmed on 2+ TFs = high conviction exhaustion trade
    // Trend UP + W5 = price about to reverse DOWN → SELL
    // Trend DOWN + W5 = price about to reverse UP → BUY
    const w5trends = [w5, w15, w60].filter(w => w && w.label === 'W5').map(w => w.trend);
    const dominantTrend = w5trends.filter(t => t === 'UP').length >= w5trends.filter(t => t === 'DOWN').length ? 'UP' : 'DOWN';
    signal = {
      type: 'W5_EXHAUSTION',
      tradeSide: dominantTrend === 'UP' ? 'SELL' : 'BUY',
      confidence: w5Count === 3 ? 'HIGH' : 'MEDIUM',
      w5Count,
      reason: `W5 IMPULSE exhaustion on ${w5Count} TF — fade the end of move`,
    };
  } else if (w3Count >= 2) {
    // W3 = strongest wave, middle of move → trade continuation
    const w3trends = [w5, w15, w60].filter(w => w && w.label === 'W3').map(w => w.trend);
    const dominantTrend = w3trends.filter(t => t === 'UP').length >= w3trends.filter(t => t === 'DOWN').length ? 'UP' : 'DOWN';
    signal = {
      type: 'W3_CONTINUATION',
      tradeSide: dominantTrend === 'UP' ? 'BUY' : 'SELL',
      confidence: 'MEDIUM',
      w3Count,
      reason: `W3 IMPULSE continuation on ${w3Count} TF — trade with the wave`,
    };
  }

  return { waves, signal, w5Count, w3Count };
}

module.exports = {
  analyzeStructure, detectSqueeze, detectBOS, detectCHoCH, detectTrap, detectDivergence,
  analyzeElliottWaves, detectElliottWave,
};
