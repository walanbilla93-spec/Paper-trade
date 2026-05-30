'use strict';

// ─── structureDetector.js ────────────────────────────────────────────────────
// fix44f: Backend port of frontend market structure detectors.
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
function detectBOS(candles) {
  if (candles.length < 10) return null;
  // candles are already closed (caller excludes open candle) — use all of them for swings
  const sH = swingHighs(candles, 3);
  const sL = swingLows(candles, 3);
  const last = candles[candles.length - 1];
  const bH = Math.max(last.open, last.close);
  const bL = Math.min(last.open, last.close);
  const rng = last.high - last.low;
  if (rng > 0 && (bH - bL) / rng < 0.40) return null; // weak body
  const volAvg = candles.slice(-20, -1).reduce((a, c) => a + (c.volume || 0), 0) / 19;
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

// ── CHoCH: Change of Character ────────────────────────────────────────────────
// In a bear trend: bull candle body closes above last swing high = CHoCH bull
// In a bull trend: bear candle body closes below last swing low = CHoCH bear
function detectCHoCH(candles, trend) {
  if (candles.length < 10 || trend === 'neutral') return null;
  const sH = swingHighs(candles, 3);
  const sL = swingLows(candles, 3);
  if (sH.length < 2 || sL.length < 2) return null;
  const last = candles[candles.length - 1];
  const bH = Math.max(last.open, last.close);
  const bL = Math.min(last.open, last.close);
  const rng = last.high - last.low;
  if (rng > 0 && (bH - bL) / rng < 0.40) return null;
  const volAvg = candles.slice(-20, -1).reduce((a, c) => a + (c.volume || 0), 0) / 19;
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

// ── Trap detection ────────────────────────────────────────────────────────────
// Bull trap: wick above swing high but close below it (fake breakout → SELL)
// Bear trap: wick below swing low but close above it (fake breakdown → BUY)
function detectTrap(candles) {
  if (candles.length < 5) return null;
  const sH = swingHighs(candles, 3);
  const sL = swingLows(candles, 3);
  const last = candles[candles.length - 1];
  const rng = last.high - last.low;
  if (!rng) return null;
  const volAvg = candles.slice(-20, -1).reduce((a, c) => a + (c.volume || 0), 0) / 19;
  const hasVol = volAvg > 0 ? (last.volume || 0) > volAvg * 1.2 : true;

  if (sH.length) {
    const sh = sH[sH.length - 1];
    const wickPct = (last.high - sh.level) / sh.level * 100;
    const upperWick = last.high - Math.max(last.open, last.close);
    const wickRatio = upperWick / rng;
    // Wick pierced swing high but body closed below = bull trap
    if (last.high > sh.level && last.close < sh.level * 0.9995 && wickPct > 0.15 && wickRatio > 0.30 && hasVol) {
      return { type: 'bull-trap', level: sh.level, tradeSide: 'SELL', strength: wickRatio };
    }
  }

  if (sL.length) {
    const sl = sL[sL.length - 1];
    const wickPct = (sl.level - last.low) / sl.level * 100;
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const wickRatio = lowerWick / rng;
    // Wick pierced swing low but body closed above = bear trap
    if (last.low < sl.level && last.close > sl.level * 1.0005 && wickPct > 0.15 && wickRatio > 0.30 && hasVol) {
      return { type: 'bear-trap', level: sl.level, tradeSide: 'BUY', strength: wickRatio };
    }
  }
  return null;
}

// ── RSI divergence ────────────────────────────────────────────────────────────
function calcRSI(candles, len = 14) {
  if (!Array.isArray(candles) || candles.length < len + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= len; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d >= 0) gains += d; else losses -= d;
  }
  let ag = gains / len, al = losses / len;
  for (let i = len + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    ag = (ag * (len - 1) + Math.max(d, 0)) / len;
    al = (al * (len - 1) + Math.max(-d, 0)) / len;
  }
  return al ? 100 - 100 / (1 + ag / al) : 100;
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
function analyzeStructure(k5, k15, trend5) {
  // Exclude last candle (current open/unfinished) — prevents false BOS/CHoCH on open candles
  const k5c  = k5.length  > 1 ? k5.slice(0, -1)  : k5;
  const k15c = k15.length > 1 ? k15.slice(0, -1) : k15;
  const squeeze    = detectSqueeze(k5c);
  const bos5       = detectBOS(k5c);
  const bos15      = k15c.length ? detectBOS(k15c) : null;
  const choch5     = detectCHoCH(k5c, trend5);
  const choch15    = k15c.length ? detectCHoCH(k15c, trend5) : null;
  const trap5      = detectTrap(k5c);
  const trap15     = k15c.length ? detectTrap(k15c) : null;
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
    // Summary: what is the dominant structure signal?
    dominant: trap ? 'TRAP' :
              (choch && chochConfirmed) ? 'CHOCH_CONFIRMED' :
              choch ? 'CHOCH' :
              bos ? 'BOS' :
              squeeze.release ? 'SQUEEZE_RELEASE' :
              squeeze.squeeze ? 'SQUEEZE' :
              divergence ? 'DIVERGENCE' :
              'NONE',
  };
}

module.exports = { analyzeStructure, detectSqueeze, detectBOS, detectCHoCH, detectTrap, detectDivergence };
