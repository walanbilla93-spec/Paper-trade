'use strict';

// ─── sweepEngine.js ──────────────────────────────────────────────────────────
// Liquidity sweep detector + fade signal generator.
// fix38h: Detects when N same-side SL_HITs cluster in a short window,
// confirms the sweep with TA, and emits a counter-direction fade signal.
//
// Architecture:
//   detectSweep(ledger, signals, now)  → sweepEvent | null
//   confirmFade(sweepEvent, ctx)       → { confirmed, reasons }
//   getFadeBoost(sweepEvent)           → { scoreBoost, maxRR, tagLabel }
//   getSweepState()                    → current sweep state (for snapshot)
// ─────────────────────────────────────────────────────────────────────────────

const SWEEP_WINDOW_MS     = 20 * 60 * 1000;  // 20 min window to detect cluster
const SWEEP_MIN_LOSSES    = 4;                // min SL_HITs same-side in window
const SWEEP_FADE_VALID_MS = 45 * 60 * 1000;  // fade signal valid for 45 min after sweep
const SWEEP_SCORE_BOOST   = 15;              // score boost for confirmed fade signals
const SWEEP_MAX_RR        = 2.2;             // fade moves are mean-reverting, keep TP tight
const SWEEP_COOLDOWN_MS   = 60 * 60 * 1000; // 1hr between sweep events same side

// State
let _sweepState = {
  active: false,
  side: null,         // swept side (e.g. 'BUY' = BUY signals got stopped → fade is SELL)
  fadeSide: null,     // direction to trade after sweep
  sweepAt: 0,
  lossCount: 0,
  symbols: [],
  confirmations: [],
  label: '',
  expiresAt: 0,
};

// Per-side cooldown timestamps
const _lastSweep = { BUY: 0, SELL: 0 };

// ─── Candle helpers ───────────────────────────────────────────────────────────

function wickRatio(candle) {
  if (!candle) return 0;
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  if (!range) return 0;
  return (range - body) / range; // fraction of candle that is wick
}

function isStopHuntCandle(candle, side) {
  if (!candle) return false;
  const wR = wickRatio(candle);
  if (wR < 0.55) return false; // at least 55% wick
  if (side === 'BUY') {
    // BUY stopped = price swept lows → long lower wick
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    return lowerWick > upperWick * 1.8;
  } else {
    // SELL stopped = price swept highs → long upper wick
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    return upperWick > lowerWick * 1.8;
  }
}

// ─── RSI divergence helper ────────────────────────────────────────────────────

function calcRSI(candles, len = 14) {
  if (!Array.isArray(candles) || candles.length < len) return null; // fix39/L-14: was len+1, off-by-one — extra candle never read
  let gains = 0, losses = 0;
  for (let i = 1; i <= len; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / len, avgLoss = losses / len;
  for (let i = len + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (len - 1) + Math.max(diff, 0)) / len;
    avgLoss = (avgLoss * (len - 1) + Math.max(-diff, 0)) / len;
  }
  if (!avgLoss) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// Returns true if RSI diverges from price (price made new extreme but RSI didn't)
function hasDivergence(candles, side) {
  if (!Array.isArray(candles) || candles.length < 20) return false;
  const recent = candles.slice(-20);
  const mid    = recent.slice(0, 10);
  const last   = recent.slice(10);
  const rsiMid  = calcRSI(mid, 7);
  const rsiLast = calcRSI(last, 7);
  if (rsiMid === null || rsiLast === null) return false;

  if (side === 'BUY') {
    // Bearish divergence: price made lower low but RSI didn't
    const priceLower = Math.min(...last.map(c => c.low)) < Math.min(...mid.map(c => c.low));
    const rsiHigher  = rsiLast > rsiMid;
    return priceLower && rsiHigher;
  } else {
    // Bullish divergence: price made higher high but RSI didn't
    const priceHigher = Math.max(...last.map(c => c.high)) > Math.max(...mid.map(c => c.high));
    const rsiLower    = rsiLast < rsiMid;
    return priceHigher && rsiLower;
  }
}

// ─── Volume helpers ───────────────────────────────────────────────────────────

function volumeDecliningSince(candles, lookback = 3) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return false;
  const recent = candles.slice(-(lookback + 1));
  for (let i = 1; i < recent.length; i++) {
    if ((recent[i].volume || 0) >= (recent[i - 1].volume || 0)) return false;
  }
  return true;
}

