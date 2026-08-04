'use strict';
/**
 * directionMode.js — switchable direction engine.
 *
 * WHY THIS EXISTS
 * ---------------
 * v4.6.8.40 (the "WR 70%" build) decided side with sideFromTrends(): a weighted vote
 * where the 5m/15m/1h SMA trends carried 18/16/10 points. It traded WITH the trend.
 * Elliott W5 exhaustion existed there too — but ONLY as a VETO
 * (EW_LONG_LATE_W5_EXHAUSTION_RISK -> penalty + reject = "this move is late, stay out").
 *
 * fix48 replaced that wholesale with determineDirection(), whose Family-1 rule is
 * "W5_EXHAUSTION -> fade it". That PROMOTED the exhaustion signal from a brake to a
 * steering wheel: the exact condition that used to mean DON'T ENTER now means
 * ENTER THE OTHER WAY. The stated reason was that SMA trend was "the weakest signal".
 * The trend votes were removed as weak — they were the part that was working.
 *
 * MODES
 *   DIRECTION_MODE=trend  (default) — restore trend-following. Elliott returns to veto-only.
 *   DIRECTION_MODE=fade             — current 4.6.9.x behaviour (W5 steers). For A/B only.
 *   DIRECTION_MODE=hybrid           — trend leads; a fade is allowed ONLY on a large,
 *                                     multi-TF-confirmed W5 against a non-opposing trend.
 *
 * Pure functions, no I/O, no requires. Safe to unit test and to call from any brain.
 */

function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function getMode() {
  const m = String(process.env.DIRECTION_MODE || 'trend').toLowerCase();
  return (m === 'fade' || m === 'hybrid' || m === 'trend') ? m : 'trend';
}

/**
 * Verbatim port of v4.6.8.40 sideFromTrends() — the 70%-WR direction vote.
 * Kept byte-faithful on purpose: this is the control arm of the A/B, so it must not
 * be "improved" while being restored, or the comparison proves nothing.
 */
function sideFromTrends(trend5, trend15, trend1h, rsi, momentumPct, volRatio) {
  let bull = 0, bear = 0;
  const reasons = [];
  if (trend5 === 'bull')  { bull += 18; reasons.push('5m trend bull'); }
  if (trend5 === 'bear')  { bear += 18; reasons.push('5m trend bear'); }
  if (trend15 === 'bull') { bull += 16; reasons.push('15m trend bull'); }
  if (trend15 === 'bear') { bear += 16; reasons.push('15m trend bear'); }
  if (trend1h === 'bull') { bull += 10; reasons.push('1h trend bull'); }
  if (trend1h === 'bear') { bear += 10; reasons.push('1h trend bear'); }

  const mom = num(momentumPct, 0);
  if (mom >  0.25) { bull += clamp(Math.abs(mom) * 2, 2, 10); reasons.push('short momentum up'); }
  if (mom < -0.25) { bear += clamp(Math.abs(mom) * 2, 2, 10); reasons.push('short momentum down'); }

  if (num(volRatio, 0) > 1.25) { bull += 4; bear += 4; reasons.push('volume expansion'); }

  const r = num(rsi, 50);
  if (r >= 45 && r <= 72) bull += 5;
  if (r >= 28 && r <= 55) bear += 5;
  if (r > 82) bull -= 12;   // blocks late longs — the original's own exhaustion brake
  if (r < 18) bear -= 12;

  if (bull >= bear + 8) return { side: 'BUY',  edge: bull - bear, reasons };
  if (bear >= bull + 8) return { side: 'SELL', edge: bear - bull, reasons };
  return { side: 'NEU', edge: Math.abs(bull - bear), reasons: ['no clear directional edge', ...reasons] };
}

/**
 * Elliott as a VETO, the way 4.6.8.40 used it.
 * Returns { reject:boolean, reason:string|null }.
 * A W5 exhaustion that OPPOSES the proposed side is a reason to stand down, not to flip.
 */
