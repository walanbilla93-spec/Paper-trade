'use strict';
// ── Fade Module — SHADOW MODE (v4.6.8.77) ────────────────────────────────────────────────────
//
// PURPOSE: counter-trend "fade" advisor for the two absolute-breadth extremes that fixEUPH already
// dampens. This module DOES NOT ACT. For every candidate born inside a fade zone it computes a
// would-be OPPOSITE-side trade with a FRESHLY RECALCULATED bracket (default 2:1, NOT the mirror
// candidate's inherited TP/SL) and stamps it into birth diag as s.diag.fadeShadow. Scored offline
// against the mirror candidate's own mfeR/maeR excursion — the exact method used to validate it.
//
// WHY A FRESH BRACKET (the core correction): a raw side-flip inherits the momentum trade's geometry
// (≈1R risk / ≈2.3R reward). Flipping that makes the fade collect +1R on the mirror's stop but pay
// −2.3R on the mirror's target — at 37–48% mirror WR the RR asymmetry is NET NEGATIVE (−0.22R on
// the dead-hour cohort). Recomputing an independent TP=2R / SL=1R bracket at the fade entry removes
// that inherited asymmetry; the fade then stands or falls on where price actually travels from entry,
// which is what the excursion sim measured.
//
// EVIDENCE BASIS (honest, per-zone — the two sides are NOT equally supported):
//   • EUPHORIA fade (mirror BUY @ bull_pct>=HI → shadow SELL): WEAK-POSITIVE. 4-session excursion
//     sim on 55 euphoria BUY moments, worst-case (ambiguous bar → loss) resolution:
//         TP1.5/SL1.0 +0.291R · TP2.0/SL1.0 +0.200R (optimistic +0.36–0.66R).
//     Rollover subset (btc_rsi rolled back under 70 after peaking >=70) improved the floor to
//     +0.379R @ TP1.5. Per-session pessimistic never negative (S2 +0.44 / S3 0.00 / S4 +0.27).
//     CAVEATS baked in, do not forget: effective n<55 (euphoria moments cluster intra-session),
//     selection is BUY-brain-fired moments (not the fade's own trigger), mirror geometry assumes
//     symmetric ATR stops. This is SHADOW-worthy evidence, not act-worthy.
//   • DESPAIR fade (mirror SELL @ bull_pct<=LO → shadow BUY): UNVALIDATED — ZERO SAMPLES. Across
//     560 labelable trades there were 0 BUYs ever taken in the <=LO zone (173 SELLs, 0 BUYs): the
//     brain is structurally blind there, so NO excursion data exists to pre-validate the mirror.
//     Built ONLY to start accumulating the sole data this corner will ever produce. Confidence is
//     hard-capped low and tagged UNVALIDATED_ZERO_SAMPLE. Do NOT upgrade its weight on pooled hope.
//
// BOTH-SIDES SYMMETRY (hard rule): both directions are built in this one module. The asymmetry is in
// stamped *confidence/evidence tier*, not in existence — justified by the zero-sample despair history.
//
// FAIL-OPEN: any missing input degrades to null ("no fade advice"); never throws. Caller treats null
// as "not in a fade zone / cannot advise" and changes nothing.

const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

// Fade-specific tunables (zone thresholds are PASSED IN from the caller's EUPH_BREADTH_* so the fade
// zone can never drift from the dampener zone — single source of truth lives in v4Brain).
const FADE_ENABLED   = String(process.env.V4_FADE_SHADOW_ENABLED || 'true').toLowerCase() === 'true';
const FADE_TP_R      = Math.min(5, Math.max(0.5, Number(process.env.V4_FADE_TP_R || '2.0')));   // fresh reward (R). Default 2:1 per operator; sim slightly favours 1.5 — left tunable to re-score.
const FADE_SL_R      = Math.min(3, Math.max(0.5, Number(process.env.V4_FADE_SL_R || '1.0')));   // fresh risk (R).
const FADE_RSI_PEAK  = Math.min(90, Math.max(50, Number(process.env.V4_FADE_RSI_PEAK   || '70'))); // euphoria rollover reference
const FADE_RSI_TROU  = Math.min(50, Math.max(10, Number(process.env.V4_FADE_RSI_TROUGH || '30'))); // despair rollover reference (mirror)

function enabled() { return FADE_ENABLED; }