// ─── CHoCH detection ─────────────────────────────────────────────────────────
// Returns true if candles show a Change of Character in the opposite direction.
// Simple: after sweep, first candle that closes strongly against swept side.

function hasChoCH(candles, fadeSide) {
  if (!Array.isArray(candles) || candles.length < 3) return false;
  const last3 = candles.slice(-3);
  if (fadeSide === 'BUY') {
    // After BUY sweep (price dropped), look for bullish engulf / higher close
    const prev = last3[last3.length - 2];
    const curr = last3[last3.length - 1];
    if (!prev || !curr) return false;
    const bullEngulf = curr.close > curr.open && curr.close > prev.high * 0.999;
    const higherClose = curr.close > prev.close * 1.003;
    return bullEngulf || higherClose;
  } else {
    // After SELL sweep, look for bearish engulf / lower close
    const prev = last3[last3.length - 2];
    const curr = last3[last3.length - 1];
    if (!prev || !curr) return false;
    const bearEngulf = curr.close < curr.open && curr.close < prev.low * 1.001;
    const lowerClose = curr.close < prev.close * 0.997;
    return bearEngulf || lowerClose;
  }
}

// ─── Core: detectSweep ───────────────────────────────────────────────────────

function detectSweep(ledger, signals, now = Date.now()) {
  // Combine ledger + live signals to get recent closed trades.
  // fixSWEEP (4.6.8.71): DEDUP by id — a stopped trade exists in BOTH the live signals array
  // (paperState SL_HIT, until pruned) and the ledger (status LOSS). Without dedup every real loss
  // counted twice, so SWEEP_MIN_LOSSES=4 was effectively ~2 and sweeps (whose swept-side
  // suppression needs NO TA confirmation) fired roughly twice as easily as designed.
  const seen = new Set();
  const allClosed = [
    ...ledger,
    ...signals,
  ].filter(s => {
    const st = String(s.paperState || s.result || s.status || '').toUpperCase();
    if (st !== 'SL_HIT' && st !== 'LOSS') return false;
    const key = s.id || `${s.sym || s.symbol}:${s.createdAt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const side of ['BUY', 'SELL']) {
    // Cooldown between sweeps
    if (now - _lastSweep[side] < SWEEP_COOLDOWN_MS) continue;

    const recentLosses = allClosed.filter(s => {
      const ts = Number(s.closedAt || s.updatedAt || s.createdAt || 0);
      return s.side === side && ts > now - SWEEP_WINDOW_MS;
    });

    if (recentLosses.length < SWEEP_MIN_LOSSES) continue;

    const fadeSide = side === 'BUY' ? 'SELL' : 'BUY';
    const symbols  = [...new Set(recentLosses.map(s => s.sym || s.symbol).filter(Boolean))];

    _lastSweep[side] = now;
    return {
      side,
      fadeSide,
      sweepAt: now,
      lossCount: recentLosses.length,
      symbols,
      expiresAt: now + SWEEP_FADE_VALID_MS,
    };
  }
  return null;
}

// ─── Core: confirmFade ────────────────────────────────────────────────────────
// ctx = { k5, k15 } candle arrays from enrich()
// Requires at least 2 of 4 TA confirmations.

function confirmFade(sweepEvent, ctx) {
  if (!sweepEvent) return { confirmed: false, confirmations: [] };

  const { fadeSide } = sweepEvent;
  // fixSWEEP (4.6.8.71): exclude the live open candle — same rule structureDetector applies.
  // hasChoCH / isStopHuntCandle / volumeDecliningSince all read the LAST array element; fed a raw
  // kline array that element is the still-forming candle, so confirmations would flicker
  // intra-candle (appear on a wick, vanish on the close). Closed candles only.
  const k5raw  = Array.isArray(ctx && ctx.k5)  ? ctx.k5  : [];
  const k15raw = Array.isArray(ctx && ctx.k15) ? ctx.k15 : [];
  const k5  = k5raw.length  > 1 ? k5raw.slice(0, -1)  : k5raw;
  const k15 = k15raw.length > 1 ? k15raw.slice(0, -1) : k15raw;
  const confirmations = [];

  // 1. CHoCH on 5m (structure shifted)
  if (hasChoCH(k5, fadeSide)) confirmations.push('CHoCH_5m');

  // 2. CHoCH on 15m (higher confidence)
  if (hasChoCH(k15, fadeSide)) confirmations.push('CHoCH_15m');

  // 3. RSI divergence at sweep point
  if (hasDivergence(k5, sweepEvent.side)) confirmations.push('RSI_DIVERGENCE');

  // 4. Volume declining on continuation (no follow-through = reversal)
  if (volumeDecliningSince(k5, 3)) confirmations.push('VOLUME_DECLINING');

  // 5. Stop-hunt candle shape
  const lastCandle = k5.length ? k5[k5.length - 1] : null;
  if (isStopHuntCandle(lastCandle, sweepEvent.side)) confirmations.push('STOP_HUNT_CANDLE');

  const confirmed = confirmations.length >= 2;
  return { confirmed, confirmations };
}

// ─── getFadeBoost ─────────────────────────────────────────────────────────────
// Called from shouldReject/calibratedScore to boost confirmed fade signals.

function getFadeBoost(symbol) {
  if (!_sweepState.active) return null;
  if (Date.now() > _sweepState.expiresAt) {
    _sweepState.active = false;
    return null;
  }
  return {
    scoreBoost:  SWEEP_SCORE_BOOST,
    maxRR:       SWEEP_MAX_RR,
    fadeSide:    _sweepState.fadeSide,
    label:       _sweepState.label,
    confirmations: _sweepState.confirmations,
  };
}

// ─── Public: tick ─────────────────────────────────────────────────────────────
// Called once per scan cycle from v4Brain.scanOnce() with ledger + signals.
// Returns sweep state so v4Brain can pass to shouldReject.

function tick(ledger, signals, now = Date.now()) {
  // Expire old sweep
  if (_sweepState.active && now > _sweepState.expiresAt) {
    _sweepState.active = false;
  }

  // Don't re-detect if sweep already active
  if (_sweepState.active) return _sweepState;

  const sweep = detectSweep(ledger, signals, now);
  if (!sweep) return _sweepState;

  // Sweep detected — update state (confirmation happens per-coin in shouldReject)
  _sweepState = {
    active:        true,
    side:          sweep.side,
    fadeSide:      sweep.fadeSide,
    sweepAt:       sweep.sweepAt,
    lossCount:     sweep.lossCount,
    symbols:       sweep.symbols,
    confirmations: [],
    label:         `SWEEP_${sweep.side}_${sweep.lossCount}x`,
    expiresAt:     sweep.expiresAt,
  };

  console.log(`[SweepEngine] Sweep detected: ${sweep.lossCount}x ${sweep.side} SL_HITs → fade ${sweep.fadeSide}`);
  return _sweepState;
}

// ─── Public: applyToSignal ────────────────────────────────────────────────────
// Called from shouldReject (v4Brain). Returns score boost + metadata if:
//   1. Sweep is active
//   2. Signal side === fadeSide
//   3. TA confirmations pass
// Also: if sweep active and signal side === swept side → suppress (add reason).

function applyToSignal(leader, ctx, reasons) {
  if (!_sweepState.active || Date.now() > _sweepState.expiresAt) return {};

  const { side, fadeSide, label } = _sweepState;

  // Suppress swept-side signals during sweep window
  if (leader.side === side) {
    reasons.push(`SWEEP_SIDE_SUPPRESSED_${label}`);
    return { suppressed: true };
  }

  // Boost fade-side signals with TA confirmation
  if (leader.side === fadeSide) {
    const fadeCheck = confirmFade(_sweepState, ctx);
    if (fadeCheck.confirmed) {
      _sweepState.confirmations = fadeCheck.confirmations;
      return {
        scoreBoost:    SWEEP_SCORE_BOOST,
        maxRR:         SWEEP_MAX_RR,
        tag:           `SWEEP_FADE:${label}`,
        confirmations: fadeCheck.confirmations,
      };
    }
  }

  return {};
}

function getSweepState() { return { ..._sweepState }; }

module.exports = { tick, applyToSignal, getSweepState, confirmFade, detectSweep };