function elliottVeto(side, elliottAnalysis) {
  const sig = elliottAnalysis && elliottAnalysis.signal;
  if (!sig || sig.type !== 'W5_EXHAUSTION') return { reject: false, reason: null };
  // sig.tradeSide is the FADE direction. If the fade opposes our trend-following side,
  // the move we want to join is exhausted -> stand down.
  if (sig.tradeSide && sig.tradeSide !== side) {
    return { reject: true, reason: `EW_W5_EXHAUSTION_AGAINST_${side}` };
  }
  return { reject: false, reason: null };
}

/**
 * Current 4.6.9.x behaviour, isolated for A/B. W5 steers; W3 continues.
 */
function fadeDirection(elliottAnalysis) {
  const sig = elliottAnalysis && elliottAnalysis.signal;
  if (!sig) return { side: 'NEU', edge: 0, reasons: ['no elliott signal'] };
  if ((sig.type === 'W5_EXHAUSTION' || sig.type === 'W3_CONTINUATION') &&
      (sig.tradeSide === 'BUY' || sig.tradeSide === 'SELL')) {
    return { side: sig.tradeSide, edge: num(sig.w5Count || sig.w3Count, 2), reasons: ['F1:Elliott_' + sig.type] };
  }
  return { side: 'NEU', edge: 0, reasons: ['elliott signal not directional'] };
}

/**
 * Main entry point.
 * ctx: { trend5, trend15, trend1h, rsi, momentumPct, volRatio, elliottAnalysis }
 * Returns { side, edge, reasons[], mode, vetoed, vetoReason }
 */
function decideDirection(ctx = {}) {
  const mode = getMode();
  const { trend5, trend15, trend1h, rsi, momentumPct, volRatio, elliottAnalysis } = ctx;

  if (mode === 'fade') {
    const d = fadeDirection(elliottAnalysis);
    return { ...d, mode, vetoed: false, vetoReason: null };
  }

  const trend = sideFromTrends(trend5, trend15, trend1h, rsi, momentumPct, volRatio);

  if (mode === 'hybrid' && trend.side === 'NEU') {
    // No trend edge. Allow a fade ONLY if the exhaustion is large and multi-TF confirmed,
    // and the opposing trend is not actively running against the fade.
    const sig = elliottAnalysis && elliottAnalysis.signal;
    const mags = (sig && Array.isArray(sig.magSigmas)) ? sig.magSigmas : [];
    const strong = sig && sig.type === 'W5_EXHAUSTION' &&
                   num(sig.w5Count, 0) >= 2 &&
                   mags.length > 0 && Math.min.apply(null, mags) >= 2.5;
    if (strong) {
      const want = sig.tradeSide;
      const opposing = (want === 'BUY')
        ? (trend5 === 'bear' && trend15 === 'bear')
        : (trend5 === 'bull' && trend15 === 'bull');
      if (!opposing) {
        return { side: want, edge: num(sig.w5Count, 2), reasons: ['HYBRID:strong W5 fade, no trend edge'], mode, vetoed: false, vetoReason: null };
      }
    }
    return { side: 'NEU', edge: trend.edge, reasons: trend.reasons, mode, vetoed: false, vetoReason: null };
  }

  if (trend.side === 'NEU') {
    return { ...trend, mode, vetoed: false, vetoReason: null };
  }

  // trend + hybrid(with a trend edge): Elliott is a VETO only — never a flip.
  const veto = elliottVeto(trend.side, elliottAnalysis);
  if (veto.reject) {
    return { side: 'NEU', edge: 0, reasons: [...trend.reasons, veto.reason], mode, vetoed: true, vetoReason: veto.reason };
  }
  return { ...trend, mode, vetoed: false, vetoReason: null };
}

