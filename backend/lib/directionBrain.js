'use strict';
// ── Direction Brain — ADVISORY SHADOW MODE (v4.6.8.68, fixBOTTOM companion) ──────────────────
//
// PURPOSE: per-candidate macro/micro direction advisor. This module DOES NOT act. It computes a
// verdict + confidence for every signal at birth and the result is stamped into s.diag.dirBrainAdvice
// so its accuracy can be scored offline against resolved outcomes (WIN/LOSS) — the "advisory" tier
// of the agreed authority ladder (advisory → veto → full), earned only through proven paper accuracy.
//
// EVIDENCE BASIS (what each input is worth today — encoded honestly, not aspirationally):
//   1. breadthRangePctile  — VALIDATED (4-session walk-forward, Jul 2026): SELL entered while
//      market breadth sits in the bottom 15% of its trailing 6h range = 16-27% WR vs ~50% baseline;
//      z=-2.43 vs pooled base; direction held in ALL 3 sessions that had bottom-zone entries; robust
//      at 4h/6h/12h lookbacks. BUY mirror (top of range) directionally consistent (44% vs 65% mid)
//      but n=18 — treated as weak supporting evidence, half weight.
//   2. btcRsi panic (<30)  — SUPPORTED (3 of 4 sessions strongly, 1 large session flat): losses 5x
//      more likely with BTC RSI<30 at SELL entry in the bloodbath session; 2x2 vs breadth-bottom
//      shows independent contribution (bottom+panic 9% WR vs bottom+calm 29%). Secondary weight.
//   3. fundingDivergenceAtEntry — CAPTURED, NOT YET VALIDATED (fixMICRO2 coverage only started
//      v4.6.8.67; the only bear session predates it). Recorded as an input for offline scoring,
//      contributes ZERO to the live verdict until a walk-forward validates it. Do not "upgrade"
//      this weight without per-session proof — two prior pooled-only findings were overfit.
//
// FAIL-OPEN: any missing input degrades confidence, never throws. Callers must treat null as
// "no advice" and change nothing.

const BOTTOM_ZONE_PCTILE = 15;   // matches the validated cut used in the walk-forward
const TOP_ZONE_PCTILE    = 85;
const RSI_PANIC          = 30;
const RSI_EUPHORIA       = 70;   // untested mirror of panic — logged in reasons, low weight

/**
 * advise(input) → { verdict, confidence, reasons, inputs } | null
 *   input = {
 *     side:            'BUY'|'SELL'            (required)
 *     breadthPctile:   0-100 | null            (position of current breadth in trailing 6h range)
 *     btcRsi:          number | null
 *     composite:       number | null           (sentinel composite score)
 *     fundingDivergence: number | null         (recorded only — zero live weight, see header)
 *   }
 * verdict: 'AGREE' (context supports the side) | 'CAUTION' (context weakly against)
 *          | 'OPPOSE' (validated toxic zone for this side)
 * confidence: 0-100. Only OPPOSE at high confidence would ever be allowed to act in a future
 * authority tier; today nothing acts on any of it.
 */
function advise(input) {
  try {
    const side = String(input && input.side || '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') return null;

    const p   = numOrNull(input.breadthPctile);
    const rsi = numOrNull(input.btcRsi);
    const comp = numOrNull(input.composite);
    const fdiv = numOrNull(input.fundingDivergence);

    const reasons = [];
    let score = 0;          // negative = against the side, positive = supports it
    let evidence = 0;       // how many validated inputs were actually present

    // ── Input 1: breadth position-in-range (validated, dominant weight) ──
    if (p != null) {
      evidence += 1;
      if (side === 'SELL') {
        if (p <= BOTTOM_ZONE_PCTILE) { score -= 3; reasons.push(`BREADTH_BOTTOM_ZONE: pctile ${p.toFixed(0)} <= ${BOTTOM_ZONE_PCTILE} — shorting the local exhaustion low (validated 16-27% WR zone)`); }
        else if (p >= TOP_ZONE_PCTILE) { score += 2; reasons.push(`BREADTH_TOP_ZONE: pctile ${p.toFixed(0)} — fading a mature relief rally (validated 57-83% WR zone)`); }
      } else { // BUY — mirror, HALF weight (directionally consistent but n=18, unproven)
        if (p >= TOP_ZONE_PCTILE) { score -= 1.5; reasons.push(`BREADTH_TOP_ZONE(BUY): pctile ${p.toFixed(0)} — buying the local breadth high (weak-evidence mirror, half weight)`); }
        else if (p <= BOTTOM_ZONE_PCTILE) { score += 1; reasons.push(`BREADTH_BOTTOM_ZONE(BUY): pctile ${p.toFixed(0)} — buying the washed-out low (weak-evidence mirror)`); }
      }
    }

    // ── Input 2: BTC RSI extreme (supported, secondary weight) ──
    if (rsi != null) {
      evidence += 1;
      if (side === 'SELL' && rsi < RSI_PANIC) { score -= 2; reasons.push(`BTC_RSI_PANIC: ${rsi.toFixed(1)} < ${RSI_PANIC} — shorting into a capitulation print (losses 5x likelier, 3/4 sessions)`); }
      if (side === 'BUY' && rsi > RSI_EUPHORIA) { score -= 1; reasons.push(`BTC_RSI_EUPHORIA: ${rsi.toFixed(1)} > ${RSI_EUPHORIA} — untested mirror, low weight`); }
    }

    // ── Input 3: funding divergence — RECORDED ONLY, zero live weight until validated ──
    if (fdiv != null) reasons.push(`FUNDING_DIV_RECORDED: ${fdiv} (no weight — pending walk-forward validation)`);

    // ── Composite — context tag only, no weight (every static composite threshold overfit) ──
    if (comp != null) reasons.push(`COMPOSITE_CONTEXT: ${comp} (no weight — static thresholds failed 4-session validation)`);

    let verdict = 'AGREE';
    if (score <= -3) verdict = 'OPPOSE';
    else if (score < 0) verdict = 'CAUTION';

    // confidence scales with both signal strength and how much validated evidence was present
    const confidence = Math.max(0, Math.min(100, Math.round(Math.abs(score) * 20 * (evidence / 2))));

    return { verdict, confidence, score: Number(score.toFixed(2)), reasons,
             inputs: { side, breadthPctile: p, btcRsi: rsi, composite: comp, fundingDivergence: fdiv } };
  } catch (_e) {
    return null; // advisory must never block signal creation
  }
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null; // Number(null)===0 — without this, a
  // missing breadthPctile reads as pctile 0 ("absolute bottom") and a missing RSI as 0 ("panic"),
  // producing a false OPPOSE at max confidence. Caught by unit test T4 in review round 1.
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { advise, BOTTOM_ZONE_PCTILE, TOP_ZONE_PCTILE, RSI_PANIC };