/**
 * evaluate(input) → fadeShadow stamp | null   (NOTHING acts on the return value)
 *   input = {
 *     side:        'BUY'|'SELL'   (the mirror candidate's side — required)
 *     absBreadth:  number|null    (_bp.cur — absolute bull_pct)
 *     btcRsi:      number|null    (current trailing-window btc_rsi)
 *     btcRsiHi:    number|null    (trailing-window MAX btc_rsi — for euphoria rollover)
 *     btcRsiLo:    number|null    (trailing-window MIN btc_rsi — for despair rollover, mirror)
 *     entry:       number|null    (mirror candidate entry price; for informational fade levels)
 *     rUnit:       number|null    (1R in price = |entry - sl| of the mirror candidate)
 *     breadthHi:   number         (EUPH_BREADTH_HI, passed in)
 *     breadthLo:   number         (EUPH_BREADTH_LO, passed in)
 *   }
 */
function evaluate(input) {
  try {
    if (!FADE_ENABLED) return null;
    const side = String(input && input.side || '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') return null;

    const bp   = num(input.absBreadth);
    if (bp == null) return null;                       // no absolute breadth ⇒ cannot locate a zone
    const hi   = num(input.breadthHi);
    const lo   = num(input.breadthLo);
    if (hi == null || lo == null) return null;

    // Zone + fade direction. Only the momentum side that fixEUPH dampens is faded.
    let zone = null, fadeSide = null, tier = null;
    if (side === 'BUY' && bp >= hi)       { zone = 'EUPHORIA'; fadeSide = 'SELL'; tier = 'WEAK_SUPPORTED'; }
    else if (side === 'SELL' && bp <= lo) { zone = 'DESPAIR';  fadeSide = 'BUY';  tier = 'UNVALIDATED_ZERO_SAMPLE'; }
    else return null;                                  // candidate not in a fade zone

    const rsi   = num(input.btcRsi);
    const rsiHi = num(input.btcRsiHi);
    const rsiLo = num(input.btcRsiLo);

    // Rollover = the higher-conviction sub-condition (peaked/troughed, then reverted). Stamped but
    // NOT required to fire; offline scoring compares rollover vs non-rollover fades. Mirror-symmetric.
    let rollover = false;
    if (zone === 'EUPHORIA') {
      rollover = (rsi != null && rsiHi != null && rsi < FADE_RSI_PEAK && rsiHi >= FADE_RSI_PEAK);
    } else { // DESPAIR
      rollover = (rsi != null && rsiLo != null && rsi > FADE_RSI_TROU && rsiLo <= FADE_RSI_TROU);
    }

    // Fresh 2:1 (default) bracket in PRICE, computed from the mirror entry and 1R unit. Informational
    // for the offline scorer / any future promotion; the module still acts on nothing.
    const entry = num(input.entry);
    const rUnit = num(input.rUnit);
    let tpPrice = null, slPrice = null;
    if (entry != null && rUnit != null && rUnit > 0) {
      if (fadeSide === 'SELL') { tpPrice = entry - FADE_TP_R * rUnit; slPrice = entry + FADE_SL_R * rUnit; }
      else                     { tpPrice = entry + FADE_TP_R * rUnit; slPrice = entry - FADE_SL_R * rUnit; }
      tpPrice = Number(tpPrice.toFixed(8));
      slPrice = Number(slPrice.toFixed(8));
    }

    // Confidence: modest for the supported side, hard-capped for the zero-sample side. Advisory only.
    let confidence;
    if (tier === 'WEAK_SUPPORTED') confidence = rollover ? 45 : 35;   // never high — evidence is shadow-grade
    else                           confidence = rollover ? 20 : 12;   // despair: capped, unvalidated

    const reasons = [
      `${zone}: mirror ${side} at absolute breadth ${bp} (${zone === 'EUPHORIA' ? '>=' + hi : '<=' + lo}) → shadow ${fadeSide}`,
      `fresh bracket TP=${FADE_TP_R}R / SL=${FADE_SL_R}R (recomputed at fade entry — NOT inherited flip)`,
      rollover ? `RSI_ROLLOVER confirmed (rsi=${rsi}, ${zone === 'EUPHORIA' ? 'hi=' + rsiHi + '>=' + FADE_RSI_PEAK : 'lo=' + rsiLo + '<=' + FADE_RSI_TROU})`
               : `no RSI rollover (lower-conviction fade)`,
      tier === 'UNVALIDATED_ZERO_SAMPLE' ? `EVIDENCE: zero historical samples in this zone — pure data-collection shadow` : `EVIDENCE: weak-positive 4-session excursion sim (shadow-grade)`,
    ];

    return {
      wouldFade: true,
      zone, fadeSide, tier, rollover, confidence,
      tpR: FADE_TP_R, slR: FADE_SL_R,
      entry: entry, tpPrice, slPrice,
      absBreadth: bp, btcRsi: rsi, btcRsiHi: rsiHi, btcRsiLo: rsiLo,
      acted: false,               // explicit: this module never acts
      reasons,
    };
  } catch (_e) {
    return null;                  // fail-open: never block signal creation
  }
}

module.exports = { evaluate, enabled };