/**
 * ── EXTENSION GATE ────────────────────────────────────────────────────────────────────
 * The single strongest pre-execution filter found in the 8-week study (7,968 trend signals,
 * 25 pairs). Five candidate features (ext21, ext50, rsi_side, mom_side, room) all turned out
 * to measure ONE underlying thing — they correlate 0.87-0.95 — namely:
 *
 *      HOW FAR PRICE HAS ALREADY TRAVELLED IN THE TRADE'S DIRECTION BEFORE ENTRY.
 *
 * Controlling for extension, RSI adds ~nothing. It is one effect, not five.
 *
 * IS/OOS (trend mode, SL 3sigma / TP 6sigma, 1:2 payoff):
 *   baseline            WR 41.2% / 41.0%   PF 1.20 / 1.22   159 trades/day
 *   ext50 <= 4.3        WR 44.0% / 42.5%   PF 1.32 / 1.26    91 trades/day
 *   + room + vol gate   WR 43.8% / 43.0%   PF 1.33 / 1.29    76 trades/day
 *
 * Worst quintile (ext50 > 6.3) ran WR 35.6% and LOST money outright — that is the bucket
 * being removed. The relationship is monotone across all five quintiles (not a lucky bucket),
 * IS and OOS agree (43.8 vs 43.0 — unlike every earlier filter tried), and it has a plain
 * economic reason: on a 1:2 payoff you need room for price to reach 2R, and entering after
 * a 6-sigma run means the easy part of the move is already behind you.
 *
 * ext50 = (log(price) - log(SMA50)) / sigma, SIGNED so positive = extended in trade direction.
 * sigma = per-bar log-return stdev of the same series.
 *
 * All thresholds env-tunable; EXT_GATE_ENABLED=false disables entirely.
 */
function extensionGate(ctx = {}) {
  if (String(process.env.EXT_GATE_ENABLED || 'true').toLowerCase() === 'false') {
    return { pass: true, reason: null, ext50: null };
  }
  const maxExt = Number(process.env.EXT_MAX_SIGMA ?? '4.3');
  const minRoom = Number(process.env.EXT_MIN_ROOM ?? '0.09');
  const maxAtrPct = Number(process.env.EXT_MAX_ATR_PCT ?? '0.93');

  const ext50 = Number(ctx.ext50);
  const room = Number(ctx.room);
  const atrPct = Number(ctx.atrPct);

  // FAIL OPEN on unmeasurable extension: a missing feature must not silently block every
  // trade. But DO record it, so a broken feed shows up as a flood of null-ext trades rather
  // than as mysteriously-changed behaviour.
  if (!Number.isFinite(ext50)) return { pass: true, reason: 'EXT_UNMEASURABLE', ext50: null };

  if (ext50 > maxExt) return { pass: false, reason: `EXT_TOO_EXTENDED_${ext50.toFixed(2)}s>${maxExt}`, ext50 };
  if (Number.isFinite(room) && room < minRoom) return { pass: false, reason: `EXT_NO_ROOM_${room.toFixed(2)}<${minRoom}`, ext50 };
  if (Number.isFinite(atrPct) && atrPct > maxAtrPct) return { pass: false, reason: `EXT_VOL_TOO_HIGH_${atrPct.toFixed(2)}>${maxAtrPct}`, ext50 };
  return { pass: true, reason: null, ext50 };
}

/**
 * Convenience: direction decision + extension gate in one call.
 * Returns the same shape as decideDirection, plus { extGate }.
 * A blocked trade returns side 'NEU' — it is not flipped, just skipped.
 */
function decideWithGate(ctx = {}) {
  const d = decideDirection(ctx);
  if (d.side === 'NEU') return { ...d, extGate: { pass: true, reason: null, ext50: null } };
  const g = extensionGate(ctx);
  if (!g.pass) {
    return { side: 'NEU', edge: 0, reasons: [...(d.reasons || []), g.reason], mode: d.mode,
             vetoed: true, vetoReason: g.reason, extGate: g };
  }
  return { ...d, extGate: g };
}

module.exports = { decideDirection, decideWithGate, extensionGate, sideFromTrends, elliottVeto, fadeDirection, getMode };
