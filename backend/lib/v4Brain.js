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
const { detectBTCRegime, getBTCRegime, detectLocalRegime, getAllowedSides, detectFlip } = require('./regimeBrain');
const sentinel   = require('./sentinelBrain'); // fix29: market sentinel
const sweepEngine = require('./sweepEngine');    // fix38h: liquidity sweep detector
const structureDetector = require('./structureDetector'); // fix44f: squeeze/trap/BOS/CHoCH/divergence + fix46c: Elliott Waves
const directionBrain = require('./directionBrain');       // fixBOTTOM: advisory shadow — logs verdicts to diag, acts on nothing
const fadeModule = require('./fadeModule');               // fixFADE (.77): counter-trend fade shadow — stamps diag.fadeShadow, acts on nothing
const { analyzeStructure, analyzeElliottWaves } = structureDetector;

const LOOP_MS = Math.max(15000, parseInt(process.env.V4_SCAN_INTERVAL_MS || process.env.BACKEND_SCAN_INTERVAL_MS || '20000', 10));
const MAX_SYMBOLS = Math.max(20, Math.min(160, parseInt(process.env.V4_SCAN_SYMBOLS || process.env.BACKEND_SCAN_SYMBOLS || '80', 10)));
const MAX_SIGNALS = Math.max(40, Math.min(250, parseInt(process.env.V4_MAX_SIGNALS || '120', 10)));
const MAX_LEDGER = Math.max(500, Math.min(20000, parseInt(process.env.V4_MAX_LEDGER || '5000', 10)));
const RECENT_LEDGER_LIMIT = Math.max(50, Math.min(1000, parseInt(process.env.V4_RECENT_LEDGER_LIMIT || '120', 10)));
const MIN_RR = Math.max(1.2, Number(process.env.V4_MIN_RR || '1.8')); // fix30: align with config.js DEFAULTS.v4MinRR=1.8 (data-driven)
const MIN_SELL_RR = Math.max(1.2, Number(process.env.V4_MIN_SELL_RR || '1.8')); // fix30: align with config.js DEFAULTS.v4MinSellRR=1.8
const MIN_NET_TP = Math.max(0, Number(process.env.V4_MIN_NET_TP_USDT || '0.25'));
const MIN_NET_TP_FEE_MULT = Math.max(0, Number(process.env.V4_MIN_NET_TP_FEE_MULT || '2.5'));
const MIN_NET_RR = Math.max(0, Number(process.env.V4_MIN_NET_RR || '0.85'));
const MAX_FRONTEND_TP_PCT = Math.max(0.2, Number(process.env.V4_MAX_FRONTEND_TP_PCT || '4.5')); // fix48b: name is legacy — now governs ingestCandidate() TP validation for retry signals, not frontend display
const DIAGNOSTIC_JOURNAL = String(process.env.V4_DIAGNOSTIC_JOURNAL || 'true').toLowerCase() !== 'false';
const MAX_DIAGNOSTIC_ROWS = Math.max(500, Math.min(50000, parseInt(process.env.V4_MAX_DIAGNOSTIC_ROWS || '5000', 10)));
const MAX_TP_ATR = Math.max(1.0, Number(process.env.V4_MAX_TP_ATR || '5.0')); // fix37: lowered 8.0→5.0; RR>3 had 17% WR (-2.77U). 5 ATR keeps targets realistic.
const RISK_WINDOW_HOURS = Math.max(1, Number(process.env.V4_RISK_WINDOW_HOURS || '2')); // fix39: lowered 6→2hr — old losses were blocking new sessions
const MAX_CONSECUTIVE_LOSSES = Math.max(1, parseInt(process.env.V4_MAX_CONSECUTIVE_LOSSES || '6', 10)); // fix43: raised 4→6; alerts showed engine paralysed for 2hrs on 5-6 loss streak. 6 is meaningful cluster, 4 was too hair-trigger.
const MAX_SESSION_LOSS_USDT = Math.max(0, Number(process.env.V4_MAX_SESSION_LOSS_USDT || '10.0')); // fix39: raised 5→10 USDT — 5 USDT was blocking after just a few losses in paper trading
const ENTRY_TOLERANCE_ATR = Math.max(0.05, Number(process.env.V4_ENTRY_TOLERANCE_ATR || '0.25'));
const ENTRY_TOLERANCE_MIN_PCT = Math.max(0.01, Number(process.env.V4_ENTRY_TOLERANCE_MIN_PCT || '0.08'));
const ENTRY_TOLERANCE_MAX_PCT = Math.max(0.05, Number(process.env.V4_ENTRY_TOLERANCE_MAX_PCT || '0.35'));
const ENTRY_REACTION_BPS = Math.max(1, Number(process.env.V4_ENTRY_REACTION_BPS || '5'));
const ENTRY_REACTION_ATR = Math.max(0.02, Number(process.env.V4_ENTRY_REACTION_ATR || '0.10'));

// ── fixRETEST (07/26): plan the entry, watch price, fire once — user's design ───────────────────
//   RETEST_APPROACH_MULT: how wide (in multiples of the normal tight entry-tolerance) the "worth
//   watching for an approach" band is. Deliberately generous — a false positive here just means we
//   start watching a little early at zero cost; a false negative means we miss the pre-placement
//   window and fall back to the existing confirm-then-enter path (still safe, just the old behavior).
const RETEST_APPROACH_MULT = Math.max(1, Number(process.env.V4_RETEST_APPROACH_MULT || '2.5'));
//   RETEST_APPROACH_MIN_TICKS: for a signal with NO prior touch history, require this many
//   consecutive scan ticks of price moving strictly closer to entry before arming the resting-limit
//   placement — filters a single noisy sample from arming it (mirrors fixHOLD's hold-window intent,
//   applied to placement instead of firing). A genuine SECOND touch (s.hadFirstTouch) arms instantly
//   regardless — the level already proved itself once.
const RETEST_APPROACH_MIN_TICKS = Math.max(1, parseInt(process.env.V4_RETEST_APPROACH_MIN_TICKS || '2', 10));
//   BABYSIT_MS: cadence for checking already-placed resting limits for early structural invalidation.
//   User's explicit sizing (07/26): does not need to be fast — the fill itself happens on Bybit's own
//   book at zero latency from us; this loop's only job is "should I cancel this before it fills
//   into a dead setup," which is not time-critical. 10s default, checks price only for the handful
//   of symbols with a resting order out (nothing like the heavy 529-pair scan fixLOOP had to cap).
const BABYSIT_MS = Math.max(5000, parseInt(process.env.V4_BABYSIT_INTERVAL_MS || '10000', 10));

// ── fixCONFIRM (hotfix 21b, 2026-07-24): MARKET-ON-CONFIRMATION ────────────────────────────────
//   Audit finding: a LIMIT placed at the confirmed-entry moment lands at ~signal.entry, which for a
//   SELL is ~0.10 ATR ABOVE the just-confirmed (lower) price — so it fills only on a bounce BACK to
//   the zone (undoing the confirmation). That misses the clean runners (the winners) and fills the
//   chop-prone bounce-backs, undershooting paper's trade count. Paper "fills" every confirmed signal
//   at the zone the instant it confirms; the faithful live analogue is a MARKET fill at confirmation.
//   true  = enter at market the moment `inZone && directional` + timing blocks pass (replicates paper's
//           count/selection; ~0.10 ATR worse entry + taker fee — user pre-authorized taker).
//   false = old maker-limit-at-entry behaviour (cheaper/better price, but undershoots + adverse-selects).
// ── REVERTED to false (07/26) — fixANCHORRR AUTOPSY: market-on-confirmation was proven live to
//   collapse dollar RR toward 1:1 on missed-move-breakout fills. fixRISKCAP (07/21) correctly widens
//   the RISK side of sizing when a market fill has chased past the zone (qty shrinks to hold ~0.25U
//   risk) but fixANCHOR's TP stays at the signal's ORIGINAL reward distance — so reward shrinks with
//   the smaller qty while risk doesn't, and RR compresses exactly when entries chase hardest. Traced
//   on 4 live 07/26 trades (ORDIUSDT, LAUSDT, 1000BONKUSDT): qty landed at 71-87% of plan purely from
//   this widening, dollar RR ~1:1 vs signal RR ~2:1-2.8:1. A first attempt tried to fix this by
//   stretching TP to match the widened risk — REJECTED by user: this is a scalping strategy sized off
//   the nearest real S/R levels; stretching TP past the actual resistance the thesis depends on trades
//   fill-rate for chasing price into open air, which is worse, not fixed, in anything short of a
//   strong trend. Root problem is upstream of sizing: market-on-confirmation chases in the first
//   place. Reverting to the limit path fixes it at the correct layer — SL/TP stay exactly at the
//   structural levels (fixANCHOR's stretch block is gated `if (useMarket...)`, inert here), and the
//   existing >0.5%-drift hard-reject (fix49b, line ~157 below) now does double duty as "skip the
//   trade if it already ran too far by confirmation time" instead of leaving a dead resting order —
//   exactly what a missed-move-breakout signal typically triggers. Confirmed entries still require
//   fixHOLD's reaction-hold (noise-wick protection stays); only the FILL mechanism reverts. KNOWN
//   TRADE-OFF, stated to user up front: this WILL undershoot trade count vs market-fill (the original
//   reason this was flipped true) — chased setups that used to fill now often get skipped outright.
//   That's the deliberate choice: fewer trades at real 2:1 over more trades at ~1:1.
const FIXCONFIRM_ENTRY_MARKET = false;
// fix33-obs2: was 10s — scan interval is 20s, so window ALWAYS expired before next scan. Signal could never activate.
const ENTRY_CONFIRMATION_WINDOW_MS = Math.max(1000, Number(process.env.V4_ENTRY_CONFIRMATION_WINDOW_SECONDS || '180') * 1000); // fix43b: raised 90→180s; fix47: config.js aligned to 180s
const MEME_SL_ATR_MULT = Math.max(0.1, Number(process.env.V4_MEME_SL_ATR_MULT || '0.45'));
const NORMAL_SL_ATR_MULT = Math.max(0.1, Number(process.env.V4_NORMAL_SL_ATR_MULT || '0.35'));
const EXPIRY_MS = Math.max(5, Number(process.env.V4_SIGNAL_EXPIRY_MINUTES || process.env.SIGNAL_EXPIRY_MINUTES || 90)) * 60 * 1000; // fix31: 30→90 min — trending markets need longer window for price to pull back to entry
// fix48d (item 3): HARD CAP on time a signal may sit in WAITING_ENTRY/WAITING_REACTION before it MUST expire.
// fix48c let setups linger up to EXPIRY_MS (90 min default, or higher UI setting) — LAB/BSB were observed
// sitting 5+ hours. This cap is independent of EXPIRY_MS and always wins (we take the min of the two).
// A setup that has not confirmed entry in 45 min is stale; the structure that justified it is gone.
const WAITING_HARD_CAP_MS = Math.max(60 * 1000, Number(process.env.V4_WAITING_HARD_CAP_MINUTES || '45') * 60 * 1000);

// fix49k: BREADTH-OVERRIDE (both sides, in-brain). When sentinel breadth strongly disagrees with
// the BTC regime LABEL (the label lags because BTC carries 2× weight in the composite), trust
// breadth over the label and rescue the breadth-aligned side that the label would otherwise block.
//   BUY-rescue : breadth >= BREADTH_OVERRIDE_BULL_PCT (70%) AND BTC label is BEAR  → allow BUY
//   SELL-rescue: breadth <= BREADTH_OVERRIDE_BEAR_PCT (30%) AND BTC label is BULL  → allow SELL
// Mirror of the H2 fight-gate. Removes a safety gate on BOTH sides → paper-only until validated.
// Default ON for paper data collection; kill via settings.breadthOverride=false (no redeploy).
const BREADTH_OVERRIDE_ENABLED = true;            // master default; settings.breadthOverride can force false
const BREADTH_OVERRIDE_BULL_PCT = 70;             // BUY-rescue floor (>= this % bull)
const BREADTH_OVERRIDE_BEAR_PCT = 30;             // SELL-rescue ceiling (<= this % bull)

// Returns 'BUY' | 'SELL' | null — which side (if any) breadth-override rescues right now.
// Pure read of the current sentinel; fail-safe to null on any gap so the normal gate applies.
function breadthOverrideSide(side, btcRegimeUpper, settings) {
  try {
    if (settings && settings.breadthOverride === false) return null;
    if (!BREADTH_OVERRIDE_ENABLED) return null;
    const s = (typeof sentinel?.getSentinel === 'function') ? sentinel.getSentinel() : null;
    const pairs = num(s?.vol?.pair_count, 0);
    const pct = pairs > 0 ? num(s?.vol?.bull_pct, NaN) : NaN;
    if (!Number.isFinite(pct)) return null;
    const reg = String(btcRegimeUpper || '').toUpperCase();
    const isBear = ['STRONG_BEAR', 'BEAR', 'BEAR_TREND', 'BEAR_RANGE'].includes(reg);
    const isBull = ['STRONG_BULL', 'BULL', 'BULL_TREND', 'BREAKOUT', 'BULL_RANGE'].includes(reg);
    if (side === 'BUY'  && isBear && pct >= BREADTH_OVERRIDE_BULL_PCT) return 'BUY';
    if (side === 'SELL' && isBull && pct <= BREADTH_OVERRIDE_BEAR_PCT) return 'SELL';
    return null;
  } catch (_e) { return null; }
}
const COOLDOWN_MS = Math.max(0, Number(process.env.V4_SYMBOL_COOLDOWN_MINUTES || process.env.COOLDOWN_MINUTES || 240)) * 60 * 1000; // fix47: removed EXPIRY_MS floor — cooldown is independent of signal expiry window
const PUBLIC_BASE = process.env.V4_MARKET_BASE_URL || 'https://api.bybit.com';
const FEE_RATE = Math.max(0, Number(process.env.V4_FEE_RATE || '0')); // fix48y: fees removed from paper P&L (real Bybit taker ~0.013-0.02/trade — extract from exchange instead). Restore via V4_FEE_RATE env.
const SLIPPAGE_RATE = Math.max(0, Number(process.env.V4_SLIPPAGE_RATE || '0')); // fix48y: slippage padding removed (was inflating netSl, crushing realized RR). Restore via V4_SLIPPAGE_RATE env.
const V4_VERSION = '4.6.9.10'; // NEW in .10 — hotfix36 (URGENT, real regression): user reported
// backend timeouts severe enough to force a manual pause — gradual onset, backend-only, frontend
// fine, tracked the recent v4Brain hotfixes. Traced to Phase 1 (hotfix29): decideLiveEntry() called
// activeTrades() -> getTrades() -> store.read('trades', {}) on EVERY qualifying candidate, EVERY
// scan tick — store.read() does a SYNCHRONOUS fs.readFileSync + JSON.parse with ZERO caching,
// blocking Node's single-threaded event loop, purely for shadow-only observability logging. Fixed:
// active-trade count now computed ONCE per scan cycle in updateExistingSignals and passed down,
// instead of re-fetched from disk per candidate. Same MAXOPEN comparison, same result — just no
// longer O(candidates) blocking disk reads per tick. Confirmed sentinelBlind() was NOT part of the
// problem (in-memory only, no disk I/O — checked before ruling it out, not assumed). 3/3 unit tests
// confirm identical MAXOPEN behavior before/after. NOT yet deployed — highest priority: this is
// very likely what's currently forcing the backend pause.
// Prior .9 — hotfix35: fixCANCELSHADOW. User asked directly: "do we
// shadow the cancellations?" Answer was no — /api/v4/expired-analysis only ever covered EXPIRED
// (timed-out waiting for entry), never STALE_CANCELLED (breadth-fight abandons, structure-break-
// before-fill, drift-toward-stop). Same underlying question either way — "would this uncompleted
// signal have won or lost anyway" — so broadened the existing walk-forward mechanism to cover both
// rather than build a new one. New bySourceState breakdown (EXPIRED vs STALE_CANCELLED) since
// they're cancelled for different reasons and are worth seeing apart, not just pooled. Response
// field renamed totalExpired -> totalDeadSignals (now covers both); confirmed nothing in
// frontend/routes depended on the old name before renaming. 2/2 unit tests: broadened filter
// includes both dead states (case-insensitive) and correctly excludes real TP_HIT/CLOSED_LOSS rows.
// Prior .8 — hotfix34: fixRSIGATEOBS. Adds a one-time RSI_GATE_PASS
// log at signal birth (only admitted signals reach signalFromLeader, so this fires once per
// tradeable signal, never per tick) — logs which RSI value/zone let it through. Durable from day
// one (added straight to PHASE_LOG_TYPES) rather than repeating the hotfix30 mistake of learning
// eviction the hard way. Purpose: match the caged trial's real closes back to "which zone" without
// hand reconstruction. Also: checked the fixRSIGATE zones against REAL Bybit-confirmed closes only
// (not paper) — SELL's dead zone (45-55, 0% n=4) and oversold weakness (<30, 0% n=3) independently
// CONFIRMED on real trades. BUY's 55-70 zone measured weaker on real trades (44%, n=9) than paper
// suggested (61%, n=49) — flagged as less solid, not yet re-tuned (needs more real samples first).
// Prior .7 — hotfix33: fixRSIGATE. User's explicit, direct instruction:
// score is confirmed dead weight (r=-0.07, long-standing), the running system is below its own
// breakeven with "no backing, not even numbers" — replace the score gate ENTIRELY with a real,
// data-backed binary direction rule, live, not shadow-tested. passesRsiDirectionGate() is now the
// SOLE entry admission rule across all 3 gate sites (scan-loop leader path, retry pre-check,
// ingestCandidate) — BUY allowed RSI 30-70, SELL allowed RSI 30-45 OR 55-70 (excludes the dead
// 45-55 zone measured at 0% WR, and both extremes). Old crude RSI check (BUY>=78/SELL<=22)
// removed as fully superseded — two overlapping RSI checks was exactly what this was asked to stop.
// SIDE EFFECT, stated plainly: since SCORE_LT_ can no longer fire, the fixPCT fork-A score-bypass
// and EUPH_ADX's "un-reject a score-only block" mechanism are now permanently dormant (nothing to
// bypass/promote from) — left in place as harmless dead code rather than ripped out, since removing
// them isn't what was asked and touching more than necessary adds risk to an already-large change.
// Caught and fixed a real bug in my own first draft: Number(null) is 0, not NaN, so the fail-open
// check for a missing RSI reading was NOT firing — fixed with an explicit null/undefined check
// before the Number() conversion. 20/20 unit tests incl. exact boundary values (30/45/55/70) and 6
// real trades from this exact session cross-checked against what the new gate would now do to them.
// Prior .6 — hotfix32: fixREVERSAL (user's direct question: "would
// reversing the trades give a better WR" — real SELL 33% WR held across 3 independent ledgers over
// weeks, not a one-off). New analyzeReversalHypothesis(): mirrors SL/TP around each REAL closed
// Bybit trade's actual entry price/instant (opposite side, same risk/reward distances), walks real
// forward candles to see which level the mirror would have hit first, using the signal's own
// already-computed netTpUSDT/netSlUSDT for the $ magnitude (mirroring doesn't change position size).
// STATED ASSUMPTION: mirror trade assumed to fill at the same price/instant as the real trade did —
// this tests signal DIRECTION quality, not a literal "flip the bot" prediction (real opposite-side
// fills would carry their own slippage/fill-rate, not modeled here). New route GET
// /api/v4/reversal-analysis. Joins bybit_ledger closes to their planned sl/tp1 via
// signalId==ledger.id (100% match confirmed on this session's data). Reuses fixTRUTHWR's exact
// close-dedup rank rule (CLOSED > non-zero pnl > later closeTime) so counts match the truth panel.
// Prior .5 — hotfix31: fixPHASE2ENTRY (real bug, found from user's
// actual /api/v4/expired-analysis output: 71% would-win vs 46% real executed WR — too big a gap to
// be real edge). Root cause: walkOutcome() scored TP/SL without ever confirming price touched the
// signal's OWN entry line first. An EXPIRED signal means the entry zone was never re-confirmed —
// scoring candles that ran straight to TP without ever revisiting entry counted "direction was
// right" as "would have won," which isn't the same thing (no fill = no trade). Fix: walk forward,
// require entry touch (BUY: low<=entry / SELL: high>=entry) before scoring TP/SL at all. New
// outcome bucket NEVER_FILLED (excluded from win/loss and from the $ estimate) alongside the
// existing WOULD_WIN/WOULD_LOSE/NEITHER_IN_WINDOW/AMBIGUOUS_SAME_CANDLE/DATA_UNAVAILABLE.
// Prior .4 — hotfix30: fixPHASELOG (real bug, found via user's uploaded
// ledger/bybit_ledger/shadow_signals export — 9/15 signals never reached Bybit but ZERO
// PHASE0_TRACE/PHASE1_SHADOW rows existed in any export to explain why). Root cause: those two log
// types were only going into the shared 1000-row trade-log, evicted within a session by busy tags
// like BREADTH_FIGHT_SHADOW (1972 rows alone in one export). Fix: durable phase_trace.ndjson store
// (8000-line cap, same pattern as shadow_signals) + new GET /api/v4/phase-trace export route.
// Prior .3 — hotfix29: fixPHASE1 (SHADOW ONLY, zero trading-behavior
// change) — decideLiveEntry() pulls the knife-check/hadFirstTouch-or-firsttouch/maxOpenTrades/
// sentinel-blind checks (currently duplicated across 3 live-entry gates) into ONE pure function.
// phase1ShadowTrace() logs its verdict vs what ACTUALLY happened (paper/live) into the same
// [trade-log] stream every tick, throttled. Does NOT replace any of the 3 existing gates — purely
// observational, gathers real agreement/divergence data before ever promoting this to be the actual
// gate. See orayan-standing-rules Phase 1 plan.
// Prior .2 — hotfix28: fixPHASE0 (structured single-line live-entry
// decision trace — hadFirstTouch/knife-check/maxOpenTrades/sentinel-blind/outcome all in one
// [trade-log] row, wired into all 3 live-entry decision chains) + fixPHASE2 (analyzeExpiredOpportunityCost
// — walks Bybit's own public klines forward from each EXPIRED signal's entry to check if TP/SL would
// have hit first, real $ estimate via the signal's own netTpUSDT/netSlUSDT; new route GET
// /api/v4/expired-analysis; excludes SKHYUSDT/SKHYNIXUSDT/SOXSUSDT — confirmed non-crypto TradFi).
// Prior .1 — fixORTRIGGER: real ledger proof (FARTCOIN, then AAVE + NEAR
// under this same .9.0 build) that paper and live still diverge at the entry moment even after fixRETEST.
// Paper activates on ANY confirmed directional reaction (first touch or second); live's execution hook
// required a genuine SECOND touch (hadFirstTouch) specifically — so a first-touch-only confirmation can
// fully win or lose on paper while NEVER reaching Bybit at all, for hours, with zero record of an
// attempt. Widened the activation-moment live hook to also fire on a first-touch confirmation, guarded
// by the SAME candle-momentum check fixKNIFEGUARD already uses (reused, not reinvented) so a first touch
// that's actually a knife still gets withheld. The existing hadFirstTouch path is completely unchanged —
// this only closes the gap for signals that previously got no live shot at all. Order still places as a
// LIMIT (FIXCONFIRM_ENTRY_MARKET unchanged, currently false) — does not reintroduce the market-chase lag
// fixCONFIRMREVERT (.94) fixed. Reversible: V4_FIRSTTOUCH_LIVE_ENABLED=false restores the exact prior
// hadFirstTouch-only requirement.
// Prior .99 deliberately skipped per user's explicit request (consistent with the
// project's existing digit-sum-9 skip convention). NEW in 4.6.9.0 — TWO fixes, both v4Brain.js only,
// same "choose the correct side accurately" objective as .98's fixEUPHADX but broader scope.
// (1) fixVWAP: a genuinely independent 4th fast-TF direction vote (rolling 20-bar 15m VWAP vs price) —
// see calcVWAP() and its call site in coinTrendEngine for the full reasoning. Deliberately folded into
// the EXISTING up/dn vote count and capped at the SAME strength ceiling of 4 that's been live and tuned
// across a dozen hotfixes — this widens which evidence COMBINATIONS can reach that ceiling, it does not
// raise the ceiling or create a parallel scale. User explicitly ruled out 200 EMA (too slow for this
// timeframe) and Supertrend (laggy) for this fix — VWAP was the specific addition requested, scoped as
// one more voice in the direction vote, not a tiebreaker with override power over ADX or the EMA votes.
// (2) fixMOVERLANE: root-caused the "same 30-40 coins" complaint directly from the scan code — the
// universe was a hard rank-and-slice by 24h $ volume (top 80), so a coin ranked 81st+ never enters the
// pipeline regardless of setup quality, and volume ranking is sticky day to day (same top names
// dominate). Adds a small bounded second lane: up to V4_MOVER_LANE_SIZE (default 15) symbols by
// absolute 24h % move that aren't already in the volume-ranked universe, reusing the same already-
// fetched tickers array (zero new network calls to build the list). Tagged leader.moverLane=true for
// auditability. Every existing gate still applies unchanged to these symbols — this only affects
// whether they're EVALUATED, never whether they're ADMITTED. Kept deliberately small to avoid
// reintroducing the CPU-saturation problem fixLOOP (hotfix 22) fixed. Both reversible:
// V4_MOVER_LANE_SIZE=0 restores the old volume-only universe; VWAP's contribution can't be disabled
// independently of the vote it's folded into (by design — it's meant to just be one more vote, not a
// separately toggleable subsystem), but PCT_ENABLED=false still turns off the whole coinTrend engine.
// Prior .98 — fixEUPHADX: user's explicit ask (07/28 chat) — EUPH_GUARD's
// flat 0.75x dampener at absolute breadth euphoria/capitulation can't distinguish the validated trap
// majority (07/03 autopsy: 22% WR) from a genuinely strong coin that's just moving inside that zone.
// Added calcADX() (Wilder ADX14, reuses the 15m candles coinTrendEngine already fetches — zero new I/O),
// exposed as coinTrend.adx15. applyPerCoinTrend now restores a euphGuard-dampened leader to its
// PRE-dampening score (un-rejecting it if score alone had blocked it) when fresh coinTrend agrees WITH
// the trade side AND adx15 clears EUPH_ADX_MIN (default 25, textbook Wilder trending floor — not yet
// tuned to this system's own data since no live sample exists). Every other gate (RR, netTP, timing,
// dead-hour, bottom-guard, max-open) still applies untouched afterward. User explicitly ruled out 200 EMA
// (too slow for this timeframe), VWAP and Supertrend (laggy) for this fix — ADX was the one addition
// requested: a trend-STRENGTH gauge to sit alongside the existing EMA20/50 direction vote, not a new
// direction source. Both-sides symmetric. Reversible: V4_EUPH_ADX_PROMOTE_ENABLED=false.
// Prior .97 — TWO fixes, both v4Brain.js only.
// (1) fixKNIFEGUARD: fixRETEST (.95/.96) places the live GTC limit on hadFirstTouch alone, deliberately
// skipping timing.directional/fixHOLD to avoid stale-price lag (see the fixRETEST comment above the
// placement block). Live 07/27-07/28 ledger showed the cost: 4 of 14 real closes died under 4min, 0% WR,
// -0.999U combined (LAUSDT/UBUSDT/ZAMAUSDT/1000PEPEUSDT) — a genuine second-touch retest firing while the
// prior 1m candle was still printing hard momentum AGAINST the trade (a knife, not a bounce). Fix adds ONE
// cheap check right at the retest placement site, using the 1m candle enrichOpenSignalMarketMap ALREADY
// fetches every tick for this exact symbol set (zero new fetches, zero added latency) — if the last
// COMPLETED 1m candle's body is large (>= V4_KNIFE_BODY_ATR of the signal's own ATR) and closes AGAINST
// the trade direction, the retest placement is withheld this tick only (not cancelled — s._autoTraded
// stays false, next tick re-checks with a fresh candle). Both-sides symmetric. Reversible:
// V4_KNIFE_BODY_ATR=0 disables (any value <=0 skips the check entirely).
// (2) fixTPREACH: shadow log data (BREADTH_FIGHT_SHADOW, 1818 rows) showed continuation-entry leaders
// (leader.continuationEntry === side, i.e. coinTrend strength>=PCT_STRONG riding an established trend)
// getting RR as low as 0.02-0.78 (BANKUSDT, TAOUSDT) even though the coin trend read was correctly strong
// — because tp1 always targets the NEAREST swing high/low (detectSwings), and a trend that's already
// blown through nearby structure leaves almost no room to the next one. resistance2/support2 (the
// SECOND swing level) were already computed but never used for TP. Fix: for a continuation-entry leader
// only, if the nearest-swing TP gives RR below V4_TPREACH_MIN_RR (default 1.2) and the second swing level
// is further out and still valid, use it instead — still passes through the existing ATR cap
// (maxTargetDistance) a few lines below unchanged, so this cannot create an unbounded target. Both-sides
// symmetric. Reversible: V4_TPREACH_ENABLED=false.
// Prior .96 — fixRETEST-GAP: a THIRD live-order call site was missed when
// .95 shipped fixRETEST. It fires immediately at signal CREATION for a signal that's already PAPER_ACTIVE
// the instant the planner builds it (price already past the zone with reaction at birth) — a completely
// separate code path from the two sites .95 gated (both live inside updateExistingSignals, the per-tick
// loop). This one wasn't caught by the grep used to find the other two because it uses a differently-named
// loop variable (`sig`, not `s`) and a differently-shaped condition. CONFIRMED live 07/26 on LPTUSDT: its
// log trail (PLACE_ATTEMPT/ENTRY_SMART_LIMIT/LIVE_PLACED) is unmistakably the OLD executeSignal→
// buildExecutionPlan smart-limit-nudge path — the exact CHILLGUYUSDT-class entry-drift mechanism .94/.95
// were built to stop, never fixRETEST's placeLimitAtEntry. Root cause: a signal born already-active has,
// by construction, zero retest history — sig.hadFirstTouch can never be true for a brand-new signal, since
// that flag is only ever set incrementally inside signalEntryTiming during the WAITING period this signal
// skipped entirely by being born already confirmed. FIX: gated this site on sig.hadFirstTouch too, same as
// the other two — correctly disables the whole pathway (a fresh signal can never satisfy it) rather than
// leaving it as a silent gap. Paper unaffected — sig.paperState stays PAPER_ACTIVE and simulates normally;
// only the live order never fires for this birth-confirmed case. Full sweep re-run across every lib/routes
// file this time (not just the one grep pattern that missed this originally) — confirms these are the
// ONLY 3 automated live-order sites in the codebase; the 2 remaining executeSignal call sites (routes/
// bot.js, routes/bybit.js) are manual/API-triggered, not automated confirmation-based firing, and are
// correctly exempt from this gate by design. Prior .95 — user-directed redesign replacing the whole 07/26
// chase/nudge/stretch patch chain (fixANCHOR, fixANCHORRR, fixRISKCAP widening, fixCONFIRM's smart-limit
// nudge) with removal of their shared root cause — acting on a "confirmed" price that's already stale by
// the time the bot notices it. Two changes: (1) a new resting-limit trigger fires the instant a signal
// shows a GENUINE retest in progress (s.hadFirstTouch — price touched the zone once, left, and a second
// touch is anticipated; the same evidence fix44f already treats as higher-conviction) — independent of
// timing.directional/the fixHOLD 40s hold-timer, which answers a different question (confirming a fill
// after the fact, not placing an order that waits for the touch). Places a GTC limit at the exact
// structural signal.entry via placeLimitAtEntry (dormant since hotfix21b, unmodified) — Bybit's own book
// fills it the instant price arrives, so the fill price IS the planned price by construction; RR cannot
// shrink regardless of how long the retest takes. Deliberately excludes missed-move-breakout confirmations
// (timing.missedMove) — no retest to rest a limit at when price ran away with no pullback, and missed-move
// was the single biggest source of 07/26's chase-driven RR damage (ORDIUSDT/LAUSDT/1000BONKUSDT/BEATUSDT/
// EULUSDT/VVVUSDT all trace to it); paper still simulates it for comparison, live no longer trades it. The
// existing directional-confirmed live-order hooks (fix57, fix44b) are now gated the same way (hadFirstTouch
// && !missedMove) as a defense-in-depth backstop only — in the normal case the resting order is already out
// by the time directional confirms, so they're a no-op. Fixed a message that used to unconditionally claim
// "order working on Bybit" even when withheld for a first-touch-only or missed-move signal. (2) new
// restingOrderWatch() — a tight (10s, V4_RESTING_WATCH_MS) cadence that re-runs the EXISTING SL-breach +
// revalidateWaitingSignal() checks (unmodified) but only for the small subset of signals currently carrying
// a resting order — cheap (a few ticker fetches, bounded by maxOpenTrades), nothing like the 529-pair sweep
// that caused the original fixLOOP overload; cancellation reuses flagTradeForCancel()/the reconciler's
// existing PENDING-order handling (fix49h(H1)), no new cancellation path. KNOWN TRADE-OFF, same as .94:
// trades that never show a genuine retest (pure first-touch confirmations, missed-move breakouts) are no
// longer traded live at all — deliberate, per user: fewer trades at real 2:1, precisely filled, over more
// trades chased at degraded RR. Paper is completely unaffected — its own PAPER_ACTIVE transition logic and
// missed-move simulation are untouched; only the LIVE order-placement decision changed. Prior .94 — fixCONFIRMREVERT: FIXCONFIRM_ENTRY_MARKET flipped true→false (see comment at its declaration ~line 60) — confirmed entries route back through the limit-at-structural-zone path instead of market-on-confirmation, after live 07/26 proved market fills chasing past the zone collapse dollar RR toward 1:1 even though signal RR stays 2:1+ (fixRISKCAP widens risk-side sizing on a chased fill; reward stayed fixed at the original distance). User's explicit call: for a scalping strategy sized off real S/R, skip a chased setup rather than chase it or stretch the target past real resistance. Also exported getConfigFlags() so /health can report the live FIXCONFIRM_ENTRY_MARKET value directly — this flag only takes effect inside trade-execution hooks gated on tradingEnabled=true, so a dry/warmup run with trading OFF produces no logs either way; /health is now the only way to confirm a deploy took effect during a warmup. Prior .93 — fixTRUTHPERM: "Bybit Truth" was re-deriving its 4 headline stats from up to 1500 raw ndjson event rows on EVERY refresh, fetched over the phone link each time. Two real problems, both fixed by one change: (1) at 100+ partial-fill orders, that row window can slide far enough that an already-closed trade's own close row falls OUT of the slice, and the trade silently vanishes from every stat (confirmed live: n dropped 50->49 with a real win disappearing between two sessions that only ever added trades); (2) genuinely heavy for numbers that change 2-3 times an hour. New getBybitTruthSummary()/recordBybitTruthResults() mirror the existing pnl_permanent pattern (getPermanentSummary/recordPermanentResults) exactly: a small persisted bybit_truth_permanent object, folded idempotently ("count once, ever" via a seen-id guard) from a bounded 500-row tail — a trade counted here can never be un-counted by a window sliding past it again, and repeat calls with no new closes do near-zero work. New route GET /api/v4/bybit-truth-summary returns this directly; frontend updated to call it instead of the old client-side 1500-row fetch+rerank. Prior .92 — fix48z2: dedupeLiveSignals orphan-duplicate fix. runs at the TOP of scanOnce, BEFORE updateExistingSignals' age/expiry check. A WAITING duplicate displaced by a fresher same-symbol+side candidate was silently OMITTED from the output list — never marked EXPIRED, invisible to the per-scan expiry check that runs later this same cycle on that list. It just sat orphaned in the persistent store. Real case: USUSDT/OUSDT survived 68/106 minutes past their own 30-min window — only caught by the next restart's unconditional full-store purge, which bypasses this dedupe filter entirely. Fix: a displaced NON-order-bearing duplicate is now explicitly finalized as EXPIRED right here (logged, resolved same cycle) instead of silently dropped. Order-bearing signals (tradeId/orderId/LIVE_RESTING/LIVE_OPEN/LIVE_PENDING) are never touched by this branch — same rule used everywhere else in this file. Prior .91 — fix48i-TRAIL: REGIME_FLIP_EXIT was closing EVERY active position on a newly-blocked side unconditionally, whether losing or winning. Real case: BANKUSDT SELL at +1.03R heading to a 2.27R/~0.567U TP got force-closed at market on a CHOP->BULL flip, capturing only +0.258U. Original fix48i data (PENGU: 83min post-flip, bled to full SL) justified protecting LOSING/marginal positions — it never justified truncating WINNERS. Now branches on rAtExit at the moment of the flip: below V4_REGIME_FLIP_TRAIL_MIN_R (default 0.5) -> UNCHANGED hard close (the validated case). At/above it -> position is NOT closed; SL is tightened to lock exactly that R floor (REGIME_FLIP_TRAIL, only ever tightens, never loosens) and the position keeps ticking toward its ORIGINAL TP. If a live Bybit position exists (s.tradeId), the real stop is also moved via executor.setTradingStopSafe (fail-open, logged on failure — never crashes the tick loop). Both-sides symmetric (same rAtExit sign convention as the original fix48i). Reversible: V4_REGIME_FLIP_TRAIL_MIN_R set very high (e.g. 999) fully restores old always-hard-close behavior. Prior .90 — fixPCT SHADOW bugfix. .89's BREADTH_FIGHT_SHADOW logged entry=undefined/sl=undefined/tp=undefined. Root cause: leader.entry/sl/tp1 only exist at the TOP level for the contrarian-flip special case (leader.entry = ... at L2140/2205) — every normal leader carries them nested under leader.plan.{entry,sl,tp1} (the plan object built at L2050, spread into leader.plan). The shadow block read the wrong path. Fixed: reads leader.plan.entry/sl/tp1. score+rr were already correct (leader.score, leader.math.rr are real top-level fields) — only entry/sl/tp1 were broken. No other logic changed vs .89. live data (24h, breadth pinned 20-28%) showed strong per-coin BUY leaders (f4leaders 5-9/scan) dying to BREADTH_FIGHT_BUY_xxPCT_LE_50 (fix49o), NOT score — a gate fork-A correctly never touches, because unlike score (r=-0.07, no value) BREADTH_FIGHT is DATA-VALIDATED (191-trade pooled: buying <50% breadth measured 33-0% WR). RECORD-ONLY: a leader rejected solely by BREADTH_FIGHT that already carries a pullback continuationEntry on its side gets its would-be entry/sl/tp1/rr + coin trend read logged (BREADTH_FIGHT_SHADOW) and stamped (leader.breadthFightShadow, breadthFightShadowAtBirth) — leader.rejected/gate.ok/rejectReasons are NEVER mutated by this block, zero trading-behavior change vs .88. Both-sides symmetric (BUY<=50 / SELL>=50, same continuationEntry+withSide test). PCT_SCAN gains breadthFightShadow=N. Purpose: gather real outcome data on whether a strong per-coin pullback trend beats the validated breadth floor BEFORE any future gate touches it. Reversible: V4_PCT_SHADOW_ENABLED=false. Prior .88 — fixPCT fork-A: SCORE-GATE BYPASS for a strong pullback continuation leader. Live PCT_SCAN proved strong per-coin F4 leaders form but die at the score gate (SCORE_LT killed 6 of 9/scan), not regime. Score has no proven trade-quality value (r=-0.07, 537 trades — standing rule), so for a coin that already earned a pullback continuation entry on its side (leader.continuationEntry === side, which itself requires coinTrend strength>=PCT_STRONG + bias-agreeing + pullback enabled) applyPerCoinTrend now strips ONLY the SCORE_LT reason: if score was the sole blocker it admits; if regime also blocks, the score-free reason set falls into the existing withSide override. EVERY other gate still applies (RR, netTP, maxTpAtr, entry-timing, dead-hour, bottom-guard, max-open). Both-sides symmetric (BUY-strong-in-bear / SELL-strong-in-bull, same continuationEntry/withSide test). Scan-loop only (ingestCandidate/retry path keeps its gate — scan runs every cycle). Observability: PCT_SCAN adds scoreBypass=N; PERCOIN_SCORE_BYPASS log line per waive; perCoinScoreBypassAtBirth in birth diag. Reversible: V4_PCT_SCORE_BYPASS=false (default true). Precondition V4_PCT_PULLBACK_ENABLED=true (off => continuationEntry null => bypass never fires). Prior .87 — fixPCT option B: OBSERVABILITY + LOAD CAP. (1) per-scan PCT_SCAN log line (only when fresh-move activity exists) shows fresh=/fetched=/strong=/f4leaders=/overrides=/conflicts= + strongBlocks: the reason strong fresh-move coins didn't trade (e.g. the 85 score gate) — so the engine is VISIBLE instead of silent, and we can see WHY nothing fires in a hostile tape without guessing. (2) V4_PCT_MAX_FETCH (default 40) caps coinTrend fetches per scan so a fresh-move-heavy bear can't saturate the 0.2 vCPU box (capped coins just miss the vote that scan, fail-open). No trading-behavior change vs .86 — this is instrumentation + a safety cap only. KNOWN (deferred by user to a fresh chat): the strength≥3 override still cannot bypass the 85 BUY score gate, so counter-regime longs still won't fire in a deep bear — that's the next fork (A), intentionally NOT built here. Prior .86 — fixPCT Phase 1.5 + 2. (1.5) VOTE — coinTrendEngine's strong 1m/3m/5m/15m read now casts a 4th direction vote (F4) in determineDirection, GUARDED against F3 double-count, so a FRESH pump (5m+15m up, 1h still lagging bear) can form a BUY leader the 1h-gated F3 misses — the piece that lets the DEXE case actually reach the Phase-1 override. Fetched only for "fresh-move" coins (5m+15m agree, 1h unconfirmed) → tightly bounded, cached 45s, fail-open. (2) PULLBACK — a continuation leader (side agrees with a strong coin trend) gets a shallow entry (V4_PCT_PULLBACK_ATR=0.3 vs default 0.6 ATR) so a runner fills on a small dip-and-resume instead of waiting for a deep reversal that never comes (fixes 'misses the runner'); SL/TP geometry + all downstream gates unchanged. Both stamped in birth diag (continuationEntryAtBirth, directionReasonsAtBirth incl. F4). Reversible: V4_PCT_VOTE_ENABLED / V4_PCT_PULLBACK_ENABLED / V4_PCT_PULLBACK_ATR. Composes with .85: vote FORMS the leader → override ADMITS it past regime → shallow entry FILLS it well. Prior .85 — fixPCT Phase 1: PER-COIN MULTI-TF TREND BRAIN. Root cause of the 07/24 8-hour freeze: in a bear regime the bot wants SELL-only, and the ONLY counter-regime rescue (fix49k breadthOverrideSide) keyed on MARKET-WIDE breadth, never the coin — so DEXE +97% stayed hard-blocked because market breadth read bearish. New coinTrendEngine() reads the COIN's OWN trend on 1m/3m/5m/15m (drops the lagging 1h that made fresh pumps read 'bear'; anchor=15m, bias needs 15m + >=2 of {1m,3m,5m}, strength 3=15m+2fast / 4=15m+3fast). applyPerCoinTrend() runs after shouldReject, BOTH sides symmetric: (1) OVERRIDE — a regime-blocked side is admitted if the coin trend is STRONG that way (the unfreeze + DEXE-long fix); (2) CONFLICT — a would-be-admitted trade that fights a strong coin trend is rejected (stop the knife-catch). Bounded fetch (only regime-blocked OR about-to-admit leaders → small subset/scan, no fixLOOP regression); fail-open (error → strength 0 → behaves like .84). Flip is SHADOW only (diag.flipShadowAtBirth). All trend TFs + strength + bias + cross + override/conflict stamped in birth diag. Reversible: V4_PCT_ENABLED=false (all off), V4_PCT_CONFLICT_ENABLED=false (keep unfreeze, drop the reject), V4_PCT_STRONG (default 3). Phase 2 (next): pullback-inside-trend continuation entry rides this read. Prior .84 — hotfix 23 fixHOLD: the live entry gate (inZone && directional) fired on `directional` = a single INTRATICK price dip of ~0.10 ATR — a noise wick in a bounce — so shorts fired on the wick then got popped through the stop (KAITO/OUSDT/BILL 07/24 stopped by 1.1-1.9% adverse pops, timing reason still 'waiting for candle confirmation' while the order had ALREADY fired). Root proven from ledger history: signals went WAITING→LIVE_PENDING_FILL with directional:false/reactionScore low. Fix: require the reaction to HOLD across a window (V4_DIRECTIONAL_HOLD_MS=40s) before it confirms; a wick that reverses inside the window never fires. Momentum breakouts exempt. Prior .83 — // NEW in .83 — hotfix 22: (a) fixLOOP — the scan fetched klines for ~529 pairs ONE AT A TIME every sweep (uncached), 500-1000 serial Bybit calls that saturated the 0.2-vCPU box: sentinel hit its 90s watchdog, price feed went 307s stale, UI lost the backend, and confirmed orders filled seconds late. Now: short-TTL kline cache + bounded-parallel PREFETCH (conc 10) warms it before the sequential build loop + setImmediate yield every 40 pairs. Sweep goes from serial-minutes to parallel-seconds; trade logic + what-gets-scanned UNCHANGED. (b) fixANCHOR (executor.js) — market-on-confirmation fills late, but TP was zone-anchored, so winners closed for scratch (REUSDT 07/24: short before a 7% drop, +0.04 because TP was 0.49% from fill). Now TP shifts to preserve intended reward DISTANCE from the ACTUAL fill; structural SL kept; skip if fill so late RR<0.6. Reversible: V4_ANCHOR_TP_TO_FILL, V4_KLINE_CACHE_MS, V4_PREFETCH_CONCURRENCY. NEW in .82 — fixCONFIRM (hotfix 21b): killed the blind birth-time resting limit (fix49c) — the LIVE knife-catch that filled on the raw first touch with no confirmation. Confirmed-entry hooks are now the SOLE live entry: they enter at MARKET on confirmation (FIXCONFIRM_ENTRY_MARKET — audited: a limit lands back at the zone ~0.10 ATR above the confirmed price, so it misses the clean runners and undershoots paper's count; market replicates paper's confirmed selection). Fire only after a fresh in-direction reaction (signalEntryTiming.directional) + all ENTRY_TIMING blocks pass. Both-sides symmetric (placement removal, not a directional gate). Reversible via FIXCONFIRM_BLIND_BIRTH_LIMIT. Prior .80 — fixRSI (ROOT CAUSE): rsiAtEntry was 100% null because leader.rsi (per-coin RSI-14/5m from marketBrain) was never threaded onto the stored signal; every prior 'fix' patched the READ side with fallback fields that never existed. Now captured at birth (_birthDiag.rsiAtEntry), threaded onto the signal return object + the contrarian-flip child, and the activation read preserves the birth value instead of clobbering to null. btcRsiAtEntry captured as mirror. fixSHADOW (RECORDING ONLY, acts on nothing): diag.rangeTrapShadow (SELL @ range-pctile<=15 ~15%WR z=-2.43 replicated OOS; BUY mirror @ >=85 weak-evidence) + diag.deadHourShadow (LK03-04 = only hours <=0 gross edge, net-negative once market-SL taker+slippage lands; 67-77% losers concentrate the cost) — both scoreable live before any future gate. .79 reserved for undeployed V79/fixSPRING. (Prior:) FULL ROADMAP BUILD (supersedes .74 zip; .72 skipped per digit-sum-9 rule). Carries: fixDEADHOUR (multi-window LK dead-hour block: birth+purge+fill, default 00:00-05:30 via V4_DEAD_WINDOWS_LK), fixSTRUCT+fixSWEEP (.71 rebased — see structureDetector/sweepEngine + buildStructurePlan sweep relocation), flip-chip display fix, ledger staleCancelled/flipped/accounted buckets. NEW in .75: (1) preset system fully removed — experimentPresetMode hardcoded 'research' (config.js clamp, frontend dropdown/buttons deleted, single RESEARCH_DEFAULTS for the reset button); (2) GET /api/v4/alerts — persistent alert feed DERIVED from ledger at read time (no second store to sync; closes "alerts disappear" = per-device localStorage), frontend merges it with key-dedupe; (3) sentinel-strip vanish fixed — restore call site read bare `_sentinelData` (undeclared until first fetch → ReferenceError swallowed by caller's try/catch → strip wiped every 2s render, repopulated only each 5-min sentinel poll); now explicit window.* + try/catch + fetch fallback; (4) equity curve — /api/v4/balance pipeline existed since fix49 but nothing rendered it AND nothing fed it in paper mode; added journal-tab SVG chart + backend hourly paper-equity self-snapshot (V4_PAPER_START_BALANCE + fix52 permanent net, paper modes only — live keeps wallet-poll as sole author); (5) legacy renderJournal gutted to stub (targeted #journalBody/#jTrades DOM deleted long ago — pure dead code). STALE-MEMORY ITEMS VERIFIED ALREADY FIXED, NO CHANGE: executor TICK_GAP log (fix49f), frontend version display (snap.version override), alerts flicker (renderKey guard). NEW in .76 — fixEUPH: absolute-breadth exhaustion dampener (BUY @ bull_pct>=74 / SELL @ <=26, score x0.75, DEFAULT ON, env V4_EUPH_*), complementary to fixBOTTOM's range-percentile which is blind when the trailing range compresses at absolute highs (07/03 autopsy: LK11-17 ~1W/11L chasing the blow-off; >=74 cohort 22% WR negative expectancy). BTC-RSI mid-leg chase shadow-logged (0/6, too thin to act). absBreadthAtEntry/btcRsiAtBirth/euphGuard always captured in birth diag. NEW in .77 — fixFADE: counter-trend fade SHADOW module (fadeModule.js) — for candidates inside the euphoria(BUY@>=74)/despair(SELL@<=26) zone, stamps a would-be OPPOSITE-side trade with a FRESH 2:1 bracket (recomputed at fade entry, NOT an inherited flip — a raw flip is -EV due to the momentum trade's ~1:2.3 RR asymmetry) into diag.fadeShadow; acts on nothing, scored offline vs the mirror candidate's mfeR/maeR. Euphoria side = weak-positive 4-session excursion sim (+0.20R @2:1 pessimistic, +0.38R w/ RSI-rollover); despair side = ZERO historical samples (brain never bought <=26), pure data-collection, confidence hard-capped + tagged UNVALIDATED_ZERO_SAMPLE. Zone reuses EUPH_BREADTH_HI/LO (no drift); tunables V4_FADE_* (TP_R=2.0/SL_R=1.0/RSI_PEAK=70/RSI_TROUGH=30). breadthRangePctile() now also exposes btcRsiHi/btcRsiLo (trailing RSI max/min, same window read) for rollover. fixFADE dead-hour un-censor: DEFAULT_DEAD_WINDOWS_LK 00:00-05:30 → 04:00-04:03 3-min stub — the old block censored its own evidence (blocked sessions logged zero dead-hour trades → biased 37%WR sample); stub keeps function+cancellation warm while gathering a clean sample. Re-widen via env at >=800 trades.
// fixBOTTOM (4.6.8.68, carried forward): breadth range-percentile guard + Direction Brain advisory shadow. FINDING (4-session walk-forward, Jul 2026): SELL entered while market breadth sits in the BOTTOM 15% of its own trailing 6h range = 16-27% WR vs ~50% baseline (z=-2.43; held in all 3 sessions with bottom-zone entries; robust at 4h/6h/12h lookbacks). Breadth LEVEL (<25%) conflated two opposite situations — at 22% breadth, range-TOP = mature relief rally (the old 83% cohort) while range-BOTTOM = shorting the exhaustion low right before the snap-back (the bloodbath). Position-in-range separates them; level cannot. THIS FIX: (1) breadthRangePctile() — cached 60s, reads breadth_history.ndjson tail (same fix49p/breadthChop pattern), returns current bull_pct's percentile within trailing V4_BOTTOM_WINDOW_MIN (default 360min); fail-open null below 30 samples. (2) Soft conviction dampen at the fixADAPT seam, flag V4_BOTTOM_GUARD_ENABLED (default OFF): SELL @ pctile<=15 or BUY @ pctile>=85 (symmetric; BUY mirror is weak-evidence n=18 but directionally consistent 44% vs 65% — documented) -> score x V4_BOTTOM_CONV_MULT (default 0.75). Flip children exempt. NOT a block. (3) breadthRangePctileAtEntry captured in diag ALWAYS (birth + fill, fixMICRO2 pattern). (4) NEW lib/directionBrain.js — advisory SHADOW only: verdict+confidence stamped to diag.dirBrainAdvice at birth from validated inputs (breadth pctile dominant, BTC-RSI-panic secondary, funding divergence recorded at ZERO weight pending validation); acts on nothing; scoreable offline against resolved outcomes. // fixMICRO2 (4.6.8.67): birth-time funding/OI capture fallback.
// fix49k: (K) BREADTH-OVERRIDE both sides, in-brain (env var REMOVED). BREADTH_OVERRIDE_ENABLED=true default ON (paper testing), killable via settings.breadthOverride=false. SYMMETRIC: BUY-rescue when breadth>=70% bull but BTC label BEAR (unblock + neutralize counter-trend penalty); SELL-rescue when breadth<=30% bull but BTC label BULL (mirror). Both unblock in btcRegimeDecision AND neutralize penalty in convictionScore. Tagged breadthOverrideApplied='BUY'|'SELL'. Removes a safety gate on BOTH sides — paper-only until validated. Replaces 49j BUY-only env experiment. HARD RULE going forward: directional fixes built both-sides same patch.
// fix49j: (J) BREADTH-OVERRIDE-BUY — EXPERIMENT, default OFF (V4_BREADTH_OVERRIDE_BUY=true to arm). Tests "breadth supersedes regime" on the BUY side: when breadth >= V4_BREADTH_OVERRIDE_PCT (default 70% bull) but BTC regime label is bear, a BUY is normally hard-blocked (btcRegimeDecision) AND score-penalized (convictionScore opposed-branch). With the toggle ON, breadth-aligned BUYs are (1) NOT hard-blocked and (2) regime penalty NEUTRALIZED to 0.90 — penalty removed, NO bonus added. Every affected trade tagged breadthOverrideBuyApplied=true for isolated analysis. Mirror of the H2 SELL gate. Does NOT touch NO_DIRECTION (family-vote) gating upstream — sample will be thin. Carries 49i zombie-purge + exhaustion tag, 49h H1/H2/H3.
// fix49i: (Z) zombie purge — orphan-state signals (paperState in neither ACTIVE nor FINAL) sliced past MAX_SIGNALS by dedupeLiveSignals became invisible to getSignals(), so the fix48q orphan-cancel never matched them → cancel button returned SIGNAL_NOT_FOUND_OR_TERMINAL. Now: getSignals force-expires orphan-state rows (same as stale-waiting), and dedupe keeps non-final rows before slicing so they can't be stranded. (X) exhaustionScore — READ-ONLY diagnostic tag (0-3: btcRSI>=80, regimeStrength>=0.9, funding<0) + raw components captured per signal. No gate, no behavior change — collecting the exhaustion-vs-outcome dataset for when the regime turns bear (current 92hr sample is 100% bull, 0 SELL — cannot validate a threshold yet). Carries 49h H1/H2/H3.
// fix49h: (H1) invalidated/expired WAITING signals now CANCEL their resting Bybit limit (2/6 live losses on 06/10 were dead setups filling); authority WAITING no longer blocks pre-entry safety checks; paper can no longer self-activate a signal with a resting live order — ACTIVE means FILLED. (H2) breadth-fighting gate: hard-block BUY at breadth<=30% bull / SELL at >=70% (n=196: fighting cohort 38% WR, +0.05U/trade). (H3) fresh-regime neutralization: direction-crossing sentinel flip <2h old → aligned side gets neutral 0.90 regimeMult, no bonus (06/10 evening: BUYs scored 81-98 off a 3-hour-old bounce label, 2W/4L live). Carries 49g authority-on-tradeId + 49a contextWeighting OFF.

// fix48v: latest market-wide Fear&Greed (0-100). Frontend sends it in the candidate payload;
// cached here so convictionScore (planner + ingest paths) can read it. null => fear leg no-ops.
let _lastKnownFng = null;
const SCORE_A_PLUS = Math.max(80, Number(process.env.V4_SCORE_A_PLUS || '90'));
const SCORE_A = Math.max(70, Number(process.env.V4_SCORE_A || '84'));
const SCORE_B = Math.max(60, Number(process.env.V4_SCORE_B || '80'));
// fix48b: DEAD CONSTS — MAX_SCORE_* caps were the root cause of the 78/70 scoring bug.
// convictionScore (fix48) uses no caps. These consts are kept only to avoid env-var parse errors
// if they're set in Northflank. They are NOT read by any scoring code.
const MAX_SCORE_WITH_RISK = Math.max(70, Number(process.env.V4_MAX_SCORE_WITH_RISK || '82'));
const MAX_SCORE_IF_ENTRY_FAR_ATR = Math.max(60, Number(process.env.V4_MAX_SCORE_IF_ENTRY_FAR_ATR || '70')); // DEAD — not used in fix48
const MAX_SCORE_IF_NO_FULL_TREND = Math.max(60, Number(process.env.V4_MAX_SCORE_IF_NO_FULL_TREND || '70')); // DEAD — not used in fix48
const MIN_SL_DISTANCE_PCT = Math.max(0, Number(process.env.V4_MIN_SL_DISTANCE_PCT || '0.50')); // fix37: raised 0.25→0.50; SL<0.5% had 30% WR, noise stops bleeding -1U
// fix30: REJECT_MIXED_BTC_REGIME module const removed — dead code. Runtime always uses config.rejectMixedBtcRegime (default=false per config.js DEFAULTS). Old default 'true' contradicted config.
const REJECT_MILD_EXTENSION = String(process.env.V4_REJECT_MILD_EXTENSION || 'true').toLowerCase() !== 'false';
const REJECT_MOMENTUM_CONFLICT = String(process.env.V4_REJECT_MOMENTUM_CONFLICT || 'true').toLowerCase() !== 'false';
const ENTRY_CONFIRMATION_REQUIRED = String(process.env.V4_ENTRY_CONFIRMATION_REQUIRED || 'true').toLowerCase() !== 'false';
const ELLIOTT_WAVE_FILTER = String(process.env.V4_ELLIOTT_WAVE_FILTER || 'true').toLowerCase() !== 'false'; // fix48b: DEAD — was used by elliottWaveContext (deprecated). Kept for env-var compat.
const REJECT_ELLIOTT_CONFLICT = String(process.env.V4_REJECT_ELLIOTT_CONFLICT || 'true').toLowerCase() !== 'false';
// FIX21: Cluster loss cooldown tuning.
// Old: 2 losses in 30min → block for 30min. Too aggressive — blocked good setups in recovery.
// New: 3 losses in 30min → block for 20min. Still protective but allows faster resumption.
const CLUSTER_LOSS_COUNT = Math.max(1, parseInt(process.env.V4_CLUSTER_LOSS_COUNT || '3', 10));
const CLUSTER_LOSS_WINDOW_MS = Math.max(1, Number(process.env.V4_CLUSTER_LOSS_WINDOW_MINUTES || '30')) * 60 * 1000;
const CLUSTER_LOSS_COOLDOWN_MS = Math.max(1, Number(process.env.V4_CLUSTER_LOSS_COOLDOWN_MINUTES || '20')) * 60 * 1000;
const SYMBOL_LOSS_LOCKOUT_MS = Math.max(1, Number(process.env.V4_SYMBOL_LOSS_LOCKOUT_MINUTES || '240')) * 60 * 1000; // fix34: raised 45->240min
const SYMBOL_SESSION_LOCKOUT_LOSSES = Math.max(1, parseInt(process.env.V4_SYMBOL_SESSION_LOCKOUT_LOSSES || '3', 10)); // fix43: raised 2→3; 2 losses locking for 4hrs was too aggressive — 5 pairs locked simultaneously

const SYMBOL_WIN_COOLDOWN_MS = Math.max(1, Number(process.env.V4_SYMBOL_WIN_COOLDOWN_MINUTES || '20')) * 60 * 1000;
const WAITING_REFRESH_MIN_SCORE_DELTA = Number(process.env.V4_WAITING_REFRESH_MIN_SCORE_DELTA || '5'); // fix43d: was 0 — any equal score triggered plan refresh causing continuous entry/SL/TP churn
const WAITING_REFRESH_MAX_ENTRY_WORSE_PCT = Math.max(0, Number(process.env.V4_WAITING_REFRESH_MAX_ENTRY_WORSE_PCT || '0.15'));


// fixZOMBIE: LIVE_RESTING / LIVE_OPEN / LIVE_PENDING come from the unified-brain state machine
// (lifecycle.js) and represent a REAL order/position on Bybit. They were missing here, so every
// site that gates on ACTIVE_STATES (orphan purge, cancel, open-count, dedupe) treated a live order
// as a dead orphan — the TUSDT live-money abandon on 07/18. They belong in the active set.
// fixZOMBIE2: CANDIDATE and FROZEN were STILL missing, so the orphan purge kept killing live signals.
//   CANDIDATE — decidePaper() returns this for EVERY signal awaiting entry (its default WAIT state).
//               Not being in either set meant every waiting signal was expired as a "zombie" the
//               moment dedupe ran. This is what produced the new T / 1000XEC zombies on 07/18.
//   FROZEN    — lifecycle.js marks this explicitly "NOT terminal": authority is ambiguous, action is
//               suspended and an alarm raised. Purging it destroys the exact safety state that exists
//               to protect an unresolved live order.
// Both are live, non-terminal states and belong in ACTIVE_STATES.
const ACTIVE_STATES = new Set(['WAITING_ENTRY', 'WAITING_REACTION', 'PAPER_ACTIVE', 'LIVE_RESTING', 'LIVE_OPEN', 'LIVE_PENDING', 'CANDIDATE', 'FROZEN']);
// fixZOMBIE: CLOSED_WIN / CLOSED_LOSS / PAPER_EXPIRED / PAPER_INVALID / CANCELLED are the unified-brain
// (lifecycle.js) TERMINAL states. They were missing from this set, so the orphan purge — which
// expires anything in NEITHER ACTIVE_STATES NOR FINAL_STATES — treated a correctly-closed live trade
// (real Bybit P&L already booked) as a corrupt orphan and overwrote it with EXPIRED, destroying the
// real result. This is why all 9 live trades on 07/17-18 showed EXPIRED in Orayan while Bybit had
// real WIN/LOSS P&L. These states are final and must be protected from the purge.
// fixZOMBIE2: 'PAPER_INVALID' was the KEY name in lifecycle.js STATES; the actual VALUE it emits is
// 'PAPER_INVALIDATED'. Guarding on the key never matched, so pre-entry invalidations were re-labelled
// EXPIRED by the purge. Both spellings kept so neither can slip through again.
const FINAL_STATES = new Set(['TP_HIT', 'SL_HIT', 'INVALIDATED', 'EXPIRED', 'REJECTED', 'STALE_CANCELLED', 'REGIME_FLIP_EXIT', 'CONTRARIAN_FLIP', 'ACTIVE_FLIP_EXIT', 'CLOSED_WIN', 'CLOSED_LOSS', 'PAPER_EXPIRED', 'PAPER_INVALID', 'PAPER_INVALIDATED', 'CANCELLED']);

// ── fixABANDON ──────────────────────────────────────────────────────────────────────────────────
// 07/11 live session: 4 of 4 REAL Bybit fills were signals Orayan had already written off. The paper
// brain stamped EXPIRED / STALE_CANCELLED on them (clock-based, pre-fill), the GTC limit filled on
// Bybit anyway, and the position then ran completely unmanaged — Orayan never looked at it again.
// Three independent layers all had to be wrong for this to happen, and all three were:
//   1. getSignals()          — expired WAITING signals on the paper clock, never checking whether a
//                              real order was resting on the exchange.
//   2. updateExistingSignals — `FINAL_STATES.has(paperState) → continue` dropped them permanently,
//                              so liveStateAuthority/unifiedBrain never got a look. (The fix49h
//                              comment even promised "authority then owns it" — it structurally could not.)
//   3. liveStateAuthority    — its CLOSED branch is itself guarded by !FINAL_STATES, so even a real
//                              Bybit close was discarded once paper had lied first.
// RULE: paper may only kill a signal it never put an order behind. The instant an order is claimed,
// the exchange owns that signal's fate. These pre-fill kills are the ONLY finals Bybit may overwrite —
// a genuinely booked outcome (TP_HIT / SL_HIT) is never touched.
const PAPER_PREFILL_FINALS = new Set(['EXPIRED', 'STALE_CANCELLED', 'INVALIDATED']);
function isOrderBearing(s) { return !!(s && (s.tradeId || s.orderId || s.orderClaimAt)); }
// A paper-final signal that still has an unresolved real order gets one authority pass per tick.
// liveResolved is stamped once Bybit's verdict is booked, which stops the reclaim loop for good.
function reclaimableFinal(s) {
  if (!s || s.liveResolved === true) return false;
  return isOrderBearing(s) && PAPER_PREFILL_FINALS.has(s.paperState);
}

// fix73: DEAD-HOUR windows in LK local time (Sri Lanka, UTC+5:30, no DST). MULTI-window, env-tunable.
// History: fix47 ripped dead hours out entirely. fix52 re-introduced a SINGLE window (03:30-05:30
// default), enforced at fill-time only — deliberately not at birth, which turned out to be the bug:
// signals born inside the window (WAITING_ENTRY) sat visible in the UI the whole time and could still
// fill in the seconds before the fill-time check next ran. 616-trade forensic re-analysis (2026-07-03,
// n=70 combined-session dataset) found the actual bad stretch is LK 00:00-05:30 as ONE contiguous
// window (35.3% WR / +0.038U expectancy-per-trade inside vs 64.2% WR / +0.341U outside, n=17 vs n=53) —
// not the previously-assumed 03:00/17:00 pair, which this dataset does NOT support (17:00 hour: n=2,
// 100% WR — too thin either way, left ungated pending more data). No env var existed on Northflank for
// this (verified via dashboard screenshot 2026-07-03) — the deployed process was silently running the
// fix52 hardcoded default (03:30-05:30), which is why the leak looked erratic across sessions.
// fix73 also closes the birth-time gap: signals are now blocked at creation (shouldReject +
// ingestCandidate, mirroring the existing dual-site breadth-fight pattern) AND any already-pending
// WAITING_ENTRY/WAITING_REACTION signal with no live order attached is purged the moment a scan tick
// observes isDeadHourLK()===true — not just at the instant its own entry condition is met. Combined:
// nothing is born, nothing pending survives, nothing fills, for the whole window. Side-agnostic by
// construction (time-based) ⇒ symmetric per project rule without special-casing BUY/SELL.
// Format: comma-separated "HH:MM-HH:MM" ranges in LK time. Supports overnight wrap (e.g. "23:00-01:00").
// Example multi-window: V4_DEAD_WINDOWS_LK="00:00-05:30,17:00-18:00". Empty/unset ⇒ DEFAULT below.
// Set V4_DEAD_WINDOWS_LK="" (empty string, not unset) to disable entirely.
const LK_OFFSET_MIN = 330; // UTC+5:30
// fixFADE (.77) DATA-COLLECTION STUB: the prior 00:00-05:30 block CENSORED its own evidence — any
// session with the block live logged ZERO dead-hour trades, so the pooled dead-hour stats
// (37% WR / +0.22R) came from an unrepresentative subsample and cannot set policy. Narrowed to a
// 3-min stub anchored at LK 04:00 (the single genuinely negative-expectancy hour observed, 12.5% WR
// / -0.55R, even in that biased sample) to KEEP the function + window-start cancellation path warm
// while un-censoring ~5h27m for a clean, complete sample. Re-widen via V4_DEAD_WINDOWS_LK once the
// hourly buckets are robust (>=800 trades). Function NOT disabled — set V4_DEAD_WINDOWS_LK="" for that.
const DEFAULT_DEAD_WINDOWS_LK = '04:00-04:03';
function _parseHHMM(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}
function parseDeadWindowsLK(raw) {
  const src = raw == null ? DEFAULT_DEAD_WINDOWS_LK : String(raw);
  if (src.trim() === '') return []; // explicit empty string = disabled
  const out = [];
  for (const part of src.split(',')) {
    const [a, b] = part.split('-').map(x => x && x.trim());
    const start = _parseHHMM(a), end = _parseHHMM(b);
    if (start == null || end == null || start === end) continue; // skip malformed / zero-length
    out.push({ start, end });
  }
  return out;
}
// Parsed once at module load — matches how DEAD_START_MIN/DEAD_END_MIN were already handled
// pre-fix73 (Northflank env vars require a redeploy to take effect, so no runtime re-parse needed).
const DEAD_WINDOWS_LK = parseDeadWindowsLK(process.env.V4_DEAD_WINDOWS_LK);
function lkMinuteOfDay(now = Date.now()) {
  const m = Math.floor(num(now, Date.now()) / 60000) + LK_OFFSET_MIN;
  return ((m % 1440) + 1440) % 1440;
}
function isDeadHourLK(now = Date.now()) {
  if (!DEAD_WINDOWS_LK.length) return false;
  const mod = lkMinuteOfDay(now);
  for (const w of DEAD_WINDOWS_LK) {
    if (w.end > w.start) { // normal window, e.g. 00:00-05:30
      if (mod >= w.start && mod < w.end) return true;
    } else { // overnight wrap, e.g. 23:00-01:00
      if (mod >= w.start || mod < w.end) return true;
    }
  }
  return false;
}
function deadHourLabel() {
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  if (!DEAD_WINDOWS_LK.length) return 'LK none (disabled)';
  return DEAD_WINDOWS_LK.map(w => `LK ${fmt(w.start)}–${fmt(w.end)}`).join(', ');
}

// fix48e: ADAPTIVE WAITING-ENTRY RE-VALIDATION.
// A waiting signal is frozen at birth — it activates whenever price reaches the limit, even if the
// market thesis that justified it has since collapsed. This is the #1 cause of bleed clusters
// (e.g. SELL born in BULL_RANGE filling 40 min later into a STRONG_BULL leg = guaranteed loss).
// Every tick, before a waiting signal may activate, we re-check it against LIVE conditions and
// either ABANDON it (STALE_CANCELLED) or FREEZE it (block activation this tick, keep waiting).
const REVAL_ADVERSE_DRIFT_FRAC = Math.max(0.1, Number(process.env.V4_REVAL_ADVERSE_DRIFT_FRAC || '0.5')); // abandon if price drifted >50% of entry→SL distance the wrong way pre-fill
const REVAL_ATR_SHOCK_MULT     = Math.max(1.1, Number(process.env.V4_REVAL_ATR_SHOCK_MULT || '1.8'));     // freeze if live ATR expanded >1.8x vs creation ATR (vol shock / regime change)
const REVAL_MOMENTUM_RSI_BUY_MAX  = Number(process.env.V4_REVAL_RSI_BUY_MAX  || '38'); // freeze BUY if live 5m RSI collapsing below this (momentum gone)
const REVAL_MOMENTUM_RSI_SELL_MIN = Number(process.env.V4_REVAL_RSI_SELL_MIN || '62'); // freeze SELL if live 5m RSI ripping above this
const REVAL_MIN_AGE_MS = Math.max(0, Number(process.env.V4_REVAL_MIN_AGE_MS || '20000')); // don't re-validate in the first 20s (avoid birth-tick noise)
// fix55: breadth-fight-at-fill — hold a waiting fill while breadth fights the side, abandon if sustained
const REVAL_BREADTH_FIGHT_GRACE_MS   = Math.max(0, Number(process.env.V4_BREADTH_FIGHT_GRACE_MIN || '3')) * 60 * 1000; // hold this long, then abandon
const REVAL_BREADTH_FIGHT_MAX_AGE_MS = Math.max(60000, Number(process.env.V4_BREADTH_FIGHT_MAX_AGE_MIN || '30') * 60 * 1000); // fail-open if breadth snapshot older than this

// fixFLIP: WAITING-stage contrarian flip (failed-rejection squeeze → opposite-side limit-retest). Default OFF.
const FLIP_ENABLED    = String(process.env.V4_FLIP_ENABLED || 'false').toLowerCase() === 'true';
const FLIP_AT_BIRTH   = String(process.env.V4_FLIP_AT_BIRTH || 'false').toLowerCase() === 'true'; // layer1 EXPERIMENTAL/default-OFF: composite birth inversion OVERFIT — cohort 0W/15L on 2 squeeze sessions but 42% (13W/18L, sacrifices 13 winners) on the full 442-trade pool; composite threshold does NOT generalize (SELL@comp<=-7 was 55% one session, 14% another). Kept as a toggle only.
const FLIP_WAITING    = String(process.env.V4_FLIP_WAITING  || 'true').toLowerCase() === 'true';  // layer2: flip a still-waiting short on reclaim
const FLIP_ACTIVE     = String(process.env.V4_FLIP_ACTIVE   || 'false').toLowerCase() === 'true'; // layer3: reverse a FILLED squeezing short (books mid-trade P&L — opt-in)
const FLIP_TF         = String(process.env.V4_FLIP_TF || '1');                                    // reclaim-confirmation timeframe (min); 1m default (5m was too wide)
const FLIP_CAP_THRESHOLD = Number(process.env.V4_FLIP_CAP_THRESHOLD || '-7');                     // capitulation composite ceiling for birth inversion (SELL side); +7 mirror for BUY
const FLIP_MIN_AGE_MS = Math.max(60000, Number(process.env.V4_FLIP_MIN_AGE_MS || '60000')); // wait ≥1 closed flip-TF bar before a waiting flip can fire
const FLIP_SL_ATR_BUF = Math.max(0.05, Number(process.env.V4_FLIP_SL_ATR_BUF || '0.25'));    // SL buffer beyond the trigger wick, in ATR
const FLIP_MIN_RR     = Math.max(0.5,  Number(process.env.V4_FLIP_MIN_RR     || '1.0'));     // skip the flip if rebuilt geometry RR < this (bad trade, not a gate)
const FLIP_DEFAULT_RR = Math.max(1.0,  Number(process.env.V4_FLIP_DEFAULT_RR || '2.0'));     // RR target when parent RR is unusable

// ── fixPCT (Phase 1): PER-COIN MULTI-TF TREND BRAIN ──────────────────────────
// WHY: the bot was frozen (07/24, 8h no fills) because in a bear regime it wants SELL-only, and the
// existing counter-regime rescue (fix49k breadthOverrideSide) keys on MARKET-WIDE breadth — never the
// coin. So DEXE +97% (a clean long) stayed hard-blocked because market breadth read bearish. This reads
// the COIN's OWN trend across 1m/3m/5m/15m (dropping the lagging 1h that made fresh pumps read 'bear')
// and does two things, both sides symmetric:
//   (1) OVERRIDE: a regime-blocked side is admitted IF the coin's own trend is STRONG that way.  → unfreeze
//   (2) CONFLICT: a would-be-admitted trade that FIGHTS a strong coin trend is rejected.          → stop the knife-catch
// Anti-whipsaw: 15m is the ANCHOR; a bias only forms when 15m agrees AND >=2 of {1m,3m,5m} confirm.
//   strength = 1 + (count of fast TFs confirming) => 3 means 15m+2fast, 4 means 15m+3fast. STRONG default = 3.
// BOUNDED FETCH: coinTrendEngine is only called for a leader that is either regime-blocked OR about to be
//   admitted — a small subset per scan, not all 527 — so it never re-creates the fixLOOP kline saturation.
// Fail-open: any fetch/parse error => strength 0 => no override, no conflict => behaves exactly like today.
// Reversible: V4_PCT_ENABLED=false kills the whole thing; V4_PCT_CONFLICT_ENABLED=false keeps the unfreeze
//   but disables the counter-trend reject. Flip stays SHADOW (diag.flipShadow) — acts on nothing here.
const PCT_ENABLED          = String(process.env.V4_PCT_ENABLED || 'true').toLowerCase() === 'true';
const PCT_CONFLICT_ENABLED = String(process.env.V4_PCT_CONFLICT_ENABLED || 'true').toLowerCase() === 'true';
const PCT_STRONG           = Math.max(2, Math.min(4, Number(process.env.V4_PCT_STRONG || '3'))); // 15m + >=2 faster
const PCT_CACHE_MS         = Math.max(15000, Number(process.env.V4_PCT_CACHE_MS || '45000'));
// fixPCT Phase 1.5/2 knobs:
//  VOTE — let a strong per-coin fast trend cast a 4th direction vote in determineDirection, so a FRESH
//         pump (5m+15m up but 1h still lagging bear) can form a BUY leader the 3-TF F3 family misses.
//         Fetched only for "fresh-move" coins (5m+15m agree, 1h hasn't confirmed) → tightly bounded.
//  PULLBACK — for a continuation leader (side agrees with a strong coin trend), tighten the entry from
//         the default 0.6 ATR pullback to a shallow PCT_PULLBACK_ATR so a strong trend fills on a small
//         dip-and-resume instead of waiting for a deep reversal that never comes (the "misses the runner").
const PCT_VOTE_ENABLED     = String(process.env.V4_PCT_VOTE_ENABLED || 'true').toLowerCase() === 'true';
const PCT_PULLBACK_ENABLED = String(process.env.V4_PCT_PULLBACK_ENABLED || 'true').toLowerCase() === 'true';
const PCT_PULLBACK_ATR     = Math.max(0.1, Math.min(0.6, Number(process.env.V4_PCT_PULLBACK_ATR || '0.3'))); // shallow continuation entry depth
// fixPCT (option B): load cap on per-scan coinTrend fetches + a per-scan observability summary so the
// engine is VISIBLE — you can watch it grip fresh-move coins and see exactly why a strong one didn't
// trade (e.g. the 85 score gate), instead of staring at silence. Logs only when there's activity.
const PCT_MAX_FETCH = Math.max(5, Number(process.env.V4_PCT_MAX_FETCH || '40')); // max coinTrend fetches per scan
// fixTPREACH (4.6.8.97): a continuation-entry leader's TP always targeted the NEAREST swing level, which
// a trend that's already broken through nearby structure leaves too close for real RR (shadow-log proof:
// BANKUSDT/TAOUSDT RR 0.02-0.78 despite a correctly-strong coin trend read). Reach for the second swing
// level instead, ONLY for continuation entries, ONLY when the nearest gives RR below the minimum below.
const TPREACH_ENABLED = String(process.env.V4_TPREACH_ENABLED || 'true').toLowerCase() === 'true';
const TPREACH_MIN_RR  = Math.max(0.5, Number(process.env.V4_TPREACH_MIN_RR || '1.2'));
// fixKNIFEGUARD (4.6.8.97): fixRETEST places the live retest limit on hadFirstTouch alone (deliberately,
// to avoid stale-price lag — see the placement-site comment). Live 07/27-28 data showed the cost: fills
// landing while the prior 1m candle was still printing hard momentum against the trade. Withhold
// placement for one tick (not a cancel) when the last completed 1m candle's body is large and against
// the trade direction. Uses the 1m candle enrichOpenSignalMarketMap already fetches — no new I/O.
const KNIFE_BODY_ATR = Math.max(0, Number(process.env.V4_KNIFE_BODY_ATR || '0.35')); // 0 disables
// fixORTRIGGER (4.6.9.1): lets the activation-moment live hook fire on a first-touch-only confirmed
// directional reaction (paper's own bar), not just a genuine second touch — see the call site in
// updateExistingSignals for full reasoning. Reuses KNIFE_BODY_ATR as the safety check for this newly
// widened path only; the existing hadFirstTouch path is unaffected either way.
const FIRSTTOUCH_LIVE_ENABLED = String(process.env.V4_FIRSTTOUCH_LIVE_ENABLED || 'true').toLowerCase() === 'true';
// fixPCT fork-A (4.6.8.88): SCORE-gate bypass for a strong pull-back continuation leader.
// Score has no proven trade-quality value (r=-0.07 across 537 trades — standing rule), yet the
// score gate was killing genuinely-strong per-coin trends (live PCT_SCAN proof: SCORE_LT killed
// 6 of 9 F4 leaders/scan). This waives ONLY the SCORE_LT reason, and ONLY when the leader already
// has a pullback continuation entry on its side (leader.continuationEntry === side — which itself
// requires coinTrend strength >= PCT_STRONG, bias agreeing with the side, AND pullback enabled).
// Every OTHER gate still applies (RR, netTP, maxTpAtr, entry-timing, dead-hour, bottom-guard,
// regime-override). Both-sides symmetric. Reversible: V4_PCT_SCORE_BYPASS=false.
const PCT_SCORE_BYPASS = String(process.env.V4_PCT_SCORE_BYPASS || 'true').toLowerCase() === 'true';
// fixPCT SHADOW (breadth-fight): the BREADTH_FIGHT_BUY/SELL gate (fix49o) is DATA-VALIDATED (191-trade
// pooled analysis: buying <50% breadth measured 33-0% WR across buckets) — unlike the score gate,
// this is NOT a candidate for a blind bypass. Instead: RECORD-ONLY. A strong pullback continuation
// leader that dies ONLY to BREADTH_FIGHT gets its would-be entry/SL/TP logged so we can later measure,
// with real data, whether a strong per-coin trend actually beats the breadth floor before ever
// touching this validated guard. Acts on nothing — leader.rejected/gate.ok/reasons never mutated here.
const PCT_SHADOW_ENABLED = String(process.env.V4_PCT_SHADOW_ENABLED || 'true').toLowerCase() === 'true';
// fix48i-trail: minimum R a position must already be at when a regime flip hits to get the TRAIL
// treatment (lock this much R, keep riding to TP) instead of the original hard close at market.
// Below this, or losing, the position still gets the unchanged hard close (data-validated for
// losing/marginal trades — PENGU bled 83min to full SL after a flip). Reversible: set very high
// (e.g. 999) to fully restore pre-patch behavior (always hard-close on flip).
const REGIME_FLIP_TRAIL_MIN_R = Number(process.env.V4_REGIME_FLIP_TRAIL_MIN_R || '0.5');
let _pctStats = null;
function _pctReset() { _pctStats = { fresh: 0, fetched: 0, capped: 0, strong: 0, f4leaders: 0, overrides: 0, conflicts: 0, scoreBypass: 0, breadthFightShadow: 0, blocks: {} }; }
function _pctBlock(r) { if (!_pctStats) return; const k = String(r || '?').replace(/_str\d+$/, '').replace(/_(BUY|SELL)$/, ''); _pctStats.blocks[k] = (_pctStats.blocks[k] || 0) + 1; }
const _coinTrendCache = new Map();

// Fresh-move signature: fast TFs (5m AND 15m) agree on a direction the slow 1h has NOT yet confirmed —
// exactly the DEXE case (ripping on the fast TFs while the lagging 1h still reads the old regime). This is
// the ONLY place we spend a coinTrendEngine fetch in the vote path, so it stays bounded to real candidates.
function isFreshMove(ctx) {
  if (!ctx) return false;
  const t5 = ctx.trend5, t15 = ctx.trend15, t1h = ctx.trend1h;
  return (t5 === 'bull' && t15 === 'bull' && t1h !== 'bull') ||
         (t5 === 'bear' && t15 === 'bear' && t1h !== 'bear');
}

// fixVWAP (4.6.9.0): rolling VWAP over the trailing `len` bars — deliberately NOT a session VWAP (crypto
// trades 24/7, a daily reset has no natural anchor here). typical price = (h+l+c)/3, weighted by volume.
// Reuses whatever candle series the caller passes (15m in coinTrendEngine, already fetched — zero new
// I/O). Returns 0 on insufficient data or zero total volume (fail-open, same convention as calcADX).
function calcVWAP(candles, len = 20) {
  if (!Array.isArray(candles) || candles.length < len) return 0;
  const window = candles.slice(-len);
  let pv = 0, vol = 0;
  for (const c of window) {
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    vol += c.volume;
  }
  return vol > 0 ? pv / vol : 0;
}

async function coinTrendEngine(symbol) {
  try {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return { bias: 'mixed', strength: 0, t1: '?', t3: '?', t5: '?', t15: '?', cross: null, adx15: 0, vwap15: 0, vwapVote: 'unknown' };
    const hit = _coinTrendCache.get(sym);
    if (hit && (Date.now() - hit.at) < PCT_CACHE_MS) return hit.data;
    const [k1, k3, k5, k15] = await Promise.all([
      fetchKline(sym, '1', 60).catch(() => []),
      fetchKline(sym, '3', 60).catch(() => []),
      fetchKline(sym, '5', 60).catch(() => []),
      fetchKline(sym, '15', 60).catch(() => []),
    ]);
    const t1  = trendFromCloses(k1.map(c => c.close));
    const t3  = trendFromCloses(k3.map(c => c.close));
    const t5  = trendFromCloses(k5.map(c => c.close));
    const t15 = trendFromCloses(k15.map(c => c.close));
    // fixVWAP: a genuinely independent 4th fast-TF vote (not another EMA read) — price vs a rolling
    // 20-bar 15m VWAP. Folded into the SAME up/dn count as t1/t3/t5 rather than a parallel scale, so
    // every existing consumer of coinTrend.strength (PCT_STRONG gates, EUPH_ADX_PROMOTE, tpreach,
    // regime override/conflict — all tuned over many hotfixes) keeps working unchanged. strength is
    // explicitly capped at 4 (Math.min), the SAME ceiling as before VWAP existed — this only changes
    // which COMBINATIONS of evidence can reach that ceiling (e.g. t15+2 EMA fast TFs+VWAP now also
    // qualifies as strength 4, not just t15+all 3 EMA), it never raises the ceiling itself. One vote
    // among several, not a tiebreaker with override power — exactly as decided with the user.
    const vwap15 = calcVWAP(k15, 20);
    const lastClose15 = k15.length ? k15[k15.length - 1].close : 0;
    const vwapVote = (vwap15 > 0 && lastClose15 > 0) ? (lastClose15 > vwap15 ? 'bull' : lastClose15 < vwap15 ? 'bear' : 'neutral') : 'unknown';
    const up = [t1, t3, t5, vwapVote].filter(t => t === 'bull').length;
    const dn = [t1, t3, t5, vwapVote].filter(t => t === 'bear').length;
    let bias = 'mixed', strength = 0;
    if (t15 === 'bull' && up >= 2)      { bias = 'up';   strength = Math.min(1 + up, 4); }
    else if (t15 === 'bear' && dn >= 2) { bias = 'down'; strength = Math.min(1 + dn, 4); }
    // golden/death cross on 15m (SMA9 vs SMA21) — logged as a confirm, not a standalone trigger
    let cross = null;
    const c15 = k15.map(c => c.close);
    if (c15.length >= 22) {
      const f = sma(c15, 9), s = sma(c15, 21);
      const pf = sma(c15.slice(0, -1), 9), ps = sma(c15.slice(0, -1), 21);
      if (pf <= ps && f > s) cross = 'golden';
      else if (pf >= ps && f < s) cross = 'death';
    }
    const data = { bias, strength, t1, t3, t5, t15, cross, adx15: calcADX(k15, 14), vwap15, vwapVote };
    _coinTrendCache.set(sym, { at: Date.now(), data });
    return data;
  } catch (_e) {
    return { bias: 'mixed', strength: 0, t1: '?', t3: '?', t5: '?', t15: '?', cross: null, adx15: 0, vwap15: 0, vwapVote: 'unknown' };
  }
}

// Applies the per-coin trend override/conflict AFTER shouldReject. Mutates leader + gate.ok in place so
// downstream max-open / rejection-store logic stays correct for admitted-by-override signals.
async function applyPerCoinTrend(leader, gate) {
  if (!PCT_ENABLED || !leader) return;
  const side = String(leader.side || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') return;
  const reasons = Array.isArray(leader.rejectReasons) ? leader.rejectReasons : [];
  const regimeBlocked = leader.rejected && reasons.length > 0 &&
    reasons.every(r => /^BTC_.*_BLOCKS_(BUY|SELL)$/.test(String(r)));
  const admitting = !leader.rejected;
  // fork-A: a score-blocked leader that ALSO carries a pullback continuation entry on its side is a
  // bypass candidate — it must reach the fetch even though it is neither regime-only-blocked nor admitting.
  const scoreBlocked    = leader.rejected && reasons.some(r => /^SCORE_LT_/.test(String(r)));
  const bypassCandidate = PCT_SCORE_BYPASS && scoreBlocked && leader.continuationEntry === side;
  // fixEUPHADX: a leader the EUPH_GUARD dampener already touched (euphoria/capitulation zone) is a
  // promotion candidate regardless of continuationEntry — reaches the fetch whether the dampened score
  // still cleared the gate (admitting=true, already covered) or got score-rejected by the dampening itself.
  const euphScoreBlocked = EUPH_GUARD_ENABLED && !!leader.euphGuard && scoreBlocked;
  // Shadow candidate: rejected specifically by the validated breadth-fight floor, AND already earned
  // a pullback continuation entry on this side. Record-only — never reaches a mutation branch below.
  const breadthFightBlocked = PCT_SHADOW_ENABLED && leader.rejected &&
    reasons.some(r => /^BREADTH_FIGHT_(BUY|SELL)_/.test(String(r))) && leader.continuationEntry === side;
  if (!regimeBlocked && !admitting && !bypassCandidate && !breadthFightBlocked && !euphScoreBlocked) return; // decision doesn't hinge on the coin trend — skip the fetch

  const ct = await coinTrendEngine(leader.symbol || leader.sym);
  leader.coinTrend = ct; // stamped for diag/logging always
  if (!ct || ct.strength < PCT_STRONG) return;

  const withSide    = (ct.bias === 'up' && side === 'BUY') || (ct.bias === 'down' && side === 'SELL');
  const againstSide = (ct.bias === 'up' && side === 'SELL') || (ct.bias === 'down' && side === 'BUY');

  // fixEUPHADX (4.6.8.98): user's explicit ask — some coins DO throw valid setups even inside the
  // euphoria/capitulation zone; EUPH_GUARD's blanket 0.75x dampener can't tell those apart from the
  // validated trap majority (07/03 autopsy: >=74 cohort 22% WR). ADX is a genuine trend-STRENGTH read,
  // separate from the EMA20/50 direction vote coinTrend already gives — a real ADX>=25 read plus coin-
  // trend agreement is meaningfully different evidence than "the move looks strong on a chart", so this
  // promotes rather than just re-trusting the same signal that got dampened. Requires ALL of: leader was
  // actually euphGuard-dampened (not every strong-trend leader — only ones the zone dampener touched),
  // fresh coinTrend agrees WITH the trade side (withSide, not just strength), and adx15 clears the
  // classic ADX "trending" floor. Restores the PRE-dampening score exactly (no boost beyond that) and,
  // if the dampening alone had pushed it below the score gate, un-rejects it — mirroring the existing
  // score-bypass pattern above. Every other gate (RR, netTP, timing, dead-hour, bottom-guard, max-open)
  // still applies untouched. Both-sides symmetric. Reversible: V4_EUPH_ADX_PROMOTE_ENABLED=false.
  if (EUPH_ADX_PROMOTE_ENABLED && leader.euphGuard && withSide && ct.adx15 >= EUPH_ADX_MIN) {
    const _restoredScore = leader.euphGuard.from;
    const _beforeScore = leader.score;
    leader.score = _restoredScore;
    leader.tier  = leader.score >= SCORE_A_PLUS ? 'A+' : leader.score >= SCORE_A ? 'A' : leader.score >= SCORE_B ? 'B' : '-';
    leader.euphAdxPromote = { side, adx15: ct.adx15, from: _beforeScore, to: leader.score, coinBias: ct.bias, coinStrength: ct.strength };
    if (leader.rejected) {
      const nonScoreE = reasons.filter(r => !/^SCORE_LT_/.test(String(r)));
      if (nonScoreE.length === 0) {
        leader.rejected = false;
        leader.rejectReasons = [];
        leader.rejectWarnings = [...(leader.rejectWarnings || []), `EUPH_ADX_PROMOTE_${side}_adx${Math.round(ct.adx15)}`];
        gate.ok = true;
      } else {
        leader.rejectReasons = nonScoreE; // score no longer the blocker; other gates (if any) still decide below
      }
    }
    try {
      addLog('EUPH_ADX_PROMOTE', `${leader.symbol}: ${side} promoted out of EUPH_GUARD dampening — adx15=${ct.adx15.toFixed(1)} (>=${EUPH_ADX_MIN}), coin trend ${ct.bias} str${ct.strength}, score ${_beforeScore}→${leader.score}`);
    } catch (_l) {}
  }

  // fixPCT SHADOW: record the would-be trade for a breadth-fight-blocked strong pullback leader.
  // RECORD ONLY — no mutation of leader.rejected / gate.ok / rejectReasons happens in this block.
  if (breadthFightBlocked && withSide) {
    const bfReason = reasons.find(r => /^BREADTH_FIGHT_(BUY|SELL)_/.test(String(r))) || null;
    const _p = leader.plan || {}; // fix: entry/sl/tp1 live under leader.plan, not leader top-level (top-level only exists post-flip)
    leader.breadthFightShadow = {
      side, entry: _p.entry, sl: _p.sl, tp1: _p.tp1,
      rr: num(leader.math && leader.math.rr, null), score: leader.score,
      breadthReason: bfReason, coinBias: ct.bias, coinStrength: ct.strength,
      t1: ct.t1, t3: ct.t3, t5: ct.t5, t15: ct.t15, cross: ct.cross || null, at: Date.now()
    };
    if (_pctStats) _pctStats.breadthFightShadow++;
    try {
      addLog('BREADTH_FIGHT_SHADOW',
        `${leader.symbol}: ${side} would-be entry=${_p.entry} sl=${_p.sl} tp=${_p.tp1} rr=${num(leader.math && leader.math.rr, 0).toFixed(2)} score=${leader.score} — blocked by ${bfReason}, coin trend ${ct.bias} str${ct.strength} (1m=${ct.t1} 3m=${ct.t3} 5m=${ct.t5} 15m=${ct.t15}${ct.cross ? ' ' + ct.cross : ''})`
      );
    } catch (_l) {}
  }

  // fork-A SCORE-gate bypass: strip ONLY the SCORE_LT reason for a strong pullback continuation leader.
  // Guarded by withSide (fresh read must still agree with the side) on top of the continuationEntry check.
  // If score was the SOLE blocker → admit outright. If regime reasons remain, they are written back so the
  // regime-override branch below re-evaluates a clean, score-free reason set. Any other gate (RR, netTP,
  // timing, dead-hour, bottom-guard, max-open downstream) is UNTOUCHED and still applies.
  if (bypassCandidate && withSide) {
    const nonScore = reasons.filter(r => !/^SCORE_LT_/.test(String(r)));
    const onlyRegimeLeft = nonScore.every(r => /^BTC_.*_BLOCKS_(BUY|SELL)$/.test(String(r)));
    // Only waive when SCORE is the LAST non-regime barrier. If any other gate (RR, netTP, timing,
    // dead-hour, bottom-guard…) still rejects, the trade dies anyway — don't waive or log a no-op.
    if (nonScore.length < reasons.length && onlyRegimeLeft) {
      leader.rejectReasons = nonScore;
      leader.perCoinScoreBypass = side;
      if (_pctStats) _pctStats.scoreBypass++;
      try { addLog('PERCOIN_SCORE_BYPASS', `${leader.symbol}: ${side} score-gate waived (score ${leader.score}) — strong pullback trend ${ct.bias} str${ct.strength} (1m=${ct.t1} 3m=${ct.t3} 5m=${ct.t5} 15m=${ct.t15}${ct.cross ? ' ' + ct.cross : ''})`); } catch (_l) {}
      if (nonScore.length === 0) {
        // score was the sole blocker → admit; every non-score gate already passed.
        leader.rejected = false;
        leader.rejectWarnings = [...(leader.rejectWarnings || []), `PERCOIN_SCORE_BYPASS_${side}_str${ct.strength}`];
        gate.ok = true;
      }
      // if only regime remains, the regime-override branch below admits it (and logs PERCOIN_OVERRIDE).
    }
  }

  // Re-evaluate regime-block against the possibly-cleaned reason set (score no longer masks a regime block).
  const reasons2       = Array.isArray(leader.rejectReasons) ? leader.rejectReasons : [];
  const regimeBlocked2 = leader.rejected && reasons2.length > 0 &&
    reasons2.every(r => /^BTC_.*_BLOCKS_(BUY|SELL)$/.test(String(r)));

  if (regimeBlocked2 && withSide) {
    // UNFREEZE: strong coin trend supports the regime-blocked side → admit it.
    leader.rejected = false;
    leader.rejectReasons = [];
    leader.perCoinOverride = side;
    if (_pctStats) _pctStats.overrides++;
    leader.rejectWarnings = [...(leader.rejectWarnings || []), `PERCOIN_TREND_OVERRIDE_${side}_str${ct.strength}`];
    gate.ok = true;
    try { addLog('PERCOIN_OVERRIDE', `${leader.symbol}: ${side} admitted vs regime — coin trend ${ct.bias} str${ct.strength} (1m=${ct.t1} 3m=${ct.t3} 5m=${ct.t5} 15m=${ct.t15}${ct.cross ? ' ' + ct.cross : ''})`); } catch (_l) {}
  } else if (admitting && againstSide) {
    // FLIP SHADOW (I4): record what a flip WOULD do — acts on nothing.
    leader.flipShadow = { would: side === 'BUY' ? 'SELL' : 'BUY', bias: ct.bias, strength: ct.strength, at: Date.now() };
    if (_pctStats) _pctStats.conflicts++;
    if (PCT_CONFLICT_ENABLED) {
      // THROW, DON'T CATCH: about to admit a trade that fights a strong coin trend → reject.
      leader.rejected = true;
      leader.rejectReasons = [...reasons, `PERCOIN_TREND_CONFLICT_${side}_str${ct.strength}`];
      gate.ok = false;
      try { addLog('PERCOIN_CONFLICT', `${leader.symbol}: ${side} rejected — fights coin trend ${ct.bias} str${ct.strength} (1m=${ct.t1} 3m=${ct.t3} 5m=${ct.t5} 15m=${ct.t15})`); } catch (_l) {}
    }
  }
}

// fixADAPT layer4: adaptive short-regime detector — the ONE signal that generalized across 4 sessions
// (trailing-N SELL WR < ~35% → next-short WR 36% vs 52% when healthy). NOT a static entry feature (every
// one of those overfit); this reads Orayan's OWN recent realized results and SELF-RELAXES. Default OFF.
const ADAPT_ENABLED    = String(process.env.V4_ADAPT_ENABLED || 'false').toLowerCase() === 'true';
const ADAPT_WINDOW     = Math.max(5, Number(process.env.V4_ADAPT_WINDOW || '10'));            // trailing resolved trades per side
const ADAPT_HOSTILE_WR = Math.min(0.9, Math.max(0.1, Number(process.env.V4_ADAPT_HOSTILE_WR || '0.35'))); // trailWR below this → hostile regime
const ADAPT_MIN_SAMPLE = Math.max(5, Number(process.env.V4_ADAPT_MIN_SAMPLE || '8'));         // need this many resolved before acting (no noise)
const ADAPT_CONV_MULT  = Math.min(1, Math.max(0.5, Number(process.env.V4_ADAPT_CONV_MULT || '0.85')));    // soft score dampen for the hostile side
const ADAPT_FLIP_VOL_RELAX = Math.min(1, Math.max(0.3, Number(process.env.V4_ADAPT_FLIP_VOL_RELAX || '0.75'))); // scale avgVol into detectFlip when hostile → easier flip

// fixBOTTOM: breadth range-percentile guard. VALIDATED finding (see V4_VERSION header): SELL at the
// bottom of breadth's trailing 6h range = 16-27% WR toxic zone. Soft dampen like fixADAPT, NOT a gate.
// Capture (breadthRangePctileAtEntry) is ALWAYS on; only the dampen is flag-gated.
const BOTTOM_GUARD_ENABLED = String(process.env.V4_BOTTOM_GUARD_ENABLED || 'false').toLowerCase() === 'true';
const BOTTOM_WINDOW_MIN    = Math.max(60, Number(process.env.V4_BOTTOM_WINDOW_MIN || '360'));      // trailing range window (min); finding robust 240-720
const BOTTOM_PCTILE        = Math.min(40, Math.max(5, Number(process.env.V4_BOTTOM_PCTILE || '15'))); // toxic-zone cut: SELL <= this / BUY >= (100-this)
const BOTTOM_CONV_MULT     = Math.min(1, Math.max(0.5, Number(process.env.V4_BOTTOM_CONV_MULT || '0.75'))); // stronger than ADAPT's 0.85 — the zone's 16-27% WR is worse than ADAPT's hostile 36%
const BOTTOM_MIN_SAMPLES   = Math.max(10, Number(process.env.V4_BOTTOM_MIN_SAMPLES || '30'));      // fail-open (pctile=null, no dampen) below this many breadth samples

// fixEUPH (4.6.8.76): ABSOLUTE-breadth exhaustion dampener — the guard fixBOTTOM structurally cannot
// provide. EVIDENCE (2026-07-03 session, backend .68): LK 11:00-13:00 BTC RSI ripped 45→74 with
// breadth pinned 75-77 (blow-off leg), then RSI collapsed 74→56 while breadth HELD at 75+ =
// distribution at the highs; every BUY born LK 11:00+ chased that top → ~1W/11L. Banded: BUY at
// bull_pct 60-70 = 62% WR +10.0U (n=32); at >=74 = 22% WR, NEGATIVE expectancy (n=9). Mirror disease
// in the 06/29-07/01 SELL bloodbath: SELL at btc_rsi<35 = 17% WR (n=18) — entering the direction of
// an extended move at a market-level exhaustion extreme, both times.
// WHY fixBOTTOM MISSED IT [verified]: range-percentile is range-RELATIVE. On 07/02 breadth ranged
// 51→80 and pctile discriminated (its >=75 bucket = 44% WR, worked). On 07/03 afternoon breadth
// compressed to 72-77 — a tight range pinned at absolute highs — so entries at absolute euphoria read
// as "pctile 50-75, mid-range, fine" (that bucket: 44% WR that day). Range compression at the top
// destroys range-relative resolution exactly when it matters. Absolute level and range position are
// COMPLEMENTARY guards, not competitors — keep both.
// MECHANISM: same soft-dampen seam and pattern as fixBOTTOM (score x mult so marginal entries fall
// under the existing minScore floor; strong setups pass), symmetric per the both-sides rule:
// BUY dampened at bull_pct >= EUPH_BREADTH_HI, SELL at bull_pct <= EUPH_BREADTH_LO. Flip children
// exempt (corrective trades). Fail-open on null breadth. DEFAULT ON — unlike Bottom Guard (gated
// awaiting SELL data), this zone actively bled TODAY, the mechanism is soft, and the counterfactual
// is net-positive; disable via V4_EUPH_GUARD_ENABLED=false. Thresholds are [Likely] not [Certain]
// (n=9 BUY-side) — env-tunable, revisit after the next mixed-regime batch. The BTC-RSI leg
// (60-70 mid-leg chase, 0/6 today — too thin to act on) is SHADOW-LOGGED to diag only, zero weight.
const EUPH_GUARD_ENABLED = String(process.env.V4_EUPH_GUARD_ENABLED || 'true').toLowerCase() === 'true';
const EUPH_BREADTH_HI    = Math.min(95, Math.max(60, Number(process.env.V4_EUPH_BREADTH_HI || '74'))); // BUY dampened at/above
const EUPH_BREADTH_LO    = Math.max(5,  Math.min(40, Number(process.env.V4_EUPH_BREADTH_LO || '26'))); // SELL dampened at/below (mirror)
const EUPH_CONV_MULT     = Math.min(1, Math.max(0.5, Number(process.env.V4_EUPH_CONV_MULT || '0.75'))); // zone severity (22% WR) ≈ bottom zone's 16-27% → same mult
// fixEUPHADX (4.6.8.98): promotes a euphoria/capitulation candidate back to full score when a real ADX
// trend-strength read (not just the EMA20/50 direction vote) backs it up — see applyPerCoinTrend for the
// full guard chain (euphGuard-dampened + withSide + adx15 >= floor, all three required). 25 is the
// standard Wilder "trending" threshold (below ~20 is conventionally chop) — kept as the default rather
// than tuned to this system's own data, since no live sample exists yet to tune it from. Disable via
// V4_EUPH_ADX_PROMOTE_ENABLED=false to fall back to the flat 0.75x dampener for every zone candidate.
const EUPH_ADX_PROMOTE_ENABLED = String(process.env.V4_EUPH_ADX_PROMOTE_ENABLED || 'true').toLowerCase() === 'true';
const EUPH_ADX_MIN = Math.max(10, Math.min(50, Number(process.env.V4_EUPH_ADX_MIN || '25')));

// fixFADE (4.6.8.77): the counter-play to fixEUPH. Where the dampener merely SHRINKS the momentum
// side inside the euphoria/despair zone, the fade module shadow-logs the OPPOSITE side with a fresh
// 2:1 bracket (see fadeModule.js header for the full evidence + the fresh-bracket rationale). It
// reuses EUPH_BREADTH_HI/LO as its zone boundary (single source of truth — the fade zone can never
// drift from the dampener zone). All fade tunables live in fadeModule.js env (V4_FADE_*). SHADOW
// ONLY — stamps diag.fadeShadow, acts on nothing. Euphoria side = weak-positive sim evidence;
// despair side = zero-sample, pure data-collection (asymmetry is in stamped confidence, not existence).

async function publicGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = PUBLIC_BASE + path + (qs ? '?' + qs : '');
  const resp = await axios.get(url, { timeout: 10000 });
  return resp.data;
}


let running = false;
let inFlight = false;
let _lastBreadthLogMs = 0;   // fix49l: throttle breadth-history sampling to once/min
let _breadthLogWrites = 0;   // fix49l: counter to trigger periodic retention trim
let _diagJournalWrites = 0;  // fix49n: counter to trigger periodic diagnostic-journal size cap
// fix49p: breadth-slope cache. Computing slope requires reading breadth_history.ndjson; doing that
// once per scanned pair (527/cycle) would re-introduce the exact file-read memory/IO pressure
// fix49m/n just removed. So we compute slope at most once per SLOPE_CACHE_MS and reuse it for the
// whole scan cycle. Slope only meaningfully changes minute-to-minute anyway (observed ~0.19%/min).
let _breadthSlopeCache = { at: 0, slope: null, samples: 0, firstPct: null, lastPct: null };
let timer = null;
let lastError = '';
let lastScanAt = 0;
let lastAutoRetryAt = 0; // throttle: auto-retry runs at most every 5 min
const _sweepSuppressLogged = new Set(); // fixSWEEP: once-per-symbol-per-sweep log throttle
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

// fix48r: LAST-GOOD SENTINEL CACHE. Root cause of the data-capture gap: initActiveDiagnostics
// read sentinel.getSentinel() at the exact activation instant and wrote null whenever the
// sentinel was cold/gapped/mid-redeploy (vol.pair_count===0 or market_regime UNKNOWN). Result:
// only ~40% of even CLOSED trades carried breadth/sentinel context — every breadth analysis ran
// on partial data. Fix: cache the sentinel whenever it is genuinely fresh, and fall back to the
// last-good snapshot (tagged stale) when the live read is empty, instead of writing null.
let _lastGoodSentinel = null;
let _lastGoodSentinelAt = 0;

// Returns { sent, stale, ageMs }. `sent` is the freshest usable sentinel: the live one if it has
// real data, else the last-good cache. `stale=true` means we fell back. Never throws.
function getSentinelForCapture() {
  let live = null;
  try { live = (typeof sentinel?.getSentinel === 'function') ? (sentinel.getSentinel() || null) : null; }
  catch (_e) { live = null; }
  // "fresh" = sentinel actually has breadth data AND a known regime AND was actually computed
  // recently. fix49s: this previously checked shape only (pair_count>0, regime known) — a frozen-
  // but-structurally-valid object passes that forever, which is exactly how BREADTH_FIGHT's own
  // staleness guard (_bUsable) got silently defeated during the 12.5h freeze: this function kept
  // reporting stale:false, ageMs:0 no matter how old `live` actually was, while the OTHER staleness
  // guard (SENTINEL_SIDE_BLOCKED, which reads sent.updatedAt directly) correctly caught it. Now both
  // paths agree on what "fresh" means.
  const _volPairs = num(live?.vol?.pair_count, num(live?.components?.vol?.pair_count, 0));
  const _regimeKnown = live && live.market_regime && live.market_regime !== 'UNKNOWN';
  const _liveAgeMs = live && live.updatedAt ? (Date.now() - live.updatedAt) : Infinity;
  const _fresh = !!live && _volPairs > 0 && _regimeKnown && _liveAgeMs <= 30 * 60 * 1000; // matches the existing 30min tolerance already used at every _bUsable call site
  if (_fresh) {
    _lastGoodSentinel = live;
    _lastGoodSentinelAt = Date.now();
    return { sent: live, stale: false, ageMs: 0 };
  }
  if (_lastGoodSentinel) {
    return { sent: _lastGoodSentinel, stale: true, ageMs: Date.now() - _lastGoodSentinelAt };
  }
  return { sent: live, stale: false, ageMs: 0 }; // nothing cached yet — return live (may be empty)
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// fix48k: immutable creation timestamp for a signal.
// ROOT CAUSE of the WAITING-zombie bug: expiry was keyed off `createdAt || updatedAt`.
// WAITING signals are re-evaluated every scan, which bumps `updatedAt` to ~now, so the
// computed age reset to near-zero every cycle and the 45-min hard cap NEVER fired
// (LAB observed stuck 23.5h). The signalId carries an immutable birth epoch
// (`v4c_<symbol>_<side>_<epochMs>`); we use that as the authoritative floor. It cannot
// be bumped by any later write. Falls back to createdAt only if the id can't be parsed,
// and NEVER falls back to updatedAt or now (those are the values that caused the bug).
function signalBirthMs(s) {
  if (!s) return 0;
  // 1) parse epoch from signalId / id tail (most reliable, immutable)
  const idStr = String(s.signalId || s.id || '');
  const tail = idStr.split('_').pop();
  const fromId = Number(tail);
  if (Number.isFinite(fromId) && fromId > 1e12) return fromId; // sane ms epoch
  // 2) fall back to createdAt ONLY (never updatedAt/now — those reset the clock)
  const c = Number(s.createdAt);
  if (Number.isFinite(c) && c > 1e12) return c;
  // 3) unknown birth -> return 0 so age = now (forces expiry of un-datable stale rows)
  return 0;
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

// fixEUPHADX: standard Wilder ADX(len) — a genuine trend-STRENGTH read (separate from the EMA20/50
// direction read trendFromCloses gives). Needs len*2+ bars for the smoothing to settle; the 15m series
// coinTrendEngine already fetches (60 bars) is used, so this costs zero new I/O. Returns 0 on insufficient
// data (fail-open — callers must treat 0 as "unknown", never as "definitely weak").
function calcADX(candles, len = 14) {
  if (!Array.isArray(candles) || candles.length < len * 2 + 1) return 0;
  const n = candles.length;
  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  // Wilder smoothing (running sum method), seeded from the first `len` values
  const wilderSmooth = (arr) => {
    const out = [];
    let sum = arr.slice(0, len).reduce((a, b) => a + b, 0);
    out.push(sum);
    for (let i = len; i < arr.length; i++) {
      sum = sum - (sum / len) + arr[i];
      out.push(sum);
    }
    return out;
  };
  const trS = wilderSmooth(tr), pDMS = wilderSmooth(plusDM), mDMS = wilderSmooth(minusDM);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    if (!(trS[i] > 0)) { dx.push(0); continue; }
    const pDI = 100 * (pDMS[i] / trS[i]);
    const mDI = 100 * (mDMS[i] / trS[i]);
    const sum = pDI + mDI;
    dx.push(sum > 0 ? 100 * Math.abs(pDI - mDI) / sum : 0);
  }
  if (dx.length < len) return 0;
  return avg(dx.slice(-len)); // ADX = smoothed average of DX over `len`
}

function trendFromCloses(closes) {
  if (!Array.isArray(closes) || closes.length < 30) return 'unknown';
  const price = closes[closes.length - 1];
  const fast = sma(closes, 9);
  const slow = sma(closes, 21);
  const base = sma(closes, 50) || slow;
  // fix43e: reverted 0.995/1.005 back to 0.998/1.002 (0.2% band)
  // fix43d widened to 0.5% — caused MORE pairs to qualify as trending → trend.aligned inflated
  // → signals escaped the 78 score cap incorrectly → score 86-90 collapsed from 88%→22% WR
  // 0.2% band was correct — tight threshold ensures only genuinely trending pairs qualify
  if (price > slow && fast >= slow && price >= base * 0.998) return 'bull';
  if (price < slow && fast <= slow && price <= base * 1.002) return 'bear';
  return 'neutral';
}

function detectSwings(candles, lr = 3) { // FIX7: was lr=2; too strict, missed many valid swing highs/lows
  const highs = [], lows = [];
  if (!Array.isArray(candles) || candles.length < lr * 2 + 5) return { highs, lows };
  for (let i = lr; i < candles.length - lr; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lr; j <= i + lr; j++) {
      if (j === i) continue;
      // fix43d: was >= / <= which excluded co-equal swing highs/lows (double tops, double bottoms)
      // Changed to strict > / < so equal-price neighbours don't invalidate a valid pivot
      if (candles[j].high > candles[i].high) isHigh = false;
      if (candles[j].low < candles[i].low) isLow = false;
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
      price: num(x.lastPrice), // fix33-obs8b: sentinelBrain filters p.price (not p.lastPrice) — alias needed for breadth
      open: num(x.prevPrice24h || x.openPrice), // fix33-obs8: needed by sentinel breadth (was undefined -> 0 pairs)
      high: num(x.highPrice24h),
      low: num(x.lowPrice24h),
      volume: num(x.volume24h),
      change24h: num(x.price24hPcnt) * 100,
      volume24h: num(x.volume24h),
      turnover24h: num(x.turnover24h),
      // fixMICRO: per-symbol funding + OI, already present on Bybit's /v5/market/tickers response but
      // previously dropped. Needed for the Direction Brain's micro layer (per-coin funding DIVERGENCE from
      // market-wide funding — the fusion input the walk-forward harness found the ledger currently lacks).
      // Zero extra API calls: same payload already fetched every scan tick.
      fundingRate: num(x.fundingRate),
      openInterest: num(x.openInterest),
      openInterestValue: num(x.openInterestValue),
    }));
}

// ── fixLOOP (hotfix 22, 2026-07-24): short-TTL kline cache ──────────────────────────────────────
//   fetchKline was UNCACHED and the scan calls it 1-2x per pair across ~529 pairs every sweep =
//   500-1000 serial Bybit REST calls, which saturated the link on the 0.2-vCPU box: the sentinel's
//   own calls queued past its 90s watchdog, the price feed went stale (307s), the UI lost the
//   backend, AND confirmed market orders filled seconds late (the late fill that gutted winner P&L).
//   This cache lets the bounded-parallel prefetch (see scanOnce) and the sequential build loop share
//   one fetch per (symbol,interval,limit) within a sweep, and dedups the 1m/5m/etc. re-fetches.
//   TTL is short (default 12s < one sweep) so structure analysis never runs on stale candles; live
//   ENTRY confirmation uses live ticker price via signalEntryTiming, NOT this cache, so timing is
//   unaffected. Env V4_KLINE_CACHE_MS to tune; 0 disables.
const KLINE_CACHE_MS = Math.max(0, Number(process.env.V4_KLINE_CACHE_MS || '12000'));
const _klineCache = new Map(); // key `${symbol}|${interval}|${limit}` -> { at, data }
async function fetchKline(symbol, interval = '5', limit = 100) {
  const key = `${symbol}|${interval}|${limit}`;
  if (KLINE_CACHE_MS > 0) {
    const hit = _klineCache.get(key);
    if (hit && (Date.now() - hit.at) < KLINE_CACHE_MS) return hit.data;
  }
  const data = await publicGet('/v5/market/kline', { category: 'linear', symbol, interval, limit });
  const list = data.result?.list || [];
  const out = list.map(r => ({
    ts: num(r[0]),
    open: num(r[1]),
    high: num(r[2]),
    low: num(r[3]),
    close: num(r[4]),
    volume: num(r[5]),
    turnover: num(r[6]),
  })).sort((a, b) => a.ts - b.ts);
  if (KLINE_CACHE_MS > 0) {
    _klineCache.set(key, { at: Date.now(), data: out });
    // bound memory: drop oldest entries past a soft cap (universe*~4 intervals)
    if (_klineCache.size > 3000) {
      const cutoff = Date.now() - KLINE_CACHE_MS;
      for (const [k, v] of _klineCache) { if (v.at < cutoff) _klineCache.delete(k); }
    }
  }
  return out;
}

// fix24-b: BTC regime detection delegated to regimeBrain (6-state)
// updateBtcRegime kept as alias for any callers outside this file
async function updateBtcRegime() {
  return detectBTCRegime();
}

function currentSettings() {
  const s = getSettings();
  return {
    ...s,
    version: V4_VERSION,
    minScoreToTrade: num(s.minScoreToTrade, 72), // fix37: keep 72 base (72-75 band = 100% WR in data)
    maxTradeUsdt: num(s.maxTradeUsdt, 10),
    leverage: Math.max(1, num(s.leverage, 5)), // fix37: default was 1, must match config.js DEFAULTS.leverage=5
    maxOpenTrades: Math.max(1, num(s.maxOpenTrades, 10)),
    safeMode: s.safeMode !== false,
    oneTradePerSymbol: s.oneTradePerSymbol !== false,
    rejectUnknownBtcRegime: s.rejectUnknownBtcRegime === true,
    rejectTrendConflict: s.rejectTrendConflict !== false,
    rejectRsiConflict: s.rejectRsiConflict !== false,
    rejectVolumeDeltaConflict: false, // FIX11: was s.rejectVolumeDeltaConflict !== false; filter is dead (no volume delta computed), always disable to stop misleading diagnostics
    rejectMixedBtcRegime: s.rejectMixedBtcRegime === true, // fix27: was !== false → forced true even when config default is false. Now respects config.js DEFAULTS.rejectMixedBtcRegime=false
    rejectMildExtension: s.rejectMildExtension !== false && REJECT_MILD_EXTENSION,       // fix43c: was ignoring V4_REJECT_MILD_EXTENSION env var
    rejectMomentumConflict: s.rejectMomentumConflict !== false && REJECT_MOMENTUM_CONFLICT, // fix43c: was ignoring V4_REJECT_MOMENTUM_CONFLICT env var
    entryConfirmationRequired: s.entryConfirmationRequired !== false && ENTRY_CONFIRMATION_REQUIRED, // fix43c: was ignoring V4_ENTRY_CONFIRMATION_REQUIRED env var
    elliottWaveFilterEnabled: s.elliottWaveFilterEnabled !== false,
    rejectElliottConflict: s.rejectElliottConflict !== false && REJECT_ELLIOTT_CONFLICT,   // fix43c: was ignoring V4_REJECT_ELLIOTT_CONFLICT env var
    v4MinRR: Math.max(1.2, num(s.v4MinRR, MIN_RR)),
    v4MinSellRR: Math.max(1.2, num(s.v4MinSellRR, MIN_SELL_RR)),
    minEntryTimingScore: 0, // fix24-b: replaced by two-gate system — kept for compat, not used for blocking
    v4MinBuyEntryTimingScore: 0,
    v4MinSellEntryTimingScore: 0,
    v4EntryReactionBps: Math.max(1, Math.min(15, num(s.v4EntryReactionBps, ENTRY_REACTION_BPS))),
    v4EntryWaitSeconds: Math.max(5, Math.min(300, num(s.v4EntryWaitSeconds, ENTRY_CONFIRMATION_WINDOW_MS / 1000))), // fix33: raised clamp 60->300 to match config.js
    v4EntryToleranceAtr: Math.max(0.15, Math.min(0.50, num(s.v4EntryToleranceAtr, ENTRY_TOLERANCE_ATR))),
    v4WaitingExpiryMinutes: Math.max(10, Math.min(240, num(s.v4WaitingExpiryMinutes, EXPIRY_MS / 60000))),
    v4SymbolLossCooldownMinutes: Math.max(15, Math.min(480, num(s.v4SymbolLossCooldownMinutes, COOLDOWN_MS / 60000))), // fix47: raised clamp 240→480 to match config.js clampSettings()
    btcRegimeMode: String(s.btcRegimeMode || 'direction_match'),
    elliottWaveWeight: String(s.elliottWaveWeight || 'normal'),
    experimentPresetMode: String(s.experimentPresetMode || 'research'),
    minSlDistancePct: Math.max(0, num(s.minSlDistancePct, MIN_SL_DISTANCE_PCT)),
    v4MinNetTpUsdt: Math.max(0, num(s.v4MinNetTpUsdt, MIN_NET_TP)),
    v4MinNetTpFeeMult: Math.max(0, Math.min(10, num(s.v4MinNetTpFeeMult, MIN_NET_TP_FEE_MULT))),
    v4MinNetRR: Math.max(0, Math.min(5, num(s.v4MinNetRR, MIN_NET_RR))),
    v4MaxFrontendTpPct: Math.max(0.2, Math.min(50, num(s.v4MaxFrontendTpPct, MAX_FRONTEND_TP_PCT))),
    v4DiagnosticJournal: s.v4DiagnosticJournal !== false,
    v4MaxTpAtr: Math.max(1.0, Math.min(8.0, num(s.v4MaxTpAtr, MAX_TP_ATR))),
    v4RiskWindowHours: Math.max(1, Math.min(72, num(s.v4RiskWindowHours, RISK_WINDOW_HOURS))),
    // fixSIZE: constant dollar risk per trade. 0 = legacy fixed-notional sizing (the old bug).
    // Default 0.25 USDT = 0.5% of a 50 USDT account. Because qty = min(riskQty, marginCapQty), this
    // can only ever SHRINK a position vs the old behaviour — it is strictly de-risking, never
    // additive. It also makes the session loss breaker meaningful for the first time: at 0.25/trade,
    // the 3 USDT cap is exactly 12 losing trades, instead of "somewhere between 8 and 20, unknowable".
    v4RiskPerTradeUsdt: Math.max(0, Math.min(5, num(s.v4RiskPerTradeUsdt, 0.25))),
    v4MaxConsecutiveLosses: Math.max(1, Math.min(20, parseInt(s.v4MaxConsecutiveLosses || MAX_CONSECUTIVE_LOSSES, 10) || MAX_CONSECUTIVE_LOSSES)),
    v4MaxSessionLossUsdt: Math.max(0, num(s.v4MaxSessionLossUsdt, MAX_SESSION_LOSS_USDT)),
  };
}

function minRRFor(side, settings = currentSettings()) {
  // fix47: floor 2.0 only — no score tier, no ceiling. Market determines TP.
  // V44 data: RR 1.8-2.0 = 21.7% WR, -5.306U (23 trades). RR 2.0-2.5 = 59.5% WR (131 trades).
  const baseRR = Math.max(2.0, num(side === 'SELL' ? settings.v4MinSellRR : settings.v4MinRR, side === 'SELL' ? MIN_SELL_RR : MIN_RR));
  return baseRR;
}

function minNetTpFor(settings = currentSettings(), math = null) {
  return minNetTpDetails(settings, math).required;
}

function minNetTpDetails(settings = currentSettings(), math = null) {
  const base = Math.max(0, num(settings.v4MinNetTpUsdt, MIN_NET_TP));
  const feeMult = Math.max(0, num(settings.v4MinNetTpFeeMult, MIN_NET_TP_FEE_MULT));
  const feeEst = Math.max(0, num(math?.feeEstUSDT, 0));
  const feeSafe = feeEst > 0 ? feeEst * feeMult : 0;
  const required = Math.max(base, feeSafe);
  return {
    required: Number(required.toFixed(4)),
    base: Number(base.toFixed(4)),
    feeSafe: Number(feeSafe.toFixed(4)),
    feeEstUSDT: Number(feeEst.toFixed(4)),
    feeMultiplier: Number(feeMult.toFixed(2)),
    mode: 'max(base, roundTripCost * feeMultiplier)'
  };
}


// ── fix49p: BREADTH SLOPE (controlled experiment, flag-gated) ──────────────────
// Reconstructs the recent breadth trajectory from breadth_history.ndjson and returns its slope
// over a configurable window. Used ONLY by the conflict-lead experiment below; returns a safe
// "flat/unknown" result on any error so it can never break scoring.
//
// Data-derived design (from 5h of live breadth, 2026-06-19): breadth moves as a slow STAIRCASE,
// ~0.19%/min average, ~1.3%/min max. So a meaningful directional move needs a 20-30 min window,
// not minute-to-minute (which is mostly flat noise). Defaults: 25-min window, need >=1.5% net move
// AND monotonic-ish direction (>=60% of steps agree) to call it "rising"/"falling".
function breadthSlope(settings = currentSettings()) {
  const SLOPE_CACHE_MS = Math.max(15000, Number(process.env.V4_BREADTH_SLOPE_CACHE_MS || '30000'));
  const now = Date.now();
  if (_breadthSlopeCache.at && (now - _breadthSlopeCache.at) < SLOPE_CACHE_MS) {
    return _breadthSlopeCache; // reuse within the scan cycle
  }
  const result = { at: now, slope: 'flat', dir: 0, netMove: 0, samples: 0, firstPct: null, lastPct: null, windowMin: 0 };
  try {
    const windowMin = Math.max(10, Number(process.env.V4_BREADTH_SLOPE_WINDOW_MIN || '25'));
    const minMove   = Math.max(0.5, Number(process.env.V4_BREADTH_SLOPE_MIN_MOVE || '1.5'));
    const cutoff = now - windowMin * 60 * 1000;
    // bounded read (same safety as fix49m trim) — newest-first
    const rows = (typeof store.readNdjsonTail === 'function') ? (store.readNdjsonTail('breadth_history', 60) || []) : [];
    const pts = rows
      .map(r => ({ ts: num(r?.ts, 0), pct: num(r?.bull_pct, NaN) }))
      .filter(p => p.ts >= cutoff && Number.isFinite(p.pct))
      .sort((a, b) => a.ts - b.ts); // chronological
    result.samples = pts.length;
    if (pts.length >= 3) {
      result.firstPct = Number(pts[0].pct.toFixed(1));
      result.lastPct  = Number(pts[pts.length - 1].pct.toFixed(1));
      result.windowMin = Math.round((pts[pts.length - 1].ts - pts[0].ts) / 60000);
      result.netMove = Number((result.lastPct - result.firstPct).toFixed(2));
      // monotonic-ish check: fraction of step-deltas agreeing with net direction
      let up = 0, down = 0, steps = 0;
      for (let i = 1; i < pts.length; i++) {
        const d = pts[i].pct - pts[i - 1].pct;
        if (d > 0) up++; else if (d < 0) down++;
        if (d !== 0) steps++;
      }
      const agreeUp   = steps > 0 ? up / steps : 0;
      const agreeDown = steps > 0 ? down / steps : 0;
      if (result.netMove >= minMove && agreeUp >= 0.6)       { result.slope = 'rising';  result.dir = 1; }
      else if (result.netMove <= -minMove && agreeDown >= 0.6){ result.slope = 'falling'; result.dir = -1; }
      else                                                    { result.slope = 'flat';    result.dir = 0; }
    }
  } catch (_e) { /* fail-safe: flat/unknown */ }
  _breadthSlopeCache = result;
  return result;
}

// ── fix53: BREADTH-VOLATILITY CIRCUIT BREAKER ───────────────────────────────
// Root cause of the 06-25→06-26 loss cluster (calibrated on 241 trades + the breadth series):
// breadth flipped from a stable deep-bear GRIND (60-min range ~2-4 pts) into a WHIPSAW (range 55;
// spiked 19%→63.5% at 23:00 LK then collapsed). The SELL-only W5-exhaustion book kept firing into
// the relief bounces — recent-loser maeR median −1.91R (immediately wrong, not give-back).
//
// A breadth-LEVEL gate can't catch this: only 2 SELLs ever ENTERED at breadth≥50 because the spike
// happens AFTER entry. A directional SLOPE gate also failed to separate (n=2). What DID separate
// cleanly was trailing-60min breadth RANGE: blocking entries when range ≥ ~22-25 removed 9 trades,
// 0W/9L (−3.06U), lifting in-window WR 39%→48% and net +3.14U→+6.21U. Stable across 20-25.
//
// This is ALSO the sentinel-lag fix: the composite regime label stays STRONG_BEAR (correctly — its
// 4-read hysteresis must NOT be made twitchy or it flip-flops into paralysis). Instead this is a
// fast REFLEX layered on top that pauses BOTH sides during instability, overriding the stale label
// without touching it. Fails OPEN (never blocks) when there aren't enough samples to trust the range,
// so a breadth-data gap can never freeze trading.
let _breadthChopCache = { at: 0, range: null, samples: 0, hi: null, lo: null, windowMin: 0, chop: false, threshold: 0 };
let _lastChopAt = 0;
function breadthChop(settings = currentSettings()) {
  const CACHE_MS = Math.max(15000, Number(process.env.V4_BREADTH_SLOPE_CACHE_MS || '30000'));
  const now = Date.now();
  if (_breadthChopCache.at && (now - _breadthChopCache.at) < CACHE_MS) return _breadthChopCache;
  const windowMin = Math.max(20, Number(process.env.V4_BREADTH_CHOP_WINDOW_MIN || '60'));
  const threshold = Math.max(5, Number(process.env.V4_BREADTH_CHOP_THRESHOLD || '25')); // default 25 (looser; data-clean 20-25)
  const minSamples = Math.max(3, Number(process.env.V4_BREADTH_CHOP_MIN_SAMPLES || '8')); // fail-open below this
  const result = { at: now, range: null, samples: 0, hi: null, lo: null, windowMin, chop: false, threshold };
  try {
    const cutoff = now - windowMin * 60 * 1000;
    const rows = (typeof store.readNdjsonTail === 'function') ? (store.readNdjsonTail('breadth_history', Math.max(80, windowMin + 20)) || []) : [];
    const vals = rows
      .map(r => ({ ts: num(r?.ts, 0), pct: num(r?.bull_pct, NaN) }))
      .filter(p => p.ts >= cutoff && Number.isFinite(p.pct))
      .map(p => p.pct);
    result.samples = vals.length;
    if (vals.length >= minSamples) {
      result.hi = Number(Math.max(...vals).toFixed(1));
      result.lo = Number(Math.min(...vals).toFixed(1));
      result.range = Number((result.hi - result.lo).toFixed(1));
      result.chop = result.range >= threshold;
    }
    // else: too few samples → fail-open (chop stays false)
  } catch (_e) { /* fail-open */ }
  if (result.chop) _lastChopAt = now;
  _breadthChopCache = result;
  return result;
}
// Breaker is ACTIVE while breadth is choppy OR within a short min-hold after the last chop reading,
// so entries don't resume on the exact tick the range dips (the bounce is often still resolving).
// Respects a settings toggle (default ON) so it can be disabled from the UI without a redeploy.
function breadthChopActive(now = Date.now(), settings = currentSettings()) {
  if (settings && settings.v4BreadthChopBreaker === false) return false;
  if (process.env.V4_BREADTH_CHOP_DISABLE === '1') return false;
  const minHoldMs = Math.max(0, Number(process.env.V4_BREADTH_CHOP_MIN_HOLD_MIN || '20')) * 60 * 1000;
  const c = breadthChop(settings);
  return !!c.chop || (_lastChopAt > 0 && (now - _lastChopAt) < minHoldMs);
}
function getBreadthChopState() {
  const c = _breadthChopCache && _breadthChopCache.at ? _breadthChopCache : breadthChop();
  return { range: c.range, hi: c.hi, lo: c.lo, samples: c.samples, windowMin: c.windowMin, threshold: c.threshold, chop: !!c.chop, active: breadthChopActive(), lastChopAt: _lastChopAt };
}

// fixBOTTOM: breadth RANGE-PERCENTILE — where does the CURRENT breadth reading sit within its own
// trailing window's range? pctile 0 = at the window low ("the absolute bottom"), 100 = at the high.
// Same cached-ndjson-tail pattern as breadthChop (fix49p) — one full-file read per 60s, shared by
// every signal born in that minute; readNdjsonTail returns rows NEWEST-FIRST (rows[0] = latest).
// Fail-open: returns pctile null (guard inactive, capture null) on cold start / thin history / errors.
let _breadthPctileCache = { at: 0, pctile: null, samples: 0, cur: null, hi: null, lo: null, btcRsi: null, btcRsiHi: null, btcRsiLo: null, composite: null, windowMin: 0 };
function breadthRangePctile() {
  const CACHE_MS = 60 * 1000;
  const now = Date.now();
  if (_breadthPctileCache.at && (now - _breadthPctileCache.at) < CACHE_MS) return _breadthPctileCache;
  const result = { at: now, pctile: null, samples: 0, cur: null, hi: null, lo: null, btcRsi: null, btcRsiHi: null, btcRsiLo: null, composite: null, windowMin: BOTTOM_WINDOW_MIN };
  try {
    const cutoff = now - BOTTOM_WINDOW_MIN * 60 * 1000;
    const rows = (typeof store.readNdjsonTail === 'function') ? (store.readNdjsonTail('breadth_history', BOTTOM_WINDOW_MIN + 60) || []) : [];
    const pts = rows
      .map(r => ({ ts: num(r?.ts, 0), pct: num(r?.bull_pct, NaN), rsi: num(r?.btc_rsi, NaN), comp: num(r?.composite, NaN) }))
      .filter(p => p.ts >= cutoff && Number.isFinite(p.pct));
    result.samples = pts.length;
    // fixEUPH: cur/btcRsi/composite hoisted OUT of the 30-sample gate — they only need the single
    // newest sample. Before this, a cold pod restart left absolute-level consumers (fixEUPH guard,
    // absBreadthAtEntry capture) blind for ~30 minutes for no reason. pctile stays gated: a
    // percentile over <30 samples is statistically meaningless, an absolute level is not.
    if (pts.length >= 1) {
      const cur = pts[0].pct; // rows are newest-first
      result.cur = Number(cur.toFixed(1));
      result.btcRsi = Number.isFinite(pts[0].rsi) ? pts[0].rsi : null;
      result.composite = Number.isFinite(pts[0].comp) ? pts[0].comp : null;
      // fixFADE (.77): trailing RSI hi/lo over the SAME window read (no extra fetch). Feeds the fade
      // module's rollover test — euphoria fade wants rsi to have peaked >=70 then rolled back under;
      // despair mirror wants a >=30 trough recovery. Populated on >=1 sample (single sample ⇒ hi=lo).
      const _rsiVals = pts.map(p => p.rsi).filter(v => Number.isFinite(v));
      if (_rsiVals.length) {
        result.btcRsiHi = Number(Math.max(..._rsiVals).toFixed(1));
        result.btcRsiLo = Number(Math.min(..._rsiVals).toFixed(1));
      }
    }
    if (pts.length >= BOTTOM_MIN_SAMPLES) {
      const _curRaw = pts[0].pct; // raw, not the display-rounded result.cur — keeps pctile byte-identical to pre-hoist behavior
      const vals = pts.map(p => p.pct);
      result.hi = Number(Math.max(...vals).toFixed(1));
      result.lo = Number(Math.min(...vals).toFixed(1));
      result.pctile = Number((100 * vals.filter(v => v < _curRaw).length / vals.length).toFixed(1));
    }
  } catch (_e) { /* fail-open */ }
  _breadthPctileCache = result;
  return result;
}
function getBreadthPctileState() { return _breadthPctileCache && _breadthPctileCache.at ? _breadthPctileCache : breadthRangePctile(); }


function minNetRRFor(settings = currentSettings()) {
  return Math.max(0, Math.min(5, num(settings.v4MinNetRR, MIN_NET_RR)));
}

function minScoreForSide(side, settings = currentSettings()) {
  // fix24e: make the UI field "MIN SCORE TO TRADE" the authority.
  // Older safe-mode defaults left v4MinSellScore=86/minScoreToTrade=84, so the
  // UI could show 70 while backend rejects with SCORE_LT_84/86. Side-specific
  // score gates are now opt-in only via v4UseSideMinScores=true.
  // fix28: raise all defaults to 70. Data: 40-69=25%WR(-11U), 70-79=57%WR(+7U).
  // Low-score trades trigger consec loss block (249 blocks!) preventing good signals from firing.
  const fallback = Math.max(0, Math.min(100, num(settings.minScoreToTrade, 70)));
  // v4UseSideMinScores: default true (fix27). Was opt-in; side scores were always set same.
  let threshold;
  if (settings.v4UseSideMinScores === false) threshold = fallback;
  else threshold = String(side || '').toUpperCase() === 'SELL'
    ? Math.max(0, Math.min(100, num(settings.v4MinSellScore, fallback)))
    : Math.max(0, Math.min(100, num(settings.v4MinBuyScore, fallback)));
  // fix48h: the continuous conviction model (BASE=46 × quality) produces a different distribution
  // than the old additive buckets — a GOOD aligned trade now scores ~62-72, IDEAL ~95-100. Old
  // saved safe-mode thresholds (84/86) would silence the system. Clamp the effective gate to a
  // ceiling appropriate for the new scale so the bot can never go mute from stale settings.
  // fix48r: ceiling raised 68→75. The 68 cap was silently eating the user's deliberate 70 floor
  // (ATOM fired at 68 after floor set to 70). 75 honors any sane floor (50-75) while still
  // blocking stale 84/86 safe-mode values that would mute the bot. Keep the clamp — don't remove.
  const NEW_SCALE_THRESHOLD_CEIL = Math.max(50, Number(process.env.V4_SCORE_THRESHOLD_CEIL || '75'));
  if (threshold > NEW_SCALE_THRESHOLD_CEIL) threshold = NEW_SCALE_THRESHOLD_CEIL;
  return threshold;
}

function minEntryTimingForSide(side, settings = currentSettings()) {
  // fix25b: entry timing is disabled (fix24-b). Fallback 0 so it never blocks.
  // Do NOT use minScoreToTrade as fallback - different scale entirely.
  const fallback = num(settings.minEntryTimingScore, 0);
  return String(side || '').toUpperCase() === 'SELL'
    ? Math.max(0, Math.min(100, num(settings.v4MinSellEntryTimingScore, fallback)))
    : Math.max(0, Math.min(100, num(settings.v4MinBuyEntryTimingScore, fallback)));
}

function sideAllowed(side, settings = currentSettings()) {
  return String(side || '').toUpperCase() !== 'SELL' || settings.v4AllowSells === true;
}

function frontendMaxTpPctFor(settings = currentSettings()) {
  return Math.max(0.2, Math.min(50, num(settings.v4MaxFrontendTpPct, MAX_FRONTEND_TP_PCT)));
}

function diagnosticEnabled(settings = currentSettings()) {
  return settings.v4DiagnosticJournal !== false && DIAGNOSTIC_JOURNAL;
}

let diagnosticRecentCache = null;

function normalizeDiagnosticRow(row) {
  const now = Date.now();
  return {
    at: num(row?.at, now),
    iso: row?.iso || new Date(num(row?.at, now)).toISOString(),
    version: row?.version || V4_VERSION,
    ...row,
  };
}

function loadDiagnostics(limit = MAX_DIAGNOSTIC_ROWS) {
  const max = Math.max(1, Math.min(parseInt(limit || MAX_DIAGNOSTIC_ROWS, 10) || MAX_DIAGNOSTIC_ROWS, MAX_DIAGNOSTIC_ROWS));
  const fromNdjson = typeof store.readNdjsonTail === 'function' ? store.readNdjsonTail('v4_diagnostic_journal', max) : [];
  if (fromNdjson.length) return fromNdjson.slice(0, max);
  const legacy = store.read('v4_diagnostic_journal', []);
  return Array.isArray(legacy) ? legacy.slice(0, max) : [];
}

function getDiagnostics(limit = 500) {
  const max = Math.max(1, Math.min(parseInt(limit || 500, 10) || 500, MAX_DIAGNOSTIC_ROWS));
  if (diagnosticRecentCache && diagnosticRecentCache.length >= max) return diagnosticRecentCache.slice(0, max);
  return loadDiagnostics(max);
}

// fix49q: BREADTH-HISTORY READ ROUTE SUPPORT. The fix49l logger writes breadth_history.ndjson
// (sentinel bull_pct + btc regime, once/min) and breadthSlope() reads it server-side, but there
// was NO API route exposing it — so the continuous breadth time-series could not be fetched
// externally (every /breadth* URL 404'd). This returns the recent breadth series, newest-first,
// bounded (read-only, same safe readNdjsonTail path breadthSlope uses; capped to protect memory).
// Also returns the current computed slope so the trend is visible without client-side math.
function getBreadthHistory(limit = 1000) {
  const max = Math.max(1, Math.min(parseInt(limit || 1000, 10) || 1000, 10000));
  let rows = [];
  try {
    rows = (typeof store.readNdjsonTail === 'function') ? (store.readNdjsonTail('breadth_history', max) || []) : [];
  } catch (_e) { rows = []; }
  let slope = null;
  try { slope = breadthSlope(currentSettings()); } catch (_e) { slope = null; }
  return { rows: Array.isArray(rows) ? rows.slice(0, max) : [], slope };
}

function appendDiagnosticJournal(row, settings = currentSettings()) {
  if (!diagnosticEnabled(settings)) return;
  try {
    const cleanRow = normalizeDiagnosticRow(row || {});
    // Append-only NDJSON is the durable diagnostic source of truth. This avoids
    // repeatedly rewriting a large JSON array during high-frequency scans.
    if (typeof store.appendNdjson === 'function') {
      store.appendNdjson('v4_diagnostic_journal', cleanRow);
      // fix49n: DIAGNOSTIC JOURNAL SIZE CAP. The NDJSON journal was append-only with NO trimming —
      // it grew unbounded every scan cycle (hundreds of rejected-candidate rows per minute). With
      // persistence ON this file survived restarts and ballooned across the day, and reads of it
      // (loadDiagnostics / the /diagnostics route) loaded the whole thing into memory — the OOM that
      // crash-looped the 512MB container. Cap it: every ~200 appends, bound the file to the most
      // recent MAX_DIAGNOSTIC_ROWS via a single bounded read + rewrite (best-effort, never disrupts).
      try {
        _diagJournalWrites = (_diagJournalWrites + 1) % 200;
        if (_diagJournalWrites === 0 && typeof store.readNdjsonTail === 'function' && typeof store.rewriteNdjson === 'function') {
          const _cap = Math.min(MAX_DIAGNOSTIC_ROWS, 10000);
          const _recent = store.readNdjsonTail('v4_diagnostic_journal', _cap) || []; // newest-first, bounded
          // rewriteNdjson writes oldest→newest in file order; readNdjsonTail returns newest-first, so reverse.
          if (_recent.length >= _cap) store.rewriteNdjson('v4_diagnostic_journal', _recent.slice().reverse());
        }
      } catch (_e) { /* trim is best-effort; never disrupt the scan */ }
    } else {
      const rows = store.read('v4_diagnostic_journal', []);
      const clean = Array.isArray(rows) ? rows : [];
      store.write('v4_diagnostic_journal', [cleanRow].concat(clean).slice(0, MAX_DIAGNOSTIC_ROWS));
    }
    const base = Array.isArray(diagnosticRecentCache) ? diagnosticRecentCache : loadDiagnostics(Math.min(1000, MAX_DIAGNOSTIC_ROWS));
    const fingerprint = (r) => [r?.at, r?.type, r?.symbol || r?.sym || '', r?.side || '', r?.result || '', Array.isArray(r?.reasons) ? r.reasons.join('|') : ''].join('::');
    const cleanFp = fingerprint(cleanRow);
    const dedupedBase = (Array.isArray(base) ? base : []).filter(r => fingerprint(r) !== cleanFp);
    diagnosticRecentCache = [cleanRow].concat(dedupedBase).slice(0, Math.min(MAX_DIAGNOSTIC_ROWS, 5000));
    // Keep a small JSON mirror for older dashboards/scripts that still read
    // v4_diagnostic_journal.json directly. The full history lives in NDJSON.
    if (diagnosticRecentCache.length <= 25 || diagnosticRecentCache.length % 50 === 0) {
      store.write('v4_diagnostic_journal', diagnosticRecentCache.slice(0, 1000));
    }
  } catch (e) {
    console.warn('[v4 diagnostic journal]', e.message);
  }
}

// fix48l: backend-persisted alerts. Frontend alerts died on tab-freeze/close (the app even
// warns about this). These are written to the store so they survive and can be polled by any
// client via GET /api/signals/alerts. Capped to the most recent N.
const BACKEND_ALERT_TYPES = new Set([
  'ENTRY_CONFIRMED', 'PAPER_ACTIVE', 'TP_HIT', 'SL_HIT', 'WIN', 'LOSS',
  'REGIME_FLIP_EXIT', 'SENTINEL_SIDE_BLOCKED', 'CONTRARIAN_FLIP',
  'SIGNAL_EXPIRED', 'INVALIDATED'
]);
const MAX_BACKEND_ALERTS = 200;
function recordBackendAlert() { /* fix48l-revert: alerts feature removed, no-op */ }

function appendSignalDiagnostic(type, s, extra = {}, settings = currentSettings()) {
  try {
    appendDiagnosticJournal({
      at: Date.now(),
      iso: new Date().toISOString(),
      type,
      version: V4_VERSION,
      id: s?.id || s?.signalId || '',
      symbol: s?.sym || s?.symbol || '',
      side: s?.side || '',
      paperState: s?.paperState || '',
      status: s?.status || '',
      displayState: s?.displayState || '',
      positionStatus: s?.positionStatus || '',
      price: s?.backendLastPrice,
      entry: s?.entry,
      sl: s?.sl,
      tp1: s?.tp1,
      score: s?.score,
      entryTimingScore: s?.entryTimingScore,
      rr: s?.rr || s?.rr1,
      netTpUSDT: s?.netTpUSDT,
      netSlUSDT: s?.netSlUSDT,
      feeEstUSDT: s?.feeEstUSDT,
      stateReason: s?.stateReason || '',
      entryTiming: s?.entryTiming || {},
      diagnostic: s?.diagnostic || {},
      closeDiagnostic: s?.closeDiagnostic || null,
      historyTail: Array.isArray(s?.history) ? s.history.slice(-5) : [],
      ...extra
    }, settings);
  } catch (_e) {}
}

function expiryMsFor(settings = currentSettings()) {
  return Math.max(5, num(settings.v4WaitingExpiryMinutes, EXPIRY_MS / 60000)) * 60 * 1000;
}

function riskWindowMsFor(settings = currentSettings()) {
  return Math.max(1, num(settings.v4RiskWindowHours, RISK_WINDOW_HOURS)) * 60 * 60 * 1000;
}

function symbolLossLockoutMsFor(settings = currentSettings()) {
  return Math.max(1, num(settings.v4SymbolLossCooldownMinutes, SYMBOL_LOSS_LOCKOUT_MS / 60000)) * 60 * 1000;
}

function symbolWinCooldownMsFor(_settings = currentSettings()) {
  return SYMBOL_WIN_COOLDOWN_MS;
}

function maxTpAtrFor(settings = currentSettings()) {
  return Math.max(1.0, Math.min(8.0, num(settings.v4MaxTpAtr, MAX_TP_ATR)));
}

function calculatePaperMath(plan, settings) {
  const entry = num(plan.entry), tp = num(plan.tp1), sl = num(plan.sl);
  const margin = Math.max(1, num(settings.maxTradeUsdt, 10));
  const leverage = Math.max(1, num(settings.leverage, 5)); // fix37: default was 1 → signals calculated at 1x even when user set 5x
  const marginCapPosition = margin * leverage;

  // ── fixSIZE: RISK-NORMALIZED SIZING (paper side — must mirror executor.buildPlan exactly) ──────
  // Was: position = margin * leverage — FIXED NOTIONAL. Every trade took ~the same dollar position,
  // so money actually at risk = notional x stop%, and stop% varies hugely between setups.
  // Live proof (07/12): CLO stop 0.62% risked 0.155U, EDGE stop 1.56% risked 0.391U — 2.5x more real
  // money on one trade than another, from two identical-looking "2:1" plans. CLO won +0.369,
  // EDGE lost -0.391: one loss ate one win even though both brackets were >2:1. A 2:1 edge measured
  // in R never reaches the account while every R is a different number of dollars.
  // Now: choose the position so (position x stop%) == a CONSTANT dollar risk.
  //   position = (riskPerTradeUsdt / stopDistance) * entry
  // Hard-capped by margin x leverage, so the position can only ever SHRINK vs the old behaviour,
  // never grow: qty = min(riskQty, marginCapQty). Tight-stop trades are unchanged (they bind on the
  // margin cap); wide-stop trades — the ones that were quietly oversized — get smaller. Strictly
  // de-risking. RR is a ratio so the gates are untouched; only the dollar scale changes.
  const stopDist = (entry && sl) ? Math.abs(entry - sl) : 0;
  const riskPerTrade = Math.max(0, num(settings.v4RiskPerTradeUsdt, 0));
  let position = marginCapPosition;
  let sizingMode = 'FIXED_NOTIONAL';
  if (riskPerTrade > 0 && stopDist > 0 && entry > 0) {
    const riskPosition = (riskPerTrade / stopDist) * entry;
    position = Math.min(riskPosition, marginCapPosition);
    sizingMode = riskPosition > marginCapPosition ? 'RISK_MARGIN_CAPPED' : 'RISK';
  }

  const tpRaw = entry && tp ? Math.abs(tp - entry) / entry : 0;
  const slRaw = entry && sl ? Math.abs(entry - sl) / entry : 0;
  const grossTp = position * tpRaw;
  const grossSl = position * slRaw;
  const cost = position * (FEE_RATE + SLIPPAGE_RATE) * 2;
  const netTp = grossTp - cost;
  const netSl = -(grossSl + cost);
  const rr = grossSl ? grossTp / grossSl : 0;
  const netRr = Math.abs(netSl) ? Math.max(0, netTp) / Math.abs(netSl) : 0;
  return {
    margin, leverage, position,
    sizingMode,                                        // fixSIZE: RISK | RISK_MARGIN_CAPPED | FIXED_NOTIONAL
    riskUsdt: Number(grossSl.toFixed(4)),              // fixSIZE: the dollars actually at risk
    tpPct: Number((tpRaw * 100 * leverage).toFixed(3)),
    slPct: Number((slRaw * 100 * leverage).toFixed(3)),
    grossTp: Number(grossTp.toFixed(4)),
    grossSl: Number(grossSl.toFixed(4)),
    feeEstUSDT: Number(cost.toFixed(4)),
    netTpUSDT: Number(netTp.toFixed(4)),
    netSlUSDT: Number(netSl.toFixed(4)),
    rr: Number(rr.toFixed(3)),
    netRr: Number(netRr.toFixed(3)),
  };
}

// fix48: determineDirection — replaces sideFromTrends.
// Root cause of sideFromTrends: SMA trend (the weakest signal) had the most votes.
// A single SMA disagreement could veto a confirmed Elliott W5 + RSI divergence setup.
// New design: 3 independent signal families each cast one directional vote.
//   F1 = Elliott wave: W5 exhaustion → fade direction; W3 continuation → trend direction
//   F2 = RSI divergence + structure: divergence/CHoCH/BOS/trap direction
//   F3 = All-3TF SMA trend: all three SMAs must agree (unanimous only)
// Decision: 2+ families agree on same side → that side. Otherwise NEU.
// Edge = number of agreeing families (2 or 3).
function determineDirection(trend5, trend15, trend1h, elliottAnalysis, structure, coinTrend) {
  const votes = { BUY: [], SELL: [] };

  // — Family 1: Elliott Wave ———————————————————————————————————————————————
  // W5_EXHAUSTION: end of move — fade it (W5 UP → SELL, W5 DOWN → BUY)
  // W3_CONTINUATION: strongest wave — trade with it
  if (elliottAnalysis && elliottAnalysis.signal) {
    const ew = elliottAnalysis.signal;
    if ((ew.type === 'W5_EXHAUSTION' || ew.type === 'W3_CONTINUATION') && (ew.tradeSide === 'BUY' || ew.tradeSide === 'SELL')) {
      votes[ew.tradeSide].push('F1:Elliott_' + ew.type);
    }
  }

  // — Family 2: RSI Divergence + Structure ——————————————————————————————————
  // Any confirmed structure signal with a clear trade side counts as F2.
  // fix48b: SQUEEZE_RELEASE added — uses BOS direction if co-present (BOS gives direction);
  // standalone SQUEEZE_RELEASE abstains since it has no inherent directional bias.
  if (structure) {
    const dom = structure.dominant || 'NONE';
    if (dom === 'TRAP' && structure.trap?.tradeSide) {
      votes[structure.trap.tradeSide].push('F2:TRAP');
    } else if ((dom === 'CHOCH_CONFIRMED' || dom === 'CHOCH') && structure.choch) {
      const s = structure.choch.type === 'bull' ? 'BUY' : 'SELL';
      votes[s].push('F2:' + dom);
    } else if (dom === 'BOS' && structure.bos) {
      const s = structure.bos.type === 'bull' ? 'BUY' : 'SELL';
      votes[s].push('F2:BOS');
    } else if (dom === 'SQUEEZE_RELEASE' && structure.bos) {
      // Squeeze released WITH a BOS = directional breakout. BOS direction wins.
      const s = structure.bos.type === 'bull' ? 'BUY' : 'SELL';
      votes[s].push('F2:SQUEEZE_RELEASE+BOS');
    } else if (dom === 'DIVERGENCE' && structure.divergence?.tradeSide) {
      votes[structure.divergence.tradeSide].push('F2:DIVERGENCE');
    }
    // SQUEEZE_RELEASE alone: no directional vote — F2 abstains (direction unknown)
    // SQUEEZE alone: no vote — still compressing, no signal yet
  }

  // — Family 3: All-3TF SMA Trend ——————————————————————————————————————————
  // Must be unanimous across 5m, 15m, 1h — no partial credit
  if (trend5 === 'bull' && trend15 === 'bull' && trend1h === 'bull') {
    votes['BUY'].push('F3:all3TF_bull');
  } else if (trend5 === 'bear' && trend15 === 'bear' && trend1h === 'bear') {
    votes['SELL'].push('F3:all3TF_bear');
  }

  // — Family 4: Per-coin fast multi-TF trend (fixPCT Phase 1.5) ——————————————
  // coinTrendEngine reads 1m/3m/5m/15m (drops the lagging 1h). Casts ONE vote when STRONG, so a fresh
  // pump/dump the 1h hasn't caught up to can still reach a 2-family leader. GUARDED: only votes when F3
  // did NOT already vote the same side (F3 = all-3-TF incl. 1h) — no double-counting the trend.
  if (coinTrend && coinTrend.strength >= PCT_STRONG) {
    const f3bull = (trend5 === 'bull' && trend15 === 'bull' && trend1h === 'bull');
    const f3bear = (trend5 === 'bear' && trend15 === 'bear' && trend1h === 'bear');
    if (coinTrend.bias === 'up' && !f3bull)   votes['BUY'].push('F4:coinTrend_str' + coinTrend.strength);
    else if (coinTrend.bias === 'down' && !f3bear) votes['SELL'].push('F4:coinTrend_str' + coinTrend.strength);
  }

  const buyVotes  = votes['BUY'].length;
  const sellVotes = votes['SELL'].length;
  const reasons   = [...votes['BUY'], ...votes['SELL']];

  if (buyVotes >= 2 && buyVotes > sellVotes) {
    return { side: 'BUY',  edge: buyVotes,  familyVotes: votes, reasons };
  }
  if (sellVotes >= 2 && sellVotes > buyVotes) {
    return { side: 'SELL', edge: sellVotes, familyVotes: votes, reasons };
  }
  return { side: 'NEU', edge: 0, familyVotes: votes, reasons: ['no 2-family consensus', ...reasons] };
}


// fix48b: DEPRECATED — alignedTrendScore was used by calibratedScore (removed in fix48).
// Kept to avoid breaking any external callers. Do not use in new code.
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


// fix48b: DEPRECATED — elliottWaveContext (range-position Elliott) was used by calibratedScore.
// New Elliott detection is in structureDetector.analyzeElliottWaves / detectElliottWave.
// Kept to avoid breaking any external callers. Do not use in new code.
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
    if (highTfBear || momentumPct < -0.35) {
      // fix27: was (highTfBear || trend5 === 'bear' || momentumPct < -0.35)
      // trend5=bear alone triggered reject on every pullback BUY — wrong.
      // Only reject if BOTH 15m+1h are bear (true downtrend), or extreme momentum.
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
    if (highTfBull || momentumPct > 0.35) {
      // fix27: was (highTfBull || trend5 === 'bull' || momentumPct > 0.35)
      // trend5=bull alone triggered reject on every bounce SELL — wrong.
      // Only reject if BOTH 15m+1h are bull (true uptrend), or extreme momentum.
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

// fix24-b: Outcome-calibrated composite score
// Components: base(8) + elliottWave(0-10) + regimeAlignment(0-30) + direction(0-18)
//             + trend(0-15) + structure(0-10) + entry(0-12) + rr(0-15)
//             + volume(0-8) + rsi(0-8) + liquidity(0-5)
// regimeAlignment is now the highest-weight component (30pts max).
// High RR (>6) is penalised — feasibility gate (fix24-d) will handle this properly.
// fix48: convictionScore — replaces calibratedScore.
// fix48h: CONTINUOUS MULTIPLICATIVE CONVICTION MODEL — replaces the additive 3-bucket score.
//
// THE PROBLEM (confirmed across 81+ trades): the old score = family + entry + regimeAlignment
// produced only a handful of discrete totals (76/80/85/100). Score was NOT monotonic with win
// rate — 85-99 bucket went 0% WR, worse than 76. The score labelled signals, it didn't RANK them.
//
// THE FIX: a continuous quality score 0-100 built as base × product-of-factors, where each factor
// is a smooth 0..1.x multiplier grounded in the data. This spreads scores across the full range so
// the score actually correlates with expected win rate, and lets shouldReject's threshold filter by
// genuine quality rather than a coarse label.
//
//   factors (each continuous):
//     familyMult   — 3-family clearly > 2-family (consensus strength)
//     entryMult    — smooth curve peaking at the 0.5-1.0 ATR zone-touch sweet spot (51% WR)
//     regimeMult   — continuous regime alignment scaled by BTC trend STRENGTH; counter-trend punished
//     rrMult       — peaks at RR 2.0-2.6, decays toward 3.0 (RR>3 = 0 wins, blocked elsewhere)
//     rsiMult      — folds RSI back in (RSI=0 → 25% WR vs RSI>0 → 48%); was discarded before
//     volMult      — volume expansion confirmation (minor)
//
// No hard internal caps. Counter-trend / poor-entry signals score LOW instead of being clamped to a
// passing label, so the natural distribution does the filtering.
function _smoothPeak(x, lo, hi, peakLo, peakHi) {
  // returns 0..1: ramps 0→1 across [lo,peakLo], holds 1 across [peakLo,peakHi], ramps 1→0 across [peakHi,hi]
  if (x <= lo || x >= hi) return 0;
  if (x >= peakLo && x <= peakHi) return 1;
  if (x < peakLo) return (x - lo) / (peakLo - lo);
  return (hi - x) / (hi - peakHi);
}

// fix49h(H3): when did the CURRENT market direction actually begin?
// sentinel.regime_since resets on ANY flip — including same-family intensification
// (BEAR→STRONG_BEAR). Treating that as "fresh" would strip the regime bonus from SELLs in the
// middle of an established bear (it would have cut scores across the winning overnight 06/10
// session). So we walk the persisted sentinel history for the most recent DIRECTION-CROSSING
// flip (bear-family ↔ bull-family, incl. via CHOP) and use that as the direction's birth time.
// Fail-open: no history / no crossing found → 0 (treated as established, no neutralization).
const _regimeFamily = (r) => {
  const x = String(r || '').toUpperCase();
  if (x === 'BULL' || x === 'STRONG_BULL') return 'bull';
  if (x === 'BEAR' || x === 'STRONG_BEAR') return 'bear';
  return 'neutral';
};
let _dirBirthMemo = { at: 0, family: '', birth: 0 };
function directionBirthMs(currentRegime) {
  const fam = _regimeFamily(currentRegime);
  if (fam === 'neutral') return 0;
  const nowMs = Date.now();
  if (_dirBirthMemo.family === fam && nowMs - _dirBirthMemo.at < 60 * 1000) return _dirBirthMemo.birth;
  let birth = 0;
  try {
    const hist = store.read('sentinel_history', []);
    if (Array.isArray(hist)) {
      // newest-first; find the latest entry that ESTABLISHED the current family
      for (const h of hist) {
        if (_regimeFamily(h?.to_regime) === fam && _regimeFamily(h?.from_regime) !== fam) {
          birth = num(h.ts, 0);
          break;
        }
        // an older entry already in a different family means current family predates history scope
        if (_regimeFamily(h?.to_regime) !== fam && _regimeFamily(h?.to_regime) !== 'neutral') break;
      }
    }
  } catch (_e) { birth = 0; }
  _dirBirthMemo = { at: nowMs, family: fam, birth };
  return birth;
}

function convictionScore(ctx, decision, plan, math, btcRegime, levels) {
  const { side } = plan;
  const { price, trend5, trend15, trend1h, rsi, volRatio, momentumPct, ticker, k5 } = ctx;
  const atr = Math.max(num(levels.atr, price * 0.006), price * 0.0005);
  const entryDistanceAtr = Math.abs(num(price) - num(plan.entry)) / atr;
  const targetDistanceAtr = Math.abs(num(plan.tp1) - num(plan.entry)) / atr;
  const stopDistanceAtr = Math.abs(num(plan.entry) - num(plan.sl)) / atr;
  let maxTargetAtr = Math.max(1.0, num(levels.maxTpAtr, MAX_TP_ATR));
  const last = Array.isArray(k5) && k5.length ? k5[k5.length - 1] : null;
  const lastRangeAtr = last ? Math.abs(num(last.high) - num(last.low)) / atr : 0;

  const localRegimeData = detectLocalRegime(k5, Array.isArray(ctx.k15) ? ctx.k15 : []);
  const localRegime = localRegimeData.localRegime;
  const sideAllowance = getAllowedSides(btcRegime.regime, localRegime);

  const components = {};
  const confluence = [];
  const risks = [];

  // ── BASE ──────────────────────────────────────────────────────────────────
  // Every signal that reaches here passed determineDirection (>=2 family vote). Base × quality.
  // fix48h-cal: BASE=50 (was 46). First-deploy showed 2-family aligned trades landing exactly on
  // the 60 threshold (no headroom) and UNKNOWN-regime trades scoring ~44 = system went silent.
  // Recalibrated so a good 2-family aligned trade clears 60 with margin, ideal lands ~100.
  const BASE = 50;

  // ── FACTOR 1: Family agreement (0.80 .. 1.30) ─────────────────────────────
  const familiesAgreed = num(decision.edge, 0);
  let familyMult;
  if (familiesAgreed >= 3)      { familyMult = 1.30; confluence.push('3-family consensus: Elliott + structure + trend'); }
  else if (familiesAgreed >= 2) { familyMult = 1.08; confluence.push(`2-family consensus: ${(decision.reasons || []).join(', ')}`); } // fix48h-cal: 1.00→1.08, most signals are 2-family — give them threshold headroom
  else                          { familyMult = 0.80; }

  // ── FACTOR 2: Entry quality (0.45 .. 1.15) ────────────────────────────────
  // Smooth curve: peaks across the 0.5-1.0 ATR zone-touch sweet spot (data: 51% WR there).
  // ≤0.25 = momentum chase (16% WR, also blocked in shouldReject); >1.8 = stretched.
  const entryPeak = _smoothPeak(entryDistanceAtr, 0.10, 2.2, 0.5, 1.0); // 0..1
  const entryMult = 0.45 + 0.70 * entryPeak; // 0.45..1.15
  if (entryDistanceAtr <= 0.25) risks.push('entry already at zone — tight stop, noise risk');
  else if (entryDistanceAtr >= 0.5 && entryDistanceAtr <= 1.0) confluence.push('entry in zone-touch sweet spot');
  else if (entryDistanceAtr > 1.8) risks.push('entry stretched from current price');

  // ── FACTOR 3: Regime alignment scaled by STRENGTH (0.35 .. 1.20) ──────────
  // Continuous, not a flat per-regime integer. Counter-trend (SELL in bull / BUY in bear) is
  // multiplicatively punished — directly targets the SELL 27% WR bleed. Uses regimeBrain strength
  // proxies (emaPctSpread, rsi distance from 50) so a STRONG bull suppresses fades harder than a weak one.
  const btcR = String(btcRegime.regime || 'UNKNOWN').toUpperCase();
  if (btcR === 'CHOP' || localRegime === 'LOCAL_CHOP') maxTargetAtr = Math.min(maxTargetAtr, 2.2);
  // strength 0..1 from how far BTC RSI is from neutral + ema spread magnitude (if available)
  const _btcRsi = num(btcRegime.rsi, 50);
  const _btcSpread = Math.abs(num(btcRegime.emaPctSpread, 0));
  const regimeStrength = clamp(Math.abs(_btcRsi - 50) / 25 * 0.6 + Math.min(1, _btcSpread / 1.5) * 0.4, 0, 1); // 0..1
  let regimeMult, regimeNote = '';
  const aligned = (s, dir) => (dir === 'BUY'
    ? ['BULL_TREND', 'BREAKOUT', 'BULL_RANGE'].includes(s)
    : ['BEAR_TREND', 'BREAKOUT', 'BEAR_RANGE'].includes(s));
  const opposed = (s, dir) => (dir === 'BUY' ? ['BEAR_TREND', 'BEAR_RANGE'].includes(s)
                                             : ['BULL_TREND', 'BULL_RANGE'].includes(s));
  // ── fix48n: REGIME-CONFLICT DETECTION (computed once, applied to both sides) ──
  // regimeBrain classifies BTC purely on 15m EMA/RSI. In a real bear, dead-cat bounces
  // trip BULL_TREND/BULL_RANGE (15m RSI pops to 52+, ema20>ema50 briefly) while sentinel
  // breadth + composite still read deep bear. Observed live: 19/28 BUYs tagged BULL_TREND
  // into a 93%-bear / Extreme-Fear tape, 32% WR. When the regimeBrain bull label is
  // contradicted by breadth/composite the label is UNRELIABLE. We then treat the regime as
  // NEUTRAL for BOTH sides (0.90): BUY loses its unearned tailwind, AND SELL loses the
  // phantom counter-trend penalty it was getting for "opposing" a bull that isn't there.
  // fix48n2 rationale: on paper, suppressing SELLs in a mislabeled bear starves the SELL
  // sample — we can't test the SELL-in-bear edge. Neutral (not boosted) lets SELLs clear
  // the gate on their own merit so the next session's SELL WR is a CLEAN read, not an
  // artifact of us tipping the scale. Does NOT block, flip, force, or boost any side.
  let _contestedBull = false, _conflictNote = '';
  try {
    const _s = (typeof sentinel?.getSentinel === 'function') ? sentinel.getSentinel() : null;
    if (_s) {
      // sentinel returns bull_pct:0 / composite:0 on NO data (cold start). num() coerces
      // null→0, so require a populated pair_count before trusting breadth; composite 0 = neutral.
      const _pairCount = num(_s.vol?.pair_count, 0);
      const _bullPct   = _pairCount > 0 ? num(_s.vol?.bull_pct, 50) : null;
      const _comp      = num(_s.composite_score, 0);
      const _bullLbl   = ['BULL_TREND', 'BULL_RANGE', 'BREAKOUT'].includes(btcR);
      const _breadthBear = (_bullPct != null) && _bullPct <= 30;  // ≤30% pairs bull
      const _compBear    = _comp <= -3;                           // composite bearish/strong-bear
      if (_bullLbl && (_breadthBear || _compBear)) {
        _contestedBull = true;
        _conflictNote = `REGIME_CONFLICT: BTC=${btcR} but breadth ${_bullPct==null?'n/a':_bullPct.toFixed(0)+'% bull'} / composite ${_comp} — regime treated neutral both sides`;
      }
    }
  } catch (_e) { /* sentinel unavailable — _contestedBull stays false, fail safe */ }

  if (_contestedBull) {
    // Contested bull label → default behavior is NEUTRAL for whichever side we're scoring (0.90).
    regimeMult = 0.90;
    regimeNote = _conflictNote;
    risks.push(_conflictNote);

    // ── fix49p: CONFLICT BREADTH-LEAD EXPERIMENT (flag-gated, default OFF) ──────────────────
    // Hypothesis: during BTC/breadth conflict, breadth SLOPE (not level) signals the true near-term
    // direction early. The conflict state here is ALWAYS "BTC=bull label + breadth deep-bear (<=30%)"
    // (that's what _contestedBull requires). Inside that state:
    //   • breadth FALLING  → getting MORE bearish → lean SELL (SELL aligns with the real direction).
    //   • breadth RISING   → recovering, but STILL <=30% = deep bear. Leaning BUY here = buying a
    //     bounce inside a bear tape, which fix48n documented at 32% WR live. We do NOT lean BUY:
    //     prior evidence says it loses, and the experiment's purpose is to probe where we're BLIND
    //     (SELL-in-mislabeled-bear), not to re-run a known-losing BUY. When breadth genuinely
    //     recovers it crosses >50, exits conflict, and the normal aligned-bonus path handles BUY.
    // This asymmetry is deliberate and evidence-based (your hard rule permits justified asymmetry).
    // Controls: OFF by default; small lean (0.96, never a full bonus); RR/score floors untouched;
    // every leaned trade tagged (components._conflictLead); reversible via one settings toggle.
    try {
      if (getSettings().v4ConflictBreadthLead === true && side === 'SELL') {
        const _slp = breadthSlope(getSettings());
        if (_slp && _slp.dir === -1 && _slp.samples >= 3) { // breadth FALLING → confirm SELL
          regimeMult = 0.96; // small lean toward SELL (the side breadth is trending toward)
          regimeNote = `CONFLICT_BREADTH_LEAD_SELL: breadth falling ${_slp.firstPct}→${_slp.lastPct}% over ${_slp.windowMin}min — experimental early lean`;
          risks.push(regimeNote);
          components._conflictLead = {
            side: 'SELL', leanSide: 'SELL', slope: _slp.slope, dir: _slp.dir,
            firstPct: _slp.firstPct, lastPct: _slp.lastPct, netMove: _slp.netMove,
            windowMin: _slp.windowMin, samples: _slp.samples, regimeMult
          };
        }
      }
    } catch (_e) { /* fail-safe: experiment never breaks scoring; neutral 0.90 stands */ }
  } else if (aligned(btcR, side)) {
    // aligned: strength helps. 1.00 (weak) → 1.20 (strong trend)
    regimeMult = 1.00 + 0.20 * regimeStrength;
    regimeNote = `BTC ${btcR} aligns ${side} (strength ${(regimeStrength*100).toFixed(0)}%)`;
    confluence.push(regimeNote);
  } else if (opposed(btcR, side)) {
    // counter-trend: strength HURTS. 0.85 (weak/ranging) → 0.35 (strong opposing trend)
    regimeMult = 0.85 - 0.50 * regimeStrength;
    // localRegime can rescue a counter-trend fade slightly (e.g. SELL at LOCAL_BULL exhaustion)
    if ((side === 'SELL' && localRegime === 'LOCAL_BULL') || (side === 'BUY' && localRegime === 'LOCAL_BEAR')) regimeMult += 0.08;
    regimeMult = clamp(regimeMult, 0.30, 0.95);
    risks.push(`counter-trend: BTC ${btcR} opposes ${side} (strength ${(regimeStrength*100).toFixed(0)}%)`);

    // fix49k: BREADTH-OVERRIDE penalty neutralization (BOTH sides). Mirror of the btcRegimeDecision
    // unblock. A side opposed by the BTC label, but breadth strongly agrees with that side: remove
    // the counter-trend PENALTY (floor to neutral 0.90). No bonus added — hypothesis is "removing
    // the regime veto lets breadth-aligned trades through", not "breadth deserves a reward".
    //   BUY  rescued when breadth >= 70% bull under a bear label
    //   SELL rescued when breadth <= 30% bull under a bull label
    const _ovrSide = breadthOverrideSide(side, btcR, getSettings());
    if (_ovrSide === side && regimeMult < 0.90) {
      try {
        const _sK = (typeof sentinel?.getSentinel === 'function') ? sentinel.getSentinel() : null;
        const _pctK = num(_sK?.vol?.bull_pct, NaN);
        regimeMult = 0.90; // penalty removed, no bonus
        regimeNote = `BREADTH_OVERRIDE_${side}: breadth ${Number.isFinite(_pctK) ? _pctK.toFixed(0) : '?'}% bull vs ${btcR} label — counter-trend penalty neutralized`;
        risks.push(regimeNote);
        components._breadthOverride = { side, breadthPct: Number.isFinite(_pctK) ? Number(_pctK.toFixed(1)) : null, btcRegime: btcR };
      } catch (_e) { /* fail-safe: penalty stands */ }
    }
  } else {
    // CHOP / UNKNOWN — no directional edge from regime, but should NOT punish.
    // fix48h-cal: 0.75→0.90. At 0.75 every signal during the post-restart UNKNOWN-regime warmup
    // window scored ~44 and the system went fully silent. 0.90 is neutral: no help, no penalty.
    regimeMult = 0.90;
    if (btcR === 'CHOP') risks.push('BTC chop — regime gives no directional edge');
  }

  // ── fix49h(H3): FRESH-REGIME NEUTRALIZATION ───────────────────────────────
  // A regime label minutes old carries no proof. 06/10 evening: a 3-hour-old bounce flipped the
  // labels bull, the score paid 81-98 to BUYs (regimeMult 1.1-1.2) and the bounce died → 2W/4L
  // live. Contrast 06/08: the SAME breadth readings inside an ESTABLISHED bull = +14.3U / 60 BUYs.
  // The killer is not the breadth level — it's trusting a newborn regime. So: while the current
  // sentinel DIRECTION (bull-family/bear-family, intensifications ignored) is younger than
  // V4_FRESH_REGIME_MS (default 2h), the side ALIGNED with the new direction gets neutral 0.90 —
  // no bonus, no penalty. NEVER a block; the score simply stops paying unearned confidence.
  // The opposite side is untouched. Fail-open on missing sentinel/history.
  try {
    const _sFresh = (typeof sentinel?.getSentinel === 'function') ? sentinel.getSentinel() : null;
    const _sentRegime = String(_sFresh?.market_regime || '').toUpperCase();
    const _sentFam = _regimeFamily(_sentRegime);
    const _alignedWithSentinel = (side === 'BUY' && _sentFam === 'bull') || (side === 'SELL' && _sentFam === 'bear');
    if (_alignedWithSentinel && regimeMult > 0.90) {
      const FRESH_REGIME_MS = Math.max(0, Number(process.env.V4_FRESH_REGIME_MS || String(2 * 60 * 60 * 1000)));
      const _birth = directionBirthMs(_sentRegime);
      const _dirAgeMs = _birth > 0 ? Date.now() - _birth : Infinity; // no birth found = established
      if (FRESH_REGIME_MS > 0 && _dirAgeMs < FRESH_REGIME_MS) {
        regimeMult = 0.90;
        regimeNote = `FRESH_REGIME_NO_BONUS: ${_sentRegime} direction only ${Math.round(_dirAgeMs / 60000)}min old — bonus withheld until established`;
        risks.push(regimeNote);
        components._freshRegime = { regime: _sentRegime, dirAgeMin: Math.round(_dirAgeMs / 60000), thresholdMin: Math.round(FRESH_REGIME_MS / 60000) };
      }
    }
  } catch (_e) { /* fail-open — established behavior */ }

  // ── FACTOR 4: RR fit (0.70 .. 1.10) ───────────────────────────────────────
  // Peaks at RR 2.0-2.6 (sweet spot 74-88% WR). Decays toward 3.0. RR>3 is blocked in shouldReject
  // and capped in planner, but if one reaches here it scores poorly rather than passing on a label.
  const rr = num(math.rr, 0);
  let rrMult;
  if (rr < 1.8)      rrMult = 0.70;                          // below floor — thin reward
  else if (rr <= 2.6) rrMult = 1.10;                         // sweet spot
  else if (rr <= 3.0) rrMult = 1.10 - 0.30 * ((rr - 2.6) / 0.4); // 1.10 → 0.80 ramp down
  else               rrMult = 0.65;                          // >3 danger (shouldn't reach here)
  if (rr >= 2.0 && rr <= 3.0) confluence.push(`RR ${rr.toFixed(2)} sweet spot`);
  else if (rr > 3.0) risks.push(`RR ${rr.toFixed(2)} above sweet spot — 30% WR territory`);

  // ── FACTOR 5: RSI (0.85 .. 1.08) — folded back in (was discarded) ─────────
  // Data: signals where RSI scored 0 = 25% WR; RSI>0 = 48% WR. RSI now affects score.
  const rsiPart = rsiScoreAndPenalty(side, rsi);
  if (rsiPart.note) confluence.push(rsiPart.note);
  if (rsiPart.risk) risks.push(rsiPart.risk);
  // rsiPart.score is 0..~8; map to 0.85..1.08
  const rsiMult = 0.85 + 0.23 * clamp(num(rsiPart.score, 0) / 8, 0, 1);
  components.rsi = rsiPart.score;

  // ── FACTOR 6: Volume confirmation (0.92 .. 1.06) ──────────────────────────
  const volScore = volumeScore(volRatio);
  const volMult = 0.92 + 0.14 * clamp(num(volScore, 0) / 6, 0, 1);
  if (volScore >= 4) confluence.push('volume expansion');
  components.volume = volScore;
  components.liquidity = liquidityScore(num(ticker.turnover24h));

  // ── Supporting context (logged only) ──────────────────────────────────────
  const hasStructure = !!(levels.support && levels.resistance);
  if (hasStructure) confluence.push('support/resistance structure present');
  else risks.push('missing nearby S/R structure');
  if (targetDistanceAtr > maxTargetAtr * 1.6) risks.push(`target too far vs ATR (${targetDistanceAtr.toFixed(2)}x)`);
  if (stopDistanceAtr > 3.0) risks.push(`SL too wide vs ATR (${stopDistanceAtr.toFixed(2)}x)`);
  const slPctCalc = plan.entry ? Math.abs(plan.entry - plan.sl) / Math.abs(plan.entry) * 100 : 0;
  if (slPctCalc > 0 && slPctCalc < 0.35) risks.push(`SL too tight (${slPctCalc.toFixed(2)}%) — noise stop`);
  const momo = Math.abs(num(momentumPct));
  if (momo > 10) risks.push('extreme short-term extension');
  else if (momo > 6) risks.push('overextended move');
  if (lastRangeAtr > 2.5) risks.push('last candle too large vs ATR');

  // ── FACTOR 7 (fix48v): CONTEXT MULTIPLIER — per-pair alignment × market breadth × fear ──────
  // Hypothesis under test (toggle contextWeighting). Multiplicative so extreme fear can't be fully
  // cancelled by alignment. Penalty leg (alignScore<0) calibrated to data: breadth-fighting trades
  // ran 21% WR / negative. Boost leg deliberately gentle — green-breadth boost is still unproven.
  let contextMult = 1.0;
  let _ctxDiag = null;
  try {
    const _cfg = getSettings(); // fix48x: was config.getSettings() — config is destructured, not a var → ReferenceError → silent catch → all context fields null
    if (_cfg.contextWeighting !== false) {
      // (1) PER-PAIR direction (weighted highest — the pair's OWN strength, not market-wide).
      const _sgn = v => (num(v, 0) > 0 ? 1 : num(v, 0) < 0 ? -1 : 0);
      const _tf = [_sgn(trend5), _sgn(trend15), _sgn(trend1h)];
      const _want = side === 'BUY' ? 1 : -1;
      const _agree = _tf.filter(s => s === _want).length;          // 0..3
      let _perPair = (_agree - 1.5) / 1.5;                          // -1..+1
      if (localRegime === 'LOCAL_BULL') _perPair += (side === 'BUY' ? 0.30 : -0.30);
      else if (localRegime === 'LOCAL_BEAR') _perPair += (side === 'SELL' ? 0.30 : -0.30);
      _perPair = clamp(_perPair, -1, 1);

      // (2) MARKET breadth (secondary) — live vol_bull_pct from sentinel.
      let _bullPct = 50;
      try { const { sent: _s } = getSentinelForCapture(); _bullPct = num(_s?.vol?.bull_pct, 50); } catch (_e) {}
      const _breadth = clamp(((side === 'BUY' ? (_bullPct - 50) : (50 - _bullPct)) / 35), -1, 1);

      // combine: per-pair 0.65, breadth 0.35. Penalty steeper than boost.
      const _align = clamp(0.65 * _perPair + 0.35 * _breadth, -1, 1);
      const _alignMult = _align < 0 ? (1 + _align * 0.22) : (1 + _align * 0.12);

      // (3) FEAR asymmetry — crypto reacts to fear > greed. Extreme fear suppresses BUYs hard.
      let _fearMult = 1.0;
      const _fng = _lastKnownFng;
      if (_fng != null && Number.isFinite(_fng)) {
        if (side === 'BUY') {
          if (_fng <= 25) _fearMult = 0.80 + 0.12 * (_fng / 25);      // 0.80..0.92 — suppress buys in extreme fear
          else if (_fng >= 75) _fearMult = 1.0 + 0.05 * ((_fng - 75) / 25); // ≤1.05 — small greed boost
        } else { // SELL
          if (_fng <= 25) _fearMult = 1.0 + 0.06 * (1 - _fng / 25);   // ≤1.06 — fear favours downside
          else if (_fng >= 75) _fearMult = 0.94;                      // mild — greed weighted weaker
        }
      }

      contextMult = clamp(_alignMult * _fearMult, 0.55, 1.20);
      if (_fng != null && _fng <= 25 && side === 'BUY') risks.push(`extreme fear (F&G ${_fng}) — BUY suppressed`);
      _ctxDiag = { perPair: +_perPair.toFixed(3), breadth: +_breadth.toFixed(3), align: +_align.toFixed(3),
                   alignMult: +_alignMult.toFixed(3), fng: _fng, fearMult: +_fearMult.toFixed(3),
                   bullPct: +num(_bullPct,50), contextMult: +contextMult.toFixed(3) };
    }
  } catch (_e) { contextMult = 1.0; } // fail safe: no-op

  // ── FINAL SCORE: base × product of factors, clamped 0-100 ─────────────────
  const qualityMult = familyMult * entryMult * regimeMult * rrMult * rsiMult * volMult * contextMult;
  const raw = BASE * qualityMult;
  const score = clamp(Math.round(raw), 0, 100);

  // expose the continuous regime alignment (0-25 scale) for CSV-compat / display
  components.regimeAlignment = clamp(Math.round((regimeMult - 0.30) / (1.20 - 0.30) * 25), 0, 25);
  components.family = familiesAgreed >= 3 ? 60 : familiesAgreed >= 2 ? 40 : 0; // kept for downstream refs
  components.entry = clamp(Math.round(entryPeak * 15), 0, 15);

  // CSV-compat aliases — now reflect the real multiplicative contributions (scaled to readable ints)
  components.base      = Math.round(BASE * 0.16);                          // ~8
  components.direction = Math.round(BASE * familyMult * 0.35 - BASE * 0.20); // family contribution proxy
  components.trend     = Math.round((regimeMult - 0.75) * 30);              // regime contribution proxy
  components.structure = hasStructure ? 8 : 0;
  components.rr        = Math.round((rrMult - 0.65) * 30);                  // rr contribution proxy
  components.elliottWave = (ctx.elliottAnalysis?.signal) ? 8 : 0;
  // store the raw multipliers for diagnostics
  components._mult = { familyMult: +familyMult.toFixed(3), entryMult: +entryMult.toFixed(3), regimeMult: +regimeMult.toFixed(3), rrMult: +rrMult.toFixed(3), rsiMult: +rsiMult.toFixed(3), volMult: +volMult.toFixed(3), contextMult: +contextMult.toFixed(3), regimeStrength: +regimeStrength.toFixed(3), qualityMult: +qualityMult.toFixed(3) };
  components._context = _ctxDiag; // fix48v: per-pair/breadth/fear breakdown (null if toggle off)

  return {
    score,
    rawScore: Number(raw.toFixed(2)),
    penalties: 0,  // no penalty model — quality is multiplicative
    components,
    confluence,
    risks,
    entryDistanceAtr: Number(entryDistanceAtr.toFixed(3)),
    lastRangeAtr: Number(lastRangeAtr.toFixed(3)),
    targetDistanceAtr: Number(targetDistanceAtr.toFixed(3)),
    stopDistanceAtr: Number(stopDistanceAtr.toFixed(3)),
    maxTargetAtr: Number(maxTargetAtr.toFixed(3)),
    exceptional: false,
    elliottWave: ctx.elliottAnalysis || null,
    regimeAlignment: components.regimeAlignment,
    btcRegime: btcR,
    localRegime,
    regimeAllowedBuy: sideAllowance.allowedBuy,
    regimeAllowedSell: sideAllowance.allowedSell,
  };
}



function buildStructurePlan(ctx, settings, btcRegime) {
  const { symbol, price, k5, k15, k60, trend5, trend15, trend1h, rsi, volRatio, momentumPct, ticker } = ctx;
  // fix48: compute structure + Elliott first — determineDirection needs both as family votes
  const k5c  = k5.length  > 1 ? k5.slice(0, -1)  : k5;
  const k15c = Array.isArray(k15) && k15.length > 1 ? k15.slice(0, -1) : (k15 || []);
  const k60c = Array.isArray(k60) && k60.length > 1 ? k60.slice(0, -1) : (k60 || []);
  const structure = structureDetector.analyzeStructure(k5, Array.isArray(k15) ? k15 : [], trend5, trend15); // fixSTRUCT: trend15 for 15m CHoCH (was trend5 — category error)
  const elliottAnalysis = analyzeElliottWaves(k5c, k15c, k60c);
  ctx.elliottAnalysis = elliottAnalysis; // passed into convictionScore via ctx
  ctx.structure = structure;             // passed into convictionScore via ctx

  // fix48: determineDirection — 2-of-3 family vote (Elliott, structure, all-3TF trend)
  const decision = determineDirection(trend5, trend15, trend1h, elliottAnalysis, structure, ctx.coinTrend);
  if (decision.side === 'NEU') return { ok: false, reason: 'NO_DIRECTION', leader: { symbol, score: 0, side: 'NEU' } };

  // fix48: direction comes directly from determineDirection family vote — no separate override.
  // The family vote already encodes Elliott W5/W3, structure (CHoCH/BOS/TRAP/DIVERGENCE),
  // and SMA trend. Any signal that fires here has ≥2 independent families agreeing.
  const effectiveSide = decision.side; // already the winning family-vote side
  // fix48b: only set structureSignal when the dominant structure actually supports decision.side.
  // A BOS-bull structure on a SELL decision should not exempt it from BULL_RANGE_SELL_BLOCKED.
  let structureSignal = null;
  if (structure.dominant !== 'NONE') {
    const _domSide =
      structure.trap?.tradeSide ||
      (structure.choch ? (structure.choch.type === 'bull' ? 'BUY' : 'SELL') : null) ||
      (structure.bos   ? (structure.bos.type   === 'bull' ? 'BUY' : 'SELL') : null) ||
      structure.divergence?.tradeSide ||
      null;
    if (_domSide === decision.side || _domSide === null) {
      structureSignal = { side: decision.side, reason: structure.dominant };
    }
  }
  const _structureFlipped = false; // no separate flip in fix48 — direction IS the vote result
  let side = effectiveSide;
  const _structureSideDiffers = false;
  const swings = detectSwings(k5, 3); // FIX9: was 2; matches updated default
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
    if (!support || !resistance) {
      // fix48b: _structureSideDiffers is always false — this branch is intentionally dead.
      // Direction now comes from family vote, not a separate override that could differ.
      if (_structureSideDiffers && decision.side === 'SELL' && support && resistance) {
        side = 'SELL'; structureSignal = null;
      } else {
        return { ok: false, reason: 'NO_STRUCTURE_LEVELS', leader: { symbol, score: 0, side } };
      }
    }
    const nearSupport = Math.abs(price - support) <= Math.max(atr * 0.75, price * 0.0075);
    // fixPCT Phase 2: continuation BUY (side agrees with a strong coin uptrend) → shallow pullback entry
    // so a runner fills on a small dip instead of waiting for a deep 0.6-ATR reversal that never comes.
    const _pullBuy = (PCT_PULLBACK_ENABLED && ctx.coinTrend && ctx.coinTrend.strength >= PCT_STRONG && ctx.coinTrend.bias === 'up') ? PCT_PULLBACK_ATR : 0.6;
    entry = nearSupport ? price : Math.max(support + minBuffer * 0.35, price - atr * _pullBuy);
    sl = Math.min(support - minBuffer, entry - atr * 0.55);
    let structureTp = resistance;
    tpSource = 'nearest resistance liquidity';
    // fixTPREACH: a continuation entry (riding an already-strong coin uptrend) chewed through the nearest
    // resistance to even be trending — leave the SECOND swing high as the target when the first one gives
    // weak RR, instead of always capping the winner at a level price is likely to blow straight through.
    const _isContinuationBuy = _pullBuy !== 0.6; // same test the shadow-log/pullback code already uses
    if (TPREACH_ENABLED && _isContinuationBuy && resistance2 > structureTp) {
      const _riskDist = entry - sl;
      const _nearRR = _riskDist > 0 ? (structureTp - entry) / _riskDist : 0;
      if (_nearRR < TPREACH_MIN_RR) {
        structureTp = resistance2;
        tpSource = 'second resistance liquidity (continuation reach, nearest gave RR<' + TPREACH_MIN_RR + ')';
      }
    }
    tp1 = structureTp > entry ? structureTp : 0;
    entrySource = nearSupport ? 'current price near support' : 'pullback toward support';
    slSource = 'below support invalidation';
  } else {
    if (!support || !resistance) {
      // fix48b: _structureSideDiffers is always false — this branch is intentionally dead.
      if (_structureSideDiffers && decision.side === 'BUY' && support && resistance) {
        side = 'BUY'; structureSignal = null;
      } else {
        return { ok: false, reason: 'NO_STRUCTURE_LEVELS', leader: { symbol, score: 0, side } };
      }
    }
    const nearResistance = Math.abs(price - resistance) <= Math.max(atr * 0.75, price * 0.0075);
    // fixPCT Phase 2: continuation SELL (side agrees with a strong coin downtrend) → shallow pullback entry (mirror)
    const _pullSell = (PCT_PULLBACK_ENABLED && ctx.coinTrend && ctx.coinTrend.strength >= PCT_STRONG && ctx.coinTrend.bias === 'down') ? PCT_PULLBACK_ATR : 0.6;
    entry = nearResistance ? price : Math.min(resistance - minBuffer * 0.35, price + atr * _pullSell);
    sl = Math.max(resistance + minBuffer, entry + atr * 0.55);
    let structureTp = support;
    tpSource = 'nearest support liquidity';
    // fixTPREACH mirror (SELL): same reasoning as the BUY branch above.
    const _isContinuationSell = _pullSell !== 0.6;
    if (TPREACH_ENABLED && _isContinuationSell && support2 > 0 && support2 < structureTp) {
      const _riskDist = sl - entry;
      const _nearRR = _riskDist > 0 ? (entry - structureTp) / _riskDist : 0;
      if (_nearRR < TPREACH_MIN_RR) {
        structureTp = support2;
        tpSource = 'second support liquidity (continuation reach, nearest gave RR<' + TPREACH_MIN_RR + ')';
      }
    }
    tp1 = structureTp < entry ? structureTp : 0;
    entrySource = nearResistance ? 'current price near resistance' : 'pullback toward resistance';
    slSource = 'above resistance invalidation';
  }

  // A recurring loss pattern in the paper ledger was ambitious TP1 levels that were
  // several ATRs away. Cap TP1 to a reachable first target; setups that no longer
  // meet the configured RR are rejected by the normal RR gate below.
  const maxTargetDistance = atr * maxTpAtrFor(settings);
  if (tp1 && maxTargetDistance > 0) {
    if (side === 'BUY' && tp1 - entry > maxTargetDistance) {
      tp1 = entry + maxTargetDistance;
      tpSource += `; capped to ${maxTpAtrFor(settings).toFixed(1)} ATR first target`;
    }
    if (side === 'SELL' && entry - tp1 > maxTargetDistance) {
      tp1 = entry - maxTargetDistance;
      tpSource += `; capped to ${maxTpAtrFor(settings).toFixed(1)} ATR first target`;
    }
  }

  // fix32: if tp1=0 (structure not found on correct side), apply 2:1 RR fallback
  // Without this, math.rr=0 and signal is always rejected — no signal ever fires
  if (!tp1 || (side === 'BUY' && tp1 <= entry) || (side === 'SELL' && tp1 >= entry)) {
    const slDist = Math.abs(entry - sl);
    const fallbackRR = Math.max(2.0, Math.min(2.5, minRRFor(side, settings)));
    tp1 = side === 'BUY' ? entry + slDist * fallbackRR : entry - slDist * fallbackRR;
    tpSource = `2:1 RR fallback (no structure ${side==='BUY'?'above':'below'} entry)`;
  }

  // fix48f: RR CEILING at 3.0 applied at the PLANNER level (adaptive, not just blocking).
  // Rather than discard a signal whose structural TP yields RR>3 (target too far = never prints,
  // 0 wins/5 losses last session), we pull TP1 IN to exactly 3.0 RR — a reachable first target.
  // This preserves the direction + entry (which may be valid) and only fixes the unreachable target.
  // The shouldReject RR>3 hard block remains as a backstop for anything that slips past this.
  const _slDistForCap = Math.abs(entry - sl);
  if (_slDistForCap > 0 && tp1) {
    const _rrNow = side === 'BUY' ? (tp1 - entry) / _slDistForCap : (entry - tp1) / _slDistForCap;
    if (_rrNow > 3.0) {
      tp1 = side === 'BUY' ? entry + _slDistForCap * 3.0 : entry - _slDistForCap * 3.0;
      tpSource += `; RR capped 3.0 (was ${_rrNow.toFixed(2)} — target unreachable)`;
    }
  }

  const plan = { entry: roundPrice(entry), sl: roundPrice(sl), tp1: roundPrice(tp1), side };
  const math = calculatePaperMath(plan, settings);

  const scoreInfo = convictionScore(ctx, decision, plan, math, btcRegime, { support, resistance, support2, resistance2, atr, requiredRR: minRRFor(side, settings), minNetTpUsdt: minNetTpFor(settings, math), maxTpAtr: maxTpAtrFor(settings) });
  const entryTiming = computeEntryTiming(ctx, plan, side, atr, settings);
  const score = scoreInfo.score;
  const contextDiag = scoreInfo?.components?._context || null; // fix48w: direct ref — survives to signal via leader.contextDiag
  const confluence = [...new Set([...decision.reasons, ...scoreInfo.confluence])];
  const risks = [...new Set(scoreInfo.risks)];

  const leader = {
    symbol,
    price: roundPrice(price),
    side,
    score,
    tier: score >= SCORE_A_PLUS ? 'A+' : score >= SCORE_A ? 'A' : score >= SCORE_B ? 'B' : '-',
    trend5, trend15, trend1h,
    // fixPCT: per-coin fast multi-TF trend (populated for fresh-move coins) + continuation-entry marker
    coinTrend: ctx.coinTrend || null,
    continuationEntry: (PCT_PULLBACK_ENABLED && ctx.coinTrend && ctx.coinTrend.strength >= PCT_STRONG &&
      ((side === 'BUY' && ctx.coinTrend.bias === 'up') || (side === 'SELL' && ctx.coinTrend.bias === 'down'))) ? side : null,
    rsi: Number(rsi.toFixed(1)),
    volRatio: Number(volRatio.toFixed(2)),
    change24h: Number(num(ticker.change24h).toFixed(2)),
    turnover24h: num(ticker.turnover24h),
    // fixMICRO: per-coin funding/OI snapshot at signal birth, carried through to diag capture
    coinFundingRate: num(ticker.fundingRate, null),
    coinOpenInterest: num(ticker.openInterest, null),
    btcRegime: btcRegime.regime,
    localRegime: scoreInfo.localRegime,  // fix48b: was missing — always undefined in exported signal/CSV
    plan,
    math,
    reasons: confluence.slice(0, 8),
    risks,
    scoreInfo,
    scoring: scoreInfo,
    contextDiag, // fix48w: 48v context breakdown (perPair/breadth/fear) — explicit field so signalFromLeader carries it
    entryTiming,
    entrySource, slSource, tpSource,
    keyLevels: { support: roundPrice(support), resistance: roundPrice(resistance), support2: roundPrice(support2), resistance2: roundPrice(resistance2), atr: roundPrice(atr) },
    // fix44f: structure detection metadata
    structure: structure.dominant,
    structureTrap: structure.trap ? structure.trap.type : null,
    structureChoch: structure.choch ? structure.choch.type : null,
    structureSqueeze: structure.squeeze,
    structureSqueezeRelease: structure.squeezeRelease,
    structureDivergence: structure.divergence ? structure.divergence.type : null,
    structureSignal: structureSignal ? structureSignal.reason : null,
    // fix46b: mark any structure-driven or LOCAL_BULL flip as contrarianFlip
    contrarianFlip: _structureFlipped || false,
    // fix46c: Elliott Wave metadata
    elliottSignal: elliottAnalysis.signal?.type || null,
    elliottW5Count: elliottAnalysis.w5Count,
    elliottW3Count: elliottAnalysis.w3Count,
    elliottReason: elliottAnalysis.signal?.reason || null,
  };
  // fix44f: CONTRARIAN FLIP — data shows BUY in LOCAL_BULL or BULL_TREND is a losing signal
  // but the SAME signal flipped to SELL wins at 66-100% WR across 3 sessions (+7.98 USDT swing)
  // Interpretation: LOCAL_BULL + strong momentum = price EXTENDED, about to reverse
  // The structure the system found (support/resistance) is still valid — just trade it SHORT
  // Conditions: BUY signal, LOCAL_BULL local regime, bull BTC regime (BULL_TREND or BULL_RANGE)
  const _flipBtcR = String(btcRegime?.regime || '').toUpperCase();
  const _flipLocalR = String(scoreInfo?.localRegime || '').toUpperCase();
  const _shouldFlip = leader.side === 'BUY' &&
    _flipLocalR === 'LOCAL_BULL' &&
    ['BULL_TREND', 'BULL_RANGE'].includes(_flipBtcR);

  if (_shouldFlip && support > 0 && resistance > 0) {
    // Rebuild plan as SELL using the SAME structure levels
    // SELL: entry near resistance, SL above resistance, TP at support
    const _sellEntry = Math.min(resistance - minBuffer * 0.35, price + atr * 0.3);
    const _sellSl    = Math.max(resistance + minBuffer, _sellEntry + atr * 0.55);
    const _sellTp    = support;
    const _sellRr    = _sellTp < _sellEntry
      ? Math.abs(_sellEntry - _sellTp) / Math.abs(_sellSl - _sellEntry)
      : 0;

    if (_sellEntry > 0 && _sellTp > 0 && _sellRr >= 2.0 && _sellTp < _sellEntry && _sellSl > _sellEntry) { // fix47: added _sellEntry>0 and _sellTp>0 degenerate guards
      // fix48t: SHADOW-CAPTURE — freeze the original BUY plan BEFORE we overwrite it with SELL levels.
      // The real SELL fires (flip edge untouched); this phantom BUY is recorded for offline replay so
      // we can later measure the breadth-vs-flip thesis on the SAME setup. Values here are still BUY.
      leader.preFlip = {
        side: 'BUY',
        entry: leader.entry,
        sl: leader.sl,
        tp1: leader.tp1,
        rr: num(leader.math?.rr, null),
        score: leader.score,
      };
      leader.side = 'SELL';
      leader.entry = roundPrice(_sellEntry);
      leader.sl    = roundPrice(_sellSl);
      leader.tp1   = roundPrice(_sellTp);
      leader.plan  = { ...leader.plan, entry: leader.entry, sl: leader.sl, tp1: leader.tp1, side: 'SELL' };
      // fix44f: recalculate full math — stale BUY netTpUSDT/netSlUSDT would fail shouldReject gates
      // fix46b: use in-scope settings not currentSettings() — avoids redundant store read
      leader.math  = calculatePaperMath(leader.plan, settings);
      leader.contrarianFlip = true;
      leader.flipReason = `LOCAL_BULL+${_flipBtcR}: price extended, flipped BUY→SELL`;
      // fix48b: recalculate scoreInfo for the SELL plan — old scoreInfo was scored as BUY
      // and its regime/entry components don't reflect the flipped trade's conviction.
      const _flipScoreInfo = convictionScore(
        ctx, decision, leader.plan, leader.math, btcRegime,
        { support, resistance, support2, resistance2, atr,
          requiredRR: minRRFor('SELL', settings),
          minNetTpUsdt: minNetTpFor(settings, leader.math),
          maxTpAtr: maxTpAtrFor(settings) }
      );
      leader.scoreInfo = _flipScoreInfo;
      leader.scoring   = _flipScoreInfo;
      leader.contextDiag = _flipScoreInfo?.components?._context || null; // fix48w: flip gets its own context snapshot
      leader.score     = _flipScoreInfo.score;
      leader.tier      = leader.score >= SCORE_A_PLUS ? 'A+' : leader.score >= SCORE_A ? 'A' : leader.score >= SCORE_B ? 'B' : '-';
      addLog('CONTRARIAN_FLIP', `${symbol}: BUY→SELL flip (${_flipBtcR}+${_flipLocalR}) entry=${leader.entry} sl=${leader.sl} tp=${leader.tp1} rr=${leader.math.rr.toFixed(2)} score=${leader.score}`);
    }
    // If RR doesn't work out, let signal pass as-is (shouldReject will handle it)
  }

  // fixFLIP layer1 — CAPITULATION-FADE birth inversion. EXPERIMENTAL, default OFF (V4_FLIP_AT_BIRTH=false).
  // Looked like a 0W/15L lock on 2 extreme-fear squeeze sessions, but the full 442-trade pool shows the same
  // (W5 + composite≤thr + trend5-up) cohort at 42% (13W/18L) — the composite threshold does NOT generalize
  // (SELL@comp≤-7 was 55% in one session, 14% in another). Shipping it ON would sacrifice ~13 winners in
  // normal regimes. Kept as a toggle for a persistent-capitulation experiment only. The BUY mirror below is a
  // genuine asymmetry: 117 pooled BUYs show NO euphoria/bull-trap failure (euphoria BUYs = 53% WR), so the
  // mirror exists for code symmetry but must stay OFF — inverting BUYs would harm a working side. The robust,
  // regime-agnostic fix is the STRUCTURAL flip (layers 2/3): it reacts to a real failed-rejection reclaim on
  // the actual trade, not a fitted parameter, so it cannot overfit the way this composite cutoff does.
  if (FLIP_ENABLED && FLIP_AT_BIRTH && !leader.contrarianFlip && support > 0 && resistance > 0) {
    let _comp = null;
    try { _comp = num(sentinel.getSentinel() && sentinel.getSentinel().composite_score, null); } catch (_e) {}
    const _t5 = String(ctx && ctx.trend5 || '').toLowerCase();
    const _isW5 = elliottAnalysis && elliottAnalysis.signal && elliottAnalysis.signal.type === 'W5_EXHAUSTION';
    const _capFadeShort = leader.side === 'SELL' && _isW5 && _comp != null && _comp <= FLIP_CAP_THRESHOLD && _t5 === 'bull';
    const _euphFadeLong = leader.side === 'BUY'  && _isW5 && _comp != null && _comp >= Math.abs(FLIP_CAP_THRESHOLD) && _t5 === 'bear';
    if (_capFadeShort || _euphFadeLong) {
      const _newSide = _capFadeShort ? 'BUY' : 'SELL';
      let _e, _s, _tp, _rr;
      if (_newSide === 'BUY') {
        // ride the bounce: entry near support/current, SL below support, TP toward resistance
        _e  = Math.max(support + minBuffer * 0.35, price - atr * 0.3);
        _s  = Math.min(support - minBuffer, _e - atr * 0.55);
        _tp = resistance;
        _rr = _tp > _e ? Math.abs(_tp - _e) / Math.abs(_e - _s) : 0;
      } else {
        _e  = Math.min(resistance - minBuffer * 0.35, price + atr * 0.3);
        _s  = Math.max(resistance + minBuffer, _e + atr * 0.55);
        _tp = support;
        _rr = _tp < _e ? Math.abs(_e - _tp) / Math.abs(_s - _e) : 0;
      }
      const _geomOk = _e > 0 && _tp > 0 && _rr >= Math.max(2.0, FLIP_MIN_RR) &&
        ((_newSide === 'BUY' && _tp > _e && _s < _e) || (_newSide === 'SELL' && _tp < _e && _s > _e));
      if (_geomOk) {
        const _fromSide = leader.side;
        leader.preFlip = { side: _fromSide, entry: leader.entry, sl: leader.sl, tp1: leader.tp1, rr: num(leader.math && leader.math.rr, null), score: leader.score };
        leader.side  = _newSide;
        leader.entry = roundPrice(_e);
        leader.sl    = roundPrice(_s);
        leader.tp1   = roundPrice(_tp);
        leader.plan  = { ...leader.plan, entry: leader.entry, sl: leader.sl, tp1: leader.tp1, side: _newSide };
        leader.math  = calculatePaperMath(leader.plan, settings);
        leader.contrarianFlip = true;
        leader.flipReason = `CAPITULATION_FADE: composite ${_comp}, trend5 ${_t5}, W5 fade ${_fromSide}→${_newSide} (ride the bounce)`;
        const _fsi = convictionScore(
          ctx, decision, leader.plan, leader.math, btcRegime,
          { support, resistance, support2, resistance2, atr,
            requiredRR: minRRFor(_newSide, settings),
            minNetTpUsdt: minNetTpFor(settings, leader.math),
            maxTpAtr: maxTpAtrFor(settings) }
        );
        leader.scoreInfo   = _fsi;
        leader.scoring     = _fsi;
        leader.contextDiag = _fsi && _fsi.components ? _fsi.components._context : null;
        leader.score       = _fsi.score;
        leader.tier        = leader.score >= SCORE_A_PLUS ? 'A+' : leader.score >= SCORE_A ? 'A' : leader.score >= SCORE_B ? 'B' : '-';
        leader.flipMeta    = { stage: 'BIRTH', from: _fromSide, to: _newSide, composite: _comp, trend5: _t5, reason: 'CAPITULATION_FADE' };
        addLog('CONTRARIAN_FLIP', `${symbol}: BIRTH ${_fromSide}→${_newSide} CAPITULATION_FADE composite=${_comp} trend5=${_t5} entry=${leader.entry} sl=${leader.sl} tp=${leader.tp1} rr=${leader.math.rr.toFixed(2)} score=${leader.score}`);
      }
    }
  }

  // fixADAPT tilt2: soft conviction dampen when THIS side's recent book is bleeding. Self-relaxing regime
  // filter, NOT a static gate — it lowers the score so more MARGINAL entries fall below the existing minScore
  // gate during a squeeze regime, and lifts automatically when recent results recover. Both sides. Flip
  // children are exempt (they're the corrective trade, not the bleeding side).
  if (ADAPT_ENABLED && !leader.contrarianFlip && adaptiveHostile(leader.side)) {
    const _before = leader.score;
    leader.score = Math.round(leader.score * ADAPT_CONV_MULT);
    leader.tier  = leader.score >= SCORE_A_PLUS ? 'A+' : leader.score >= SCORE_A ? 'A' : leader.score >= SCORE_B ? 'B' : '-';
    leader.adaptiveDampen = { side: leader.side, from: _before, to: leader.score, mult: ADAPT_CONV_MULT, trailWR: getAdaptiveRegime()[String(leader.side).toLowerCase() + 'WR'] };
  }

  // fixBOTTOM: soft conviction dampen inside the validated toxic zone — SELL while breadth sits at the
  // BOTTOM of its trailing range (shorting the local exhaustion low; 16-27% WR across 3 sessions), and
  // the symmetric BUY mirror at the range TOP (weak evidence n=18, 44% vs 65% mid, directionally
  // consistent — both sides in one patch per the symmetry rule, BUY documented as the weaker leg).
  // Like fixADAPT: lowers score so MARGINAL entries fall below the existing minScore gate; strong
  // setups still pass. Flip children exempt (they're the corrective trade). Fail-open on null pctile.
  if (BOTTOM_GUARD_ENABLED && !leader.contrarianFlip) {
    try {
      const _bp = breadthRangePctile();
      if (_bp && _bp.pctile != null) {
        const _sideU = String(leader.side || '').toUpperCase();
        const _inToxicZone = (_sideU === 'SELL' && _bp.pctile <= BOTTOM_PCTILE) ||
                             (_sideU === 'BUY'  && _bp.pctile >= (100 - BOTTOM_PCTILE));
        if (_inToxicZone) {
          const _before = leader.score;
          leader.score = Math.round(leader.score * BOTTOM_CONV_MULT);
          leader.tier  = leader.score >= SCORE_A_PLUS ? 'A+' : leader.score >= SCORE_A ? 'A' : leader.score >= SCORE_B ? 'B' : '-';
          leader.bottomGuard = { side: _sideU, from: _before, to: leader.score, mult: BOTTOM_CONV_MULT,
                                 pctile: _bp.pctile, cur: _bp.cur, lo: _bp.lo, hi: _bp.hi, windowMin: _bp.windowMin };
          addLog('BOTTOM_GUARD', `${leader.symbol}: ${_sideU} in breadth range-${_sideU === 'SELL' ? 'BOTTOM' : 'TOP'} zone (pctile=${_bp.pctile}, breadth=${_bp.cur} in [${_bp.lo}..${_bp.hi}] over ${_bp.windowMin}m) — score ${_before}→${leader.score}`);
        }
      }
    } catch (_eBG) { /* dampen must never block signal creation */ }
  }

  // fixEUPH (4.6.8.76): ABSOLUTE-breadth exhaustion dampener — see config-block comment for the full
  // evidence chain (07/03 blow-off autopsy + 06/29 SELL-bloodbath mirror) and why range-percentile
  // (fixBOTTOM above) is blind to this zone when the trailing range compresses at absolute highs.
  // Deliberately a SEPARATE block from fixBOTTOM, evaluated after it: both can fire on one candidate
  // (range-top AND absolute-euphoria), compounding to ~0.56x — correct, that's the most toxic corner
  // of the map. Reuses the same cached breadthRangePctile() read — `cur` is the absolute level;
  // requires only that cur is present (needs 1 fresh sample, not the 30-sample pctile threshold).
  if (EUPH_GUARD_ENABLED && !leader.contrarianFlip) {
    try {
      const _bp = breadthRangePctile();
      if (_bp && _bp.cur != null) {
        const _sideU = String(leader.side || '').toUpperCase();
        const _inEuphZone = (_sideU === 'BUY'  && _bp.cur >= EUPH_BREADTH_HI) ||
                            (_sideU === 'SELL' && _bp.cur <= EUPH_BREADTH_LO);
        if (_inEuphZone) {
          const _before = leader.score;
          leader.score = Math.round(leader.score * EUPH_CONV_MULT);
          leader.tier  = leader.score >= SCORE_A_PLUS ? 'A+' : leader.score >= SCORE_A ? 'A' : leader.score >= SCORE_B ? 'B' : '-';
          leader.euphGuard = { side: _sideU, from: _before, to: leader.score, mult: EUPH_CONV_MULT,
                               absBreadth: _bp.cur, threshold: _sideU === 'BUY' ? EUPH_BREADTH_HI : EUPH_BREADTH_LO,
                               btcRsi: _bp.btcRsi };
          addLog('EUPH_GUARD', `${leader.symbol}: ${_sideU} at absolute breadth ${_sideU === 'BUY' ? 'euphoria' : 'capitulation'} (bull_pct=${_bp.cur}, ${_sideU === 'BUY' ? '>=' + EUPH_BREADTH_HI : '<=' + EUPH_BREADTH_LO}) — score ${_before}→${leader.score}`);
        }
        // SHADOW ONLY (zero weight): BTC-RSI mid-leg chase marker — BUY while btc_rsi 60-70 went 0/6
        // on 07/03; n far too thin to act on. Stamped so the next batch can score it offline.
        if (_bp.btcRsi != null) {
          const _rsiLegChase = (_sideU === 'BUY' && _bp.btcRsi >= 60 && _bp.btcRsi < 70) ||
                               (_sideU === 'SELL' && _bp.btcRsi > 30 && _bp.btcRsi <= 40);
          if (_rsiLegChase) leader.rsiLegChaseShadow = { side: _sideU, btcRsi: _bp.btcRsi };
        }
      }
    } catch (_eEU) { /* dampen must never block signal creation */ }
  }

  // fixSWEEP (4.6.8.71): sweep evaluation MOVED HERE from shouldReject. The old call site built
  // `_sweepCtx = { k5: leader.k5 || [], k15: leader.k15 || [] }` — but leader NEVER carried k5/k15,
  // so confirmFade always received empty arrays, TA confirmation could never pass, and the boost
  // side of the engine was DEAD WIRE since fix38h (0 sweep-tagged trades in 774 logged) while the
  // suppression side (needs no candles) kept firing invisibly. Real k5/k15 are in scope here.
  // Compact result stamped on leader (no candle arrays — leaders get serialized to the candidate
  // store); shouldReject consumes leader.sweep instead of calling the engine with empty ctx.
  try {
    const _swReasons = [];
    const _sw = sweepEngine.applyToSignal(leader, { k5, k15 }, _swReasons);
    if (_sw.suppressed) {
      leader.sweep = { suppressed: true, label: _swReasons[0] || 'SWEEP_SIDE_SUPPRESSED' };
    } else if (_sw.scoreBoost) {
      const _before = leader.score;
      leader.score = Math.min(100, Math.round(leader.score + _sw.scoreBoost));
      leader.tier  = leader.score >= SCORE_A_PLUS ? 'A+' : leader.score >= SCORE_A ? 'A' : leader.score >= SCORE_B ? 'B' : '-';
      leader.sweep = { suppressed: false, boost: _sw.scoreBoost, from: _before, to: leader.score,
                       tag: _sw.tag, maxRR: _sw.maxRR, confirmations: _sw.confirmations };
      addLog('SWEEP_FADE', `${leader.symbol}: ${leader.side} confirmed fade (${(_sw.confirmations || []).join(',')}) — score ${_before}→${leader.score}`);
    }
  } catch (_eSW) { /* sweep evaluation must never block plan creation */ }

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

function entryToleranceAbs(price, atr, settings = currentSettings()) {
  price = num(price, 0); atr = num(atr, 0);
  if (!price) return 0;
  const tolAtr = Math.max(0.15, Math.min(0.50, num(settings.v4EntryToleranceAtr, ENTRY_TOLERANCE_ATR)));
  const raw = atr > 0 ? atr * tolAtr : price * (ENTRY_TOLERANCE_MAX_PCT / 100);
  const min = price * (ENTRY_TOLERANCE_MIN_PCT / 100);
  const max = price * (ENTRY_TOLERANCE_MAX_PCT / 100);
  return clamp(raw, min, max);
}

function entryReactionAbs(price, atr, settings = currentSettings()) {
  price = num(price, 0); atr = num(atr, 0);
  if (!price) return 0;
  const bps = Math.max(1, Math.min(15, num(settings.v4EntryReactionBps, ENTRY_REACTION_BPS)));
  return Math.max(price * (bps / 10000), atr * ENTRY_REACTION_ATR);
}

function isMemeOrHighVol(symbol, price, atr) {
  const s = String(symbol || '').toUpperCase();
  const ap = atrPct(price, atr);
  return ap >= 4.5 || /(PEPE|BONK|FLOKI|SHIB|DOGE|MEME|MOG|TURBO|BRETT|WIF|PENGU|LADYS|BABY|CAT|DOG|TRUMP)/.test(s);
}

function minSlDistancePctFor(symbol, price, atr, settings = {}) {
  const base = Math.max(0, num(settings.minSlDistancePct, MIN_SL_DISTANCE_PCT));
  const ap = atrPct(price, atr);
  const mult = isMemeOrHighVol(symbol, price, atr) ? MEME_SL_ATR_MULT : NORMAL_SL_ATR_MULT;
  const floor = ap ? ap * mult : 0;
  const highVolFloor = isMemeOrHighVol(symbol, price, atr) ? Math.max(base, 0.35) : base;
  return Math.max(base, floor, highVolFloor);
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


// fix24-b: Two-gate entry timing system
// Gate 1 — Zone touch score (0-30, proximity-based, no candle close needed)
// Gate 2 — Reaction confirmation (candle close + wick + volume, adds 0-20)
// Total entryTimingScore: 0-100 continuous (replaces binary 97/68)

function calcZoneTouchScore(price, entry) {
  if (!price || !entry) return 0;
  const distPct = Math.abs(price - entry) / entry * 100;
  if (distPct <= 0.15) return 30;
  if (distPct <= 0.30) return 22;
  if (distPct <= 0.50) return 14;
  if (distPct <= 1.00) return 6;
  return 0;
}

function calcReactionScore(last, side, avgVolume) {
  if (!last) return 0;
  let pts = 0;
  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  const bodyPct = range > 0 ? body / range : 0;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWickPct = range > 0 ? upperWick / range : 0;
  const lowerWickPct = range > 0 ? lowerWick / range : 0;
  const volOk = avgVolume > 0 && last.volume >= avgVolume * 0.8;

  if (side === 'BUY') {
    if (last.close > last.open) pts += 10;      // bullish candle close
    if (lowerWickPct >= 0.40) pts += 6;         // lower wick rejection >= 40%
    if (volOk) pts += 4;                         // volume confirmation
  } else {
    if (last.close < last.open) pts += 10;       // bearish candle close
    if (upperWickPct >= 0.40) pts += 6;          // upper wick rejection >= 40%
    if (volOk) pts += 4;                          // volume confirmation
  }
  return pts; // max 20
}

// Legacy wrapper — used by older code paths that just want a single score number
function deriveEntryTimingScore(leader, timing = {}) {
  const scoring = leader?.scoreInfo || leader?.scoring || {};
  const entryDistanceAtr = num(scoring.entryDistanceAtr, 2.0);
  const lastRangeAtr = num(scoring.lastRangeAtr, 1.0);
  const price = num(leader?.price, 0);
  const entry = num(leader?.plan?.entry || leader?.entry, 0);

  // Gate 1 — zone touch
  let score = calcZoneTouchScore(price, entry);

  // Gate 1 fallback via ATR distance when price/entry are missing
  if (!score && entryDistanceAtr) {
    if (entryDistanceAtr <= 0.25) score = 28;
    else if (entryDistanceAtr <= 0.50) score = 20;
    else if (entryDistanceAtr <= 1.00) score = 10;
    else if (entryDistanceAtr <= 1.80) score = 4;
    else score = 0;
  }

  // Gate 2 — timing confirmation bonuses
  if (timing.inZone) score += 8;
  if (timing.directional) score += 14;

  // Penalties
  if (lastRangeAtr > 1.8) score -= 8;
  if (lastRangeAtr > 2.5) score -= 8;
  const riskText = [
    ...(Array.isArray(leader?.risks) ? leader.risks : []),
    ...(Array.isArray(scoring?.risks) ? scoring.risks : [])
  ].join(' | ');
  if (/overextended|mild extension|large recent candle|entry too far/i.test(riskText)) score -= 6;

  return clamp(Math.round(score), 0, 100);
}

function computeEntryTiming(ctx, plan, side, atr, settings = currentSettings()) {
  const price = num(ctx?.price, num(plan?.entry));
  const entry = num(plan?.entry);
  const k5 = Array.isArray(ctx?.k5) ? ctx.k5 : [];
  const last = k5.length ? k5[k5.length - 1] : null;
  const vols = k5.map(c => num(c.volume)).filter(Boolean);
  const avgVolume = vols.length ? vols.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,vols.length) : 0;

  // Gate 1: zone touch
  const zoneTouchScore = calcZoneTouchScore(price, entry);
  const inZone = zoneTouchScore >= 14; // within 0.5% of entry

  // Gate 2: reaction confirmation (requires last candle close)
  const reactionScore = inZone ? calcReactionScore(last, side, avgVolume) : 0;
  const directional = reactionScore >= 10; // body direction + at least one other condition

  const tolerance = entryToleranceAbs(entry || price, atr, settings);
  const reaction = entryReactionAbs(entry || price, atr, settings);

  const reason = !inZone
    ? `WAITING_ENTRY: price not in zone (dist ${(Math.abs(price-entry)/entry*100).toFixed(2)}%, need ≤0.5%)`
    : directional
      ? `ENTRY_CONFIRMED: zone touch + candle reaction confirmed (reactionScore=${reactionScore})`
      : `WAITING_REACTION: zone touched, waiting for candle confirmation (reactionScore=${reactionScore}/20)`;

  return {
    inZone,
    directional,
    zoneTouchScore,
    reactionScore,
    tolerance: roundPrice(tolerance),
    reaction: roundPrice(reaction),
    price: roundPrice(price),
    reason,
  };
}

function signalEntryTiming(s, price, atr, now, settings = currentSettings()) {
  const entry = num(s?.entry);
  const tolerance = entryToleranceAbs(entry || price, atr, settings);
  const reaction = entryReactionAbs(entry || price, atr, settings);
  const inZone = !!(price && entry && Math.abs(price - entry) <= tolerance);

  // FIX B: Missed-move detection — if price ran PAST entry in the right direction by > 0.5 ATR
  // without pulling back, activate immediately (breakout/continuation entry).
  // This prevents high-score setups from expiring when price trends through without a pullback.
  if (!inZone && price && entry && atr > 0) {
    const missedMoveThreshold = atr * num(settings.v4MissedMoveAtr, 0.5);
    const priceBeyondForBuy  = s?.side === 'BUY'  && price > entry + missedMoveThreshold;
    const priceBeyondForSell = s?.side === 'SELL' && price < entry - missedMoveThreshold;
    if (priceBeyondForBuy || priceBeyondForSell) {
      return {
        inZone: true,
        directional: true,
        tolerance,
        reaction,
        expiredWindow: false,
        missedMove: true,
        reason: `ENTRY_CONFIRMED: missed-move breakout — price ran ${((Math.abs(price - entry) / atr).toFixed(2))}ATR past entry in trade direction`,
      };
    }
  }

  // Reset the reaction latch when price leaves the entry zone. The old code kept
  // entryZoneTouchedAt forever, so a late move could activate a stale setup.
  if (!inZone) {
    if (s) {
      // fix44f: track first-touch history — if price touched zone and left, record it
      // On second return, signal is higher conviction (same logic that makes retry outperform planner)
      if (s.entryZoneTouchedAt && !s.hadFirstTouch) {
        s.hadFirstTouch = true;       // price visited zone and left → second touch incoming
        s.firstTouchLeftAt = now;
      }
      s.entryZoneTouchedAt = null;
      s.entryZoneTouchPrice = null;
      s.directionalSince = null; // fixHOLD: leaving the zone resets the reaction-hold clock
    }
    return { inZone, directional: false, tolerance, reaction, expiredWindow: false, reason: 'WAITING_ENTRY: price outside tight entry zone' };
  }

  if (!s.entryZoneTouchedAt) {
    s.entryZoneTouchedAt = now;
    s.entryZoneTouchPrice = roundPrice(price);
  }

  const touch = num(s.entryZoneTouchPrice, entry);
  const elapsed = now - num(s.entryZoneTouchedAt, now);
  const maxWaitMs = Math.max(5000, num(settings.v4EntryWaitSeconds, ENTRY_CONFIRMATION_WINDOW_MS / 1000) * 1000);

  // fix44f: second touch = confirmed level. Reaction threshold halved on second return.
  // Retry signals naturally get this because they re-enrich from current price.
  // Planner signals now get same benefit when price leaves zone and returns.
  const effectiveReaction = s.hadFirstTouch ? reaction * 0.5 : reaction;

  let directional = false;
  if (s.side === 'BUY')  directional = price >= Math.max(entry, touch) + effectiveReaction;
  if (s.side === 'SELL') directional = price <= Math.min(entry, touch) - effectiveReaction;

  // ── fixHOLD (hotfix 23, 2026-07-24): require the reaction to HOLD before it confirms ─────────────
  //   The `directional` above is a single INTRATICK price dip of effectiveReaction (~0.10 ATR). In a
  //   bounce that is just noise: the live gate (inZone && directional) fired shorts on a wick, then
  //   price popped back through the stop. PROVEN 07/24 — KAITO/OUSDT/BILL shorts were stopped by a
  //   1.1-1.9% adverse pop (then the real drop came), and their own timing reason still read
  //   "waiting for candle confirmation" while the order had already fired. Candles aren't available at
  //   this per-tick gate, so we can't check a candle CLOSE; instead require the dip to hold beyond the
  //   threshold across a confirmation window (default 40s ≈ 2-3 scan ticks) — a wick that reverses
  //   inside the window never fires, but a real reaction does. Momentum breakouts are exempt (the
  //   missed-move branch returned above, before this). Env V4_DIRECTIONAL_HOLD_MS (0 disables).
  const HOLD_MS = Math.max(0, Number(process.env.V4_DIRECTIONAL_HOLD_MS || '40000'));
  if (HOLD_MS > 0 && s) {
    if (directional) {
      if (!s.directionalSince) s.directionalSince = now;           // first tick the reaction appeared
      if (now - num(s.directionalSince, now) < HOLD_MS) directional = false; // not held long enough yet
    } else {
      s.directionalSince = null;                                    // reaction failed to hold → reset clock
    }
  }
  const expiredWindow = elapsed > maxWaitMs;

  if (!directional && expiredWindow) {
    s.entryZoneTouchedAt = now;
    s.entryZoneTouchPrice = roundPrice(price);
  }

  const touchLabel = s.hadFirstTouch ? 'SECOND_TOUCH' : 'FIRST_TOUCH';
  const reason = directional
    ? `ENTRY_CONFIRMED: ${touchLabel} — price reacted in trade direction (reaction×${s.hadFirstTouch?'0.5':'1.0'})`
    : expiredWindow
      ? 'WAITING_REACTION: confirmation window expired; reset touch'
      : `WAITING_REACTION: ${touchLabel} — zone touched, waiting for direction`;
  return { inZone, directional, tolerance, reaction: effectiveReaction, elapsed, expiredWindow, hadFirstTouch: !!s.hadFirstTouch, reason };
}

function terminalStateOf(s) {
  const st = String(s?.paperState || s?.displayState || s?.status || '').toUpperCase();
  if (st === 'TP_HIT' || st === 'WIN' || st === 'CLOSED_WIN') return 'TP_HIT';
  if (st === 'SL_HIT' || st === 'LOSS' || st === 'CLOSED_LOSS') return 'SL_HIT';
  if (st === 'INVALIDATED' || st === 'INVALID' || st === 'PAPER_INVALID' || st === 'PAPER_INVALIDATED') return 'INVALIDATED';
  if (st === 'EXPIRED' || st === 'PAPER_EXPIRED') return 'EXPIRED';
  if (st === 'STALE_CANCELLED' || st === 'CANCELLED') return 'STALE_CANCELLED';
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

function combinedLedgerSignalRows(signals = []) {
  const out = [];
  const seen = new Set();
  for (const r of [...getLedger(), ...(signals || []).map(normalizeLedgerTrade)]) {
    if (!r) continue;
    const key = r.id || r.key || ledgerKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function clusterLossBlocked(signals, side) {
  const now = Date.now();
  const recent = combinedLedgerSignalRows(signals)
    .filter(s => {
      const st = String(s.paperState || s.result || s.status || '').toUpperCase();
      return s && s.side === side && (st === 'SL_HIT' || st === 'LOSS');
    })
    .map(s => num(s.closedAt || s.updatedAt || s.createdAt, 0))
    .filter(ts => ts && now - ts <= CLUSTER_LOSS_WINDOW_MS)
    .sort((a, b) => b - a);
  if (recent.length < CLUSTER_LOSS_COUNT) return false;
  const blocked = now - recent[0] <= CLUSTER_LOSS_COOLDOWN_MS;
  if (blocked) console.log(`[v4 cluster] ${side} side blocked: ${recent.length} losses in window, most recent ${Math.round((now - recent[0]) / 60000)}min ago`); // FIX20: added log for debugging
  return blocked;
}


function symbolLossLockoutReason(signals, leader, settings = currentSettings()) {
  if (!leader || !leader.symbol || !leader.side) return '';
  const reason = symbolCooldownReason(signals, leader.symbol, leader.side, Date.now(), settings);
  return /LOSS_COOLDOWN|SESSION_LOCKOUT/.test(reason) ? reason : '';
}

function symbolCooldownReason(signals, symbol, side, now = Date.now(), settings = currentSettings()) {
  const rows = combinedLedgerSignalRows(signals).filter(s => s && (s.sym === symbol || s.symbol === symbol) && (!side || s.side === side));
  const active = rows.find(s => ACTIVE_STATES.has(s.paperState));
  if (active) {
    return active.paperState === 'PAPER_ACTIVE' ? 'DUPLICATE_SYMBOL_SIDE_ACTIVE' : 'DUPLICATE_SYMBOL_SIDE_WAITING';
  }

  const lockoutMs = symbolLossLockoutMsFor(settings);
  const riskWindowMs = Math.max(lockoutMs, riskWindowMsFor(settings));
  const losses = rows
    .filter(s => ['SL_HIT','LOSS'].includes(String(s.paperState || s.result || s.status || '').toUpperCase()))
    .map(s => num(s.closedAt || s.updatedAt || s.createdAt, 0))
    .filter(ts => ts && now - ts <= riskWindowMs)
    .sort((a, b) => b - a);
  if (losses.length >= SYMBOL_SESSION_LOCKOUT_LOSSES) return `SYMBOL_${symbol}_${side || 'ANY'}_SESSION_LOCKOUT`;
  if (losses.length && now - losses[0] <= lockoutMs) return `SYMBOL_${symbol}_${side || 'ANY'}_LOSS_COOLDOWN`;

  const winCooldownMs = symbolWinCooldownMsFor(settings);
  const wins = rows
    .filter(s => ['TP_HIT','WIN'].includes(String(s.paperState || s.result || s.status || '').toUpperCase()))
    .map(s => num(s.closedAt || s.updatedAt || s.createdAt, 0))
    .filter(Boolean)
    .sort((a, b) => b - a);
  if (wins.length && now - wins[0] <= winCooldownMs) return `SYMBOL_${symbol}_${side || 'ANY'}_WIN_COOLDOWN`;
  return '';
}

function liveSymbolSideKey(s) {
  return `${String(s?.sym || s?.symbol || '').toUpperCase()}|${String(s?.side || '').toUpperCase()}`;
}

function livePriority(s) {
  const st = String(s?.paperState || '').toUpperCase();
  const t = num(s.updatedAt || s.createdAt);
  // fixEVICT: dedupeLiveSignals keeps only ONE signal per symbol|side among ACTIVE_STATES, ranked by
  // this function. LIVE_OPEN / LIVE_RESTING / LIVE_PENDING / FROZEN were not listed, so they fell to
  // the bare-timestamp branch — meaning a BRAND-NEW signal for the same symbol+side simply out-ranked
  // (newer epoch) and EVICTED a signal holding a REAL OPEN POSITION. The evicted row left the array,
  // was never processed again, and could never book its close: BANKUSDT 07/18 sat at LIVE_OPEN with
  // updatedAt frozen at 14:37:47 while Bybit had already closed it at 14:38:37 for -0.288.
  // The old tiers (1e6 / 5e5 / 2.5e5) were also far SMALLER than the epoch tiebreaker (~1.8e12), so
  // they never actually separated anything. Tiers are now 1e15 apart — above epoch magnitude — so
  // ordering is deterministic and an exchange-owned signal can never lose to a paper one.
  if (st === 'LIVE_OPEN') return 5e15 + t;                                  // real position — never evict
  if (st === 'LIVE_RESTING' || st === 'LIVE_PENDING') return 4e15 + t;      // real order on the book
  if (st === 'FROZEN') return 3e15 + t;                                     // ambiguous — protect
  if (st === 'PAPER_ACTIVE') return 2e15 + t;
  if (st === 'WAITING_REACTION') return 1e15 + num(s.score) * 100 + num(s.rr || s.rr1) * 10 + t / 1e6;
  if (st === 'WAITING_ENTRY' || st === 'CANDIDATE') return 5e14 + num(s.score) * 100 + num(s.rr || s.rr1) * 10 + t / 1e6;
  return t;
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
  const now48z2 = Date.now();
  for (const s of list || []) {
    if (!s || !ACTIVE_STATES.has(s.paperState)) continue;
    const id = s.id || tradeKey(s);
    if (!liveKeep.has(id) || seenLive.has(id)) {
      // fix48z2: a duplicate displaced HERE was previously just omitted from `out` — silently
      // dropped from every downstream pass this cycle, INCLUDING updateExistingSignals()'s age/
      // expiry check (which runs on THIS function's output, later in scanOnce). Because dedupe
      // runs before that check, a displaced-but-still-WAITING duplicate became an invisible zombie:
      // never marked EXPIRED, never logged, sitting in the persistent store until the next restart's
      // unconditional full-store purge finally found it (real case: USUSDT/OUSDT survived 68/106
      // minutes past their own 30-min window before a restart caught them — normal per-scan expiry
      // never got the chance). Fix: explicitly finalize a displaced NON-order-bearing duplicate as
      // EXPIRED right here, so it's logged and resolved THIS cycle instead of orphaned.
      // CRITICAL: an order-bearing signal must NEVER be dropped, finalized, or otherwise touched here
      // — "an order-bearing signal's fate belongs to Bybit" (same rule as the zombie-purge below).
      // It must still be preserved unchanged in `out`, just like before this patch, even though it
      // lost the liveKeep race (a real order can legitimately coexist with a newer candidate row).
      const _orderBearing = !!(s.tradeId || s.orderId || s.orderClaimAt || s.paperState === 'LIVE_RESTING' || s.paperState === 'LIVE_OPEN' || s.paperState === 'LIVE_PENDING');
      if (_orderBearing) {
        if (!seenLive.has(id)) { seenLive.add(id); out.push(s); } // preserve as-is, never finalize
        continue;
      }
      if (!seenLive.has(id)) {
        seenLive.add(id);
        out.push({ ...s, paperState: 'EXPIRED', displayState: 'EXPIRED', status: 'EXPIRED',
                   positionStatus: 'NONE', updatedAt: now48z2, closedAt: now48z2,
                   stateReason: `${V4_VERSION}: superseded by a fresher ${s.side} candidate for the same symbol — displaced duplicate resolved instead of left orphaned` });
      }
      continue;
    }
    seenLive.add(id);
    out.push(s);
  }
  // fix49i(Z): purge orphan-state rows HERE, before the MAX_SIGNALS slice — order-independent.
  // (Doing it only in getSignals' map ran before dedupe, so a just-purged zombie became FINAL and
  // was then sliced out by a flood of newer finals → stranded again. Purging at the slice site
  // guarantees the orphan is finalized regardless of how many rows exist.) A purged zombie keeps
  // its (old) createdAt so it sorts to the tail and naturally ages out of the capped window next
  // cycle — but it leaves as a proper FINAL row, out of the open count and cancellable.
  const now49i = Date.now();
  const purged = out.map(s => {
    if (!s) return s;
    // fixZOMBIE: the purge must NEVER finalize a signal that has a real order/position on the
    // exchange. LIVE_RESTING (a GTC limit resting on Bybit) was not in ACTIVE_STATES, so the old
    // condition treated it as a dead orphan and purged it to EXPIRED — abandoning a live order with
    // no tradeId reclaim possible. Live-money bug seen on TUSDT 07/18. An order-bearing signal's
    // fate belongs to Bybit; the paper purge may only touch truly stateless orphans.
    const orderBearing = !!(s.tradeId || s.orderId || s.orderClaimAt || s.paperState === 'LIVE_RESTING' || s.paperState === 'LIVE_OPEN');
    if (orderBearing) return s; // never purge — liveStateAuthority/unifiedBrain owns it
    if (!ACTIVE_STATES.has(s.paperState) && !FINAL_STATES.has(s.paperState)) {
      return { ...s, paperState: 'EXPIRED', displayState: 'EXPIRED', status: 'EXPIRED', positionStatus: 'NONE', updatedAt: now49i, closedAt: now49i, stateReason: `${V4_VERSION}: orphan-state zombie purged (was '${s.paperState || 'undefined'}')` };
    }
    return s;
  });
  // Keep non-FINAL (active/waiting) rows ahead of FINAL rows before slicing so a live/waiting row
  // is never dropped in favor of a stale closed one; newest-first within each group. Just-purged
  // zombies carry a fresh closedAt (now49i) so they rank among recent finals for one cycle —
  // long enough to show as EXPIRED and drop out of the open count — then age out naturally.
  const _finalRank = (s) => (FINAL_STATES.has(s.paperState) ? 1 : 0);
  const _recency = (s) => num(s.closedAt, num(s.createdAt, num(s.updatedAt, 0)));
  return purged.sort((a, b) => {
    const fr = _finalRank(a) - _finalRank(b);
    if (fr !== 0) return fr;
    return _recency(b) - _recency(a);
  }).slice(0, MAX_SIGNALS);
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
    stateReason: `${V4_VERSION}: ${reason}; refreshed waiting setup with newer/better planner data`,
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

// fix24-b: btcRegimeDecision updated for 6-state regime labels
function btcRegimeDecision(leader, settings, btcUnknownException = false) {
  const mode = String(settings.btcRegimeMode || 'direction_match').toLowerCase();
  const regime = String(leader.btcRegime || 'UNKNOWN').toUpperCase();
  const side = String(leader.side || '').toUpperCase();
  const reasons = [];
  const warnings = [];

  if (mode === 'off') return { reasons, warnings: ['BTC_REGIME_FILTER_OFF'] };

  if (!regime || regime === 'UNKNOWN') {
    warnings.push(btcUnknownException ? 'BTC_UNKNOWN_HIGH_CONFIDENCE_EXCEPTION' : 'BTC_REGIME_UNKNOWN_NEUTRAL');
    if ((mode === 'strict' || settings.rejectUnknownBtcRegime) && !btcUnknownException) reasons.push('BTC_REGIME_UNKNOWN');
    return { reasons, warnings };
  }

  if (regime === 'CHOP') {
    // fix39: CHOP no longer hard-blocks in direction_match mode.
    // calibratedScore already applies -12 penalty for CHOP. Hard block = zero signals.
    // strict mode still blocks.
    warnings.push('BTC_CHOP_REGIME');
    if (mode === 'strict') reasons.push('BTC_CHOP_BLOCKS_TRADE');
    return { reasons, warnings };
  }

  // Hard blocks — regime directly opposed to side.
  // FIX: sentinelBrain emits STRONG_BULL/BULL/CHOP/BEAR/STRONG_BEAR — not old BEAR_TREND/BULL_TREND labels.
  // fix36: regimeBrain emits BULL_TREND/BEAR_TREND/BULL_RANGE/BEAR_RANGE/BREAKOUT/CHOP
  // sentinelBrain emits STRONG_BULL/BULL/CHOP/BEAR/STRONG_BEAR.
  // leader.btcRegime = regimeBrain.regime. Normalize both namespaces here.
  const BULL_REGIMES = ['STRONG_BULL', 'BULL', 'BULL_TREND', 'BREAKOUT'];
  const BEAR_REGIMES = ['STRONG_BEAR', 'BEAR', 'BEAR_TREND'];

  if (side === 'BUY' && BEAR_REGIMES.includes(regime)) {
    // fix49k: BREADTH-OVERRIDE BUY-rescue. Strong bull breadth under a bear label → don't block.
    if (breadthOverrideSide('BUY', regime, settings) === 'BUY') {
      warnings.push(`BREADTH_OVERRIDE_BUY_${regime}`);
    } else if (mode === 'direction_match' || mode === 'strict') {
      reasons.push(`BTC_${regime}_BLOCKS_BUY`);
      return { reasons, warnings };
    } else {
      warnings.push(`BTC_${regime}_WEAK_FOR_BUY`);
    }
  }
  if (side === 'SELL' && BULL_REGIMES.includes(regime)) {
    // fix49k: BREADTH-OVERRIDE SELL-rescue (mirror). Heavy bear breadth under a bull label → don't
    // block. This is the case that bit us live: breadth 24.8% bull, label still BULL, SELL hard-
    // blocked, BUYs losing into a 74%-bear tape with no way to short it.
    if (breadthOverrideSide('SELL', regime, settings) === 'SELL') {
      warnings.push(`BREADTH_OVERRIDE_SELL_${regime}`);
    } else if (mode === 'direction_match' || mode === 'strict') {
      reasons.push(`BTC_${regime}_BLOCKS_SELL`);
      return { reasons, warnings };
    } else {
      warnings.push(`BTC_${regime}_WEAK_FOR_SELL`);
    }
  }

  // neutral_allowed mode: add warning but don't block for aligned trades
  if (mode === 'neutral_allowed') {
    if (side === 'BUY' && !BULL_REGIMES.includes(regime) && !BEAR_REGIMES.includes(regime)) warnings.push('BTC_CHOP_NEUTRAL_FOR_BUY');
    if (side === 'SELL' && !BEAR_REGIMES.includes(regime) && !BULL_REGIMES.includes(regime)) warnings.push('BTC_CHOP_NEUTRAL_FOR_SELL');
  }

  // Strict mode: require exact alignment
  if (mode === 'strict') {
    if (side === 'BUY' && !BULL_REGIMES.includes(regime)) reasons.push(`BTC_${regime}_NOT_BULLISH_FOR_BUY`);
    if (side === 'SELL' && !BEAR_REGIMES.includes(regime)) reasons.push(`BTC_${regime}_NOT_BEARISH_FOR_SELL`);
  }

  return { reasons, warnings };
}

function globalRiskBlockReason(signals = [], settings = currentSettings()) {
  const now = Date.now();
  const cutoff = now - riskWindowMsFor(settings);
  const rows = [];
  const seen = new Set();
  const signalRows = (signals || []).filter(Boolean).map(normalizeLedgerTrade);
  // fix39b: skip losses before last clearSignals() call — UI ledger clear resets risk block
  const riskResetTs = num(store.read('v4_risk_reset_ts', { ts: 0 }).ts, 0);
  for (const r of [...getLedger(), ...signalRows]) {
    if (!r) continue;
    const key = r.id || r.key || ledgerKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    const result = String(r.result || r.status || '').toUpperCase();
    if (result !== 'WIN' && result !== 'LOSS') continue;
    const ts = num(r.closedAt || r.updatedAt || r.createdAt || r.openedAt, 0);
    if (!ts || ts < cutoff) continue;
    if (riskResetTs && ts < riskResetTs) continue; // fix39b: pre-reset losses don't count
    rows.push({ ...r, result, ts, realizedPnl: num(r.realizedPnl, result === 'WIN' ? num(r.netTpUSDT) : num(r.netSlUSDT)) });
  }
  rows.sort((a, b) => b.ts - a.ts);
  if (!rows.length) return '';

  // FIX31: Count consecutive losses per SIDE separately — SELL losses shouldn't block BUY and vice versa.
  // Also reduce hold from 2hr → 1hr. With fix30 BTC regime gate blocking wrong-side trades,
  // the root cause of loss clusters is fixed; cooldown just needs to be a safety valve.
  let consecutiveLossesAll = 0;
  let consecutiveLossesBuy = 0;
  let consecutiveLossesSell = 0;
  let lastLossTs = 0;
  let lastLossTsBuy = 0;
  let lastLossTsSell = 0;
  for (const r of rows) {
    if (r.result === 'LOSS') {
      consecutiveLossesAll += 1;
      if (!lastLossTs) lastLossTs = r.ts;
      const rSide = String(r.side || '').toUpperCase();
      if (rSide === 'BUY')  { consecutiveLossesBuy  += 1; if (!lastLossTsBuy)  lastLossTsBuy  = r.ts; }
      if (rSide === 'SELL') { consecutiveLossesSell += 1; if (!lastLossTsSell) lastLossTsSell = r.ts; }
    } else break;
  }
  const maxConsecutive = Math.max(1, num(settings.v4MaxConsecutiveLosses, MAX_CONSECUTIVE_LOSSES));
  // fix36: fix31 comment claimed per-side counting but code still used consecutiveLossesAll.
  // True fix: block all trading when all-side streak hits (cross-side cluster = bad market conditions).
  // This also correctly resets when a WIN on EITHER side breaks the streak.
  const blockHoldMs = Math.max(1, Number(process.env.V4_CONSEC_LOSS_HOLD_HOURS || '1')) * 60 * 60 * 1000;
  if (consecutiveLossesAll >= maxConsecutive) {
    const timeSinceLastLoss = now - lastLossTs;
    if (timeSinceLastLoss < blockHoldMs) {
      const resumeInMin = Math.ceil((blockHoldMs - timeSinceLastLoss) / 60000);
      return `RISK_BLOCK_${consecutiveLossesAll}_CONSECUTIVE_LOSSES_RESUME_IN_${resumeInMin}MIN`;
    }
    // Hold period elapsed — allow trading again
  }

  const net = rows.reduce((a, r) => a + num(r.realizedPnl), 0);
  const maxLoss = Math.max(0, num(settings.v4MaxSessionLossUsdt, MAX_SESSION_LOSS_USDT));
  if (maxLoss > 0 && net <= -maxLoss) return `RISK_BLOCK_ROLLING_LOSS_${net.toFixed(2)}_LE_${maxLoss}`;
  return '';
}

function shouldReject(leader, settings, signals = []) {
  const reasons = [];
  const warnings = [];

  // fix-sentinel-observe: sentinel gates DISABLED — sentinel is observer only.
  // Data showed frontend (no sentinel gate) 76% WR vs backend (gated) 52% WR.
  // Sentinel was blocking good signals and getting confused by regimeBrain conflict.
  // Gates will be re-enabled once we have 500+ clean trades to calibrate properly.
  const sent = sentinel.getSentinel();
  const sentimentReady = sent && sent.market_regime !== 'UNKNOWN';
  // Sentinel still runs and logs conflicts — for data collection only, no gating
  const sentinelAgeMs = sent && sent.updatedAt ? Date.now() - sent.updatedAt : Infinity;
  const sentinelStale = sentinelAgeMs > 5 * 60 * 1000;
  if (sentinelStale && sentimentReady) {
    warnings.push(`SENTINEL_STALE_${Math.round(sentinelAgeMs/1000)}s`);
  }

  // Log regime conflict as warning only — data collection for future calibration
  const _btcMtfBull = ['BULL_TREND','BREAKOUT','BULL_RANGE'].includes(String(leader.btcRegime || '').toUpperCase());
  const _btcMtfBear = ['BEAR_TREND','BEAR_RANGE'].includes(String(leader.btcRegime || '').toUpperCase());
  const _sentBull   = ['STRONG_BULL','BULL'].includes(String(sent && sent.market_regime || '').toUpperCase());
  const _sentBear   = ['STRONG_BEAR','BEAR'].includes(String(sent && sent.market_regime || '').toUpperCase());
  const _sentinelBtcConflict = sentimentReady && !sentinelStale && (
    (_sentBull && _btcMtfBear) || (_sentBear && _btcMtfBull)
  );
  if (_sentinelBtcConflict) {
    warnings.push(`SENTINEL_BTC_CONFLICT:sentinel=${sent.market_regime},btcMtf=${leader.btcRegime}`);
  }

  // fix48i: NARROW, SAFE sentinel side-block (re-enabled with strict guards).
  // The old sentinel gating throttled the whole system via stacking score_adj inflation AND still
  // let losers through (it adjusted gates but never blocked the side). This is different: a single
  // binary side-block that ONLY fires when the sentinel is FRESH, READY, and has explicitly removed
  // this side from allowed_sides because the regime opposes it. It cannot inflate gates, cannot
  // affect the other side, and self-disables the moment the sentinel goes stale (anti-throttle).
  // Data (02:36 flip): APT/NEAR SELLs fired 2-3 min AFTER BEAR→BULL — this is exactly that case.
  const _sentAllowed = Array.isArray(sent && sent.allowed_sides) ? sent.allowed_sides.map(x => String(x).toUpperCase()) : null;
  const _sideUp = String(leader.side || '').toUpperCase();
  const _sentClearRegime = ['STRONG_BULL', 'BULL', 'STRONG_BEAR', 'BEAR'].includes(String(sent && sent.market_regime || '').toUpperCase());
  const _sentinelSideBlock =
    sentimentReady &&            // regime is known
    !sentinelStale &&            // data is fresh (<5 min) — stale sentinel CANNOT block
    _sentClearRegime &&          // only in a clear directional regime (never in CHOP/UNKNOWN)
    Array.isArray(_sentAllowed) &&
    _sentAllowed.length > 0 &&   // sentinel actually computed sides (not empty/error state)
    !_sentAllowed.includes(_sideUp); // and this side is NOT permitted
  // fix49k: BREADTH-OVERRIDE supersedes the sentinel side-block too (full allowed). When breadth
  // strongly disagrees with the label, the SENTINEL_SIDE_BLOCKED gate is keyed on the SAME lagging
  // composite label that the override is overriding — so letting it re-block would only half-open
  // the door. Tonight's live case: BULL label + 24% breadth + allowed_sides=[BUY] → SELL hit BOTH
  // the BTC-label block AND this one; the override must beat both or the SELL never fires.
  const _breadthOvr = breadthOverrideSide(_sideUp, String(leader.btcRegime || '').toUpperCase(), settings);
  if (_sentinelSideBlock && _breadthOvr === _sideUp) {
    warnings.push(`BREADTH_OVERRIDE_${_sideUp}_BEATS_SENTINEL_BLOCK_regime=${sent.market_regime}`);
  } else if (_sentinelSideBlock) {
    reasons.push(`SENTINEL_SIDE_BLOCKED_${_sideUp}_regime=${sent.market_regime}`);
  }
  // NOTE: sentinel score/RR gate INFLATION remains disabled — only the binary side-block above is active.

  // fix49h(H2): BREADTH-FIGHTING GATE. Strongest validated finding at n=196 closed trades:
  // breadth-ALIGNED trades = 65% WR, +0.26U/trade; breadth-FIGHTING = 38% WR, +0.05U/trade (zero
  // expectancy, pure variance). Graded by design — the goal is filtering the bad, not cutting reach:
  //   HARD reject (extremes, data-clear):  BUY at breadth <= 30% bull  |  SELL at >= 70% bull
  //   WARN only (thin bands, n<=2 — collect): BUY 30-40  |  SELL 60-70
  // Fail-open: no breadth data, or last-known snapshot older than 30 min → warn, never block
  // (the old sentinel gating throttled the whole system when stale — never again).
  // Uses getSentinelForCapture(): live sentinel with last-known-good fallback, so a sentinel gap
  // at signal time no longer means an ungated trade (also the null-capture fix direction).
  // Tunable without redeploy: V4_BUY_MIN_BREADTH (default 30), V4_SELL_MAX_BREADTH (default 70).
  let _breadthGate = { pct: null, usable: false, stale: false };
  try {
    const { sent: _bSent, stale: _bStale, ageMs: _bAgeMs } = getSentinelForCapture();
    const _bPairs = num(_bSent?.vol?.pair_count, 0);
    const _bPct = _bPairs > 0 ? num(_bSent?.vol?.bull_pct, NaN) : NaN;
    const _bUsable = Number.isFinite(_bPct) && (!_bStale || _bAgeMs <= 30 * 60 * 1000);
    _breadthGate = { pct: Number.isFinite(_bPct) ? Number(_bPct.toFixed(1)) : null, usable: _bUsable, stale: !!_bStale };
    if (_bUsable) {
      // fix49o: 30/70 -> 50/50 MIRRORED. 191-trade pooled analysis: BUY edge needs breadth >=50%
      // (<50% was a losing zone, 33-0% WR across buckets); SELL edge needs breadth <=50% (>=65%
      // bull was where SELL lost). Both constants clamp at 50 by design (BUY_MIN_BREADTH max=50,
      // SELL_MAX_BREADTH min=50) so this sits exactly at each function's hard limit — confirmed
      // intentional ceiling/floor, not a workaround. Soft-warn thresholds (BUY<=65, SELL>=35) tag the
      // marginal band just past the hard floor; they are COSMETIC ONLY (pushed to gate.warnings,
      // never read by scoring) — if ever promoted to a real penalty, re-validate the band vs data first.
      const BUY_MIN_BREADTH  = Math.max(0, Math.min(50, Number(process.env.V4_BUY_MIN_BREADTH  || '50')));
      const SELL_MAX_BREADTH = Math.max(50, Math.min(100, Number(process.env.V4_SELL_MAX_BREADTH || '50')));
      if (_sideUp === 'BUY') {
        if (_bPct <= BUY_MIN_BREADTH) reasons.push(`BREADTH_FIGHT_BUY_${_bPct.toFixed(0)}PCT_LE_${BUY_MIN_BREADTH}`);
        else if (_bPct <= 65) warnings.push(`BREADTH_SOFT_BUY_${_bPct.toFixed(0)}PCT`);
      } else if (_sideUp === 'SELL') {
        if (_bPct >= SELL_MAX_BREADTH) reasons.push(`BREADTH_FIGHT_SELL_${_bPct.toFixed(0)}PCT_GE_${SELL_MAX_BREADTH}`);
        else if (_bPct >= 35) warnings.push(`BREADTH_SOFT_SELL_${_bPct.toFixed(0)}PCT`);
      }
    } else {
      warnings.push('BREADTH_UNAVAILABLE_NO_GATE');
    }
  } catch (_e) { warnings.push('BREADTH_GATE_ERROR_NO_GATE'); }

  // fixPCTL: BREADTH-PERCENTILE EXTREME — SHADOW ONLY, never blocks. Live 07/18: 5 SELL losses at
  // breadthRangePctile 97-99 all passed the absolute-breadth gate above because bull_pct sat at
  // 47-50 (< SELL_MAX 50). Percentile-extreme + absolute-mid = compressed breadth range — a zone
  // the absolute gate is structurally blind to. n=5 is far too small to gate on; this warning tags
  // every such candidate so the next dataset can decide whether the zone deserves a real gate.
  try {
    const _pc = getBreadthPctileState();
    const _pp = num(_pc && _pc.pctile, NaN);
    if (Number.isFinite(_pp)) {
      if (_sideUp === 'SELL' && _pp >= 95) warnings.push(`BREADTH_PCTILE_EXTREME_SELL_${_pp.toFixed(0)}_SHADOW`);
      else if (_sideUp === 'BUY' && _pp <= 5) warnings.push(`BREADTH_PCTILE_EXTREME_BUY_${_pp.toFixed(0)}_SHADOW`);
    }
  } catch (_e) { /* shadow flag must never affect gating */ }

  // Use user settings only — no sentinel gate override
  const userMinScore = minScoreForSide(leader.side, settings);
  const minScore = userMinScore;

  const userMinRR = minRRFor(leader.side, settings);
  const minRR = userMinRR;

  // fix38f: symbol confidence decay — re-signal same symbol+side in short window = indecision
  // Check existing signals (live) for recent same-sym+side within decay window
  const _now38f = Date.now();
  const _sameRecent = (signals || []).filter(s => {
    const sym = String(s.sym || s.symbol || '').toUpperCase();
    const ts  = Number(s.createdAt || s.updatedAt || 0);
    return sym === String(leader.symbol || '').toUpperCase() &&
           s.side === leader.side &&
           _now38f - ts < 30 * 60 * 1000; // 30 min window
  });
  if (_sameRecent.length >= 1) {
    const ageMin = Math.min(..._sameRecent.map(s => (_now38f - Number(s.createdAt || s.updatedAt || 0)) / 60000));
    // fix39: warn only — hard rejection was blocking valid re-entries after invalidations
    warnings.push(ageMin < 15 ? `SYMBOL_DECAY_FAST:${Math.round(ageMin)}min` : `SYMBOL_DECAY:${Math.round(ageMin)}min`);
  }

  const minNetTpInfo = minNetTpDetails(settings, leader.math);
  const minNetTp = minNetTpInfo.required;
  const minNetRR = minNetRRFor(settings);
  const atr = num(leader?.keyLevels?.atr, 0);
  const px = num(leader?.price || leader?.plan?.entry, 0);
  const minSlPct = minSlDistancePctFor(leader?.symbol, px, atr, settings);
  const slPct = slDistancePct(leader);
  // fixSWEEP (4.6.8.71): consume the sweep result stamped in buildStructurePlan (where real k5/k15
  // exist) — the old direct call here passed leader.k5/k15 which never existed, see plan-side comment.
  // Suppression is now LOGGED: it fired invisibly since fix38h (suppressed candidates are never born,
  // so they leave no ledger trace) — next dataset can finally quantify what it's been rejecting.
  // Log throttled to once per symbol per sweep window: the trade log is a 1000-entry ring and an
  // unthrottled 45-min sweep (per candidate × per ~2-min scan) could evict everything else in it.
  if (leader.sweep && leader.sweep.suppressed) {
    reasons.push(leader.sweep.label || 'SWEEP_SIDE_SUPPRESSED');
    try {
      const _swKey = `${leader.sweep.label}:${leader.symbol}`;
      if (!_sweepSuppressLogged.has(_swKey)) {
        if (_sweepSuppressLogged.size > 600) _sweepSuppressLogged.clear();
        _sweepSuppressLogged.add(_swKey);
        addLog('SWEEP_SUPPRESS', `${leader.symbol}: ${leader.side} suppressed (${leader.sweep.label})`);
      }
    } catch (_e) {}
  }

  const btcUnknown = !leader.btcRegime || leader.btcRegime === 'UNKNOWN';
  const btcUnknownException = btcUnknown && btcUnknownHighConfidenceOk(leader);

  // fix27: entry timing gate redesign
  // NOT_IN_ENTRY_ZONE was a HARD REJECT killing all signals where price had not yet
  // reached the entry zone. Signals must queue as WAITING_ENTRY; the two-gate state
  // machine (updateExistingSignals) handles promotion to WAITING_REACTION → PAPER_ACTIVE.
  // Moving to warnings so signals still queue but never activate prematurely.
  const timing = leader?.entryTiming || {};
  const zoneTouchScore = num(timing.zoneTouchScore, 0);
  const reactionScore = num(timing.reactionScore, 0);
  const minZoneTouch = 6; // kept for snapshot/diagnostic reference only
  if (zoneTouchScore < minZoneTouch) warnings.push('NOT_IN_ENTRY_ZONE');

  // fixAGREEBLOCK (hotfix 17): stop generating new candidates entirely for a symbol Bybit has
  // already told us it will refuse until a product agreement is signed on Bybit's site — no point
  // re-litigating the same rejection every scan cycle. HARD_REJECT_PREFIXES below marks this
  // never-retry (it won't resolve until the user acts outside this codebase).
  try {
    if (require('./executor').isAgreementBlocked(leader.symbol)) reasons.push('SYMBOL_AGREEMENT_REQUIRED');
  } catch (_e) { /* executor not loaded yet at boot — fail open, canTradeSignal still gates at execution time */ }
  // fixENFORCE (hotfix 18) — bottom-range HARD gate DELIBERATELY NOT SHIPPED. It was built, then
  // killed by its own pre-ship replay on this week's 272 completed signals: SELL @ pctile<=15 ran
  // 17W/14L (55% WR, +6.12U) THIS week — the 16-27% WR trap signature belonged to the bloodbath
  // regime and has since inverted, exactly the TRAP_CONTRADICTS_SIDE lesson (79% WR CALM vs 37%
  // ELEVATED). Hard-gating it now would have blocked profitable trades. The ×0.75 dampener below
  // remains as-is. Do not promote this gate again without a regime-conditioned replay passing.
  if (!['BUY', 'SELL'].includes(leader.side)) reasons.push('NO_DIRECTION');
  // fix44f: contrarian flip SELLs bypass SELL_SIDE_DISABLED — they're high-conviction counter-trend trades
  if (!sideAllowed(leader.side, settings) && !leader.contrarianFlip) reasons.push('SELL_SIDE_DISABLED');
  // fix48: block entries where price is already at/past the planned zone (entryDistanceAtr ≤ 0.25)
  // Data: 16 losses vs 3 wins (16% WR) when entry is this tight.
  // Root cause: tight entries = momentum-chase with noise stop, no pullback, gets stopped immediately.
  const _entryAtr = num(leader?.scoreInfo?.entryDistanceAtr, 0);
  if (_entryAtr > 0 && _entryAtr <= 0.25) reasons.push('ENTRY_ALREADY_AT_ZONE');

  if (!passesRsiDirectionGate(leader.side, leader.rsi)) reasons.push(`RSI_GATE_${leader.side}_${leader.rsi}`);
  if (leader.math.rr < minRR) reasons.push(`RR_LT_${minRR}`);
  // fix48f: HARD block RR > 3.0 — NO exemptions. Data is unambiguous across 81+ trades:
  // RR>3.0 = 0 wins / 5 losses in the latest session, ~20-25% WR historically, negative net.
  // The structureSignal/contrarianFlip exemptions were a skeleton key that let every
  // RR>3 counter-trend SELL through (PLAYSOUT 5.47, INJ 4.00, TON 3.64, LAB 5.99 — all lost).
  // High RR here = TP parked at a structurally unreachable level (~4.1% away vs 2.4% for winners),
  // not a tight stop. The target simply never prints. This is a zero-win section, not a narrow edge.
  if (leader.math.rr > 3.0) reasons.push(`RR_GT_3.0_BLOCKED_${leader.math.rr.toFixed(2)}`);

  // fix47: PLANNER_RR_DEADZONE removed — RR 2.25-2.74 data from 3 sessions not sufficient
  // to permanently block. Let signals through, track outcomes, re-evaluate with more data.
  // fix43: LOCAL_BEAR → score penalty not hard reject. 78 kills in alerts data.
  // Also: detectLocalRegime() uses 5m only — k15 passed but closes15 never used in classification.
  // A 1h bull pullback on 5m looks LOCAL_BEAR and was being hard-blocked.
  // Now: LOCAL_BEAR on 5m = -12 score penalty. Only hard-block if k15 ALSO confirms bear (trend15=bear).
  const _localR = String(leader?.scoreInfo?.localRegime || leader?.plan?.localRegime || '').toUpperCase();
  if (_localR === 'LOCAL_BEAR') {
    if (leader.trend15 === 'bear') {
      // Both 5m and 15m confirm bear — genuine local bear, hard block
      reasons.push('LOCAL_BEAR_BLOCKED_CONFIRMED');
    } else {
      // 5m bear but 15m not confirming — likely pullback, apply penalty only
      warnings.push('LOCAL_BEAR_5M_ONLY_WARN');
    }
  }
  // fix43e: hard block BULL_RANGE SELL — data: 40 trades, 35% WR, -6.18U across all sessions
  // In BULL_RANGE BTC is net bullish — SELL signals fight the macro tide, structurally losing
  // fix47: exempt structureSignal (W5 exhaustion, CHoCH, TRAP, DIVERGENCE) — these ARE the valid
  // counter-trend fades. W5 exhaustion at a bull range top is precisely the highest-conviction SELL.
  const _btcRForSellBlock = String(leader.btcRegime || '').toUpperCase();
  if (_btcRForSellBlock === 'BULL_RANGE' && leader.side === 'SELL' && !leader.structureSignal && !leader.contrarianFlip) reasons.push('BULL_RANGE_SELL_BLOCKED');

  // fix43b: use leader.btcRegime (regimeBrain, 3-TF) not sentRegime (sentinelBrain, disabled/stale)
  const _btcRegimeForSell = String(leader.btcRegime || '').toUpperCase();
  const _isBullRegime = ['BULL_TREND','BULL_RANGE','BREAKOUT','BULL'].includes(_btcRegimeForSell);
  // fix47: also exempt structureSignal from SELL_RR_TOO_HIGH_IN_BULL — W5 exhaustion SELL at bull top
  // targeting a distant support is exactly right — don't cap its TP
  if (_isBullRegime && leader.side === 'SELL' && leader.math.rr > 2.5 && !leader.structureSignal && !leader.contrarianFlip) reasons.push('SELL_RR_TOO_HIGH_IN_BULL');
  if (leader.math.netTpUSDT < minNetTp) reasons.push(`NET_TP_TOO_SMALL_${leader.math.netTpUSDT}_LT_${minNetTp}`);
  if (minNetRR > 0 && num(leader.math.netRr, 0) < minNetRR) reasons.push(`NET_RR_LT_${minNetRR}`);
  if (slPct > 0 && slPct < minSlPct) reasons.push(`SL_TOO_TIGHT_${slPct.toFixed(2)}_LT_${minSlPct}`);
  // fix42: hard cap on SL width — data: SL>2.5% = 0W 4L, -6.71U across 2 sessions
  if (slPct > 2.5) reasons.push(`SL_TOO_WIDE_${slPct.toFixed(2)}_GT_2.5PCT`);

  const targetAtr = num(leader?.scoreInfo?.targetDistanceAtr, 0);
  const maxTargetAtr = maxTpAtrFor(settings);
  // fix27: was Math.min(8.0, maxTargetAtr + scoreTpBonus) — Math.min capped the bonus to zero
  // when maxTargetAtr=8.0 (default). Score bonus now actually extends the gate.
  // Data: median TP is 11.87x ATR. Gate 8.0*1.10=8.8 blocked 737 signals (dominant skip reason).
  // fix48b: thresholds 85/75 still reasonable — fix48 3-family signals score 60-100; 2-family hostile-regime floor ~46.
  // A 3-family score of 85+ (60+15+10) means BULL_TREND + zone-touch + 3 families. High conviction = wider TP gate is correct.
  const scoreTpBonus = leader.score >= 85 ? 2.5 : leader.score >= 75 ? 1.5 : 0;
  const effectiveMaxTpAtr = maxTargetAtr + scoreTpBonus; // no Math.min cap — bonus is real
  if (targetAtr && targetAtr > effectiveMaxTpAtr * 1.10) reasons.push(`TP_TOO_FAR_${targetAtr.toFixed(2)}ATR_GT_${effectiveMaxTpAtr.toFixed(1)}`);

  const btc = btcRegimeDecision(leader, settings, btcUnknownException);
  reasons.push(...btc.reasons);
  warnings.push(...btc.warnings);

  if (settings.rejectTrendConflict) {
    // fix27: requires ALL 3 TFs to conflict — true structural opposition, not a pullback.
    // fix48b: exempt structureSignal and contrarianFlip — in fix48, a SELL voted by F1(Elliott W5)
    // + F2(CHoCH/TRAP) in a full bull trend is the correct counter-trend fade. F3 abstained
    // precisely because trend was bull. Blocking it here contradicts the family vote system.
    // fixTRENDVETO (hotfix 19): the old veto required ALL THREE timeframes against the side, so a
    // coin pumping hard on 5m+15m still got shorted as long as the 1h EMA hadn't flipped yet —
    // exactly the AKE/NIGHT/RE screenshot pattern (short opened INTO a fresh vertical run, stopped
    // in 1-7 min). Majority vote now: 2 of 3 timeframes against the side vetoes the entry. The
    // structureSignal and contrarianFlip exemptions are kept unchanged — flips are deliberate
    // counter-plays. HONESTY NOTE: trends were never persisted to the ledger, so this gate could
    // not be replay-validated offline like hotfix 18's kills were; it is grounded in the code audit
    // + 14 live loss screenshots. The diag stamp added below makes it auditable from now on —
    // judge it by ENFORCE counts vs outcomes after a few days, and revert if the data disagrees.
    const _t19 = { b: 0, s: 0 };
    for (const _tf of [leader.trend5, leader.trend15, leader.trend1h]) {
      if (_tf === 'bull') _t19.b++; else if (_tf === 'bear') _t19.s++;
    }
    if (leader.side === 'BUY' && _t19.s >= 2 && !leader.structureSignal && !leader.contrarianFlip) reasons.push(`TREND_CONFLICT_LONG_${_t19.s}OF3`);
    if (leader.side === 'SELL' && _t19.b >= 2 && !leader.structureSignal && !leader.contrarianFlip) reasons.push(`TREND_CONFLICT_SHORT_${_t19.b}OF3`);
  }

  // fixRSIGATE: the old settings.rejectRsiConflict check (BUY>=78 / SELL<=22) is now superseded —
  // passesRsiDirectionGate() above is strictly tighter (BUY 30-70, SELL 30-45∪55-70) and is the sole
  // RSI/direction rule. Keeping both would just be two overlapping gates, which is what this hotfix
  // was explicitly asked to stop doing.

  // fix43: EXTENSION_RISK, MOMENTUM_CONFLICT, ELLIOTT_WAVE_CONFLICT → warnings only (not hard rejects).
  // Data: 472 combined hard kills across 1500 alerts. High-score signals were blocked by these.
  // Score penalties already applied inside calibratedScore(). Hard reject was double-punishing.
  if (settings.rejectMildExtension && hasRiskOrReason(leader, /mild extension|overextended|extreme short-term extension|late wave 5/i)) warnings.push('EXTENSION_RISK_WARN');
  if (settings.rejectMomentumConflict) {
    const _btcR = String(leader.btcRegime || settings.currentBtcRegime || '').toUpperCase();
    const _bearAligned = leader.side === 'SELL' && ['STRONG_BEAR','BEAR','BEAR_TREND'].includes(_btcR);
    const _bullAligned = leader.side === 'BUY'  && ['STRONG_BULL','BULL','BULL_TREND','BREAKOUT'].includes(_btcR);
    if (!_bullAligned && leader.side === 'BUY'  && hasRiskOrReason(leader, /short momentum down/i)) warnings.push('MOMENTUM_CONFLICT_LONG_WARN');
    if (!_bearAligned && leader.side === 'SELL' && hasRiskOrReason(leader, /short momentum up/i))   warnings.push('MOMENTUM_CONFLICT_SHORT_WARN');
  }

  const ew = leader?.scoreInfo?.elliottWave || leader?.scoring?.elliottWave || null;
  if (settings.rejectElliottConflict && ew && ew.reject) warnings.push('ELLIOTT_WAVE_CONFLICT_WARN');
  if (settings.entryConfirmationRequired && !entryConfirmationOk(leader)) warnings.push('ENTRY_CONFIRMATION_PENDING');
  const lockout = symbolLossLockoutReason(signals, leader, settings);
  if (lockout) reasons.push(lockout);
  if (clusterLossBlocked(signals, leader.side)) reasons.push(`CLUSTER_${leader.side}_LOSSES_COOLDOWN`);
  const riskBlock = globalRiskBlockReason(signals, settings);
  if (riskBlock) reasons.push(riskBlock);
  if (settings.minTurnover24h && leader.turnover24h < settings.minTurnover24h) reasons.push('LOW_TURNOVER');
  // fix73: DEAD_HOUR birth block — planner path. Side-agnostic (time-based), no separate BUY/SELL
  // branch needed; see the fix73 block comment above isDeadHourLK() for the evidence and rationale.
  if (isDeadHourLK()) reasons.push(`DEAD_HOUR_NO_NEW_SIGNALS_${deadHourLabel().replace(/\s+/g, '')}`);

  const gate = {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    warnings: [...new Set(warnings)],
    minNetTpInfo, minNetRR, netRr: num(leader.math.netRr, 0),
    // fix24-b: new timing fields replace entryTimingScore. fix27: NOT_IN_ENTRY_ZONE moved to warnings
    zoneTouchScore, reactionScore,
    minZoneTouch, minRR, minScore, slPct, minSlPct,
    breadthGate: _breadthGate // fix49h(H2): breadth value + usability at gate time, for CSV/forensics
  };
  appendDiagnosticJournal({
    at: Date.now(),
    iso: new Date().toISOString(),
    type: gate.ok ? 'CANDIDATE_ACCEPTED' : 'CANDIDATE_REJECTED',
    version: V4_VERSION,
    symbol: leader.symbol,
    side: leader.side,
    score: leader.score,
    gate,
    math: leader.math,
    plan: leader.plan,
    price: leader.price,
    market: { trend5: leader.trend5, trend15: leader.trend15, trend1h: leader.trend1h, rsi: leader.rsi, volRatio: leader.volRatio, change24h: leader.change24h, turnover24h: leader.turnover24h, btcRegime: leader.btcRegime },
    entryTiming: leader.entryTiming,
    keyLevels: leader.keyLevels,
    reasons: leader.reasons,
    risks: leader.risks,
    scoring: leader.scoreInfo || leader.scoring || null
  }, settings);
  return gate;
}

function signalFromLeader(leader, settings) {
  const now = Date.now();
  const plan = leader.plan;
  const price = num(leader.price);
  const entry = num(plan.entry);
  const atr = num(leader.keyLevels?.atr, Math.abs(price - entry));
  const timing = leader.entryTiming || { inZone: false, directional: false, zoneTouchScore: 0, reactionScore: 0, reason: 'WAITING_ENTRY: no entry timing context' };
  const minScore = minScoreForSide(leader.side, settings);
  const state = timing.inZone && timing.directional ? 'PAPER_ACTIVE' : timing.inZone ? 'WAITING_REACTION' : 'WAITING_ENTRY';
  const id = `v4_${leader.symbol}_${leader.side}_${now}`;

  // fixMICRO2: BIRTH-TIME capture fallback. Previously coinFundingRateAtEntry/coinOpenInterestAtEntry/
  // fundingDivergenceAtEntry were ONLY stamped in initActiveDiagnostics, which fires on ACTIVE fill.
  // Any signal that never fills (WAITING → CONTRARIAN_FLIP / EXPIRED / STALE_CANCELLED / INVALIDATED)
  // stayed permanently null — silently dropping exactly the population the flip logic (fixFLIP) and the
  // Direction Brain most need micro data on. This stamps the SAME fields here, at signal birth, from data
  // already on hand (leader.coinFundingRate/coinOpenInterest + a market-wide sentinel read). If the signal
  // later fills, initActiveDiagnostics's existing block overwrites these with the fresher fill-time reading
  // (unchanged behavior there) — birth capture is a FALLBACK, not a competing source of truth.
  // SAFETY: this ONLY writes into a local `_birthDiag` object that becomes the `diag:` field below. It does
  // NOT touch paperState, status, tradeId, positionStatus, or any field the state machine, reconciler, or
  // Bybit live-authority path reads — structurally incapable of affecting fills/cancels/invalidations.
  let _birthDiag = {};
  try {
    const { sent: _bSent } = getSentinelForCapture();
    const _bs = _bSent || {};
    const _mktFunding = num(_bs?.fund?.avg_rate, num(_bs?.components?.fund?.avg_rate, null));
    const _coinFunding = num(leader.coinFundingRate, null);
    _birthDiag = {
      // fixTRENDVETO (hotfix 19): persist the trend read at birth — the veto above was un-replayable
      // offline because these were never stored. Never again.
      trend5AtBirth: leader.trend5 || null,
      trend15AtBirth: leader.trend15 || null,
      trend1hAtBirth: leader.trend1h || null,
      // fixPCT (Phase 1): per-coin multi-TF trend engine read + decision, stamped on every signal
      coinTrend1mAtBirth: leader.coinTrend?.t1 || null,
      coinTrend3mAtBirth: leader.coinTrend?.t3 || null,
      coinTrend5mAtBirth: leader.coinTrend?.t5 || null,
      coinTrend15mAtBirth: leader.coinTrend?.t15 || null,
      coinTrendBiasAtBirth: leader.coinTrend?.bias || null,
      coinTrendStrengthAtBirth: num(leader.coinTrend?.strength, null),
      coinTrendCrossAtBirth: leader.coinTrend?.cross || null,
      perCoinOverrideAtBirth: leader.perCoinOverride || null,
      perCoinScoreBypassAtBirth: leader.perCoinScoreBypass || null,
      breadthFightShadowAtBirth: leader.breadthFightShadow || null,
      continuationEntryAtBirth: leader.continuationEntry || null,
      directionReasonsAtBirth: Array.isArray(leader.reasons) ? leader.reasons.filter(r => /^F[1-4]:/.test(String(r))).slice(0, 6) : null,
      flipShadowAtBirth: leader.flipShadow || null,
      coinFundingRateAtEntry: _coinFunding,
      coinOpenInterestAtEntry: num(leader.coinOpenInterest, null),
      fundingRateAtEntry: _mktFunding,
      // fixSTRUCT: structure state at birth — ALWAYS captured on every signal (both paths), fixing
      // the coverage gap where structure fields only survived inside retry-path rawPayload. The
      // previous autopsy conflated "field absent" with "detector said NONE" because of this gap.
      structureDominantAtBirth: leader.structure || null,
      structureTrapAtBirth: leader.structureTrap || null,
      structureDivergenceAtBirth: leader.structureDivergence || null,
      // fixSWEEP: sweep state at birth (boost details or null) — suppressed candidates never reach
      // here, they die in shouldReject; boosted ones are now finally visible for offline scoring.
      sweepAtBirth: leader.sweep || null,
      fundingDivergenceAtEntry: (_coinFunding != null && _mktFunding != null)
        ? Number((_coinFunding - _mktFunding).toFixed(6)) : null,
    };
    // fixBOTTOM: breadth range-percentile at birth — ALWAYS captured (guard on or off), so the
    // walk-forward can score the toxic-zone finding on every signal including never-filled ones.
    // Same cached read the dampener uses; costs nothing extra within the 60s cache window.
    const _bpB = breadthRangePctile();
    _birthDiag.breadthRangePctileAtEntry = (_bpB && _bpB.pctile != null) ? _bpB.pctile : null;
    // fixRSI (root-cause): rsiAtEntry was 100% null because leader.rsi (per-coin RSI-14 on 5m,
    // set by marketBrain) was NEVER threaded onto the stored signal — every prior fix patched the
    // READ side with fallback fields that never existed. Capture it at BIRTH here, and thread it
    // onto the return object below so the activation read resolves a real number.
    _birthDiag.rsiAtEntry = num(leader.rsi, null);
    // fixRSIGATEOBS (07/30): one-time PASS confirmation per admitted signal, so the caged trial's
    // real closes can be matched back to "which RSI zone let this one through" without hand
    // reconstruction. signalFromLeader only runs for admitted leaders (rejected candidates die in
    // shouldReject, never reach here) — so this fires exactly once per tradeable signal, not per
    // tick, unlike a log at the gate-check site itself would.
    try {
      addLog('RSI_GATE_PASS', `${leader.symbol} ${leader.side} — rsi=${_birthDiag.rsiAtEntry}`, {
        symbol: leader.symbol, side: leader.side, rsi: _birthDiag.rsiAtEntry,
      });
    } catch (_rgp) { /* observability only — never blocks signal creation */ }
    _birthDiag.btcRsiAtEntry = num(leader.btcRsi, null);
    // fixEUPH: ABSOLUTE breadth + guard outcomes at birth — ALWAYS captured (guard on or off), same
    // rationale as the pctile capture above: scoreable on every signal including never-filled ones.
    // absBreadthAtEntry needs only `cur` (1 fresh sample), so it populates even when pctile is null.
    _birthDiag.absBreadthAtEntry = (_bpB && _bpB.cur != null) ? _bpB.cur : null;
    _birthDiag.btcRsiAtBirth = (_bpB && _bpB.btcRsi != null) ? _bpB.btcRsi : null;
    _birthDiag.euphGuard = leader.euphGuard || null;               // fired = {side,from,to,mult,absBreadth,btcRsi}; null = not in zone (or guard off)
    _birthDiag.rsiLegChaseShadow = leader.rsiLegChaseShadow || null; // shadow marker, zero weight — offline scoring only
    // fixBOTTOM: Direction Brain ADVISORY SHADOW — verdict logged, nothing acts on it. Scoreable
    // offline: diag.dirBrainAdvice.verdict vs eventual WIN/LOSS = the advisory-tier accuracy record
    // that decides whether it ever earns veto authority.
    try {
      const _dbAdvice = directionBrain.advise({
        side: leader.side,
        breadthPctile: _birthDiag.breadthRangePctileAtEntry,
        btcRsi: (_bpB && _bpB.btcRsi != null) ? _bpB.btcRsi : null,
        composite: (_bpB && _bpB.composite != null) ? _bpB.composite : num(_bs?.composite_score, null),
        fundingDivergence: _birthDiag.fundingDivergenceAtEntry,
      });
      if (_dbAdvice) _birthDiag.dirBrainAdvice = _dbAdvice;
    } catch (_eDB) { /* advisory must never block signal creation */ }
    // fixFADE (.77): counter-trend fade SHADOW — stamps a would-be opposite-side trade with a fresh
    // 2:1 bracket for candidates inside the euphoria/despair zone. Acts on nothing; scored offline
    // against this mirror candidate's eventual mfeR/maeR. rUnit = 1R in price = |entry - sl|.
    // fixFADE-hotfix1: read plan.entry/plan.sl, NOT leader.entry/leader.sl. leader.entry/sl are ONLY
    // ever set as a side-effect mutation on the two contrarian-flip branches (~L1806/1871); every other
    // candidate path (plain BUY/SELL) never sets them, so this returned {entry:null, tpPrice:null,
    // slPrice:null} on 100% of live rows (verified: 3 real EUPHORIA firings, all null) even though
    // zone/rollover/tier — the breadth+RSI-only fields — computed correctly. `entry`/`plan` are already
    // local vars at the top of signalFromLeader (`const entry = num(plan.entry)`), and plan.sl is kept
    // in sync on the flip branches too (L1809/1874), so it's the single correct source for every path.
    try {
      const _fadeSl  = num(plan.sl, null);
      const _rUnit = (entry != null && _fadeSl != null) ? Math.abs(entry - _fadeSl) : null;
      const _fade = fadeModule.evaluate({
        side: leader.side,
        absBreadth: (_bpB && _bpB.cur != null) ? _bpB.cur : null,
        btcRsi:     (_bpB && _bpB.btcRsi   != null) ? _bpB.btcRsi   : null,
        btcRsiHi:   (_bpB && _bpB.btcRsiHi != null) ? _bpB.btcRsiHi : null,
        btcRsiLo:   (_bpB && _bpB.btcRsiLo != null) ? _bpB.btcRsiLo : null,
        entry: entry,
        rUnit: (_rUnit && _rUnit > 0) ? _rUnit : null,
        breadthHi: EUPH_BREADTH_HI,
        breadthLo: EUPH_BREADTH_LO,
      });
      if (_fade) {
        _birthDiag.fadeShadow = _fade;
        addLog('FADE_SHADOW', `${leader.symbol}: ${_fade.zone} — shadow ${_fade.fadeSide} vs ${leader.side} (breadth=${_fade.absBreadth}, ${_fade.rollover ? 'ROLLOVER' : 'no-rollover'}, ${_fade.tier}) TP=${_fade.tpR}R/SL=${_fade.slR}R — logged only, acts on nothing`);
      }
    } catch (_eFD) { /* fade shadow must never block signal creation */ }
  } catch (_eBirth) { /* capture must never block signal creation */ }

  return {
    id,
    source: `backend-planner-${V4_VERSION}`,
    plannerVersion: V4_VERSION,
    sym: leader.symbol,
    symbol: leader.symbol,
    side: leader.side,
    contrarianFlip: !!leader.contrarianFlip, // fix48t: arbitration tag
    preFlip: leader.preFlip || null,         // fix48t: frozen phantom-BUY plan for offline replay
    contextDiag: leader.contextDiag || null, // fix48w: 48v per-pair/breadth/fear breakdown
    diag: _birthDiag, // fixMICRO2: birth-time funding/OI fallback (see comment above)
    coinFundingRate: num(leader.coinFundingRate, null),     // fixMICRO: per-coin funding at birth
    coinOpenInterest: num(leader.coinOpenInterest, null),   // fixMICRO: per-coin OI at birth
    status: state === 'PAPER_ACTIVE' ? 'ACTIVE' : 'DETECTED',
    paperState: state,
    displayState: state,
    positionStatus: state === 'PAPER_ACTIVE' ? 'PAPER' : 'NONE',
    orderStatus: 'NOT_SENT_PAPER',
    score: leader.score,
    setupScore: leader.score,
    regimeAlignment: leader.scoreInfo?.regimeAlignment || 0,
    btcRegime: leader.btcRegime,
    localRegime: leader.localRegime,
    rsi: num(leader.rsi, null),        // fixRSI: per-coin RSI-14(5m) on the signal (covers flip path too)
    btcRsi: num(leader.btcRsi, null),  // fixRSI: systemic BTC RSI at birth (mirror)
    experimentPresetMode: settings.experimentPresetMode || 'research', // fix-preset: was 'balanced' — Research is the only standard
    experimentSettingsSnapshot: { preset: settings.experimentPresetMode || 'research', minScoreToTrade: settings.minScoreToTrade, v4MinBuyScore: settings.v4MinBuyScore, v4MinSellScore: settings.v4MinSellScore, v4AllowSells: settings.v4AllowSells, v4MinRR: settings.v4MinRR, v4MinSellRR: settings.v4MinSellRR, v4MinNetTpUsdt: settings.v4MinNetTpUsdt, v4MinNetTpFeeMult: settings.v4MinNetTpFeeMult, v4MinNetRR: settings.v4MinNetRR, v4MaxTpAtr: settings.v4MaxTpAtr, v4EntryReactionBps: settings.v4EntryReactionBps, v4EntryWaitSeconds: settings.v4EntryWaitSeconds, v4EntryToleranceAtr: settings.v4EntryToleranceAtr, btcRegimeMode: settings.btcRegimeMode, elliottWaveWeight: settings.elliottWaveWeight },
    tier: leader.tier,
    entry: plan.entry,
    sl: plan.sl,
    tp1: plan.tp1,
    rr: leader.math.rr,
    rr1: leader.math.rr,
    netRr: leader.math.netRr,
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
    openedAt: state === 'PAPER_ACTIVE' ? now : null,
    updatedAt: now,
    expireMs: expiryMsFor(settings),
    stateReason: `${V4_VERSION}: ${timing.reason}`,
    reasons: leader.reasons,
    risks: leader.risks,
    entryTiming: timing,
    entryZoneTouchedAt: timing.inZone ? now : null,
    entryZoneTouchPrice: timing.inZone ? roundPrice(price) : null,
    diagnostic: {
      version: V4_VERSION,
      capturedAt: now,
      minNetTpInfo: minNetTpDetails(settings, leader.math),
      gateSnapshot: { minScoreToTrade: settings.minScoreToTrade, minScore, v4MinBuyScore: settings.v4MinBuyScore, v4MinSellScore: settings.v4MinSellScore, v4AllowSells: settings.v4AllowSells, minRR: minRRFor(leader.side, settings), minNetTp: minNetTpFor(settings, leader.math), minNetRR: minNetRRFor(settings), maxTpAtr: maxTpAtrFor(settings), btcRegimeMode: settings.btcRegimeMode, sentinelRegime: sentinel.getSentinel()?.market_regime, sentinelAllowed: sentinel.getSentinel()?.allowed_sides },
      marketSnapshot: { price: leader.price, trend5: leader.trend5, trend15: leader.trend15, trend1h: leader.trend1h, rsi: leader.rsi, volRatio: leader.volRatio, change24h: leader.change24h, turnover24h: leader.turnover24h, btcRegime: leader.btcRegime },
      scoreBreakdown: leader.scoreInfo || leader.scoring || null,
      entryTiming: timing,
      keyLevels: leader.keyLevels,
      math: leader.math
    },
    planner: {
      source: `backend-planner-${V4_VERSION}`,  // fix36: was hardcoded stale v4.6.8.24b
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
    history: [{ at: now, state, reason: state === 'PAPER_ACTIVE' ? 'Entry active from backend planner' : (state === 'WAITING_REACTION' ? 'Planner touched entry zone and waits for directional reaction' : 'Planner created and waiting entry') }],
  };
}

function getSignals() {
  const data = store.read('v4_signals', []);
  if (!Array.isArray(data)) return [];
  const now = Date.now();
  let changed = false;
  const normalized = data.map(s => {
    if (!s) return s;
    // fix48k: age from IMMUTABLE birth epoch (signalBirthMs), not createdAt||updatedAt.
    // updatedAt bumps on every scan for WAITING rows, which previously reset the age to ~0
    // and defeated the hard cap entirely. birthMs=0 (un-datable row) => age=now => forced expiry.
    const _birthMs = signalBirthMs(s);
    const _waitingAge = now - _birthMs;
    // fixABANDON (layer 1): the paper clock may NOT kill a signal that has a real order on Bybit.
    // This was the first domino: a GTC limit legitimately rests for up to 45min by design, the hard
    // cap fired, the signal went FINAL, and every downstream authority check was then skipped.
    // Order-bearing signals now fall through to updateExistingSignals, where liveStateAuthority /
    // unifiedBrain owns them and the fix49h expiry path can still expire AND cancel the real order
    // properly (flagTradeForCancel) — which is the correct, order-aware way to end their life.
    if (!isOrderBearing(s) && (s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION' || s.paperState === 'CANDIDATE') && _waitingAge > Math.min(num(s.expireMs, EXPIRY_MS), WAITING_HARD_CAP_MS)) {
      changed = true;
      return { ...s, paperState: 'EXPIRED', displayState: 'EXPIRED', status: 'EXPIRED', positionStatus: 'NONE', updatedAt: now, closedAt: now, stateReason: `${V4_VERSION}: stale waiting setup expired (hard cap; age ${Math.round(_waitingAge/60000)}min)` };
    }
    // fix49i(Z): orphan-state zombie purge is handled in dedupeLiveSignals (before the slice), so
    // it's order-independent and can't be re-stranded. Intentionally NOT done here — doing it pre-
    // dedupe turned the orphan FINAL too early and let the slice drop it again.
    return s;
  });
  const deduped = dedupeLiveSignals(normalized);
  if (changed || deduped.length !== data.length) store.write('v4_signals', deduped.slice(0, MAX_SIGNALS));
  return deduped;
}

function saveSignals(signals) {
  // fixSAVE: LAST-WRITE-WINS HARDENING. The scan loop holds its signals array across awaits and
  // saves at end-of-tick; executor callbacks save fresh copies mid-tick. The scan's stale array then
  // overwrote the callback's live-link writes (tradeId/orderId/orderClaimAt/...) — the race behind
  // the BANKUSDT 07/18 authority miss that fixLINK had to defend against downstream. Defense in
  // depth at the single write chokepoint: before writing, re-read the stored copy and PRESERVE any
  // live-link field the store has but the incoming row lacks. Nothing in the codebase intentionally
  // clears these fields on a live row, so fill-if-missing is always safe. liveResolved likewise —
  // losing it re-arms the reclaim loop on an already-booked close.
  let _prevById = null;
  try {
    const _prev = store.read('v4_signals', []);
    if (Array.isArray(_prev)) _prevById = new Map(_prev.filter(p => p && p.id).map(p => [p.id, p]));
  } catch (_e) { /* store unreadable — write what we have */ }
  const _incoming = signals || [];
  if (_prevById) {
    for (const s of _incoming) {
      if (!s || !s.id) continue;
      const p = _prevById.get(s.id);
      if (!p) continue;
      for (const f of ['tradeId', 'orderId', 'liveOrderId', 'orderClaimAt', 'orderStatus']) {
        if (!s[f] && p[f]) s[f] = p[f];
      }
      if (p.liveResolved && !s.liveResolved) s.liveResolved = p.liveResolved;
    }
  }
  store.write('v4_signals', dedupeLiveSignals(_incoming).slice(0, MAX_SIGNALS));
}

// fixREJSTATE (hotfix 17): root cause of the phantom-execution bug the user caught (a "winning"
// REUSDT SELL that never touched Bybit). Three call sites commit a signal to PAPER_ACTIVE (or hold
// it WAITING/LIVE_PENDING_FILL) and THEN fire the live order asynchronously; on rejection they only
// addLog('LIVE_REJECTED', ...) — the signal itself was never told, so it kept simulating against
// live price and eventually closed itself as a fake TP_HIT/SL_HIT with fabricated paper P&L, while
// no real order ever existed. Confirmed from the user's own Northflank log: V4_SIGNAL → PAPER_ACTIVE,
// then in the same tick ENTRY_DRIFT_REJECTED → SKIP: buildExecutionPlan failed → LIVE_REJECTED, and
// the signal simply carried on. Per user decision: don't silently drop it — move it to a distinct,
// already-modeled REJECTED terminal state (FINAL_STATES has carried 'REJECTED' since early on, wired
// into ledger result-mapping and UI counters, but nothing ever actually assigned it — a fix that was
// half-built and never finished). This makes the rejection visible with zero fake P&L, and — because
// REJECTED is now a FINAL_STATE — the PAPER_ACTIVE tp/sl-simulation loop and every WAITING promotion
// path skip it on the next tick. Guards against overwriting a real outcome: if the signal already
// reached a FINAL_STATE (e.g. it genuinely hit TP/SL in the brief window before this async rejection
// landed), this is a no-op — a real booked result is never replaced.
function markSignalRejected(id, errText, permanentBlock) {
  try {
    if (!id) return;
    const sigs = getSignals();
    const idx = sigs.findIndex(x => x.id === id);
    if (idx < 0) return;
    const s = sigs[idx];
    if (FINAL_STATES.has(s.paperState)) return; // never overwrite a real booked outcome
    const now = Date.now();
    const reason = permanentBlock
      ? `${V4_VERSION}: REJECTED — ${s.sym || s.symbol || ''} needs a signed Bybit product agreement before it can trade (see /v4/agreement-blocks)`
      : `${V4_VERSION}: REJECTED — live order failed: ${errText || 'unknown'}`;
    s.paperState = 'REJECTED';
    s.status = 'REJECTED';
    s.displayState = 'REJECTED';
    s.positionStatus = 'NONE';
    s.entryHit = false;
    s.closedAt = now;
    s.realizedPnl = 0;
    s.rejectReason = errText || 'unknown';
    s.stateReason = reason;
    s.history = [...(s.history || []), { at: now, state: 'REJECTED', reason }];
    saveSignals(sigs);
  } catch (e) {
    addLog('ERROR', `markSignalRejected failed: ${e.message}`);
  }
}

// ═══ fixENFORCE (hotfix 18) — KNOWLEDGE → ENFORCEMENT ═══════════════════════════════════════
// The July-23 forensics (real WR 31.9% vs paper 49%, p=0.003; SELL 9W/25L) proved the brain was
// muzzled, not blind: BOTTOM_GUARD correctly flagged nearly every losing SELL as bottom-of-range
// (the validated 16-27% WR trap, z=-2.43, held out-of-sample in 3 sessions) yet only dampened
// score ×0.75 — mathematically toothless under the research preset's floor 42 (any score ≥56
// survives). Meanwhile SENTINEL_SIDE_BLOCKED fail-OPENS when the sentinel is stale, and the
// sentinel was 7 minutes stale — so protection vanished exactly when the backend was struggling.
// Per user decision (July 23): live trading continues, enforcement ships NOW. Two teeth:
//  (1) Bottom-range hard gate at candidate birth, BOTH sides per the symmetry rule: SELL blocked
//      at pctile<=15 (strong evidence), BUY blocked at pctile>=85 (weak-evidence n=18 mirror,
//      44% vs 65%, documented as weak — symmetry rule requires shipping it or stating why not;
//      the direction agrees, so it ships). Soft-rejected (NOT in HARD_REJECT_PREFIXES): the zone
//      moves with breadth, so the retry engine may legitimately re-test once the market exits it.
//      Contrarian-flip children stay exempt — same exemption the dampener always had, because
//      flips are BORN as deliberate counter-plays at extremes.
//  (2) Blind-brain circuit breaker on LIVE order placement only: if the sentinel has not produced
//      a fresh view in 10 minutes (or cannot be read at all — fail-CLOSED, unlike every gate
//      before it), no NEW live order is placed. Threshold is 10min, not 5, deliberately: current
//      backend staleness hovers ~7min under Bybit REST load, and the user's explicit instruction
//      is to keep trading — 5min would be a stealth trading pause, 10min catches real outages.
//      Paper signal flow is untouched (paper needs no market view to simulate safely).
// All constants hardcoded per the standing no-env-vars rule.
const ENFORCE_SENTINEL_MAX_AGE_MS = 10 * 60 * 1000;

function sentinelBlind() {
  try {
    const s = sentinel.getSentinel();
    const age = s && s.updatedAt ? Date.now() - s.updatedAt : Infinity;
    return age > ENFORCE_SENTINEL_MAX_AGE_MS;
  } catch (_e) {
    return true; // cannot read the brain at all -> blind -> fail CLOSED for live orders
  }
}

// fixPHASE0 (Phase 0, 07/29 plan — see orayan-standing-rules): a single structured record per
// live-entry decision, written into the SAME [trade-log] stream (tradeLog.addLog) everything else
// already uses — one document, not a new file. Motivating case: SKHYNIX/AAVE/NEAR-style mysteries
// ("why did this signal never reach Bybit") used to require cross-referencing 3+ separate log tags
// (KNIFE_GUARD_HOLD, LIVE_SKIPPED, LIVE_BLIND_SKIP) at different timestamps. This logs the FULL
// decision state (hadFirstTouch, knife-check, maxOpenTrades, sentinel-blind, missedMove, outcome) in
// ONE row, at the exact point each live-entry branch resolves. Throttled per signal+outcome (30s) so
// a signal stuck on the same blocker for minutes doesn't spam the log — a CHANGE in outcome always
// logs immediately (e.g. knife-withheld -> maxOpen-reached is two rows, correctly showing progress).
// Read-only / observability — never mutates trading decisions, never blocks placement, fail-open.
function phase0Trace(s, outcome, checks) {
  try {
    const key = `${s.id}:${outcome}`;
    const now0 = Date.now();
    if (s._phase0Last === key && (now0 - num(s._phase0LastAt, 0)) < 30000) return;
    s._phase0Last = key;
    s._phase0LastAt = now0;
    addLog('PHASE0_TRACE', `${s.symbol} ${s.side} — ${outcome}`, {
      symbol: s.symbol,
      side: s.side,
      hadFirstTouch: !!s.hadFirstTouch,
      missedMove: !!(checks && checks.missedMove),
      knifeCheck: (checks && checks.knife) || 'n/a',       // 'ok' | 'withheld' | 'n/a'
      maxOpenTrades: (checks && checks.maxOpen) || 'n/a',  // 'ok' | 'reached' | 'n/a'
      sentinelBlind: (checks && checks.sentinel) || 'n/a', // 'ok' | 'blind' | 'n/a'
      outcome,
    });
  } catch (_e) { /* never let observability break the tick loop */ }
}

function tradeKey(s) {
  s = s || {};
  return `${s.sym || s.symbol || ''}|${s.side || ''}|${s.entry || ''}|${s.sl || ''}|${s.tp1 || ''}`;
}

// fixPHASE1 (Phase 1, 07/29 plan — see orayan-standing-rules): SHADOW-ONLY unified entry-decision
// engine. This is step 1 of "one entry engine instead of two brains" — pulls the SAME checks the 3
// existing live-entry gates already run (knife-check, hadFirstTouch/first-touch rule, maxOpenTrades,
// sentinel-blind) into ONE pure function, evaluated in parallel to whatever paper/live actually did.
// It does NOT replace the 3 existing gates and does NOT change any trading behavior — read-only,
// called nowhere near an order-placement path. Purpose: gather real agreement/divergence data before
// ever promoting this to be the actual gate paper (and eventually live) uses.
function decideLiveEntry(s, market, timing, settings, atr, activeCount) {
  if (timing.missedMove) return { wouldPlace: false, reason: 'MISSED_MOVE_EXEMPT' };

  const kCandle = market && market.candle;
  let knifeBlocked = false;
  if (KNIFE_BODY_ATR > 0 && kCandle && atr > 0) {
    const body = num(kCandle.close) - num(kCandle.open);
    const bodyAtr = Math.abs(body) / atr;
    if (s.side === 'BUY' && body < 0 && bodyAtr >= KNIFE_BODY_ATR) knifeBlocked = true;
    else if (s.side === 'SELL' && body > 0 && bodyAtr >= KNIFE_BODY_ATR) knifeBlocked = true;
  }
  if (s.hadFirstTouch && knifeBlocked) return { wouldPlace: false, reason: 'WITHHELD_KNIFE' };

  const liveEntryOk = s.hadFirstTouch || (FIRSTTOUCH_LIVE_ENABLED && !knifeBlocked && timing.directional);
  if (!liveEntryOk) return { wouldPlace: false, reason: 'AWAITING_CONFIRMATION' };

  // fixPHASE1PERF: activeCount is now computed ONCE per scan cycle by the caller (updateExistingSignals),
  // not re-fetched from disk here on every candidate — see the comment at that call site for why.
  if (num(activeCount, 0) >= (settings.maxOpenTrades || 3)) return { wouldPlace: false, reason: 'MAXOPEN' };

  if (sentinelBlind()) return { wouldPlace: false, reason: 'SENTINEL_BLIND' };

  return { wouldPlace: true, reason: 'WOULD_PLACE' };
}

// Compares decideLiveEntry()'s verdict against what ACTUALLY happened (paper activation + whether a
// live order/tradeId exists), logs ONE row per signal into the SAME [trade-log] stream. Throttled
// like phase0Trace. Read-only, fail-open, zero effect on any trading decision.
function phase1ShadowTrace(s, verdict, actuallyLive) {
  try {
    const key = `${s.id}:${verdict.reason}:${actuallyLive}`;
    const now1 = Date.now();
    if (s._phase1Last === key && (now1 - num(s._phase1LastAt, 0)) < 30000) return;
    s._phase1Last = key;
    s._phase1LastAt = now1;
    const agree = verdict.wouldPlace === actuallyLive;
    addLog('PHASE1_SHADOW', `${s.symbol} ${s.side} — unified=${verdict.wouldPlace ? 'WOULD_PLACE' : verdict.reason} actual=${actuallyLive ? 'LIVE' : 'NOT_LIVE'} — ${agree ? 'AGREE' : 'DIVERGE'}`, {
      symbol: s.symbol, side: s.side,
      unifiedWouldPlace: verdict.wouldPlace, unifiedReason: verdict.reason,
      actuallyLive: !!actuallyLive,
      agree,
    });
  } catch (_e) { /* never let observability break the tick loop */ }
}

function ledgerKey(s) {
  s = s || {};
  const id = String(s.id || s.signalId || s._id || '').trim();
  if (id) return id;
  const ts = num(s.createdAt || s.openedAt || s.closedAt || s.updatedAt || s.ts, 0);
  return `${tradeKey(s)}|${ts || ''}`;
}

function normalizeLedgerTrade(s) {
  const planKey = tradeKey(s);
  const key = ledgerKey(s);
  const result =
    s.paperState === 'TP_HIT' || s.paperState === 'CLOSED_WIN' || s.status === 'WIN' ? 'WIN' :
    s.paperState === 'SL_HIT' || s.paperState === 'CLOSED_LOSS' || s.status === 'LOSS' ? 'LOSS' :
    s.paperState === 'REGIME_FLIP_EXIT' ? (s.status === 'WIN' ? 'WIN' : 'LOSS') :
    s.paperState === 'INVALIDATED' || s.paperState === 'PAPER_INVALID' || s.paperState === 'PAPER_INVALIDATED' ? 'INVALIDATED' :
    s.paperState === 'EXPIRED' || s.paperState === 'PAPER_EXPIRED' ? 'EXPIRED' :
    s.paperState === 'STALE_CANCELLED' || s.paperState === 'CANCELLED' ? 'STALE_CANCELLED' :
    s.paperState === 'REJECTED' ? 'REJECTED' :
    s.paperState === 'PAPER_ACTIVE' || s.paperState === 'LIVE_OPEN' || s.paperState === 'LIVE_RESTING' || s.paperState === 'LIVE_PENDING' || s.paperState === 'FROZEN' ? 'ACTIVE' :
    (s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION') ? s.paperState : (s.paperState || s.status || 'UNKNOWN');

  const lossReason =
    result === 'LOSS'
      ? (s.lossReason || s.stateReason || lastHistoryReason(s) || 'SL hit')
      : '';

  return {
    id: s.id || s.signalId || key,
    key,
    planKey,
    sym: s.sym,
    symbol: s.sym || s.symbol,
    side: s.side,
    entry: s.entry,
    sl: s.sl,
    tp1: s.tp1,
    score: s.score,
    entryTimingScore: s.entryTimingScore,
    minEntryTimingScoreAtCapture: s.minEntryTimingScoreAtCapture,
    experimentPresetMode: s.experimentPresetMode || s.experimentSettingsSnapshot?.preset || 'research',
    experimentSettingsSnapshot: s.experimentSettingsSnapshot || {},
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
    diagnostic: s.diagnostic || {},
    diag: s.diag || {}, // fix48d: rich excursion/regime path capture for adaptive analysis
    timingRevertCount: num(s.timingRevertCount, 0), // fix48d (item 4): times reverted from ENTRY_TIMING=100
    entryTiming: s.entryTiming || {},
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
    // fix43d: removed duplicate expiry check here — updateExistingSignals() already expires WAITING signals
    // Having it in both places caused double-processing edge cases on signals near expiry boundary
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
  const liveKeep = new Set([...liveBySymbolSide.values()].map(r => r.key || ledgerKey(r)));
  for (const r of prepared) {
    if (!r) continue;
    const liveState = String(r.paperState || r.result || '').toUpperCase();
    const key = r.key || ledgerKey(r);
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

// fixPHASE2 (Phase 2, 07/29 plan — see orayan-standing-rules): real opportunity-cost check on
// EXPIRED signals, instead of guessing whether a breakout/continuation mode is worth building.
// Explicitly excludes non-crypto symbols (user's call, 07/29) — these are Bybit TradFi perps
// (stock/ETF-linked), same family flagged in the earlier "Signing Bybit TradFi Perpetuals" session.
// Extend this set if more TradFi symbols show up in the ledger later.
const TRADFI_EXCLUDE_SYMBOLS = new Set(['SKHYUSDT', 'SKHYNIXUSDT', 'SOXSUSDT']);

// Uses Bybit's OWN public kline endpoint (same exchange the trade ran on, no auth needed) — NOT a
// third party. fetchKline() only returns the most recent N candles with no historical start/end, so
// this calls publicGet directly with explicit start/end (Bybit v5 kline supports both).
async function fetchKlineRange(symbol, interval, startMs, endMs) {
  const data = await publicGet('/v5/market/kline', {
    category: 'linear', symbol, interval, start: Math.floor(startMs), end: Math.floor(endMs), limit: 1000,
  });
  const list = data.result?.list || [];
  return list.map(r => ({
    ts: num(r[0]), open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]),
  })).sort((a, b) => a.ts - b.ts);
}

// Walks 1m candles forward from the signal's own entry, checks which level (tp1 or sl) would have
// been touched FIRST — but ONLY after price actually touched the entry line. An EXPIRED signal
// means the entry zone was never re-confirmed within its own window; scoring TP/SL on candles that
// never revisited entry would count "price ran the called direction without ever giving a fill" as
// a WIN, which overstates the case (real gap found 07/30 — expired signals showed 71% would-win vs
// 46% real executed WR, and this was the reason). If entry is never touched anywhere in the window,
// the result is NEVER_FILLED, not a win or loss. Both-sides symmetric (BUY/SELL mirrored).
function walkOutcome(row, candles) {
  const side = String(row.side || '').toUpperCase();
  let filled = false;
  for (const c of candles) {
    if (!filled) {
      const touchedEntry = side === 'BUY' ? (c.low <= row.entry) : (c.high >= row.entry);
      if (!touchedEntry) continue;
      filled = true; // fall through — check this SAME candle for tp/sl too, in case it also reached them
    }
    if (side === 'BUY') {
      const hitSl = c.low <= row.sl;
      const hitTp = c.high >= row.tp1;
      if (hitSl && hitTp) return 'AMBIGUOUS_SAME_CANDLE'; // both levels inside one candle — can't order intrabar, honest about it
      if (hitTp) return 'WOULD_WIN';
      if (hitSl) return 'WOULD_LOSE';
    } else {
      const hitSl = c.high >= row.sl;
      const hitTp = c.low <= row.tp1;
      if (hitSl && hitTp) return 'AMBIGUOUS_SAME_CANDLE';
      if (hitTp) return 'WOULD_WIN';
      if (hitSl) return 'WOULD_LOSE';
    }
  }
  return filled ? 'NEITHER_IN_WINDOW' : 'NEVER_FILLED';
}

// Manual-trigger analysis (NOT run on the scan loop — historical range fetches are too heavy to run
// automatically). lookaheadMs bounds how long past the signal's own expiry we keep watching for a
// late TP/SL (default 3h) — capped at "now" so we never request a future range.
// fixCANCELSHADOW (07/30, hotfix35) — user's direct question: "do we shadow the cancellations?"
// Answer was no — this only ever covered EXPIRED (timed-out waiting for entry). STALE_CANCELLED
// (breadth-fight abandons, structure-break-before-fill, drift-toward-stop) is the exact same
// underlying question — "would this uncompleted signal have won or lost anyway" — so it reuses the
// identical walk-forward mechanism instead of a new one. Both categories tagged with sourceState so
// the breakdown stays legible (they're cancelled for different reasons, worth seeing separately).
async function analyzeExpiredOpportunityCost({ lookaheadMs = 3 * 60 * 60 * 1000 } = {}) {
  const ledger = getLedger();
  const now = Date.now();
  const DEAD_STATES = new Set(['EXPIRED', 'STALE_CANCELLED']);
  const all = ledger.filter(r => DEAD_STATES.has(String(r.paperState || r.result || '').toUpperCase()));
  const excluded = all.filter(r => TRADFI_EXCLUDE_SYMBOLS.has(String(r.symbol || r.sym || '').toUpperCase()));
  const candidates = all.filter(r => !TRADFI_EXCLUDE_SYMBOLS.has(String(r.symbol || r.sym || '').toUpperCase()));

  const results = [];
  const CONC = 8; // bounded — manual admin call, not the hot path, but still don't hammer Bybit
  for (let i = 0; i < candidates.length; i += CONC) {
    const batch = candidates.slice(i, i + CONC);
    const batchResults = await Promise.all(batch.map(async (row) => {
      const sourceState = String(row.paperState || row.result || '').toUpperCase();
      try {
        const start = num(row.openedAt || row.createdAt);
        const end = Math.min(num(row.closedAt || row.updatedAt || start) + lookaheadMs, now);
        if (!(start > 0) || end <= start) return { ...baseRow(row), sourceState, outcome: 'DATA_UNAVAILABLE', note: 'bad timestamps' };
        const candles = await fetchKlineRange(row.symbol || row.sym, '1', start, end);
        if (!candles.length) return { ...baseRow(row), sourceState, outcome: 'DATA_UNAVAILABLE', note: 'no candles returned' };
        const outcome = walkOutcome(row, candles);
        return { ...baseRow(row), sourceState, outcome };
      } catch (e) {
        return { ...baseRow(row), sourceState, outcome: 'DATA_UNAVAILABLE', note: e.message };
      }
    }));
    results.push(...batchResults);
  }

  const wouldWin = results.filter(r => r.outcome === 'WOULD_WIN');
  const wouldLose = results.filter(r => r.outcome === 'WOULD_LOSE');
  const neither = results.filter(r => r.outcome === 'NEITHER_IN_WINDOW');
  const neverFilled = results.filter(r => r.outcome === 'NEVER_FILLED');
  const ambiguous = results.filter(r => r.outcome === 'AMBIGUOUS_SAME_CANDLE');
  const unavailable = results.filter(r => r.outcome === 'DATA_UNAVAILABLE');
  // Uses each signal's OWN already-computed netTpUSDT/netSlUSDT (real planned $ at that size) —
  // no new P&L model invented here. NEVER_FILLED rows are correctly excluded — no fill, no P&L.
  const estimatedOpportunityCostUsdt =
    wouldWin.reduce((sum, r) => sum + num(r.netTpUSDT), 0) +
    wouldLose.reduce((sum, r) => sum + num(r.netSlUSDT), 0); // netSlUSDT is already negative

  const bySourceState = {};
  for (const state of DEAD_STATES) {
    const rows = results.filter(r => r.sourceState === state);
    if (!rows.length) continue;
    const w = rows.filter(r => r.outcome === 'WOULD_WIN').length;
    const l = rows.filter(r => r.outcome === 'WOULD_LOSE').length;
    bySourceState[state] = {
      analyzed: rows.length, wouldWin: w, wouldLose: l,
      wouldWinRate: (w + l) > 0 ? Math.round((w / (w + l)) * 1000) / 10 : null,
      neverFilled: rows.filter(r => r.outcome === 'NEVER_FILLED').length,
    };
  }

  return {
    ok: true,
    totalDeadSignals: all.length, // EXPIRED + STALE_CANCELLED combined
    excludedNonCrypto: excluded.map(r => ({ symbol: r.symbol || r.sym, reason: 'non-crypto (TradFi)' })),
    analyzed: results.length,
    wouldWin: wouldWin.length,
    wouldLose: wouldLose.length,
    neverFilled: neverFilled.length, // price never touched entry — directional read may be fine, but no fill = no trade
    neitherInWindow: neither.length,
    ambiguousSameCandle: ambiguous.length,
    dataUnavailable: unavailable.length,
    estimatedOpportunityCostUsdt: Math.round(estimatedOpportunityCostUsdt * 10000) / 10000,
    bySourceState, // EXPIRED vs STALE_CANCELLED breakdown — different mechanisms, worth seeing apart
    rows: results,
  };
}

function baseRow(row) {
  return {
    id: row.id, symbol: row.symbol || row.sym, side: row.side,
    entry: row.entry, sl: row.sl, tp1: row.tp1,
    netTpUSDT: row.netTpUSDT, netSlUSDT: row.netSlUSDT,
    openedAt: row.openedAt, closedAt: row.closedAt,
  };
}

// fixREVERSAL (07/30, user's direct question: "would reversing the trades give a better WR?" — real
// SELL 33% WR across 3 independent ledgers over weeks, not a one-off bad stretch). This tests it
// properly instead of guessing: for each REAL closed Bybit trade, mirrors the SL/TP around the same
// entry price (same risk/reward distances, opposite side) and walks REAL forward candles to see
// which level a mirrored trade would have hit first. Uses the signal's own already-computed
// netTpUSDT/netSlUSDT for the hypothetical $ magnitude — mirroring doesn't change position size, so
// those numbers are structurally valid for the mirror too, no new P&L model invented.
// IMPORTANT STATED ASSUMPTION: assumes the mirror trade fills at the exact same price/instant as the
// real trade did (openTime/avgEntryPrice) — real execution for the opposite side could differ
// slightly (spread, slippage, fill probability), so this is a directional signal-quality test, not a
// claim that literally flipping the bot would reproduce these exact numbers.
function mirrorLevels(side, entry, sl, tp1) {
  const risk = Math.abs(num(sl) - num(entry));
  const reward = Math.abs(num(entry) - num(tp1));
  const mirroredSide = side === 'BUY' ? 'SELL' : 'BUY';
  const mirroredSl = mirroredSide === 'BUY' ? entry - risk : entry + risk;
  const mirroredTp = mirroredSide === 'BUY' ? entry + reward : entry - reward;
  return { mirroredSide, mirroredSl, mirroredTp };
}

// fixRSIGATE (07/30, hotfix33) — REPLACES the score gate entirely, per user's direct instruction:
// scores are r=-0.07 correlated with trade quality (standing rule, 537 trades, long confirmed) and
// the system was running below its own breakeven with "no backing, not even numbers." This is the
// backing: real per-side RSI-at-birth vs outcome, pulled from 40 SELL + 101 BUY resolved signals
// (07/30 session). BUY: 30-45=60% WR, 45-55=59%, 55-70=61% — broadly profitable 30-70, breaks down
// only above 70 (chasing overbought, 29% WR n=14). SELL: 30-45=55%, 55-70=83% (n=6, thin but the
// sharpest edge found) — but the 45-55 "neutral" zone is 0% (n=6) and <30 (oversold shorts, i.e.
// chasing an already-crashed coin) is 33%. User's explicit call from these numbers: BUY allowed
// 30-70 inclusive; SELL allowed 30-45 OR 55-70 only (excludes the dead 45-55 zone AND both extremes).
// This is now the SOLE direction/entry admission rule — score is no longer checked anywhere in the
// live decision path (still computed/logged for confluence display only, never gates). Fail-open
// (no rsi data => true) rather than silently blocking every candidate if RSI ever fails to compute.
function passesRsiDirectionGate(side, rsi) {
  if (rsi === null || rsi === undefined) return true;
  const r = Number(rsi);
  if (!Number.isFinite(r)) return true;
  if (side === 'BUY') return r >= 30 && r <= 70;
  if (side === 'SELL') return (r >= 30 && r <= 45) || (r >= 55 && r <= 70);
  return true;
}

async function analyzeReversalHypothesis({ lookaheadMs = 3 * 60 * 60 * 1000, tail = 1000 } = {}) {
  const ledger = getLedger();
  const sigById = new Map(ledger.map(r => [r.id, r]));

  let bybitRows = [];
  try { bybitRows = store.readNdjsonTail('bybit_ledger', tail) || []; } catch (_e) {}
  const closesRaw = bybitRows.filter(x => x && x.event === 'STATUS_CHANGE' && String(x.status || '').toUpperCase() === 'POSITION_CLOSED');
  // Same rank/dedupe rule as fixTRUTHWR's recordBybitTruthResults — CLOSED beats anything, non-zero
  // pnl beats zero, later closeTime is the tiebreaker.
  const _rank = (c) => [String(c && c.positionStatus || '').toUpperCase() === 'CLOSED' ? 1 : 0,
                        num(c && c.closedPnl) !== 0 ? 1 : 0, num(c && c.closeTime)];
  const _better = (a, b) => { if (!b) return true; const ra = _rank(a), rb = _rank(b);
    for (let i = 0; i < ra.length; i++) { if (ra[i] !== rb[i]) return ra[i] > rb[i]; } return false; };
  const byTrade = new Map();
  for (const c of closesRaw) {
    const k = c.tradeId || c.orderId || c.signalId || `${c.symbol}|${c.closeTime}`;
    if (_better(c, byTrade.get(k))) byTrade.set(k, c);
  }
  const realTrades = [...byTrade.values()].filter(t => sigById.has(t.signalId));
  const excludedNoSignal = byTrade.size - realTrades.length; // real closes we couldn't join to a planned sl/tp1

  const CONC = 8;
  const results = [];
  for (let i = 0; i < realTrades.length; i += CONC) {
    const batch = realTrades.slice(i, i + CONC);
    const batchResults = await Promise.all(batch.map(async (t) => {
      const sig = sigById.get(t.signalId);
      const entry = num(t.avgEntryPrice);
      const { mirroredSide, mirroredSl, mirroredTp } = mirrorLevels(t.side, entry, sig.sl, sig.tp1);
      const base = {
        symbol: t.symbol, realSide: t.side, mirroredSide,
        realClosedPnl: num(t.closedPnl), realOutcome: num(t.closedPnl) > 0 ? 'REAL_WIN' : 'REAL_LOSS',
        mirrorHypotheticalUsd: 0, // only WOULD_WIN/WOULD_LOSE below ever override this — every other
        // path (DATA_UNAVAILABLE, NEITHER_IN_WINDOW, AMBIGUOUS_SAME_CANDLE) has no real outcome, so
        // it must stay 0, not silently carry a placeholder into the net $ sum.
      };
      try {
        const start = num(t.openTime);
        const end = Math.min(num(t.closeTime || start) + lookaheadMs, Date.now());
        if (!(start > 0) || end <= start) return { ...base, mirrorOutcome: 'DATA_UNAVAILABLE' };
        const candles = await fetchKlineRange(t.symbol, '1', start, end);
        if (!candles.length) return { ...base, mirrorOutcome: 'DATA_UNAVAILABLE' };
        // Mirror trade is assumed filled already (same entry instant) — walk candles from the FIRST
        // one (inclusive) checking mirrored tp/sl, no entry-touch gate needed (unlike Phase 2's
        // EXPIRED-signal case, which never filled at all).
        let mirrorOutcome = 'NEITHER_IN_WINDOW';
        for (const c of candles) {
          const hitSl = mirroredSide === 'BUY' ? c.low <= mirroredSl : c.high >= mirroredSl;
          const hitTp = mirroredSide === 'BUY' ? c.high >= mirroredTp : c.low <= mirroredTp;
          if (hitSl && hitTp) { mirrorOutcome = 'AMBIGUOUS_SAME_CANDLE'; break; }
          if (hitTp) { mirrorOutcome = 'MIRROR_WOULD_WIN'; break; }
          if (hitSl) { mirrorOutcome = 'MIRROR_WOULD_LOSE'; break; }
        }
        const mirrorUsd = mirrorOutcome === 'MIRROR_WOULD_WIN' ? num(sig.netTpUSDT)
          : mirrorOutcome === 'MIRROR_WOULD_LOSE' ? num(sig.netSlUSDT) : 0;
        return { ...base, mirrorOutcome, mirrorHypotheticalUsd: mirrorUsd };
      } catch (e) {
        return { ...base, mirrorOutcome: 'DATA_UNAVAILABLE', note: e.message };
      }
    }));
    results.push(...batchResults);
  }

  const realWins = results.filter(r => r.realOutcome === 'REAL_WIN');
  const realLosses = results.filter(r => r.realOutcome === 'REAL_LOSS');
  const mirrorWins = results.filter(r => r.mirrorOutcome === 'MIRROR_WOULD_WIN');
  const mirrorLosses = results.filter(r => r.mirrorOutcome === 'MIRROR_WOULD_LOSE');
  const realNetUsd = results.reduce((s, r) => s + num(r.realClosedPnl), 0);
  const mirrorNetUsd = results.reduce((s, r) => s + num(r.mirrorHypotheticalUsd), 0);

  const bySide = {};
  for (const side of ['BUY', 'SELL']) {
    const rows = results.filter(r => r.realSide === side);
    if (!rows.length) continue;
    bySide[side] = {
      realTrades: rows.length,
      realWinRate: Math.round((rows.filter(r => r.realOutcome === 'REAL_WIN').length / rows.length) * 1000) / 10,
      realNetUsd: Math.round(rows.reduce((s, r) => s + num(r.realClosedPnl), 0) * 10000) / 10000,
      mirrorWinRate: Math.round((rows.filter(r => r.mirrorOutcome === 'MIRROR_WOULD_WIN').length /
        rows.filter(r => r.mirrorOutcome === 'MIRROR_WOULD_WIN' || r.mirrorOutcome === 'MIRROR_WOULD_LOSE').length || 1) * 1000) / 10,
      mirrorNetUsd: Math.round(rows.reduce((s, r) => s + num(r.mirrorHypotheticalUsd), 0) * 10000) / 10000,
    };
  }

  return {
    ok: true,
    assumption: 'mirror trade assumed to fill at same entry price/instant as the real trade — directional signal-quality test, not a literal flip-the-bot prediction',
    totalRealTrades: byTrade.size,
    excludedNoMatchingSignal: excludedNoSignal,
    analyzed: results.length,
    realWinRate: Math.round((realWins.length / results.length) * 1000) / 10,
    mirrorWinRate: Math.round((mirrorWins.length / (mirrorWins.length + mirrorLosses.length || 1)) * 1000) / 10,
    realNetUsd: Math.round(realNetUsd * 10000) / 10000,
    mirrorNetUsd: Math.round(mirrorNetUsd * 10000) / 10000,
    bySide,
    rows: results,
  };
}

// fix49s: LEDGER RECONCILIATION — permanent zombie fix. Root cause traced precisely: a ledger row
// can sit non-FINAL (WAITING_ENTRY/WAITING_REACTION/PAPER_ACTIVE) and then have its SOURCE row
// evicted from the live v4_signals array (MAX_SIGNALS slice dropping a low-priority WAITING
// candidate as fresher signals arrive — confirmed via RAREUSDT/REUSDT: createdAt===updatedAt,
// single history entry, frozen 150+min) WITHOUT ever reaching its own age-based expiry (which only
// runs on rows still present in getSignals()'s array — it can't act on a row that's already gone).
// fix43d deliberately removed an age-check from saveLedger() on the assumption the live-side check
// would always get a chance to run first; that assumption breaks exactly when eviction happens
// before the hard-cap age. This is the actual mechanism behind "Cancel failed:
// SIGNAL_NOT_FOUND_OR_TERMINAL" — cancel looks in the live array and finds nothing, while the
// ledger still shows the row as open because nothing ever told it the row was gone. Fix: every
// upsert, reconcile any non-FINAL ledger row whose id is no longer present in the CURRENT live
// signals list to a terminal state — independent of why or which future code path causes the
// disappearance. Guarded against the empty-signals false-positive case (a transient/cold-start
// empty read must never be allowed to mass-expire a live ledger).
let _lastLedgerReconcileAt = 0;
let _lastLedgerReconcileCount = 0;
function reconcileOrphanedLedgerRows(ledger, signals) {
  const liveIds = new Set((signals || []).map(s => s && (s.id || s.signalId || tradeKey(s))).filter(Boolean));
  const hasLiveOpenRows = (ledger || []).some(r => r && ACTIVE_STATES.has(String(r.paperState || '').toUpperCase()));
  if (liveIds.size === 0 && hasLiveOpenRows) {
    // Suspicious: ledger thinks positions are open but the live array came back completely empty.
    // Far more likely a transient/cold-start read than every open position vanishing at once —
    // skip reconciliation this cycle rather than risk mass false-positive expiry.
    return { rows: ledger, reconciledCount: 0, skipped: true };
  }
  const now = Date.now();
  let reconciledCount = 0;
  const rows = (ledger || []).map(r => {
    if (!r) return r;
    const st = String(r.paperState || '').toUpperCase();
    const rid = r.id || r.key || ledgerKey(r);
    if (ACTIVE_STATES.has(st) && rid && !liveIds.has(rid)) {
      reconciledCount++;
      return {
        ...r,
        paperState: 'EXPIRED', displayState: 'EXPIRED', status: 'EXPIRED', positionStatus: 'NONE',
        updatedAt: now, closedAt: r.closedAt || now,
        stateReason: `${V4_VERSION}: reconciled — lost from live signal window, never resolved (was '${r.paperState}')`,
      };
    }
    return r;
  });
  if (reconciledCount > 0) {
    _lastLedgerReconcileAt = now;
    _lastLedgerReconcileCount += reconciledCount;
    try { console.log(`[ledger-reconcile] force-resolved ${reconciledCount} orphaned ledger row(s)`); } catch (_e) {}
  }
  return { rows, reconciledCount, skipped: false };
}
function getLedgerReconcileStats() { return { lastAt: _lastLedgerReconcileAt, totalReconciled: _lastLedgerReconcileCount }; }

function upsertLedger(signals = []) {
  const ledger = getLedger();
  const { rows: reconciled } = reconcileOrphanedLedgerRows(ledger, signals);
  const merged = saveLedger([...reconciled, ...(signals || []).map(normalizeLedgerTrade)]);
  // fix52: fold newly-resolved trades into the permanent (decay-proof) accumulator, once each.
  try { recordPermanentResults(merged); } catch (e) { console.warn('[v4] recordPermanentResults failed:', e.message); }
  return merged;
}

function computeLedgerSummary(rows = getLedger()) {
  const unique = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    const key = r.id || r.key || ledgerKey(r);
    unique.set(key, r);
  }
  const list = [...unique.values()];
  const wins = list.filter(r => r.result === 'WIN').length;
  const losses = list.filter(r => r.result === 'LOSS').length;
  const waiting = list.filter(r => r.result === 'WAITING_ENTRY' || r.result === 'WAITING_REACTION').length;
  const active = list.filter(r => r.result === 'ACTIVE').length;
  const invalidated = list.filter(r => r.result === 'INVALIDATED').length;
  const expired = list.filter(r => r.result === 'EXPIRED').length;
  const rejected = list.filter(r => r.result === 'REJECTED').length;
  // fix73: these two buckets existed as terminal states (both in FINAL_STATES) but were never
  // counted in the summary — total = completed+open+invalidated+expired+rejected silently undercounted
  // by however many STALE_CANCELLED/flip rows existed (16 of 84 in the 2026-07-02 export). Not a data
  // bug, purely a reporting gap — every row was always in `list`, just invisible in the header math.
  const staleCancelled = list.filter(r => r.result === 'STALE_CANCELLED').length;
  const flipped = list.filter(r => ['CONTRARIAN_FLIP', 'REGIME_FLIP_EXIT', 'ACTIVE_FLIP_EXIT'].includes(r.result)).length;
  const net = list.reduce((a, r) => a + (r.result === 'WIN' || r.result === 'LOSS' ? num(r.realizedPnl) : 0), 0);
  const grossWins = list.filter(r => r.result === 'WIN').reduce((a, r) => a + num(r.netTpUSDT), 0);
  const grossLosses = list.filter(r => r.result === 'LOSS').reduce((a, r) => a + num(r.netSlUSDT), 0);
  const completed = wins + losses;
  const hitRate = completed ? Math.round((wins / completed) * 100) : 0;
  const winRows = list.filter(r => r.result === 'WIN');
  const lossRows = list.filter(r => r.result === 'LOSS');
  const avgWin = wins ? grossWins / wins : 0;
  const avgLossAbs = losses ? Math.abs(grossLosses / losses) : 0;
  const expectancy = completed ? (wins / completed) * avgWin - (losses / completed) * avgLossAbs : 0;
  const profitFactor = grossLosses ? grossWins / Math.abs(grossLosses) : (grossWins > 0 ? 999 : 0);
  const sideStats = ['BUY','SELL'].reduce((acc, side) => {
    const rows = list.filter(r => r.side === side && (r.result === 'WIN' || r.result === 'LOSS'));
    const sw = rows.filter(r => r.result === 'WIN');
    const sl = rows.filter(r => r.result === 'LOSS');
    const pnl = rows.reduce((a, r) => a + num(r.realizedPnl), 0);
    acc[side] = { completed: rows.length, wins: sw.length, losses: sl.length, winRate: rows.length ? Math.round(sw.length / rows.length * 100) : 0, netPnl: Number(pnl.toFixed(4)) };
    return acc;
  }, {});

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
    staleCancelled, // fix73
    flipped,        // fix73
    accounted: completed + waiting + active + invalidated + expired + rejected + staleCancelled + flipped, // fix73: should equal `total`; a gap flags a new unbucketed terminal state
    hitRate,
    winRate: hitRate,
    avgWin: Number(avgWin.toFixed(4)),
    avgLoss: Number(avgLossAbs.toFixed(4)),
    expectancy: Number(expectancy.toFixed(4)),
    profitFactor: Number(profitFactor.toFixed(3)),
    sideStats,
    netPnl: Number(net.toFixed(4)),
    grossWins: Number(grossWins.toFixed(4)),
    grossLosses: Number(grossLosses.toFixed(4)),
    lossReasons: Object.entries(lossReasons)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    recent: list.slice(0, RECENT_LEDGER_LIMIT),

    // ── Daily PnL breakdown ─────────────────────────────────────────────
    // Groups closed trades by UTC date (YYYY-MM-DD). Stored so the frontend
    // can render a daily P&L bar chart and cumulative equity curve.
    dailyPnl: computeDailyPnl(list),

    // ── Overall running totals (persisted across ledger clears via store) ─
    // allTimeNetPnl accumulates from pnlHistory store — survives clearSignals().
    allTimeNetPnl: Number((num(store.read('pnl_all_time', { net: 0 })?.net) + net).toFixed(4)),
    allTimeTrades: num(store.read('pnl_all_time', { trades: 0 })?.trades) + completed
  };
}

// ── Daily PnL computation ──────────────────────────────────────────────────
// Returns array of { date: 'YYYY-MM-DD', pnl, wins, losses, trades } sorted newest first.
function computeDailyPnl(list = []) {
  const byDay = {};
  for (const r of list) {
    if (r.result !== 'WIN' && r.result !== 'LOSS') continue;
    const ts = num(r.closedAt || r.updatedAt || r.createdAt, 0);
    if (!ts) continue;
    const day = new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD UTC
    if (!byDay[day]) byDay[day] = { date: day, pnl: 0, wins: 0, losses: 0, trades: 0 };
    byDay[day].pnl += num(r.realizedPnl);
    byDay[day].trades += 1;
    if (r.result === 'WIN') byDay[day].wins += 1;
    else byDay[day].losses += 1;
  }
  return Object.values(byDay)
    .map(d => ({ ...d, pnl: Number(d.pnl.toFixed(4)) }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// ── All-time PnL persistence ───────────────────────────────────────────────
// Called after each scan cycle to accumulate PnL across ledger clears.
// Stores: { net, trades, updatedAt, history: [{date, pnl, trades}] }
function updateAllTimePnl(currentLedger = getLedger()) {
  const existing = store.read('pnl_all_time', { net: 0, trades: 0, history: [], updatedAt: 0 });
  const daily = computeDailyPnl(currentLedger.filter(r => r.result === 'WIN' || r.result === 'LOSS'));
  const currentNet = currentLedger.reduce((a, r) =>
    (r.result === 'WIN' || r.result === 'LOSS') ? a + num(r.realizedPnl) : a, 0);
  const currentTrades = currentLedger.filter(r => r.result === 'WIN' || r.result === 'LOSS').length;
  // Merge daily history — existing days not in current ledger are preserved (cleared sessions)
  const histMap = {};
  for (const d of (existing.history || [])) histMap[d.date] = d;
  for (const d of daily) histMap[d.date] = d; // current ledger overwrites same-day
  const merged = Object.values(histMap).sort((a, b) => b.date.localeCompare(a.date));
  const allTimeNet = merged.reduce((a, d) => a + num(d.pnl), 0);
  const allTimeTrades = merged.reduce((a, d) => a + num(d.trades), 0);
  store.write('pnl_all_time', {
    net: Number(allTimeNet.toFixed(4)),
    trades: allTimeTrades,
    updatedAt: Date.now(),
    history: merged.slice(0, 365) // keep 1 year
  });
  return { net: allTimeNet, trades: allTimeTrades, history: merged };
}

// ── Futures account balance recording ─────────────────────────────────────
// Snapshots the Bybit USDT wallet balance on demand (called from /api/v4/balance route).
// Stores: { snapshots: [{ts, iso, walletBalance, availableBalance, unrealisedPnl}] }
function recordBalanceSnapshot(balanceData = {}) {
  const existing = store.read('balance_history', { snapshots: [] });
  const snap = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    walletBalance: num(balanceData.walletBalance),
    availableBalance: num(balanceData.availableBalance),
    unrealisedPnl: num(balanceData.unrealisedPnl || 0),
    equity: num(balanceData.equity || balanceData.walletBalance)
  };
  const snapshots = [snap, ...(existing.snapshots || [])].slice(0, 720); // 30 days @ hourly
  store.write('balance_history', { snapshots });
  return snap;
}

function getBalanceHistory() {
  return store.read('balance_history', { snapshots: [] });
}

function getAllTimePnl() {
  return store.read('pnl_all_time', { net: 0, trades: 0, history: [], updatedAt: 0 });
}

// ── fix52: PERMANENT resolved-trade accumulator ─────────────────────────────
// ROOT FIX for the win-rate / daily-PnL "decay without a loss" bug. The old all-time/daily figures
// were RECOMPUTED from the live ledger every cycle (updateAllTimePnl, computeLedgerSummary). When a
// resolved WIN aged out of the capped/cleared ledger window, its contribution silently disappeared
// and the numbers shrank with no new loss — exactly the 58%→56% drift the operator observed.
//
// This store is APPEND-ONLY and idempotent: each resolved WIN/LOSS is folded into running counters
// EXACTLY ONCE, keyed on its stable id in `seen`, and never removed. Counters never decrement, so a
// row churning out of the live window can't move the figures. Day buckets are keyed to LK local date
// (the trader's day boundary, matching the dead-hour timezone). Starts empty at deploy by design.
const PERM_DAYS_KEEP = 60;
const PERM_SEEN_CAP = 30000;
function _lkDateKey(ts) {
  // Shift epoch by the LK offset, then read the UTC date of the shifted instant = LK local date.
  const d = new Date(num(ts, Date.now()) + LK_OFFSET_MIN * 60000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD in LK local time
}
function _emptyPerm() {
  return {
    startedAt: Date.now(), allTimeNet: 0, allTimeWins: 0, allTimeLosses: 0,
    seen: {}, seenOrder: [], days: {},
    side: { BUY: { wins: 0, losses: 0, net: 0 }, SELL: { wins: 0, losses: 0, net: 0 } },
  };
}
function getPermanentStats() {
  const s = store.read('pnl_permanent', null);
  if (!s || typeof s !== 'object') return _emptyPerm();
  return {
    startedAt: num(s.startedAt, Date.now()),
    allTimeNet: num(s.allTimeNet, 0),
    allTimeWins: num(s.allTimeWins, 0),
    allTimeLosses: num(s.allTimeLosses, 0),
    seen: s.seen && typeof s.seen === 'object' ? s.seen : {},
    seenOrder: Array.isArray(s.seenOrder) ? s.seenOrder : [],
    days: s.days && typeof s.days === 'object' ? s.days : {},
    side: s.side && typeof s.side === 'object'
      ? { BUY: { wins: 0, losses: 0, net: 0, ...(s.side.BUY || {}) }, SELL: { wins: 0, losses: 0, net: 0, ...(s.side.SELL || {}) } }
      : { BUY: { wins: 0, losses: 0, net: 0 }, SELL: { wins: 0, losses: 0, net: 0 } },
  };
}

// fixTRUTHPERM: "Bybit Truth" was re-deriving its 4 headline stats from up to 1500 raw ndjson event
// rows on EVERY refresh — fetched over the phone's link, then re-ranked/re-summed client-side. Two
// real problems: (1) at 2-3 fills/hour with 100+ partial-fill orders, that raw-row window can slide
// far enough that an already-closed trade's own close row falls OUT of the last-1500 slice, and the
// trade silently vanishes from every stat (confirmed: n dropped 50->49, a real win disappeared,
// between two sessions with only NEW trades in between); (2) it's genuinely heavy for what it is —
// a handful of numbers that only change 2-3 times an hour. Same idempotent "count once, ever" pattern
// as pnl_permanent (recordPermanentResults) above, applied to REAL Bybit closes instead of paper
// ones. A trade counted here can never be un-counted by a window sliding past it again.
const BT_PERM_SEEN_CAP = 30000;
function _emptyBtPerm() {
  return { startedAt: Date.now(), seen: {}, seenOrder: [], n: 0, wins: 0, losses: 0,
           netPnl: 0, grossPnl: 0, totalFees: 0, slipSum: 0, slipCount: 0,
           partialOrderIds: {}, symbolOrderIds: {} };
}
function getBybitTruthStats() {
  const s = store.read('bybit_truth_permanent', null);
  if (!s || typeof s !== 'object') return _emptyBtPerm();
  return {
    startedAt: num(s.startedAt, Date.now()),
    seen: s.seen && typeof s.seen === 'object' ? s.seen : {},
    seenOrder: Array.isArray(s.seenOrder) ? s.seenOrder : [],
    n: num(s.n, 0), wins: num(s.wins, 0), losses: num(s.losses, 0),
    netPnl: num(s.netPnl, 0), grossPnl: num(s.grossPnl, 0), totalFees: num(s.totalFees, 0),
    slipSum: num(s.slipSum, 0), slipCount: num(s.slipCount, 0),
    partialOrderIds: s.partialOrderIds && typeof s.partialOrderIds === 'object' ? s.partialOrderIds : {},
    symbolOrderIds: s.symbolOrderIds && typeof s.symbolOrderIds === 'object' ? s.symbolOrderIds : {},
  };
}
// Fold newly-resolved real Bybit closes into the permanent counters (idempotent by trade key).
// Reads a bounded recent tail (500 rows — plenty of margin at 2-3 fills/hour with multi-row fills)
// rather than the full 1500-row window, since already-seen ids are skipped for free; the expensive
// rank/dedupe work only ever happens once per trade, not on every refresh.
function recordBybitTruthResults() {
  const perm = getBybitTruthStats();
  let rows = [];
  try { rows = store.readNdjsonTail('bybit_ledger', 500) || []; } catch (_e) {}
  const closesRaw = rows.filter(x => x && x.event === 'STATUS_CHANGE' && String(x.status || '').toUpperCase() === 'POSITION_CLOSED');
  // Same rank rule as the (now-retired) client-side dedupe: CLOSED beats anything, non-zero pnl
  // beats zero, later closeTime is the tiebreaker — a genuine break-even close still ranks first.
  const _rank = (c) => [String(c && c.positionStatus || '').toUpperCase() === 'CLOSED' ? 1 : 0,
                        num(c && c.closedPnl) !== 0 ? 1 : 0, num(c && c.closeTime)];
  const _better = (a, b) => { if (!b) return true; const ra = _rank(a), rb = _rank(b);
    for (let i = 0; i < ra.length; i++) { if (ra[i] !== rb[i]) return ra[i] > rb[i]; } return false; };
  const byTrade = new Map();
  for (const c of closesRaw) {
    const k = c.tradeId || c.orderId || c.signalId || `${c.symbol}|${c.closeTime}`;
    if (_better(c, byTrade.get(k))) byTrade.set(k, c);
  }
  const execs = rows.filter(x => x && x.event === 'EXECUTION');
  const byOrderExecCount = {};
  for (const e of execs) { const k = e.orderId || e.orderLinkId || '?'; byOrderExecCount[k] = (byOrderExecCount[k] || 0) + 1; }

  let dirty = false;
  for (const [k, c] of byTrade) {
    const id = String(k);
    if (perm.seen[id]) continue; // count once, ever — survives restarts & window churn
    perm.seen[id] = 1;
    perm.seenOrder.push(id);
    const pnl = num(c.closedPnl);
    const fees = num(c.totalFees);
    perm.n += 1;
    if (pnl > 0) perm.wins += 1; else perm.losses += 1;
    perm.netPnl += pnl;
    perm.grossPnl += pnl + fees;
    perm.totalFees += fees;
    const slip = Number(c.entrySlippage);
    if (Number.isFinite(slip)) { perm.slipSum += slip; perm.slipCount += 1; }
    if ((byOrderExecCount[c.orderId] || 0) > 1) perm.partialOrderIds[c.orderId] = 1;
    if (c.symbol && c.orderId) {
      perm.symbolOrderIds[c.symbol] = perm.symbolOrderIds[c.symbol] || {};
      perm.symbolOrderIds[c.symbol][c.orderId] = 1;
    }
    dirty = true;
  }
  if (!dirty) return perm;
  if (perm.seenOrder.length > BT_PERM_SEEN_CAP) {
    const removed = perm.seenOrder.splice(0, perm.seenOrder.length - BT_PERM_SEEN_CAP);
    for (const rid of removed) delete perm.seen[rid];
  }
  perm.netPnl = Number(perm.netPnl.toFixed(4));
  perm.grossPnl = Number(perm.grossPnl.toFixed(4));
  perm.totalFees = Number(perm.totalFees.toFixed(4));
  try { store.write('bybit_truth_permanent', perm); } catch (e) { console.warn('[v4] bybit_truth_permanent write failed:', e.message); }
  return perm;
}
function getBybitTruthSummary() {
  const perm = recordBybitTruthResults();
  const wr = perm.n ? Math.round((perm.wins / perm.n) * 100) : 0;
  const avgSlip = perm.slipCount ? perm.slipSum / perm.slipCount : null;
  const feeDragPct = perm.grossPnl > 0 ? (perm.totalFees / perm.grossPnl * 100) : null;
  const dupSymbols = Object.entries(perm.symbolOrderIds).filter(([, ids]) => Object.keys(ids).length > 1).map(([sym]) => sym);
  return {
    n: perm.n, wins: perm.wins, losses: perm.losses, winRate: wr,
    netPnl: perm.netPnl, grossPnl: perm.grossPnl, totalFees: perm.totalFees,
    avgEntrySlip: avgSlip, feeDragPct,
    partialOrders: Object.keys(perm.partialOrderIds).length,
    dupSymbols, dupSymbolCount: dupSymbols.length,
    startedAt: perm.startedAt,
  };
}
// Fold any newly-resolved WIN/LOSS rows into the permanent counters (idempotent). Writes only when
// something actually changed, so it's cheap to call every scan cycle.
function recordPermanentResults(ledger = getLedger()) {
  const perm = getPermanentStats();
  let dirty = false;
  for (const r of (ledger || [])) {
    if (!r) continue;
    if (r.result !== 'WIN' && r.result !== 'LOSS') continue;
    const id = String(r.id || r.key || ledgerKey(r) || '').trim();
    if (!id || perm.seen[id]) continue; // count once, ever — survives restarts & window churn
    const pnl = num(r.realizedPnl, r.result === 'WIN' ? num(r.netTpUSDT) : num(r.netSlUSDT));
    const day = _lkDateKey(r.closedAt || r.updatedAt || r.createdAt);
    const side = String(r.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    perm.seen[id] = 1;
    perm.seenOrder.push(id);
    perm.allTimeNet += pnl;
    if (r.result === 'WIN') perm.allTimeWins += 1; else perm.allTimeLosses += 1;
    if (!perm.days[day]) perm.days[day] = { date: day, pnl: 0, wins: 0, losses: 0, trades: 0 };
    perm.days[day].pnl += pnl; perm.days[day].trades += 1;
    if (r.result === 'WIN') perm.days[day].wins += 1; else perm.days[day].losses += 1;
    if (!perm.side[side]) perm.side[side] = { wins: 0, losses: 0, net: 0 };
    perm.side[side].net += pnl;
    if (r.result === 'WIN') perm.side[side].wins += 1; else perm.side[side].losses += 1;
    dirty = true;
  }
  if (!dirty) return perm;
  // Bound the idempotency guard (FIFO). Terminal ids never re-resolve, so evicting the oldest after
  // the cap can't cause a double-count — they will not reappear as fresh WIN/LOSS transitions.
  if (perm.seenOrder.length > PERM_SEEN_CAP) {
    const removed = perm.seenOrder.splice(0, perm.seenOrder.length - PERM_SEEN_CAP);
    for (const rid of removed) delete perm.seen[rid];
  }
  // Trim day buckets to retention (newest kept).
  const dayKeys = Object.keys(perm.days).sort().reverse();
  if (dayKeys.length > PERM_DAYS_KEEP) {
    for (const k of dayKeys.slice(PERM_DAYS_KEEP)) delete perm.days[k];
  }
  perm.allTimeNet = Number(perm.allTimeNet.toFixed(4));
  for (const k of Object.keys(perm.days)) perm.days[k].pnl = Number(perm.days[k].pnl.toFixed(4));
  for (const sd of Object.keys(perm.side)) perm.side[sd].net = Number(num(perm.side[sd].net).toFixed(4));
  try { store.write('pnl_permanent', perm); } catch (e) { console.warn('[v4] pnl_permanent write failed:', e.message); }
  return perm;
}
// Derived, API-facing view: all-time net/WR (permanent) + last-N LK days + side splits.
function getPermanentSummary(days = 7) {
  const perm = recordPermanentResults(); // fold any pending first, then read
  const completed = perm.allTimeWins + perm.allTimeLosses;
  const winRate = completed ? Math.round((perm.allTimeWins / completed) * 100) : 0;
  const lastN = Object.values(perm.days).sort((a, b) => b.date.localeCompare(a.date)).slice(0, Math.max(1, days));
  const sideStats = {};
  for (const sd of ['BUY', 'SELL']) {
    const s = perm.side[sd] || { wins: 0, losses: 0, net: 0 };
    const c = num(s.wins) + num(s.losses);
    sideStats[sd] = { wins: num(s.wins), losses: num(s.losses), completed: c, winRate: c ? Math.round(num(s.wins) / c * 100) : 0, netPnl: Number(num(s.net).toFixed(4)) };
  }
  return {
    startedAt: perm.startedAt,
    net: Number(num(perm.allTimeNet).toFixed(4)),
    wins: perm.allTimeWins, losses: perm.allTimeLosses, completed, winRate,
    days: lastN, sideStats,
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
  for (const s of signals) unique.set(s?.id || s?.signalId || ledgerKey(s), s);
  const rows = [...unique.values()];
  const wins = rows.filter(s => s.paperState === 'TP_HIT' || s.status === 'WIN').length;
  const losses = rows.filter(s => s.paperState === 'SL_HIT' || s.status === 'LOSS').length;
  const waiting = rows.filter(s => s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION' || s.paperState === 'CANDIDATE').length;
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

function activeFinalFromMarket(s, market, price) {
  const side = String(s.side || '').toUpperCase();
  const tp = num(s.tp1), sl = num(s.sl);
  const candleTs = num(market.ts || market.candleTs || market.candle?.ts, 0);
  const candleIntervalMs = Math.max(1000, num(market.candleIntervalMs, 60000));
  const openedAt = num(s.openedAt, 0);
  // If the paper trade was activated after the current candle had already opened,
  // using that whole candle's high/low can create false TP/SL results from price
  // action that happened before entry. Use tick/mark price only until the next
  // fresh candle range is available.
  const rangeStartedBeforeEntry = candleTs && openedAt && openedAt > candleTs && openedAt < candleTs + candleIntervalMs;
  const rangeUsable = !rangeStartedBeforeEntry;
  const high = rangeUsable ? num(market.high || market.lastHigh || market.candle?.high, price) : price;
  const low = rangeUsable ? num(market.low || market.lastLow || market.candle?.low, price) : price;
  let tpHit = false;
  let slHit = false;
  if (side === 'BUY') {
    tpHit = high >= tp || price >= tp;
    slHit = low <= sl || price <= sl;
  } else if (side === 'SELL') {
    tpHit = low <= tp || price <= tp;
    slHit = high >= sl || price >= sl;
  }
  if (!tpHit && !slHit) return null;
  // If both levels are inside the same observed candle/range, ordering is unknowable.
  // Use the conservative first-hit rule to avoid inflated paper win rate.
  if (tpHit && slHit) return { state: 'SL_HIT', status: 'LOSS', reason: `${V4_VERSION}: SL and TP touched same range; conservative SL first-hit rule`, exitPx: sl, rangeUsable };
  if (slHit) return { state: 'SL_HIT', status: 'LOSS', reason: `${V4_VERSION}: SL hit`, exitPx: sl, rangeUsable };
  return { state: 'TP_HIT', status: 'WIN', reason: `${V4_VERSION}: TP hit`, exitPx: tp, rangeUsable };
}

// fix48d: rich per-trade diagnostic capture — pure observability, NO gating.
// These fields are what the adaptive analysis needs and the old CSV never had:
//   • mfeR / maeR    — max favourable / adverse excursion in R (unlocks Fix A trail/BE + partial-TP sim)
//   • timeToActivateMs / activeDurationMs — how long the setup waited, how long it ran
//   • regime path    — btc + local regime & their strength proxies AT ENTRY, plus whether they flipped mid-trade
//   • atrPctAtEntry  — volatility context so we can normalise per-symbol behaviour
// regimeBrain exposes rsi / emaPctSpread / atrPct / volMomentum — real continuous strength signals.
function btcRegimeStrength() {
  const r = (typeof getBTCRegime === 'function') ? (getBTCRegime() || {}) : (snapshot.btcRegime || {});
  return {
    regime: r.regime || 'UNKNOWN',
    rsi: num(r.rsi, null),
    emaPctSpread: num(r.emaPctSpread, null),
    atrPct: num(r.atrPct, null),
    volMomentum: r.volMomentum != null ? r.volMomentum : null,
  };
}

function initActiveDiagnostics(s, entryPrice, atr, now, settings) {
  const risk = Math.abs(num(s.entry) - num(s.sl)) || (atr || 0) || 1e-9;
  const btc = btcRegimeStrength();
  s.diag = s.diag || {};
  s.diag.entryPx = roundPrice(entryPrice);
  s.diag.riskAbs = risk;
  s.diag.atrAtEntry = roundPrice(atr || 0);
  s.diag.atrPctAtEntry = num(s.price) ? Number(((atr || 0) / num(s.price) * 100).toFixed(4)) : null;
  s.diag.timeToActivateMs = now - num(s.createdAt, now);
  s.diag.activatedAt = now;
  s.diag.mfeR = 0;   // best price seen, in R, since activation
  s.diag.maeR = 0;   // worst price seen, in R (stored as a negative number)
  s.diag.ticks = 0;
  s.diag.timingRevertCount = num(s.timingRevertCount, 0);
  // regime AT ENTRY
  s.diag.btcRegimeAtEntry = btc.regime;
  s.diag.btcRsiAtEntry = btc.rsi;
  s.diag.btcEmaSpreadAtEntry = btc.emaPctSpread;
  s.diag.btcAtrPctAtEntry = btc.atrPct;
  s.diag.btcVolMomentumAtEntry = btc.volMomentum;
  s.diag.localRegimeAtEntry = s.localRegime || s.scoreInfo?.localRegime || null;
  // regime flip tracking (filled by tracker)
  s.diag.btcRegimeFlipped = false;
  s.diag.btcRegimeAtExit = btc.regime;
  // fix48r: rsiAtEntry was 100% null in 48m-48q CSVs (the 48m 'hardening' didn't reach the
  // stored signal). Try every plausible source: s.rsi, scoreInfo.rsi, the leader/candidate rsi,
  // the scoring object, then sc_rsi component. Keeps a real number wherever one exists.
  // fixRSI: prefer the live signal rsi, then the value captured at birth — NEVER overwrite a real
  // birth value with null. Legacy fallbacks kept last for older in-flight signals.
  s.diag.rsiAtEntry = num(s.rsi,
                       num(s.diag?.rsiAtEntry,
                       num(s.scoreInfo?.rsi,
                       num(s.scoring?.rsi,
                       num(s.leader?.rsi,
                       num(s.candidate?.rsi, null))))));
  // fix48m-instr: atrPctAtEntry fallback when s.price was null at activation (use entry px).
  if (s.diag.atrPctAtEntry == null) {
    const _px = num(s.price, num(s.entry, 0));
    s.diag.atrPctAtEntry = _px ? Number(((atr || 0) / _px * 100).toFixed(4)) : null;
  }
  // fix48r: CAPTURE MARKET-SENTINEL CONTEXT AT ENTRY — now with last-good fallback.
  // Previously read getSentinel() directly and wrote null on any cold/gapped read, leaving ~60%
  // of closed trades untagged. getSentinelForCapture() returns the freshest usable snapshot
  // (live if real, else last-known-good) plus a staleness flag we record for honest analysis.
  try {
    const { sent: _sent, stale: _sentStale, ageMs: _sentAge } = getSentinelForCapture();
    const _s = _sent || {};
    s.diag.breadthBullPctAtEntry = num(_s?.vol?.bull_pct,
                                       num(_s?.components?.vol?.bull_pct, null));
    s.diag.breadthLabelAtEntry   = _s?.vol?.label || _s?.components?.vol?.label || null;
    s.diag.fundingRateAtEntry    = num(_s?.fund?.avg_rate,
                                       num(_s?.components?.fund?.avg_rate, null));
    s.diag.fundingDangerAtEntry  = _s?.fund?.danger || _s?.components?.fund?.danger || null;
    s.diag.sentinelRegimeAtEntry = _s?.market_regime || null;
    s.diag.sentinelCompositeAtEntry = num(_s?.composite_score, null);
    s.diag.sentinelAllowedAtEntry = Array.isArray(_s?.allowed_sides) ? _s.allowed_sides.join('|') : null;
    // fix48r: record whether the sentinel context was fresh or a stale fallback, so analysis can
    // weight/filter accordingly instead of silently trusting stale tags as live.
    s.diag.sentinelStaleAtEntry = !!_sentStale;
    s.diag.sentinelAgeMsAtEntry = _sentStale ? num(_sentAge, null) : 0;
    s.diag.breadthOverrideAtEntry = !!_s?.breadth_override_active; // fix48s: green-breadth BUY control-group tag
    // fix48t: SHADOW-CAPTURE tags. contrarianFlipAtEntry marks a BUY→SELL flip; preFlip* records the
    // original BUY plan that was NOT traded, for offline kline replay (breadth-vs-flip arbitration).
    s.diag.contrarianFlipAtEntry = !!s.contrarianFlip;
    const _pf = s.preFlip || null;
    s.diag.preFlipSide  = _pf ? _pf.side : null;
    s.diag.preFlipEntry = _pf ? num(_pf.entry, null) : null;
    s.diag.preFlipSl    = _pf ? num(_pf.sl, null) : null;
    s.diag.preFlipTp1   = _pf ? num(_pf.tp1, null) : null;
    s.diag.preFlipRr    = _pf ? num(_pf.rr, null) : null;
    s.diag.preFlipScore = _pf ? num(_pf.score, null) : null;
    // fix48w: read contextDiag from the signal directly (fix48v used fragile components chain → all null).
    // leader.contextDiag is now an explicit field on both signalFromLeader + ingestCandidate.
    const _ctx = s.contextDiag || null;
    s.diag.fearGreedAtEntry    = _ctx ? (_ctx.fng ?? null) : (_lastKnownFng ?? null);
    s.diag.perPairAlignAtEntry = _ctx ? num(_ctx.perPair, null) : null;
    s.diag.alignScoreAtEntry   = _ctx ? num(_ctx.align, null) : null;
    s.diag.fearMultAtEntry     = _ctx ? num(_ctx.fearMult, null) : null;
    s.diag.contextMultAtEntry  = _ctx ? num(_ctx.contextMult, null) : null;

    // fixMICRO: per-COIN funding + OI at entry, alongside the existing market-wide fundingRateAtEntry.
    // This is the Direction Brain's micro-layer input the walk-forward harness found missing — whether
    // THIS coin's own funding/positioning has already decoupled from the market-wide reading (e.g. this
    // coin's shorts are more crowded than the market average while price hasn't caught down yet).
    // leader.coinFundingRate/coinOpenInterest are set in buildStructurePlan straight off Bybit's existing
    // /v5/market/tickers payload (zero extra API calls — see fetchTickers). Absent on older/replayed
    // signals (field didn't exist pre-fixMICRO) — stays null, walk-forward can filter on it.
    s.diag.coinFundingRateAtEntry = num(s.coinFundingRate, null);
    s.diag.coinOpenInterestAtEntry = num(s.coinOpenInterest, null);
    if (s.diag.coinFundingRateAtEntry != null && s.diag.fundingRateAtEntry != null) {
      // positive = this coin's funding is MORE bullish-leaning (less short-crowded) than market average;
      // negative = this coin is MORE short-crowded than the market — the squeeze-fuel divergence.
      s.diag.fundingDivergenceAtEntry = Number((s.diag.coinFundingRateAtEntry - s.diag.fundingRateAtEntry).toFixed(6));
    } else {
      s.diag.fundingDivergenceAtEntry = null;
    }

    // fixBOTTOM: re-stamp breadth range-percentile at FILL time (fresher than birth if the signal
    // waited; overwrites the birth fallback, same fixMICRO2 pattern). dirBrainAdvice is NOT
    // re-stamped — the advisory is scored on what it knew at birth, its actual decision point.
    try {
      const _bpF = breadthRangePctile();
      if (_bpF && _bpF.pctile != null) s.diag.breadthRangePctileAtEntry = _bpF.pctile;
      else if (s.diag.breadthRangePctileAtEntry === undefined) s.diag.breadthRangePctileAtEntry = null;
    } catch (_eBPF) { if (s.diag.breadthRangePctileAtEntry === undefined) s.diag.breadthRangePctileAtEntry = null; }

    // fixSHADOW (RECORDING ONLY — acts on nothing, gates nothing, changes no trade). Stamps two
    // patterns confirmed across 756 pooled trades (Jun21–Jul7) so they can be scored live before
    // any future gate is even considered. Built both-sides per the symmetry rule.
    try {
      const _pct = num(s.diag.breadthRangePctileAtEntry, null);
      // (1) Range-position trap. SELL @ pctile<=15 = ~15% WR (z=-2.43, replicated out-of-sample).
      //     BUY mirror @ pctile>=85 stamped for symmetry (weak evidence, small n — documented).
      s.diag.rangeTrapShadow =
        (s.side === 'SELL' && _pct != null && _pct <= 15) ? { side: 'SELL', pctile: _pct, priorWR: 15, note: 'BOTTOM_RANGE_SHORT_TRAP — RECORDING ONLY' } :
        (s.side === 'BUY'  && _pct != null && _pct >= 85) ? { side: 'BUY',  pctile: _pct, priorWR: 44, note: 'TOP_RANGE_LONG_TRAP — RECORDING ONLY (weak evidence)' } :
        null;
      // (2) LK 03:00-04:00 dead zone. Only hours with <=0 gross edge; go net-negative once the
      //     market-SL taker+slippage cost lands (67-77% losers => cost concentrates on them).
      const _lkH = new Date(num(now, Date.now()) + (5 * 3600 + 30 * 60) * 1000).getUTCHours();
      s.diag.deadHourShadow =
        (_lkH === 3 || _lkH === 4) ? { lkHour: _lkH, note: 'LK03-04 LOW_EDGE_HIGH_SLIPPAGE — RECORDING ONLY' } : null;
    } catch (_eShadow) { /* recording-only: must never touch the trade path */ }

    // fix49i(X): EXHAUSTION TAG — read-only, no behavior change. Captures the signature that won
    // every time across the 92hr bull run (btcRSI 83-87, regimeStrength ~1.0, funding deeply
    // negative) and that ALSO produced the 06/10 reversal losses — same setup, opposite outcome,
    // decided only by whether the trend continued. We cannot validate a blocking threshold yet:
    // the sample is 100% bull, 0 SELL, zero losing-exhaustion entries to compare against. So we
    // tag now and let the data accumulate; when the regime turns bear, exhaustionScore vs result
    // settles the question with evidence. Components stored raw so any threshold can be tested
    // retrospectively (RSI>=80 vs >=85, funding<0 vs <-0.003) without having pre-committed a line.
    try {
      const _exBtcRsi  = num(s.diag.btcRsiAtEntry, null);
      const _exRegStr  = num(s.scoring?.components?._mult?.regimeStrength,
                          num(s.scoreInfo?.components?._mult?.regimeStrength,
                          num(s.diagnostic?.scoreBreakdown?.components?._mult?.regimeStrength, null)));
      const _exFunding = num(s.diag.fundingRateAtEntry, null);
      const _cRsi  = _exBtcRsi  != null && _exBtcRsi  >= 80;
      const _cReg  = _exRegStr  != null && _exRegStr  >= 0.9;
      const _cFund = _exFunding != null && _exFunding < 0;
      // score only counts conditions whose inputs were actually present (null input ≠ false signal)
      s.diag.exhaustionScore = (_cRsi ? 1 : 0) + (_cReg ? 1 : 0) + (_cFund ? 1 : 0);
      // fix49k: tag which side (if any) breadth-override rescued this signal — for isolated analysis
      s.diag.breadthOverrideApplied = (s.scoring?.components?._breadthOverride?.side ||
                                       s.scoreInfo?.components?._breadthOverride?.side || null);
      // fix49p: tag conflict-breadth-lead experimental trades for clean cohort separation in the ledger
      s.diag.conflictLead = (s.scoring?.components?._conflictLead ||
                             s.scoreInfo?.components?._conflictLead || null);
      s.diag.exhaustionComponents = {
        btcRsi: _exBtcRsi, btcRsiHot: _cRsi,
        regimeStrength: _exRegStr, regimeStrengthHot: _cReg,
        funding: _exFunding, fundingNegative: _cFund,
        anyInputNull: (_exBtcRsi == null || _exRegStr == null || _exFunding == null)
      };
    } catch (_e) {
      s.diag.exhaustionScore = null;
      s.diag.exhaustionComponents = null;
    }
  } catch (_e) {
    s.diag.breadthBullPctAtEntry = null;
    s.diag.sentinelStaleAtEntry = null;
    s.diag.breadthOverrideAtEntry = null; // fix48s
    s.diag.contrarianFlipAtEntry = null;  // fix48t
    s.diag.fearGreedAtEntry = null;       // fix48v
    s.diag.contextMultAtEntry = null;     // fix48v
    s.diag.exhaustionScore = null;        // fix49i
    s.diag.exhaustionComponents = null;   // fix49i
  }
}

function trackActiveDiagnostics(s, market, price, now) {
  if (!s.diag || !s.diag.riskAbs) return;
  const side = String(s.side || '').toUpperCase();
  const risk = s.diag.riskAbs;
  const entryPx = num(s.diag.entryPx, num(s.entry));
  // use candle extremes when usable so excursion reflects the true path, not just last tick
  const hi = num(market.high || market.lastHigh || market.candle?.high, price);
  const lo = num(market.low  || market.lastLow  || market.candle?.low,  price);
  let favPx, advPx;
  if (side === 'BUY') { favPx = hi; advPx = lo; }
  else                { favPx = lo; advPx = hi; }
  const favR = side === 'BUY' ? (favPx - entryPx) / risk : (entryPx - favPx) / risk;
  const advR = side === 'BUY' ? (advPx - entryPx) / risk : (entryPx - advPx) / risk; // <=0 when adverse
  if (favR > s.diag.mfeR) s.diag.mfeR = Number(favR.toFixed(3));
  if (advR < s.diag.maeR) s.diag.maeR = Number(advR.toFixed(3));
  s.diag.ticks = num(s.diag.ticks, 0) + 1;
  // detect btc regime flip during the trade
  const btcNow = btcRegimeStrength();
  s.diag.btcRegimeAtExit = btcNow.regime;
  if (btcNow.regime !== s.diag.btcRegimeAtEntry && btcNow.regime !== 'UNKNOWN') s.diag.btcRegimeFlipped = true;
}

function finalizeActiveDiagnostics(s, now) {
  if (!s.diag) return;
  s.diag.activeDurationMs = now - num(s.diag.activatedAt, now);
  // mfeR is the headline metric for Fix A: a trade with mfeR>=1 that still lost = a BE/trail would have saved it
  s.diag.reachedPlus1R = num(s.diag.mfeR, 0) >= 1.0;
  s.diag.reachedPlus2R = num(s.diag.mfeR, 0) >= 2.0;
}

// fix48e: ADAPTIVE RE-VALIDATION of a still-waiting signal against LIVE market conditions.
// Returns { action: 'ABANDON'|'FREEZE'|'OK', reason }.
//   ABANDON → setup thesis is dead; move to STALE_CANCELLED (no fill, no loss taken).
//   FREEZE  → conditions temporarily hostile; don't activate this tick but keep waiting (may recover).
//   OK      → thesis intact; normal timing logic proceeds.
// `market` may carry fresh 5m context (closes5/rsi5/atr5) injected by enrichOpenSignalMarketMap.
function revalidateWaitingSignal(s, market, price, now) {
  const side = String(s.side || '').toUpperCase();
  const age = now - num(s.createdAt, now);
  if (age < REVAL_MIN_AGE_MS) return { action: 'OK', reason: '' };

  const entry = num(s.entry), sl = num(s.sl);
  const riskAbs = Math.abs(entry - sl) || 0;

  // ── 1. REGIME DRIFT (the big one) ────────────────────────────────────────
  // Re-run the directional thesis against the CURRENT btc + local regime.
  // If the signal's side is no longer permitted, the reason it was born is gone.
  const btc = btcRegimeStrength();
  const liveLocal = s.localRegime || s.scoreInfo?.localRegime || market.localRegime || 'LOCAL_UNKNOWN';
  try {
    const allow = getAllowedSides(btc.regime, liveLocal);
    const sideAllowedNow = side === 'BUY' ? allow.allowedBuy : allow.allowedSell;
    const bornRegime = s.diag?.btcRegimeAtEntry || s.scoreInfo?.btcRegime || s.btcRegime;
    if (!sideAllowedNow && btc.regime && btc.regime !== 'UNKNOWN') {
      // only abandon if the regime actually CHANGED from birth (avoid abandoning on a borderline
      // setup that was always weak — those are the planner's job, not the guard's)
      if (bornRegime && String(bornRegime).toUpperCase() !== String(btc.regime).toUpperCase()) {
        return { action: 'ABANDON', reason: `regime drifted ${bornRegime}→${btc.regime}; ${side} no longer permitted (${allow.blockReason || 'side blocked'})` };
      }
    }
  } catch (_e) { /* getAllowedSides unavailable — skip regime check */ }

  // ── 2. ADVERSE PRE-ENTRY DRIFT ───────────────────────────────────────────
  // If price has already drifted toward SL by > REVAL_ADVERSE_DRIFT_FRAC of the entry→SL distance
  // BEFORE the trade even fills, the structure is breaking. Don't buy a falling knife into the limit.
  if (riskAbs > 0 && price) {
    const adverse = side === 'BUY' ? (entry - price) : (price - entry); // >0 = moved toward SL side
    if (adverse > 0 && adverse / riskAbs >= REVAL_ADVERSE_DRIFT_FRAC) {
      return { action: 'ABANDON', reason: `price drifted ${(adverse/riskAbs*100).toFixed(0)}% of entry→SL toward stop before fill — structure breaking` };
    }
  }

  // ── 3. LIVE MOMENTUM REVERSAL (freeze, recoverable) ──────────────────────
  // Use fresh 5m RSI if enrich provided it. BUY into collapsing RSI, or SELL into ripping RSI,
  // is fighting live momentum. Freeze (don't fill) until momentum realigns — setup may still be valid.
  const rsi5 = num(market.rsi5, NaN);
  if (Number.isFinite(rsi5)) {
    if (side === 'BUY'  && rsi5 < REVAL_MOMENTUM_RSI_BUY_MAX)  return { action: 'FREEZE', reason: `live 5m RSI ${rsi5.toFixed(0)} collapsing — momentum opposes BUY, holding fill` };
    if (side === 'SELL' && rsi5 > REVAL_MOMENTUM_RSI_SELL_MIN) return { action: 'FREEZE', reason: `live 5m RSI ${rsi5.toFixed(0)} ripping — momentum opposes SELL, holding fill` };
  }

  // ── 4. VOLATILITY SHOCK (freeze, recoverable) ────────────────────────────
  // If live ATR has expanded sharply vs the ATR at signal creation, a regime shift / news event is
  // underway. The original SL/TP geometry is no longer calibrated. Freeze until vol normalises.
  const atrBorn = num(s.diag?.atrAtEntry || s.planner?.keyLevels?.atr, 0);
  const atrLive = num(market.atr5, 0);
  if (atrBorn > 0 && atrLive > 0 && atrLive / atrBorn >= REVAL_ATR_SHOCK_MULT) {
    return { action: 'FREEZE', reason: `live ATR ${(atrLive/atrBorn).toFixed(1)}x creation ATR — volatility shock, SL/TP geometry stale` };
  }

  // ── 5. fix55: BREADTH FIGHT AT FILL (graduated hold → abandon) ────────────
  // The validated breadth-fight gate (BUY needs bull% ≥ floor, SELL ≤ ceiling; 65% WR aligned vs
  // 38% fighting, n=196 — fix49h/o) runs at CREATION only. A signal born in aligned breadth can
  // drift into the fight zone while it sits in WAITING, then fill into a backdrop that no longer
  // supports it (the regime LABEL stays put — sentinel hysteresis — so nothing else catches it).
  // Re-check LIVE breadth each tick: FREEZE (hold the fill) while it fights; if breadth recovers
  // within the grace window we resume normal fill; if it is STILL fighting after the grace window
  // the regime has turned and the edge is gone → ABANDON. Both sides symmetric. Same 50/50 env
  // thresholds + same getSentinelForCapture() snapshot the creation gate uses. Fails OPEN on a
  // stale/missing breadth read (never freezes the system on a data gap).
  try {
    const BUY_MIN_BREADTH  = Math.max(0, Math.min(50, Number(process.env.V4_BUY_MIN_BREADTH  || '50')));
    const SELL_MAX_BREADTH = Math.max(50, Math.min(100, Number(process.env.V4_SELL_MAX_BREADTH || '50')));
    const { sent: _bSent, stale: _bStale, ageMs: _bAgeMs } = getSentinelForCapture();
    const _bPairs = num(_bSent?.vol?.pair_count, 0);
    const _bPct = _bPairs > 0 ? num(_bSent?.vol?.bull_pct, NaN) : NaN;
    const _bUsable = Number.isFinite(_bPct) && (!_bStale || _bAgeMs <= REVAL_BREADTH_FIGHT_MAX_AGE_MS);
    if (_bUsable) {
      const fighting = (side === 'BUY' && _bPct <= BUY_MIN_BREADTH) || (side === 'SELL' && _bPct >= SELL_MAX_BREADTH);
      if (fighting) {
        if (!num(s._breadthFightSince, 0)) s._breadthFightSince = now; // first fighting tick — start the clock
        const held = now - s._breadthFightSince;
        if (held >= REVAL_BREADTH_FIGHT_GRACE_MS) {
          return { action: 'ABANDON', reason: `breadth ${_bPct.toFixed(0)}% fought ${side} for ${(held / 60000).toFixed(1)}min (≥${(REVAL_BREADTH_FIGHT_GRACE_MS / 60000).toFixed(0)}min grace) — regime turned, edge gone` };
        }
        return { action: 'FREEZE', reason: `breadth ${_bPct.toFixed(0)}% now fighting ${side} (need ${side === 'BUY' ? '≥' + BUY_MIN_BREADTH : '≤' + SELL_MAX_BREADTH}%); holding fill, ${Math.max(0, (REVAL_BREADTH_FIGHT_GRACE_MS - held) / 60000).toFixed(1)}min to abandon` };
      } else if (num(s._breadthFightSince, 0)) {
        s._breadthFightSince = 0; // breadth recovered into the aligned zone → resume normal fill
      }
    }
  } catch (_e) { /* breadth snapshot unavailable — fail open, do not block */ }

  return { action: 'OK', reason: '' };
}

// fix49e: LIVE STATE AUTHORITY (replaces fix49d liveFillGate).
// Root cause of the 49d losses: in LIVE mode the paper brain ran its own TP/SL/expiry logic in
// parallel with Bybit, with no single source of truth. It abandoned real filled positions
// (BEAT/WLD marked STALE/INVALIDATED while Bybit shorts ran to SL) and booked invented P&L that
// disagreed with Bybit (NEAR -0.134 paper vs -0.22 real). 49d's lookup also used fragile signalId
// matching and missed fills.
//
// Fix: in LIVE mode, a signal that has a linked Bybit trade (s.tradeId) is driven ENTIRELY by that
// trade. Paper expiry/revalidation/missed-move/TP-SL are bypassed. Bybit is the only brain.
//   - position OPEN            -> ACTIVE, locked (paper cannot abandon or close it)
//   - position CLOSED          -> close with Bybit's real closedPnl (WIN if >0, LOSS if <0)
//   - order filled, no pos yet -> ACTIVE (transitional), locked
//   - order resting unfilled   -> WAITING, locked (only reconciler's own stale-cancel ends it)
//   - order cancelled/rejected -> STALE_CANCELLED (no real position — correct)
//   - no tradeId / no record   -> return null, fall through to paper logic (safe default)
//
// Reversible: V4_LIVE_FILL_GATE=false disables this and restores pure paper behaviour.
// Returns an action object or null (null = run normal paper logic).
function liveStateAuthority(signal, settings, now) {
  // fix49g: do NOT gate on botMode/tradingEnabled. Observed 2026-06-10 19:32: user hit the kill
  // switch (tradingEnabled=false) while VVV/SIREN positions were open and a WLD limit was resting —
  // the authority switched off and the paper brain went back to price-guessing 6 signals ACTIVE vs
  // Bybit's 2 real positions. tradingEnabled gates NEW order placement (executor); it must never
  // gate truth-mirroring of EXISTING live trades. The existence of a trade record (signal.tradeId)
  // IS the condition: a real order was placed, so Bybit is this signal's truth until terminal.
  if (String(process.env.V4_LIVE_FILL_GATE || 'true').toLowerCase() === 'false') return null;
  if (!signal.tradeId) return null; // no live order linked → paper logic (e.g. order never placed)

  let trades;
  try { trades = store.read('trades', {}); } catch (_e) { return null; }
  const trade = trades && trades[signal.tradeId];
  if (!trade) return null; // record not found → paper logic (do not abandon based on absence)

  const st  = String(trade.status || '').toUpperCase();
  const pos = String(trade.positionStatus || '').toUpperCase();

  // Position currently open on Bybit → lock ACTIVE, never let paper close/abandon it.
  if (pos === 'OPEN' || st === 'POSITION_OPEN') {
    return { kind: 'ACTIVE', trade };
  }

  // Position closed on Bybit → mirror real exit + real P&L.
  if (pos === 'CLOSED' || st === 'POSITION_CLOSED') {
    const realPnl = num(trade.closedPnl);
    return { kind: 'CLOSED', trade, realPnl,
             result: realPnl >= 0 ? 'WIN' : 'LOSS',
             finalState: realPnl >= 0 ? 'TP_HIT' : 'SL_HIT',
             exitPx: num(trade.avgExitPrice) || null };
  }

  // Order accepted, filling, or partially filled but no position object yet → hold ACTIVE-transitional.
  if (['ORDER_FILLED_NO_POSITION', 'PARTIALLY_FILLED_NO_POSITION'].includes(st)) {
    return { kind: 'ACTIVE', trade };
  }

  // Order still resting / pending fill → WAITING, locked. Only reconciler stale-cancel ends it.
  if (['ORDER_PENDING_FILL', 'ORDER_SUBMITTED', 'PENDING', 'LIMIT_WAITING', 'SENT_LIVE'].includes(st)
      || (trade.orderStatus && num(trade.cumExecQty) === 0)) {
    return { kind: 'WAITING', trade };
  }

  // Cancelled / rejected / deactivated → no real position, mark stale.
  if (['CANCELLED', 'ORDER_CANCELLED', 'ORDER_REJECTED', 'ORDER_DEACTIVATED'].includes(st)) {
    return { kind: 'CANCELLED', trade };
  }

  // Unknown state → safest is to hold WAITING (do NOT run paper close on a live trade we can't classify).
  return { kind: 'WAITING', trade };
}

// fix57: READ-ONLY divergence detector. Compares each live paper signal's displayed state against
// its linked Bybit trade record. Takes NO action — pure telemetry so the Orayan-vs-Bybit mismatches
// (paper ACTIVE with no order, paper P&L with no live close, etc.) are visible in /health and can be
// watched to confirm the fill-authority fix is holding before any acting reconciliation is added.
function detectLiveDivergences() {
  const out = { mode: 'PAPER', checked: 0, divergences: [] };
  try {
    const settings = currentSettings();
    if (settings.botMode !== 'LIVE_REAL_BYBIT') return out;
    out.mode = 'LIVE';
    const signals = getSignals();
    const trades = store.read('trades', {});
    for (const s of signals) {
      if (FINAL_STATES.has(s.paperState)) continue;
      out.checked++;
      const sym = s.sym || s.symbol;
      const isActive = s.paperState === 'PAPER_ACTIVE' || String(s.positionStatus || '').toUpperCase() === 'OPEN';
      const trade = s.tradeId ? trades[s.tradeId] : null;
      const tradePos = trade ? String(trade.positionStatus || '').toUpperCase() : null;
      if (isActive && !s.tradeId) {
        out.divergences.push({ sym, side: s.side, kind: 'ACTIVE_NO_LIVE_ORDER', detail: 'paper ACTIVE but no live order linked (tradeId missing)' });
      } else if (isActive && s.tradeId && !trade) {
        out.divergences.push({ sym, side: s.side, kind: 'ACTIVE_NO_TRADE_RECORD', detail: `paper ACTIVE but trade record ${s.tradeId} not found` });
      } else if (isActive && trade && tradePos !== 'OPEN') {
        out.divergences.push({ sym, side: s.side, kind: 'ACTIVE_NO_BYBIT_POSITION', detail: `paper ACTIVE but Bybit trade status=${trade.status} (no open position)` });
      } else if (num(s.realizedPnl) !== 0 && tradePos !== 'CLOSED') {
        out.divergences.push({ sym, side: s.side, kind: 'PAPER_PNL_NO_LIVE_CLOSE', detail: `paper shows P&L ${s.realizedPnl} but Bybit trade ${trade ? 'status=' + trade.status : 'missing'} (not closed)` });
      }
    }
  } catch (e) { out.error = e.message; }
  return out;
}

// fix49h: flag the linked trade so the reconciler cancels the resting Bybit order.
// Single helper — every pre-entry kill path (invalidate / expire / stale-cancel) must call this.
// 06/10 live data: 2 of 6 losses were signals Orayan had already invalidated whose GTC limits
// kept resting, filled on the retrace into broken structure, and rode to SL on Bybit.
// Fill-race note: if the order actually filled on Bybit but the local record lags one reconcile
// cycle, the reconciler's cancel gets retCode 110001, leaves the trade un-cancelled, and the
// next deriveStatus pass classifies the real position — liveStateAuthority then owns it.
// fixFLIP: build an opposite-side WAITING_ENTRY child from a failed-rejection squeeze on a still-waiting
// parent. Pure constructor — no mutation of `parent`, no store writes. Returns child signal or null.
// detectFlip() (regimeBrain) is the trigger: parent SELL whose closed 5m bar prints back above entry on a
// volume spike → BUY; symmetric for BUY. Geometry rebuilt from scratch (old levels are nonsense flipped).
function buildFlipChild(parent, market, price, now, settings) {
  try {
    if (!FLIP_ENABLED || !parent || parent.flippedOnce) return null;
    const side = String(parent.side || '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') return null;
    if ((now - signalBirthMs(parent)) < FLIP_MIN_AGE_MS) return null;

    const candle = (market && (market.candleFlipClosed || market.candle5closed)) || null;
    const avgVol = num(market && (market.avgVolFlip != null ? market.avgVolFlip : market.avgVol5), 0);
    if (!candle || !(avgVol > 0)) return null; // need a closed flip-TF bar + real avg volume
    // fixADAPT: in a hostile regime for THIS side, lower the volume-spike bar detectFlip must clear so more
    // squeezing shorts (or longs) flip — the reactive flip leans harder exactly when the side is bleeding.
    const avgVolForFlip = adaptiveHostile(side) ? avgVol * ADAPT_FLIP_VOL_RELAX : avgVol;

    const flip = detectFlip(parent, candle, avgVolForFlip);
    if (!flip || !flip.flip) return null;
    const newSide = flip.newSide;
    if (newSide !== 'BUY' && newSide !== 'SELL' || newSide === side) return null;

    const E = num(parent.entry);
    if (!(E > 0)) return null;

    // Live-squeeze confirmation: only flip while the reclaim is STILL in force at the current price
    // (avoid flipping into a faded squeeze where the 5m bar closed through entry but price snapped back).
    const px = num(price, num(candle.close, 0));
    if (px > 0) {
      if (side === 'SELL' && !(px > E)) return null; // failed-SELL reclaim must still hold above entry
      if (side === 'BUY'  && !(px < E)) return null; // failed-BUY breakdown must still hold below entry
    }
    const atr = num(parent.diag && parent.diag.atrAtEntry,
                num(parent.planner && parent.planner.keyLevels && parent.planner.keyLevels.atr,
                num(market.atr5, 0)));
    const buf = (atr > 0 ? atr : E * 0.002) * FLIP_SL_ATR_BUF;
    const parentRr = num(parent.rr, 0);
    const rrTarget = parentRr >= 1 ? parentRr : FLIP_DEFAULT_RR;

    let entry, sl, tp;
    if (newSide === 'BUY') {
      // failed-SELL rejection: old resistance E is now support; limit-retest a BUY at E
      const support = Math.min(num(candle.low, E), E);
      entry = E;
      sl = support - buf;
      if (!(sl < entry)) return null;
      tp = entry + rrTarget * (entry - sl);
    } else {
      // failed-BUY support: old support E is now resistance; limit-retest a SELL at E
      const resistance = Math.max(num(candle.high, E), E);
      entry = E;
      sl = resistance + buf;
      if (!(sl > entry)) return null;
      tp = entry - rrTarget * (sl - entry);
    }
    if (!(entry > 0) || !(sl > 0) || !(tp > 0)) return null;

    const plan = { entry: roundPrice(entry), sl: roundPrice(sl), tp1: roundPrice(tp) };
    const math = calculatePaperMath(plan, settings);
    if (num(math.rr, 0) < FLIP_MIN_RR) return null; // bad geometry — don't take it (not a gate; sane construction)

    let composite = null;
    try { composite = num(sentinel.getSentinel() && sentinel.getSentinel().composite_score, null); } catch (_e) {}

    const flipLeader = {
      symbol: parent.sym || parent.symbol,
      side: newSide,
      price: num(candle.close, entry),
      plan,
      tier: parent.tier,
      score: num(parent.score, 0),
      scoreInfo: (parent.diagnostic && parent.diagnostic.scoreBreakdown) || (parent.planner && parent.planner.scoring) || null,
      btcRegime: parent.btcRegime,
      localRegime: parent.localRegime,
      rsi: num(parent.rsi, num(parent.diag && parent.diag.rsiAtEntry, null)),        // fixRSI: inherit parent RSI on flip path
      btcRsi: num(parent.btcRsi, num(parent.diag && parent.diag.btcRsiAtEntry, null)), // fixRSI: inherit parent BTC RSI on flip
      keyLevels: Object.assign({}, (parent.planner && parent.planner.keyLevels) || {}, { atr }),
      math,
      entrySource: 'CONTRARIAN_FLIP', slSource: 'CONTRARIAN_FLIP', tpSource: 'CONTRARIAN_FLIP',
      reasons: [flip.label || `Contrarian flip ${side}->${newSide}`],
      risks: Array.isArray(parent.risks) ? parent.risks.slice(0, 4) : [],
      entryTiming: { inZone: false, directional: false, zoneTouchScore: 0, reactionScore: 0, reason: `CONTRARIAN_FLIP retest: ${flip.flipReason}` },
      contrarianFlip: true,
      preFlip: { side, entry: parent.entry, sl: parent.sl, tp1: parent.tp1, rr: parent.rr, score: parent.score },
    };
    const child = signalFromLeader(flipLeader, settings);
    if (!child) return null;
    child.id = `v4flip_${flipLeader.symbol}_${newSide}_${now}`;
    child.flippedOnce = true;                 // hard guard — a flip child can never itself flip
    child.flippedFromId = parent.id;
    child.flipReason = flip.flipReason;
    child.flipMeta = { parentId: parent.id, parentSide: side, newSide, flipReason: flip.flipReason, sentinelComposite: composite, triggerClose: num(candle.close, null), at: now };
    child.source = `backend-flip-${V4_VERSION}`;
    child.stateReason = `${V4_VERSION}: contrarian flip ${side}→${newSide} (${flip.flipReason}); limit-retest @ ${plan.entry}; composite ${composite}`;
    return child;
  } catch (_e) {
    return null; // never let a flip attempt disrupt the state machine
  }
}

function flagTradeForCancel(s, why) {
  if (!s || !s.tradeId) return;
  try {
    const trades = store.read('trades', {});
    if (trades[s.tradeId]) {
      trades[s.tradeId].signalInvalidated = true;
      trades[s.tradeId].invalidateReason = String(why || 'SIGNAL_KILLED');
      trades[s.tradeId].invalidateFlaggedAt = Date.now();
      store.write('trades', trades);
    }
  } catch (_e) { /* never block the state machine on store errors */ }
}

// fixADAPT: rolling per-side regime derived from realized results (not a market snapshot). Recomputed once
// per scan tick. HOSTILE when the trailing-N win rate for that side is below ADAPT_HOSTILE_WR — i.e. the side
// is in a losing/squeeze regime — and self-relaxes to NORMAL the moment recent results recover. Both sides.
let _adaptiveRegime = { sell: 'NORMAL', buy: 'NORMAL', sellWR: null, buyWR: null, sellN: 0, buyN: 0, at: 0 };
function computeAdaptiveRegime(ledger = getLedger()) {
  const prev = _adaptiveRegime;
  const out = { sell: 'NORMAL', buy: 'NORMAL', sellWR: null, buyWR: null, sellN: 0, buyN: 0, at: Date.now() };
  try {
    const resolved = (ledger || []).filter(r => r && (r.paperState === 'TP_HIT' || r.paperState === 'SL_HIT'));
    for (const side of ['BUY', 'SELL']) {
      const rows = resolved
        .filter(r => String(r.side).toUpperCase() === side)
        .sort((a, b) => num(b.closedAt, num(b.updatedAt, 0)) - num(a.closedAt, num(a.updatedAt, 0)))
        .slice(0, ADAPT_WINDOW);
      const n = rows.length;
      const w = rows.filter(r => r.paperState === 'TP_HIT').length;
      const wr = n ? w / n : null;
      const key = side.toLowerCase();
      out[key + 'N'] = n;
      out[key + 'WR'] = wr;
      out[key] = (n >= ADAPT_MIN_SAMPLE && wr != null && wr < ADAPT_HOSTILE_WR) ? 'HOSTILE' : 'NORMAL';
    }
  } catch (_e) { /* regime detection must never break the scan */ }
  _adaptiveRegime = out;
  if (ADAPT_ENABLED && (out.sell !== prev.sell || out.buy !== prev.buy)) {
    const p = (v) => v == null ? 'n/a' : `${(v * 100).toFixed(0)}%`;
    addLog('ADAPT_REGIME', `SELL ${prev.sell}→${out.sell} (trailWR ${p(out.sellWR)}, n=${out.sellN}) | BUY ${prev.buy}→${out.buy} (trailWR ${p(out.buyWR)}, n=${out.buyN})`);
  }
  return out;
}
function adaptiveHostile(side) {
  if (!ADAPT_ENABLED) return false;
  return _adaptiveRegime[String(side || '').toLowerCase()] === 'HOSTILE';
}
function getAdaptiveRegime() { return _adaptiveRegime; }

function updateExistingSignals(signals, priceMap) {
  const now = Date.now();
  const settings = currentSettings();
  let changed = false;
  const _flipChildren = []; // fixFLIP: opposite-side children built mid-loop, appended after iteration
  // fixPHASE1PERF (07/31, hotfix36) — REAL BUG, confirmed via user's reported backend timeouts
  // (gradual, backend-only, tracked the recent v4Brain hotfixes — pointed straight here). Phase 1's
  // decideLiveEntry() was calling activeTrades() -> getTrades() -> store.read('trades', {}) on EVERY
  // qualifying candidate, EVERY tick — store.read() does a SYNCHRONOUS fs.readFileSync + JSON.parse
  // with ZERO caching (confirmed in store.js), which BLOCKS Node's single-threaded event loop. For
  // shadow-only observability logging, that's pure self-inflicted overhead scaling with candidate
  // count and trades-file size — exactly the "gradual, backend-only" symptom reported. Fix: compute
  // the active-trade count ONCE per scan cycle here, pass it down, instead of once per candidate.
  let _p1ActiveCount = 0;
  try { _p1ActiveCount = require('./executor').activeTrades().length; } catch (_p1ce) { /* fail-open, shadow only */ }
  for (const s of signals) {
    if (!s) continue;
    // fixABANDON (layer 2): was `if (FINAL_STATES.has(s.paperState)) continue;` — which permanently
    // dropped any signal paper had killed, INCLUDING ones with a live unresolved order on Bybit.
    // A reclaimable final (order-bearing + paper pre-fill kill + not yet resolved by Bybit) now gets
    // an authority pass so a late fill can be re-claimed. It is a RECLAIM pass only: paper logic is
    // never re-run on a final signal (see the `_finalNow` guard right after the authority block).
    const _finalNow = FINAL_STATES.has(s.paperState);
    if (_finalNow && !reclaimableFinal(s)) continue;

    const market = priceMap.get(s.sym) || priceMap.get(s.symbol) || {};
    const price = num(market.markPrice || market.lastPrice || market.close || s.backendLastPrice);
    const prevState = s.paperState;

    // fix49h(H1): LIVE STATE AUTHORITY now runs FIRST — before the fix48g no-price expiry block.
    // In 49g it ran after the price guard, so the early-expiry block could kill a signal with a
    // resting live order WITHOUT flagging the order for cancel (the fix49c cancel in the second
    // expiry block was dead code — this earlier block always fired first on the same condition).
    // Authority does not need a live price; only the trade record.
    // === UNIFIED BRAIN (env V4_UNIFIED_BRAIN=true) — single-authority seam removal ============
    // When enabled, any order-bearing signal is driven ENTIRELY by the reconciled Bybit trade
    // record via the lifecycle core (lib/lifecycle.js + lib/unifiedBrain.js). All snapshot/paper
    // logic below is bypassed for such signals, so a live position can NEVER be abandoned/staled
    // by the scanner price (the BTW failure). Genuinely never-ordered signals fall through to the
    // unchanged paper path. Default OFF → exact legacy behaviour, zero effect. Reversible by flag.
    if (require('./unifiedBrain').flagEnabled()) {
      let _ubTrades = {}; try { _ubTrades = store.read('trades', {}) || {}; } catch (_e) {}
      const _ub = require('./unifiedBrain').unifiedTick(s, _ubTrades, price, now);
      if (_ub.handled) { changed = true; continue; }
    }
    // === end UNIFIED BRAIN =====================================================================
    const _live = liveStateAuthority(s, settings, now);
    let _liveResting = false; // fix49h: true = real GTC limit resting unfilled on Bybit
    if (_live) {
      if (_live.kind === 'ACTIVE') {
        if (s.paperState !== 'PAPER_ACTIVE') {
          // fixABANDON: if paper had wrongly killed this pre-fill, it left a bogus closedAt behind.
          // Clear it — this position is OPEN on Bybit and is very much not closed.
          const _wasPaperLie = PAPER_PREFILL_FINALS.has(s.paperState);
          if (_wasPaperLie) { s.closedAt = null; s.liveResolved = false; }
          s.paperState = 'PAPER_ACTIVE';
          s.status = 'ACTIVE';
          s.displayState = 'PAPER_ACTIVE';
          s.positionStatus = 'OPEN';
          s.entryHit = true;
          if (!s.openedAt) s.openedAt = now;
          if (typeof initActiveDiagnostics === 'function') { try { initActiveDiagnostics(s, price, num(s.atr), now, settings); } catch (_e) {} }
          s.stateReason = `${V4_VERSION}: LIVE — Bybit position OPEN (authority lock)${_wasPaperLie ? ' [RECLAIMED from a wrong paper kill]' : ''}`;
          appendSignalDiagnostic(_wasPaperLie ? 'LIVE_LOCK_RECLAIMED' : 'LIVE_LOCK_ACTIVE', s, { prevState, price, tradeId: s.tradeId }, settings);
          changed = true;
        }
        continue; // locked to Bybit; skip all paper logic
      }
      if (_live.kind === 'WAITING') {
        // fix49h(H1): the resting order NO LONGER blocks pre-entry safety checks. 49e/49g hard-
        // `continue`d here, which meant SL-breach invalidation, hard-cap expiry and adaptive
        // re-validation NEVER ran for a signal with a resting limit — the order sat on Bybit while
        // structure broke, then filled on the retrace into a dead setup (2 of 6 live losses, 06/10).
        // New contract for a resting live order:
        //   - paper pre-entry KILL paths run normally; each flags the trade → reconciler cancels
        //   - paper ACTIVATION is forbidden (see _liveResting gate at the activation site):
        //     ACTIVE must mean a real Bybit fill, never a paper guess. Kills the
        //     "Orayan ACTIVE / Bybit never filled" divergence and live missed-move fiction.
        _liveResting = true;
        if (s.paperState !== 'WAITING_ENTRY' && s.paperState !== 'WAITING_REACTION') {
          // e.g. paper self-activated before the order filled (49d-class desync) → demote
          s.paperState = 'WAITING_ENTRY';
          s.displayState = 'WAITING_ENTRY';
          s.status = 'DETECTED';
          s.positionStatus = 'NONE';
          s.stateReason = `${V4_VERSION}: LIVE — Bybit order resting/unfilled (demoted to WAITING; fill decides ACTIVE)`;
          appendSignalDiagnostic('LIVE_LOCK_WAITING', s, { prevState, price, tradeId: s.tradeId }, settings);
          changed = true;
        }
        // fall through — expiry / invalidation / re-validation below stay armed
      } else if (_live.kind === 'CLOSED') {
        // fixABANDON (layer 3): was guarded by `!FINAL_STATES.has(s.paperState)` — so if paper had
        // already (wrongly) stamped EXPIRED/STALE_CANCELLED pre-fill, Bybit's REAL close was thrown
        // away and the trade vanished from the ledger with 0 P&L. Bybit truth now overwrites a paper
        // pre-fill kill. A real booked outcome (TP_HIT/SL_HIT) is still never overwritten.
        if (!FINAL_STATES.has(s.paperState) || PAPER_PREFILL_FINALS.has(s.paperState)) {
          if (typeof finalizeActiveDiagnostics === 'function') { try { finalizeActiveDiagnostics(s, now); } catch (_e) {} }
          const _wasPaperLie = PAPER_PREFILL_FINALS.has(s.paperState);
          s.paperState = _live.finalState;       // TP_HIT or SL_HIT (by real P&L sign)
          s.displayState = _live.finalState;
          s.status = _live.result;               // WIN / LOSS
          s.positionStatus = 'CLOSED';
          s.closedAt = now;
          if (_live.exitPx) s.exitPx = roundPrice(_live.exitPx);
          s.realizedPnl = Number(num(_live.realPnl).toFixed(4)); // Bybit's REAL closed P&L
          s.liveResolved = true;                 // fixABANDON: Bybit's verdict is booked — stop reclaiming
          s.stateReason = `${V4_VERSION}: LIVE — Bybit position CLOSED, real P&L ${s.realizedPnl >= 0 ? '+' : ''}${s.realizedPnl}${_wasPaperLie ? ' [RECLAIMED: paper had wrongly killed this pre-fill]' : ''}`;
          const liveCloseDiag = { at: now, state: _live.finalState, reason: s.stateReason, price, exitPx: s.exitPx, realizedPnl: s.realizedPnl, source: 'BYBIT_CLOSED_PNL', reclaimed: _wasPaperLie };
          s.history = [...(s.history || []), liveCloseDiag];
          s.closeDiagnostic = liveCloseDiag;
          appendDiagnosticJournal({ at: now, iso: new Date(now).toISOString(), type: 'TRADE_CLOSED', version: V4_VERSION, symbol: s.sym || s.symbol, side: s.side, result: s.status, realizedPnl: s.realizedPnl, close: liveCloseDiag, signal: normalizeLedgerTrade(s) }, settings);
          appendSignalDiagnostic(_wasPaperLie ? 'LIVE_CLOSE_RECLAIMED' : 'LIVE_CLOSE_REAL_PNL', s, { prevState, price, realPnl: s.realizedPnl, tradeId: s.tradeId }, settings);
          changed = true;
        }
        continue;
      } else if (_live.kind === 'CANCELLED') {
        if (!FINAL_STATES.has(s.paperState) || PAPER_PREFILL_FINALS.has(s.paperState)) {
          s.paperState = 'STALE_CANCELLED';
          s.displayState = 'STALE_CANCELLED';
          s.status = 'STALE';
          s.positionStatus = 'NONE';
          s.liveResolved = true;                 // fixABANDON: order is genuinely gone — stop reclaiming
          s.stateReason = `${V4_VERSION}: LIVE — Bybit order cancelled/rejected (no position)`;
          appendSignalDiagnostic('LIVE_LOCK_CANCELLED', s, { prevState, price, tradeId: s.tradeId }, settings);
          changed = true;
        }
        continue;
      }
    }

    // fixABANDON (layer 2, cont.): a signal that is paper-FINAL only got this far as a RECLAIM pass —
    // to give Bybit authority a chance to overturn a wrong pre-fill kill. If authority did not take
    // it above (no trade record yet, or the order is still resting), we stop here. Paper logic must
    // never re-run on a final signal: that would resurrect expired setups and re-arm entry/exit
    // checks on a dead row. This `continue` is what keeps the reclaim strictly read-only for paper.
    if (_finalNow) continue;

    // fix48g: TIME-BASED EXPIRY runs BEFORE the price guard.
    // Bug: a WAITING signal whose symbol has no price in priceMap (illiquid/delisted pair) hit
    // `if(!price) continue` below and skipped the 45-min hard cap entirely — sitting for HOURS
    // (PLAYSOUT observed at 388 min). Age needs no price. Expire stale waiting setups here first.
    if (s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION' || s.paperState === 'CANDIDATE') {
      const _ageNoPrice = now - signalBirthMs(s); // fix48l: immutable birth epoch, not createdAt||updatedAt (updatedAt bumps every scan → zombie)
      const _capNoPrice = Math.min(num(s.expireMs, expiryMsFor(settings)), WAITING_HARD_CAP_MS);
      if (_ageNoPrice > _capNoPrice) {
        s.paperState = 'EXPIRED';
        s.status = 'EXPIRED';
        s.displayState = 'EXPIRED';
        s.positionStatus = 'NONE';
        s.closedAt = now;
        s.updatedAt = now;
        s.stateReason = `${V4_VERSION}: waiting setup expired at ${Math.round(_ageNoPrice/60000)}min (cap ${Math.round(_capNoPrice/60000)}min)${price ? '' : ' — no live price feed'}`;
        s.history = [...(s.history || []), { at: now, state: 'EXPIRED', reason: s.stateReason }];
        flagTradeForCancel(s, 'EXPIRED_PRE_FILL'); // fix49h(H1): was the missing cancel — 49c's flag lived only in the unreachable second expiry block
        changed = true;
        continue;
      }
    }

    // fix73: DEAD-HOUR PENDING PURGE. Runs unconditionally for every pending signal on every tick
    // while inside a dead window — deliberately BEFORE the `if (!price) continue` guard below, so a
    // symbol with no live price still gets purged (age-based expiry above has the same ordering for
    // the same reason). Distinct from the fill-time-only DEAD_HOUR_BLOCK further down: that one only
    // fires when a signal's OWN entry condition is met at that instant, which is why pending signals
    // used to sit visibly in WAITING_ENTRY/WAITING_REACTION for the whole window before this fix —
    // exactly what showed up as "signals tab populated during dead hours." This clears them all at
    // the moment the window opens (or the moment a signal is born inside an already-open window, as
    // a backstop behind the birth-time blocks in shouldReject/ingestCandidate).
    // SAFETY: identical no-live-order guard as DEAD_HOUR_BLOCK — never touches a signal carrying a
    // resting GTC limit or an open Bybit position; that's a live-only follow-up, out of scope here.
    if ((s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION' || s.paperState === 'CANDIDATE') && isDeadHourLK(now) && !s.tradeId && !s.liveOrderId) {
      s.paperState = 'EXPIRED';
      s.displayState = 'EXPIRED';
      s.status = 'EXPIRED';
      s.positionStatus = 'NONE';
      s.entryHit = false;
      s.closedAt = now;
      s.updatedAt = now;
      s.stateReason = `${V4_VERSION}: DEAD_HOUR_PENDING_PURGE — cancelled inside ${deadHourLabel()} dead window (no fill)`;
      s.history = [...(s.history || []), { at: now, state: 'EXPIRED', reason: s.stateReason, price: price || null }];
      flagTradeForCancel(s, 'DEAD_HOUR_PENDING_PURGE');
      appendSignalDiagnostic('DEAD_HOUR_PENDING_PURGE', s, { prevState, price: price || null, lkMinute: lkMinuteOfDay(now), window: deadHourLabel() }, settings);
      changed = true;
      continue;
    }

    if (!price) continue;

    s.backendLastPrice = roundPrice(price);
    s.updatedAt = now;

    const entry = num(s.entry), sl = num(s.sl);
    const side = s.side;
    const age = now - signalBirthMs(s); // fix48l: immutable birth epoch (was num(s.createdAt, now) — missing createdAt made age=0, dodging cap)
    const atr = num(s.planner?.keyLevels?.atr, Math.abs(entry - sl));

    if (s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION' || s.paperState === 'CANDIDATE') {
      // fixFLIP: failed-rejection squeeze → flip to opposite-side limit-retest BEFORE the SL-breach
      // invalidation below. Pre-fill only (no position, no loss). Parent → terminal CONTRARIAN_FLIP,
      // resting order cancelled; child is a fresh WAITING_ENTRY appended after the loop. Flag-gated.
      if (FLIP_ENABLED && FLIP_WAITING && !s.flippedOnce) {
        const _flipChild = buildFlipChild(s, market, price, now, settings);
        if (_flipChild) {
          s.paperState = 'CONTRARIAN_FLIP';
          s.status = 'CONTRARIAN_FLIP';
          s.displayState = 'CONTRARIAN_FLIP';
          s.positionStatus = 'NONE';
          s.closedAt = now;
          s.stateReason = `${V4_VERSION}: flipped ${s.side}→${_flipChild.side} (${_flipChild.flipReason}) — retest child ${_flipChild.id}`;
          s.history = [...(s.history || []), { at: now, state: 'CONTRARIAN_FLIP', reason: s.stateReason, price }];
          appendSignalDiagnostic('SIGNAL_CONTRARIAN_FLIP', s, { prevState, ageMs: age, price, flip: _flipChild.flipMeta }, settings);
          flagTradeForCancel(s, 'CONTRARIAN_FLIP'); // pull any resting limit on the abandoned side
          addLog('CONTRARIAN_FLIP', `${s.sym} ${s.side}→${_flipChild.side} ${_flipChild.flipReason} entry=${_flipChild.entry} sl=${_flipChild.sl} tp=${_flipChild.tp1} rr=${_flipChild.rr} composite=${_flipChild.flipMeta.sentinelComposite}`);
          _flipChildren.push(_flipChild);
          changed = true;
          continue;
        }
      }
      // fix48d (item 3): hard cap on waiting time. min(expireMs, WAITING_HARD_CAP_MS) — the cap always wins.
      // A setup sitting longer than the cap has lost the structure that justified it; force-expire.
      const _effectiveExpiry = Math.min(num(s.expireMs, expiryMsFor(settings)), WAITING_HARD_CAP_MS);
      if (age > _effectiveExpiry) {
        const _hitHardCap = age > WAITING_HARD_CAP_MS && WAITING_HARD_CAP_MS <= num(s.expireMs, expiryMsFor(settings));
        s.paperState = 'EXPIRED';
        s.status = 'EXPIRED';
        s.displayState = 'EXPIRED';
        s.positionStatus = 'NONE';
        s.closedAt = now;
        s.stateReason = _hitHardCap
          ? `${V4_VERSION}: setup hit ${Math.round(WAITING_HARD_CAP_MS/60000)}min waiting hard-cap before entry confirmation`
          : `${V4_VERSION}: setup expired before entry confirmation`;
        s.history = [...(s.history || []), { at: now, state: 'EXPIRED', reason: s.stateReason }];
        appendSignalDiagnostic('SIGNAL_EXPIRED', s, { prevState, ageMs: age, price }, settings);
        flagTradeForCancel(s, 'EXPIRED_HARD_CAP'); // fix49h(H1): unified cancel flag — order must not fill into dead setup
        changed = true;
        continue;
      }
      if (side === 'BUY' && price <= sl) {
        s.paperState = 'INVALIDATED';
        s.status = 'INVALID';
        s.displayState = 'INVALIDATED';
        s.positionStatus = 'NONE';
        s.closedAt = now;
        s.stateReason = `${V4_VERSION}: structure broke before entry`;
        s.history = [...(s.history || []), { at: now, state: 'INVALIDATED', reason: s.stateReason, price }];
        appendSignalDiagnostic('SIGNAL_INVALIDATED', s, { prevState, ageMs: age, price }, settings);
        flagTradeForCancel(s, 'STRUCTURE_BROKE_PRE_FILL'); // fix49h(H1): reconciler now honors this for PENDING orders too
        changed = true;
        continue;
      }
      if (side === 'SELL' && price >= sl) {
        s.paperState = 'INVALIDATED';
        s.status = 'INVALID';
        s.displayState = 'INVALIDATED';
        s.positionStatus = 'NONE';
        s.closedAt = now;
        s.stateReason = `${V4_VERSION}: structure broke before entry`;
        s.history = [...(s.history || []), { at: now, state: 'INVALIDATED', reason: s.stateReason, price }];
        appendSignalDiagnostic('SIGNAL_INVALIDATED', s, { prevState, ageMs: age, price }, settings);
        flagTradeForCancel(s, 'STRUCTURE_BROKE_PRE_FILL'); // fix49h(H1): reconciler now honors this for PENDING orders too
        changed = true;
        continue;
      }
      // fix48e: ADAPTIVE RE-VALIDATION — re-check the live market thesis before allowing fill.
      // Runs every tick while waiting. Abandons dead setups, freezes hostile-but-recoverable ones.
      const reval = revalidateWaitingSignal(s, market, price, now);
      if (reval.action === 'ABANDON') {
        s.paperState = 'STALE_CANCELLED';
        s.status = 'STALE_CANCELLED';
        s.displayState = 'STALE_CANCELLED';
        s.positionStatus = 'NONE';
        s.closedAt = now;
        s.stateReason = `${V4_VERSION}: setup cancelled — ${reval.reason}`;
        s.history = [...(s.history || []), { at: now, state: 'STALE_CANCELLED', reason: s.stateReason, price }];
        appendSignalDiagnostic('SIGNAL_STALE_CANCELLED', s, { prevState, ageMs: age, price, reval }, settings);
        flagTradeForCancel(s, 'REVALIDATION_ABANDON'); // fix49h(H1): mirror the invalidation cancel path — pending live order is pulled
        changed = true;
        continue;
      }
      if (reval.action === 'FREEZE') {
        // keep waiting; record why we held the fill this tick, but do NOT activate
        s.revalFrozen = true;
        s.revalFreezeReason = reval.reason;
        s.revalFreezeCount = num(s.revalFreezeCount, 0) + 1;
        if (s.paperState !== 'WAITING_ENTRY') changed = true;
        s.paperState = 'WAITING_ENTRY';
        s.displayState = 'WAITING_ENTRY';
        s.status = 'DETECTED';
        s.positionStatus = 'NONE';
        s.stateReason = `${V4_VERSION}: fill held — ${reval.reason}`;
        continue;
      }
      if (s.revalFrozen) { s.revalFrozen = false; s.revalFreezeReason = null; } // momentum/vol recovered
      const timing = signalEntryTiming(s, price, atr, now, settings);
      // fixPHASE1: shadow-only — compares the unified decision engine against what actually happened.
      // Zero effect on the branches below (no mutation, no continue/return, purely a log side-effect).
      try {
        const _p1Verdict = decideLiveEntry(s, market, timing, settings, atr, _p1ActiveCount);
        const _p1ActuallyLive = !!(s.liveOrderId || s.tradeId);
        phase1ShadowTrace(s, _p1Verdict, _p1ActuallyLive);
      } catch (_p1e) { /* shadow only — never let it touch the real tick loop */ }

      // ── fixRETEST (07/26): REST A LIMIT AT THE STRUCTURAL ENTRY ON A GENUINE RETEST ────────────
      // User-directed redesign, replacing the whole day's chase/nudge/stretch patch chain (fixANCHOR,
      // fixANCHORRR, fixRISKCAP widening, the smart-limit nudge) by removing the shared root cause of
      // all of them: acting on a "confirmed" price that's already stale by the time the bot notices it.
      // Instead: plan the entry, wait for a GENUINE retest (price touched the zone once, LEFT, and is
      // coming back — s.hadFirstTouch, the same "second touch = higher conviction" evidence fix44f
      // already computes for paper), and rest a GTC LIMIT at the exact structural signal.entry via
      // placeLimitAtEntry (dormant since hotfix21b, fully intact, never modified). Bybit fills it the
      // instant price actually reaches that price — zero latency, zero chase, zero nudge: the fill
      // price IS the planned price by construction, so RR cannot shrink no matter how long the retest
      // takes to arrive. This fires INDEPENDENTLY of `timing.directional`/the fixHOLD 40s hold-timer —
      // that gate answers "has price already bounced AND held," which is for CONFIRMING a fill after
      // the fact, not for PLACING an order that waits for the touch itself; requiring it here would
      // just reintroduce the same stale-by-the-time-we-notice lag. Deliberately EXCLUDES missed-move-
      // breakout (timing.missedMove) — there is no retest to rest a limit at when price ran away with
      // no pullback, and missed-move was the single biggest source of today's chase-driven RR damage
      // (ORDIUSDT/LAUSDT/1000BONKUSDT/BEATUSDT/EULUSDT/VVVUSDT all trace to it); paper still simulates
      // missed-move for comparison, live simply never trades it now.
      // Fires once per signal (same _autoTraded/liveOrderId/tradeId latch every other live hook uses).
      // Placement itself needs no new safety net: revalidateWaitingSignal() ran just above this tick
      // (ABANDON/FREEZE both `continue` before reaching here), so we only ever arm on a thesis that's
      // currently OK. BABYSITTING an already-placed resting order (cancel if structure breaks before
      // fill) is likewise NOT new logic: the SL-breach invalidation + revalidateWaitingSignal both
      // already run every tick for ANY waiting signal whether or not it carries a live order, and
      // flagTradeForCancel()/the reconciler already honour cancellation for a resting PENDING order
      // (fix49h(H1), unmodified). A dedicated tighter (10s) watch specifically for signals with a
      // resting order out is added separately — restingOrderWatch(), see near fastSyncOnce below —
      // running these SAME two checks on a faster cadence, per explicit user request.
      // fixKNIFEGUARD: last completed 1m candle (already fetched for this symbol by
      // enrichOpenSignalMarketMap, zero new I/O). If it's a large candle printing hard AGAINST the trade
      // direction, the retest is arriving on a knife, not a bounce — withhold this tick, re-check next tick.
      const _kCandle = market && market.candle;
      let _knifeBlocked = false, _knifeReason = '';
      if (KNIFE_BODY_ATR > 0 && _kCandle && atr > 0) {
        const _body = num(_kCandle.close) - num(_kCandle.open);
        const _bodyAtr = Math.abs(_body) / atr;
        if (s.side === 'BUY' && _body < 0 && _bodyAtr >= KNIFE_BODY_ATR) {
          _knifeBlocked = true;
          _knifeReason = `last 1m candle bearish ${_bodyAtr.toFixed(2)}ATR against BUY`;
        } else if (s.side === 'SELL' && _body > 0 && _bodyAtr >= KNIFE_BODY_ATR) {
          _knifeBlocked = true;
          _knifeReason = `last 1m candle bullish ${_bodyAtr.toFixed(2)}ATR against SELL`;
        }
      }
      if (settings.botMode === 'LIVE_REAL_BYBIT' && settings.tradingEnabled && s.hadFirstTouch &&
          !timing.missedMove && !s._autoTraded && !s.liveOrderId && !s.tradeId && _knifeBlocked) {
        if (!s._knifeGuardLogged || now - num(s._knifeGuardLoggedAt, 0) > 30000) {
          s._knifeGuardLogged = true;
          s._knifeGuardLoggedAt = now;
          addLog('KNIFE_GUARD_HOLD', `${s.symbol} ${s.side} retest withheld — ${_knifeReason}`);
        }
        phase0Trace(s, 'WITHHELD_KNIFE_RETEST', { knife: 'withheld' });
      } else if (settings.botMode === 'LIVE_REAL_BYBIT' && settings.tradingEnabled && s.hadFirstTouch &&
          !timing.missedMove && !s._autoTraded && !s.liveOrderId && !s.tradeId) {
        const { placeLimitAtEntry: _placeLimitRetest, activeTrades: _atRetest } = require('./executor');
        if (sentinelBlind()) {
          addLog('LIVE_BLIND_SKIP', `${s.symbol} ${s.side} — sentinel blind >10min, resting limit withheld`);
          phase0Trace(s, 'SKIPPED_SENTINEL_BLIND_RETEST', { knife: 'ok', sentinel: 'blind' });
        } else if (_atRetest().length >= (settings.maxOpenTrades || 3)) {
          addLog('LIMIT_SKIPPED', `${s.symbol} ${s.side} — maxOpenTrades reached`);
          phase0Trace(s, 'SKIPPED_MAXOPEN_RETEST', { knife: 'ok', sentinel: 'ok', maxOpen: 'reached' });
        } else {
          phase0Trace(s, 'PLACED_RETEST_LIMIT', { knife: 'ok', sentinel: 'ok', maxOpen: 'ok' });
          s._autoTraded = true; // latch synchronously — the call below is async, next tick must not double-fire
          changed = true; // flush the latch to disk THIS tick — without this, saveSignals may be skipped
                           // (it's conditional on `changed`), leaving _autoTraded unpersisted and risking a
                           // next-tick retry before the async placement below resolves. placeLimitAtEntry's
                           // own orderLinkId idempotency would no-op a genuine duplicate harmlessly either
                           // way, but this makes it correct by design rather than by that safety net alone.
          _placeLimitRetest({ ...s, plan: s.plan || { entry: s.entry, sl: s.sl, tp1: s.tp1 }, leverage: settings.leverage || 5, margin: settings.maxTradeUsdt || 5 }, { settings })
            .then(r => {
              if (r && r.ok) {
                const sigs = getSignals(); const idx = sigs.findIndex(x => x.id === s.id);
                if (idx >= 0) { sigs[idx].liveOrderId = r.orderId; sigs[idx].tradeId = r.tradeId; sigs[idx].orderStatus = 'LIMIT_WAITING'; saveSignals(sigs); }
                addLog('LIMIT_PLACED_RETEST', `${s.symbol} ${s.side} GTC limit @ ${s.entry} (genuine retest confirmed)`, { orderId: r.orderId, tradeId: r.tradeId });
              } else if (!r?.skipped) {
                s._autoTraded = false; // placement failed — allow a retry on a later tick
                addLog('LIMIT_PLACE_FAILED', `${s.symbol} ${s.side}: ${r?.error || 'unknown'}`);
              }
            })
            .catch(e => { s._autoTraded = false; addLog('LIMIT_PLACE_ERROR', `${s.symbol} ${s.side}: ${e.message}`); });
        }
      }

      if (timing.inZone && timing.directional) {
        // fix49h(H1): ACTIVE must mean FILLED. A real GTC limit is resting at entry on Bybit —
        // the exchange decides the fill, not paper timing. Without this gate, missed-move and
        // zone-touch activation marked signals ACTIVE that Bybit never filled (paper booked
        // fictional wins while only the reversals filled — the 06/10 paper 3W/5L vs live 1W/6L gap).
        // Safety checks above (SL-breach, expiry, re-validation) already ran this tick; we only
        // withhold the paper ACTIVATION. Bybit fill → liveStateAuthority promotes to ACTIVE.
        if (_liveResting) {
          if (s.paperState !== 'WAITING_ENTRY' && s.paperState !== 'WAITING_REACTION') changed = true;
          if (s.paperState !== 'WAITING_REACTION') s.paperState = 'WAITING_ENTRY';
          s.displayState = s.paperState;
          s.status = 'DETECTED';
          s.positionStatus = 'NONE';
          s.stateReason = `${V4_VERSION}: paper timing ready (${timing.missedMove ? 'missed-move' : 'zone confirm'}) but Bybit limit unfilled — activation deferred to real fill`;
          if (!s._deferLogged) {
            s._deferLogged = true; // latch — missed-move can hold true for many ticks; log the episode once
            appendSignalDiagnostic('LIVE_ACTIVATION_DEFERRED', s, { prevState, price, timing, tradeId: s.tradeId }, settings);
          }
          continue;
        }
        // fix48d (item 5): compute and PERSIST the entry timing score at the moment of activation.
        // fix48c left entryTimingScore as NaN/blank for most rows — no data for analysis.
        const _activationTimingScore = deriveEntryTimingScore(
          { scoreInfo: s.scoreInfo || s.scoring, scoring: s.scoring || s.scoreInfo, price, plan: s.plan || { entry: s.entry }, entry: s.entry, risks: s.risks },
          timing
        );
        // fix48d (item 4): ENTRY_TIMING == 100 means price is being chased at the extreme of the move
        // (max zone-touch + inZone + directional bonuses all stacked) — a momentum chase, not a pullback entry.
        // Instead of activating into it, revert to WAITING_ENTRY and let it re-confirm on a genuine pullback.
        // The hard-cap (item 3) still governs total waiting time, so it cannot loop forever.
        if (_activationTimingScore >= 100) {
          if (s.paperState !== 'WAITING_ENTRY') changed = true;
          s.paperState = 'WAITING_ENTRY';
          s.displayState = 'WAITING_ENTRY';
          s.status = 'DETECTED';
          s.positionStatus = 'NONE';
          s.entryTimingScore = _activationTimingScore; // still persist the observed score
          s.timingRevertCount = num(s.timingRevertCount, 0) + 1;
          s.stateReason = `${V4_VERSION}: ENTRY_TIMING=100 (momentum chase) — reverted to WAITING_ENTRY, awaiting pullback re-confirm`;
          appendSignalDiagnostic('ENTRY_TIMING_MAX_REVERT', s, { prevState, price, timing, timingScore: _activationTimingScore }, settings);
          continue;
        }
        // fix48k: ENTRY_TIMING_TOO_HIGH block. Across N=193 terminal trades (two-tier, regime-robust,
        // best-hour-stripped) entryTimingScore buckets were: 16=75%WR, 22=59%, 28=65%, 36=67% (all net +),
        // but 44=33%WR (-1.18U) and 52=25%WR (-0.30U). The >=44 band is a consistent, twice-confirmed
        // (N=113 and N=193) net-negative cohort — late confirmations that are past the clean pullback zone
        // but below the =100 chase extreme. Block activation; let the hard cap expire it if it never improves.
        // Tunable/disable-able via env without a redeploy of logic: V4_TIMING_BLOCK_THRESHOLD (default 44; set 999 to disable).
        const _timingBlockAt = Math.max(1, Number(process.env.V4_TIMING_BLOCK_THRESHOLD || '44'));
        if (_activationTimingScore >= _timingBlockAt) {
          if (s.paperState !== 'WAITING_ENTRY') changed = true;
          s.paperState = 'WAITING_ENTRY';
          s.displayState = 'WAITING_ENTRY';
          s.status = 'DETECTED';
          s.positionStatus = 'NONE';
          s.entryTimingScore = _activationTimingScore;
          s.stateReason = `${V4_VERSION}: ENTRY_TIMING=${_activationTimingScore} >= ${_timingBlockAt} (late-confirm net-negative band) — held in WAITING, not activated`;
          appendSignalDiagnostic('ENTRY_TIMING_TOO_HIGH', s, { prevState, price, timing, timingScore: _activationTimingScore, threshold: _timingBlockAt }, settings);
          continue;
        }
        // fix52: DEAD-HOUR FILL BLOCK. Entry conditions are met at THIS instant — gating here (not at
        // signal creation) is the whole point: it kills exactly the in-window fills the old creation-
        // time block leaked. Per spec the period is fully dead — a setup reaching entry inside the
        // window is killed (EXPIRED), not held. Side-agnostic ⇒ symmetric.
        // SAFETY: only fire on paper signals with NO live order attached (no tradeId / no liveOrderId).
        // A signal carrying a resting GTC limit must never be silently EXPIRED here (it would orphan a
        // real order); truly deading LIVE hours needs resting-order cancellation on window entry —
        // flagged as a separate live-only follow-up, out of scope for this paper-focused fix.
        if (isDeadHourLK(now) && !s.tradeId && !s.liveOrderId) {
          if (s.paperState !== 'EXPIRED') changed = true;
          s.paperState = 'EXPIRED';
          s.displayState = 'EXPIRED';
          s.status = 'EXPIRED';
          s.positionStatus = 'NONE';
          s.entryHit = false;
          s.closedAt = now;
          s.updatedAt = now;
          s.stateReason = `${V4_VERSION}: DEAD_HOUR_BLOCK — entry reached inside ${deadHourLabel()} dead window; killed (no fill)`;
          s.history = [...(s.history || []), { at: now, state: 'EXPIRED', reason: s.stateReason, price }];
          appendSignalDiagnostic('DEAD_HOUR_BLOCK', s, { prevState, price, lkMinute: lkMinuteOfDay(now), window: deadHourLabel() }, settings);
          continue;
        }
        // fix53: BREADTH-VOLATILITY CIRCUIT BREAKER — pause NEW fills (both sides) while breadth is
        // whipsawing. Unlike dead-hours we do NOT kill the setup: the structure may still be valid once
        // chop clears, so HOLD in WAITING_ENTRY (the WAITING hard-cap will reap anything that goes stale).
        // Paper-only guard so a resting live order is never stranded mid-window.
        if (breadthChopActive(now, settings) && !s.tradeId && !s.liveOrderId) {
          const _chop = breadthChop(settings);
          if (s.paperState !== 'WAITING_ENTRY') changed = true;
          s.paperState = 'WAITING_ENTRY';
          s.displayState = 'WAITING_ENTRY';
          s.status = 'DETECTED';
          s.positionStatus = 'NONE';
          s.entryHit = false;
          s.updatedAt = now;
          s.stateReason = `${V4_VERSION}: BREADTH_CHOP_HOLD — 60m breadth range ${_chop.range} ≥ ${_chop.threshold}; entries paused both sides until breadth restabilises`;
          appendSignalDiagnostic('BREADTH_CHOP_HOLD', s, { prevState, price, range: _chop.range, hi: _chop.hi, lo: _chop.lo, threshold: _chop.threshold, samples: _chop.samples }, settings);
          continue;
        }
        // ── fix57: LIVE-MODE FILL AUTHORITY ──────────────────────────────────────────────────
        // In LIVE mode, ACTIVE must mean a CONFIRMED Bybit fill — never a paper price-touch. The old
        // path committed PAPER_ACTIVE here synchronously, THEN fired the order async; if placement
        // failed/skipped (reject, maxOpen, or fix56's dedup guard), tradeId never got set and the
        // signal was stranded PAPER_ACTIVE with fabricated paper P&L and no Bybit order — the SNDK
        // ghost / CLO "active but resting" / LIT "profit but unfilled" divergences. Now: place the
        // order once and HOLD the signal pending-fill; liveStateAuthority (Bybit truth) promotes it
        // to ACTIVE only when a real position exists. NON-DESTRUCTIVE — places nothing extra, cancels
        // and closes nothing (the reconciler still owns those). Reversible: V4_LIVE_ACTIVATION_BYBIT_ONLY=false.
        const _liveMode57 = settings.botMode === 'LIVE_REAL_BYBIT' && settings.tradingEnabled;
        if (_liveMode57 && String(process.env.V4_LIVE_ACTIVATION_BYBIT_ONLY || 'true').toLowerCase() !== 'false') {
          // fixRETEST: in the normal case the resting limit was already placed above the moment
          // hadFirstTouch flipped true, so !s.liveOrderId is already false by the time directional
          // confirms and this never fires. Kept as a defense-in-depth backstop (e.g. a first touch
          // that confirms directional without ever leaving the zone once — no retest ever happened)
          // gated on the SAME hadFirstTouch/!missedMove rule so it can never fire on exactly the two
          // patterns fixRETEST was built to stop trading live.
          if (!s._autoTraded && !s.liveOrderId && !s.tradeId && s.hadFirstTouch && !timing.missedMove) {
            const { activeTrades: _activeTrades57 } = require('./executor');
            const _liveCount57 = _activeTrades57().length;
            if (_liveCount57 >= (settings.maxOpenTrades || 3)) {
              addLog('LIVE_SKIPPED', `${s.symbol} ${s.side} — maxOpenTrades reached (${_liveCount57})`);
              phase0Trace(s, 'SKIPPED_MAXOPEN_BACKSTOP', { knife: 'n/a', sentinel: 'n/a', maxOpen: 'reached' });
            } else if (sentinelBlind()) {
              // fixENFORCE circuit breaker: no fresh market view for >10min — no NEW live orders.
              // Signal goes REJECTED (visible, zero fake P&L) instead of silently simulating.
              addLog('LIVE_BLIND_SKIP', `${s.symbol} ${s.side} — sentinel blind >10min, live order withheld`);
              markSignalRejected(s.id, 'SENTINEL_BLIND: no fresh market view for >10min — live order withheld', false);
              phase0Trace(s, 'SKIPPED_SENTINEL_BLIND_BACKSTOP', { knife: 'n/a', sentinel: 'blind', maxOpen: 'ok' });
            } else {
              phase0Trace(s, 'LIVE_ORDER_ATTEMPTED_BACKSTOP', { knife: 'n/a', sentinel: 'ok', maxOpen: 'ok' });
              s._autoTraded = true;
              require('./executor').executeSignal({ ...s, plan: s.plan || { entry: s.entry, sl: s.sl, tp1: s.tp1 }, leverage: settings.leverage || 5, margin: settings.maxTradeUsdt || 5 }, { settings, forceMarket: FIXCONFIRM_ENTRY_MARKET })
                .then(r => {
                  if (r && r.ok) {
                    const sigs = getSignals(); const idx = sigs.findIndex(x => x.id === s.id);
                    if (idx >= 0) { sigs[idx].orderId = r.orderId; sigs[idx].tradeId = r.tradeId; sigs[idx].orderStatus = 'SENT_LIVE'; saveSignals(sigs); }
                    addLog('LIVE_PLACED', `${s.symbol} ${s.side} order placed`, { orderId: r.orderId, tradeId: r.tradeId });
                  } else {
                    addLog('LIVE_REJECTED', `${s.symbol} ${s.side} order not placed`, { reason: r?.error || 'unknown', skipped: !!(r && r.skipped) });
                    markSignalRejected(s.id, r?.error, !!(r && r.permanentBlock)); // fixREJSTATE
                  }
                })
                .catch(e => { addLog('LIVE_ERROR', `${s.symbol} ${s.side} executor error: ${e.message}`); markSignalRejected(s.id, e.message, false); });
            }
          }
          // hold pending-fill — NOT active, no paper P&L. liveStateAuthority promotes on a real fill.
          if (s.paperState !== 'WAITING_ENTRY' || s.displayState !== 'LIVE_PENDING_FILL') {
            s.paperState = 'WAITING_ENTRY';
            s.status = 'DETECTED';
            s.displayState = 'LIVE_PENDING_FILL';
            s.positionStatus = 'NONE';
            s.entryHit = false;
            s.stateReason = s.liveOrderId
              ? `${V4_VERSION}: LIVE — entry reached, order working on Bybit; ACTIVE only on confirmed fill`
              : `${V4_VERSION}: LIVE — confirmed but withheld (${timing.missedMove ? 'missed-move, not traded live' : 'awaiting genuine retest — first touch only, no resting order'}); no live order placed`;
            s.history = [...(s.history || []), { at: now, state: 'LIVE_PENDING_FILL', reason: s.stateReason, price }];
            appendSignalDiagnostic('LIVE_PENDING_FILL', s, { prevState, price, tradeId: s.tradeId || null }, settings);
            changed = true;
          }
          continue; // liveStateAuthority owns promotion to ACTIVE
        }
        s.paperState = 'PAPER_ACTIVE';
        s.status = 'ACTIVE';
        s.displayState = 'PAPER_ACTIVE';
        s.positionStatus = 'PAPER';
        s.entryHit = true;
        s.openedAt = now;
        s.entryTimingScore = _activationTimingScore; // fix48d (item 5): real value, every activated trade
        // fix48d: initialise rich excursion/regime path tracking for adaptive analysis (no gating)
        initActiveDiagnostics(s, price, atr, now, settings);
        s.stateReason = `${V4_VERSION}: ` + timing.reason;
        s.history = [...(s.history || []), { at: now, state: 'PAPER_ACTIVE', reason: s.stateReason, price }];
        appendSignalDiagnostic('TRADE_ACTIVATED', s, { prevState, price, timing }, settings);
        changed = true;
        // fixORTRIGGER (4.6.9.1): FARTCOIN/AAVE/NEAR proof (07/29 chat, real ledger evidence, 3 confirmed
        // instances) — paper activates HERE the moment timing.directional confirms, first touch or
        // second, no hadFirstTouch requirement. The live hook right below required s.hadFirstTouch
        // specifically (a genuine SECOND touch) — so a signal confirmed only on its FIRST touch
        // activates on paper and can fully win or lose in simulation, but NEVER gets a live order at
        // any point (the 5661 backstop is deliberately gated on the identical hadFirstTouch rule per
        // its own comment, so it can't rescue this case either — confirmed empty Bybit ledger for all
        // three symbols despite hours elapsed). timing.directional is GUARANTEED true here (that's why
        // this branch is running) and already survived fixHOLD's 40s hold-through-the-window
        // requirement — not a raw wick. The only new safeguard the first-touch-only path needs is the
        // SAME candle-momentum check fixKNIFEGUARD (hotfix 24) already uses at the other live-placement
        // site — reused here rather than invented fresh, so a first touch that's actually a knife still
        // gets withheld exactly like a retest would. The existing hadFirstTouch path is UNCHANGED (no
        // new check added to it, zero behavior change for signals that already reach live today). Order
        // still places as a LIMIT (forceMarket stays FIXCONFIRM_ENTRY_MARKET, currently false) — this
        // does not reintroduce market-chase lag, it only widens WHICH confirmations may place one.
        // Reversible: V4_FIRSTTOUCH_LIVE_ENABLED=false fully restores the old hadFirstTouch-only gate.
        const _firstTouchKnifeOk = (() => {
          const _kC = market && market.candle;
          if (!(KNIFE_BODY_ATR > 0 && _kC && atr > 0)) return true; // fail-open, same convention as fixKNIFEGUARD
          const _b = num(_kC.close) - num(_kC.open);
          const _bAtr = Math.abs(_b) / atr;
          if (s.side === 'BUY'  && _b < 0 && _bAtr >= KNIFE_BODY_ATR) return false;
          if (s.side === 'SELL' && _b > 0 && _bAtr >= KNIFE_BODY_ATR) return false;
          return true;
        })();
        const _liveEntryOk = s.hadFirstTouch || (FIRSTTOUCH_LIVE_ENABLED && _firstTouchKnifeOk);
        if (!s.hadFirstTouch && FIRSTTOUCH_LIVE_ENABLED && !_firstTouchKnifeOk && !s._firstTouchKnifeLogged) {
          s._firstTouchKnifeLogged = true;
          addLog('KNIFE_GUARD_HOLD', `${s.symbol} ${s.side} first-touch live entry withheld — candle against trade direction`);
          phase0Trace(s, 'WITHHELD_KNIFE_FIRSTTOUCH', { knife: 'withheld' });
        }
        // fix44b: live execution hook
        // fix49c: skip if liveOrderId set — GTC limit was already placed at WAITING_ENTRY, no double-execute
        if (settings.botMode === 'LIVE_REAL_BYBIT' && settings.tradingEnabled && !s._autoTraded && !s.liveOrderId && _liveEntryOk && !timing.missedMove) {
          const { activeTrades } = require('./executor');
          // fix44e: use activeTrades() directly — previous filter missed ORDER_SUBMITTED status
          const liveCount = activeTrades().length;
          if (liveCount >= (settings.maxOpenTrades || 3)) {
            addLog('LIVE_SKIPPED', `${s.symbol} ${s.side} — maxOpenTrades reached (${liveCount})`);
            phase0Trace(s, 'SKIPPED_MAXOPEN_MAIN', { knife: 'ok', sentinel: 'n/a', maxOpen: 'reached' });
          } else if (sentinelBlind()) {
            addLog('LIVE_BLIND_SKIP', `${s.symbol} ${s.side} — sentinel blind >10min, live order withheld`); // fixENFORCE
            markSignalRejected(s.id, 'SENTINEL_BLIND: no fresh market view for >10min — live order withheld', false);
            phase0Trace(s, 'SKIPPED_SENTINEL_BLIND_MAIN', { knife: 'ok', sentinel: 'blind', maxOpen: 'ok' });
          } else {
          phase0Trace(s, 'LIVE_ORDER_ATTEMPTED_MAIN', { knife: 'ok', sentinel: 'ok', maxOpen: 'ok' });
          s._autoTraded = true;
          const _executor = require('./executor');
          _executor.executeSignal({ ...s, plan: s.plan || { entry: s.entry, sl: s.sl, tp1: s.tp1 }, leverage: settings.leverage || 5, margin: settings.maxTradeUsdt || 5 }, { settings, forceMarket: FIXCONFIRM_ENTRY_MARKET })
            .then(r => {
              if (r && r.ok) {
                const sigs = getSignals();
                const idx = sigs.findIndex(x => x.id === s.id);
                if (idx >= 0) { sigs[idx].orderId = r.orderId; sigs[idx].tradeId = r.tradeId; sigs[idx].orderStatus = 'SENT_LIVE'; saveSignals(sigs); }
                addLog('LIVE_PLACED', `${s.symbol} ${s.side} order placed`, { orderId: r.orderId, tradeId: r.tradeId });
              } else {
                addLog('LIVE_REJECTED', `${s.symbol} ${s.side} order failed`, { reason: r?.error || 'unknown' });
                markSignalRejected(s.id, r?.error, !!(r && r.permanentBlock)); // fixREJSTATE
              }
            })
            .catch(e => { addLog('LIVE_ERROR', `${s.symbol} ${s.side} executor error: ${e.message}`); markSignalRejected(s.id, e.message, false); });
          } // end else (liveCount check)
        }
      } else if (timing.inZone) {
        if (s.paperState !== 'WAITING_REACTION') changed = true;
        s.paperState = 'WAITING_REACTION';
        s.displayState = 'WAITING_REACTION';
        s.status = 'DETECTED';
        s.positionStatus = 'NONE';
        s.stateReason = `${V4_VERSION}: ` + timing.reason;
        if (prevState !== s.paperState) appendSignalDiagnostic('WAITING_STATE_CHANGED', s, { prevState, price, timing }, settings);
      } else {
        if (s.paperState !== 'WAITING_ENTRY') changed = true;
        s.paperState = 'WAITING_ENTRY';
        s.displayState = 'WAITING_ENTRY';
        s.status = 'DETECTED';
        s.positionStatus = 'NONE';
        s.stateReason = `${V4_VERSION}: ` + timing.reason;
        if (prevState !== s.paperState || timing.expiredWindow) {
          appendSignalDiagnostic(prevState !== s.paperState ? 'WAITING_STATE_CHANGED' : 'ENTRY_CONFIRMATION_RESET', s, { prevState, price, timing }, settings);
        }
      }
      continue;
    }

    if (s.paperState === 'PAPER_ACTIVE') {
      // fix48d: record excursion + regime path on every tick (observability only — no gating)
      trackActiveDiagnostics(s, market, price, now);

      // fix48i: REGIME-FLIP EXIT. The sentinel flagged this open position because BTC regime flipped
      // against its side (e.g. SELL when BEAR→BULL).
      if (s.regimeFlipExit && price) {
        const entryPx = num(s.entry);
        const slDist = Math.abs(entryPx - num(s.sl)) || 1e-9;
        // realised R at the moment of the flip (signed): + if in profit, - if underwater
        const rAtExit = String(s.side).toUpperCase() === 'BUY'
          ? (price - entryPx) / slDist
          : (entryPx - price) / slDist;

        // fix48i-TRAIL: a position already meaningfully in profit (>=0.5R) when the flip hits does NOT
        // need the emergency exit — that protection was built for LOSING/marginal trades bleeding to
        // full SL after a flip (PENGU: 83min, full SL). A winner heading to its real TP doesn't have
        // that risk; force-closing it at market only clips real profit short (BANKUSDT case: +1.03R
        // heading to a 2.27R TP, cut to +0.258U instead of the ~0.567U target). Below 0.5R, or losing,
        // keep the ORIGINAL hard close unchanged — that's the data-validated case this fix protects.
        // Both-sides symmetric (rAtExit sign convention above already mirrors BUY/SELL). Reversible via
        // V4_REGIME_FLIP_TRAIL_MIN_R (default 0.5; set to a huge number to fully restore old behavior).
        if (rAtExit >= REGIME_FLIP_TRAIL_MIN_R) {
          const lockR = REGIME_FLIP_TRAIL_MIN_R; // guarantee at least this much R no matter what happens next
          const isBuy = String(s.side).toUpperCase() === 'BUY';
          const newSl = roundPrice(isBuy ? entryPx + lockR * slDist : entryPx - lockR * slDist);
          // Only ever tighten, never loosen — if a prior trail already locked a better level, keep it.
          const currentlyTighter = isBuy ? (num(s.sl) >= newSl) : (num(s.sl) <= newSl);
          if (!currentlyTighter) {
            s.sl = newSl;
            s.regimeFlipTrail = true;
            s.regimeFlipFrom = s.regimeFlipFrom || null;
            s.regimeFlipTo = s.regimeFlipTo || null;
            s.stateReason = `${V4_VERSION}: regime-flip TRAIL — locked +${lockR}R (sl->${newSl}) instead of closing, rAtExit=${rAtExit.toFixed(2)}R, still targeting original TP`;
            const trailDiag = { at: now, state: 'REGIME_FLIP_TRAIL', reason: s.stateReason, price, newSl, lockR, rAtExit: Number(rAtExit.toFixed(3)) };
            s.history = [...(s.history || []), trailDiag];
            try {
              addLog('REGIME_FLIP_TRAIL', `${s.symbol} ${s.side}: rAtExit=${rAtExit.toFixed(2)}R >= ${lockR}R — SL trailed to ${newSl} instead of closing (was heading to full TP)`);
            } catch (_l) {}
            // If this signal has a live Bybit position, actually move the real stop too — an in-memory
            // sl change alone does nothing for real capital.
            if (s.tradeId) {
              try {
                require('./executor').setTradingStopSafe({ symbol: s.symbol, tp1: s.tp1, sl: newSl, side: s.side, bybitSide: s.side === 'BUY' ? 'Buy' : 'Sell' })
                  .catch(e => addLog('WARN', `regime-flip trail: live SL move failed for ${s.symbol}: ${e.message}`));
              } catch (_e) { addLog('WARN', `regime-flip trail: live SL move threw for ${s.symbol}: ${_e.message}`); }
            }
          }
          // Clear the flip-exit flag either way — this position has been handled (trailed, not closed);
          // it continues ticking as PAPER_ACTIVE toward its (now-protected) TP or the new tightened SL.
          s.regimeFlipExit = false;
          changed = true;
          continue;
        }
        // rAtExit < REGIME_FLIP_TRAIL_MIN_R: original hard-close path, UNCHANGED.
        finalizeActiveDiagnostics(s, now);
        const riskUSDT = Math.abs(num(s.netSlUSDT)) || 0;
        s.paperState = 'REGIME_FLIP_EXIT';
        s.status = rAtExit >= 0 ? 'WIN' : 'LOSS';
        s.displayState = 'REGIME_FLIP_EXIT';
        s.positionStatus = 'CLOSED';
        s.closedAt = now;
        s.exitPx = roundPrice(price);
        s.realizedPnl = Number((rAtExit * riskUSDT).toFixed(4));
        s.stateReason = `${V4_VERSION}: regime-flip exit ${s.regimeFlipFrom}->${s.regimeFlipTo} at ${rAtExit >= 0 ? '+' : ''}${rAtExit.toFixed(2)}R (cut before full SL)`;
        const flipDiag = { at: now, state: 'REGIME_FLIP_EXIT', reason: s.stateReason, price, exitPx: s.exitPx, rAtExit: Number(rAtExit.toFixed(3)), realizedPnl: s.realizedPnl };
        s.history = [...(s.history || []), flipDiag];
        s.closeDiagnostic = flipDiag;
        appendDiagnosticJournal({ at: now, iso: new Date(now).toISOString(), type: 'TRADE_CLOSED', version: V4_VERSION, symbol: s.sym || s.symbol, side: s.side, result: s.status, realizedPnl: s.realizedPnl, close: flipDiag, signal: normalizeLedgerTrade(s) }, settings);
        appendSignalDiagnostic('REGIME_FLIP_EXIT', s, { prevState, price, rAtExit, from: s.regimeFlipFrom, to: s.regimeFlipTo }, settings);
        if (s.tradeId) { const _t = store.read('trades', {}); if (_t[s.tradeId]) { _t[s.tradeId].signalInvalidated = true; store.write('trades', _t); } }
        changed = true;
        continue;
      }

      // fixFLIP layer3 — ACTIVE REVERSAL (opt-in: V4_FLIP_ACTIVE). A filled short that's now underwater
      // and prints a flip-TF failed-rejection reclaim (squeeze confirmed) is closed at the CURRENT price —
      // booking the PARTIAL loss instead of riding to full SL — and a reversed retest child is born to ride
      // the bounce. Mirror applies to a filled long via detectFlip's symmetric FAILED_BUY_SUPPORT. Books
      // real mid-trade P&L, so default OFF. Reuses the regime-flip-exit accounting above.
      if (FLIP_ENABLED && FLIP_ACTIVE && !s.activeFlippedOnce && price) {
        const _entryPx = num(s.entry);
        const _slDist = Math.abs(_entryPx - num(s.sl)) || 1e-9;
        const _rNow = String(s.side).toUpperCase() === 'BUY' ? (price - _entryPx) / _slDist : (_entryPx - price) / _slDist;
        if (_rNow < 0) { // only reverse a losing position, never a winning one
          const _revChild = buildFlipChild(s, market, price, now, settings);
          if (_revChild) {
            finalizeActiveDiagnostics(s, now);
            const _riskUSDT = Math.abs(num(s.netSlUSDT)) || 0;
            s.activeFlippedOnce = true;
            s.paperState = 'ACTIVE_FLIP_EXIT';
            s.status = 'LOSS'; // _rNow < 0 by guard
            s.displayState = 'ACTIVE_FLIP_EXIT';
            s.positionStatus = 'CLOSED';
            s.closedAt = now;
            s.exitPx = roundPrice(price);
            s.realizedPnl = Number((_rNow * _riskUSDT).toFixed(4));
            s.stateReason = `${V4_VERSION}: active reversal ${s.side}→${_revChild.side} (${_revChild.flipReason}) at ${_rNow.toFixed(2)}R — cut + reverse, retest child ${_revChild.id}`;
            const _revDiag = { at: now, state: 'ACTIVE_FLIP_EXIT', reason: s.stateReason, price, exitPx: s.exitPx, rAtExit: Number(_rNow.toFixed(3)), realizedPnl: s.realizedPnl, flip: _revChild.flipMeta };
            s.history = [...(s.history || []), _revDiag];
            s.closeDiagnostic = _revDiag;
            appendDiagnosticJournal({ at: now, iso: new Date(now).toISOString(), type: 'TRADE_CLOSED', version: V4_VERSION, symbol: s.sym || s.symbol, side: s.side, result: s.status, realizedPnl: s.realizedPnl, close: _revDiag, signal: normalizeLedgerTrade(s) }, settings);
            appendSignalDiagnostic('ACTIVE_FLIP_EXIT', s, { prevState, price, rAtExit: _rNow, flip: _revChild.flipMeta }, settings);
            flagTradeForCancel(s, 'ACTIVE_FLIP_EXIT');
            addLog('CONTRARIAN_FLIP', `${s.sym} ACTIVE ${s.side}→${_revChild.side} ${_revChild.flipReason} cut@${_rNow.toFixed(2)}R entry=${_revChild.entry} sl=${_revChild.sl} tp=${_revChild.tp1} composite=${_revChild.flipMeta.sentinelComposite}`);
            _flipChildren.push(_revChild);
            changed = true;
            continue;
          }
        }
      }

      const final = activeFinalFromMarket(s, market, price);
      if (final) {
        finalizeActiveDiagnostics(s, now);
        s.paperState = final.state;
        s.displayState = final.state;
        s.status = final.status;
        s.positionStatus = 'CLOSED';
        s.closedAt = now;
        s.exitPx = roundPrice(final.exitPx || price);
        s.realizedPnl = final.state === 'TP_HIT' ? num(s.netTpUSDT) : num(s.netSlUSDT);
        s.stateReason = final.reason;
        const closeDiag = { at: now, state: final.state, reason: final.reason, price, high: market.high, low: market.low, exitPx: s.exitPx, rangeUsable: final.rangeUsable, realizedPnl: s.realizedPnl, netTpUSDT: s.netTpUSDT, netSlUSDT: s.netSlUSDT, feeEstUSDT: s.feeEstUSDT };
        s.history = [...(s.history || []), closeDiag];
        s.closeDiagnostic = closeDiag;
        appendDiagnosticJournal({ at: now, iso: new Date(now).toISOString(), type: 'TRADE_CLOSED', version: V4_VERSION, symbol: s.sym || s.symbol, side: s.side, result: final.status, realizedPnl: s.realizedPnl, close: closeDiag, signal: normalizeLedgerTrade(s) }, settings);
        appendSignalDiagnostic('TRADE_CLOSE_TRACE', s, { prevState, final, price, high: market.high, low: market.low, rangeUsable: final.rangeUsable }, settings);
        // fix44f: if paper closed but Bybit order still pending → flag for cancel + block symbol
        // Prevents stale limit orders filling into dead setups after paper TP/SL hit
        if (s.tradeId) {
          const _trades = store.read('trades', {});
          const _trade = _trades[s.tradeId];
          if (_trade && ['PENDING','ORDER_SUBMITTED','ORDER_PENDING_FILL'].includes(_trade.status)) {
            _trade.paperClosed = true;
            _trade.paperCloseState = final.state;
            _trade.paperCloseAt = now;
            _trade.signalInvalidated = true; // reuse reconciler cancel path
            store.write('trades', _trades);
            addLog('PAPER_BYBIT_MISMATCH', `${s.sym} ${s.side} paper=${final.state} but Bybit order still PENDING — flagged for cancel`, { tradeId: s.tradeId, orderId: _trade.orderId });
          }
        }
        changed = true;
      }
    }
  }
  // fixFLIP: append opposite-side retest children built during iteration (processed next tick; never re-flip)
  if (_flipChildren.length) {
    for (const _c of _flipChildren) signals.push(_c);
    changed = true;
  }
  return changed;
}

function canCreateForSymbol(signals, symbol, settings, side = '') {
  if (!settings.oneTradePerSymbol) return true;
  // symbolCooldownReason is now the single source of truth and is side-aware.
  // The old extra recentClosed check blocked reversals and fresh attempts after
  // EXPIRED/INVALIDATED rows, which reduced trade capture without improving accuracy.
  return !symbolCooldownReason(signals, symbol, side || null, Date.now(), settings);
}

async function enrichOpenSignalMarketMap(signals, basePriceMap) {
  const out = new Map(basePriceMap || []);
  const open = (signals || []).filter(s => s && ACTIVE_STATES.has(s.paperState));
  const symbols = [...new Set(open
    .map(s => String(s.sym || s.symbol || '').toUpperCase())
    .filter(Boolean))].slice(0, 30);
  // fix48e: symbols that are WAITING need fresh 5m context for adaptive re-validation
  // (RSI/ATR momentum + vol-shock checks). Active trades only need 1m price for TP/SL.
  const waitingSymbols = new Set(open
    .filter(s => s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION' || s.paperState === 'CANDIDATE')
    .map(s => String(s.sym || s.symbol || '').toUpperCase()));

  await Promise.all(symbols.map(async symbol => {
    try {
      const candles = await fetchKline(symbol, '1', 3);
      const last = candles[candles.length - 1] || null;
      const base = out.get(symbol) || {};
      const merged = {
        ...base,
        markPrice: num(base.markPrice || base.lastPrice || last?.close, 0),
        lastPrice: num(base.lastPrice || last?.close || base.markPrice, 0),
        close: num(last?.close || base.lastPrice || base.markPrice, 0),
        high: num(last?.high, 0),
        low: num(last?.low, 0),
        ts: num(last?.ts, 0),
        candleTs: num(last?.ts, 0),
        candleIntervalMs: 60000,
        candle: last,
      };
      // fix48e: fresh 5m momentum/volatility for waiting-entry re-validation
      if (waitingSymbols.has(symbol)) {
        try {
          const k5 = await fetchKline(symbol, '5', 30);
          const closes5 = k5.map(c => c.close);
          if (closes5.length >= 15) {
            merged.rsi5 = calcRsi(closes5, 14);
            // ATR(14) on 5m as the live volatility gauge
            const trs = [];
            for (let i = 1; i < k5.length; i++) {
              const h = num(k5[i].high), l = num(k5[i].low), pc = num(k5[i-1].close);
              trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
            }
            merged.atr5 = trs.length ? avg(trs.slice(-14)) : 0;
            merged.localRegime = (typeof detectLocalRegime === 'function') ? (detectLocalRegime(k5).localRegime) : undefined;
            // fixFLIP: last CLOSED 5m bar (drop the forming one) + 20-bar avg volume (fallback flip trigger)
            if (k5.length >= 3) {
              const closedK5 = k5.slice(0, -1); // exclude the in-progress bar (no repaint)
              merged.candle5closed = closedK5[closedK5.length - 1] || null;
              const v5 = closedK5.slice(-20).map(c => num(c.volume)).filter(v => v > 0);
              merged.avgVol5 = v5.length ? v5.reduce((a, b) => a + b, 0) / v5.length : 0;
            }
          }
        } catch (_e5) { /* keep 1m-only data if 5m fetch fails */ }
      }
      // fixFLIP layer2/3: configurable flip-TF confirmation bar (default 1m — 5m too wide for a squeeze) for
      // BOTH waiting symbols (layer2 waiting-flip) AND active symbols (layer3 active-reversal). Fetched once.
      if (FLIP_ENABLED && (FLIP_WAITING || FLIP_ACTIVE)) {
        try {
          if (String(FLIP_TF) === '5' && merged.candle5closed) {
            merged.candleFlipClosed = merged.candle5closed;
            merged.avgVolFlip = merged.avgVol5;
          } else {
            const kF = await fetchKline(symbol, String(FLIP_TF), 30);
            if (Array.isArray(kF) && kF.length >= 3) {
              const closedF = kF.slice(0, -1);
              merged.candleFlipClosed = closedF[closedF.length - 1] || null;
              const vF = closedF.slice(-20).map(c => num(c.volume)).filter(v => v > 0);
              merged.avgVolFlip = vF.length ? vF.reduce((a, b) => a + b, 0) / vF.length : 0;
            }
          }
        } catch (_eF) { /* flip data is best-effort; absence just means no flip this tick */ }
      }
      out.set(symbol, merged);
    } catch (_e) {
      // Keep ticker-only price data if candles are unavailable.
    }
  }));
  return out;
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

// ── Backend Auto-Retry ────────────────────────────────────────────────────
// Runs inside every scanOnce() cycle but throttled to once per 5 minutes.
// Replays recent soft-gate rejections through ingestCandidate with current
// (possibly relaxed) settings. Hard-gate failures are never retried.
// Requires no browser — runs 24/7 as long as the Node process is alive.
const RETRY_INTERVAL_MS = 2 * 60 * 1000; // fix44f: 5min→2min — retry=59% WR vs planner=46%, generate more retries
const RETRY_MAX_AGE_MS  = 2.5 * 60 * 60 * 1000; // fix44b: 4hr->2.5hr — stale setups in CHOP caused cluster losses
const RETRY_MIN_SCORE   = 72; // fix44e: raised from 46 — effective gate in ingestCandidate is v4MinSellScore=72 (lowest gate)
                               // Storing score<72 candidates wastes store space — they always fail shouldReject on retry
const HARD_REJECT_PREFIXES = [
  // fixAGREEBLOCK (hotfix 17): never retry a symbol Bybit will only accept once the user signs a
  // product agreement on Bybit's own site — no retry count fixes that.
  'SYMBOL_AGREEMENT_REQUIRED',
  'BAD_SYMBOL','NO_DIRECTION','PLAN_MISSING',
  'BUY_PLAN_DIRECTION_INVALID','SELL_PLAN_DIRECTION_INVALID',
  'DUPLICATE_SYMBOL_SIDE_ACTIVE',
  // fix44e: MAX_OPEN_TRADES_REACHED removed — these SHOULD retry when a slot opens
  'CLUSTER_BUY_LOSSES_COOLDOWN','CLUSTER_SELL_LOSSES_COOLDOWN',
  'GLOBAL_RISK_BLOCK','ENRICH_ERROR',
  // fix43: add hard failures that should never be retried — they won't resolve on retry
  // fix47: DEAD_HOUR_NO_NEW_ENTRIES removed — dead hours removed entirely in fix47
  'LOCAL_BEAR_BLOCKED',         // structure-based — pair was genuinely bearish at rejection
  'LOCAL_BEAR_BLOCKED_CONFIRMED', // fix43 variant
  'SL_TOO_WIDE',                // price-based — SL structure doesn't change
  // fix44: DUPLICATE_SYMBOL_SIDE_WAITING — signal already queued, retrying just refreshes plan endlessly
  // Data: SKYAI1USDT 6x, HMSTRUSDT 5x — one real win counted as 5-6, phantom PnL in paper, 6x margin in live
  'DUPLICATE_SYMBOL_SIDE_WAITING',
  // fix48d (item 6): a frontend/unknown-source signal is never a valid retry candidate — backend is sole source.
  // Prevents a frontend-blocked payload from ever being replayed into the retry queue.
  'FRONTEND_SIGNALS_DISABLED',
  // fixPCT (Phase 1): a strong per-coin counter-trend conflict must not be replayed through
  // ingestCandidate (which has no per-coin trend check) — the trend won't have reversed in 2 min,
  // and if it does, a fresh scan signal is born clean. Never retry a knife-catch.
  'PERCOIN_TREND_CONFLICT',
];

async function autoRetryRejections(currentSnapshot, settings) {
  const now = Date.now();
  if (now - lastAutoRetryAt < RETRY_INTERVAL_MS) return; // throttle

  // Only retry if there is at least one open slot
  const signals = getSignals();
  const openCount = openSignalCount(signals);
  if (openCount >= settings.maxOpenTrades) return;

  lastAutoRetryAt = now;
  const cutoff = now - RETRY_MAX_AGE_MS;
  const rows = store.read('v4_candidate_rejections', []);

  // Filter: recent, high-enough score, no hard-gate reason
  const candidates = rows.filter(r => {
    if (!r || !r.at || r.at < cutoff) return false;
    if (num(r.score, 0) < RETRY_MIN_SCORE) return false;
    const reasons = Array.isArray(r.reasons) ? r.reasons : [];
    return !reasons.some(rs => HARD_REJECT_PREFIXES.some(p => String(rs).startsWith(p)));
  });

  // Deduplicate — EARLIEST rejection per symbol+side (fix44b: was most recent — caused age clock reset on re-rejection)
  const seen = new Map();
  for (const r of candidates) {
    const k = `${r.symbol}_${r.side}`;
    if (!seen.has(k) || r.at < seen.get(k).at) seen.set(k, r);
  }
  // Rejection store doesn't know if signal was later accepted — check live signals
  const liveSignals = getSignals();
  const deduped = [...seen.values()]
    .filter(r => {
      const alreadyLive = liveSignals.some(s =>
        s && (s.symbol === r.symbol || s.sym === r.symbol) &&
        s.side === r.side &&
        ['WAITING_ENTRY','WAITING_REACTION','PAPER_ACTIVE'].includes(s.paperState)
      );
      return !alreadyLive;
    })
    .sort((a, b) => num(b.score, 0) - num(a.score, 0));

  if (!deduped.length) return;

  let captured = 0;
  for (const r of deduped) {
    if (openSignalCount(getSignals()) >= settings.maxOpenTrades) break;

    // fix44e: rebuild plan from CURRENT market data — stale entry/sl/tp1 causes limit orders
    // to queue at wrong price levels and never fill (or fill into dead setups)
    let payload;
    try {
      const ctx = await enrich({ symbol: r.symbol, sym: r.symbol, lastPrice: 0 });
      const currentBtcRegime = getBTCRegime();
      const built = buildStructurePlan(ctx, settings, currentBtcRegime);
      if (built.ok && built.leader && (
        built.leader.side === r.side ||       // same side as rejection
        built.leader.contrarianFlip           // flip happened (LOCAL_BULL or structure override)
      )) {
        // Fresh plan built — use it with retry source attribution
        payload = {
          ...built.leader,
          source: `backend-retry-${V4_VERSION}`,
          btcRegime: currentBtcRegime?.regime || r.btcRegime || '',
          score: built.leader.score || 0, // fix48b: use fresh build score only — stale r.score could bypass score gate
        };
      } else {
        // Fresh build failed or side flipped — skip this candidate
        addLog('RETRY_SKIP', `${r.symbol} ${r.side} fresh build failed: ${built.reason || 'side mismatch'}`);
        continue;
      }
    } catch (e) {
      // enrich failed (symbol delisted, API error) — fall back to stale plan with current regime
      addLog('RETRY_STALE', `${r.symbol} ${r.side} using stale plan: ${e.message}`);
      const entry = r.plan?.entry || 0;
      const sl = r.plan?.sl || 0;
      const atrEst = entry && sl ? Math.abs(entry - sl) / 0.55 : 0;
      payload = {
        symbol: r.symbol, sym: r.symbol, side: r.side,
        score: r.score, setupScore: r.score, confidence: r.score,
        entryTimingScore: r.entryTimingScore || 0,
        source: `backend-retry-${V4_VERSION}`,
        entry: r.plan?.entry, sl: r.plan?.sl, tp1: r.plan?.tp1,
        rr: r.rr, atr: atrEst, rsi: r.rsi, // fixRSIGATE: stale-fallback branch had no rsi at all — gate would fail-open blind without this
        btcRegime: getBTCRegime()?.regime || r.btcRegime || '',
        state: 'READY', keyLevels: {}, plan: r.plan || {},
      };
    }

    // fixRSIGATE (07/30, hotfix33): REPLACES fix48q's score-floor enforcement. Same two-branch
    // coverage (fresh build via ...built.leader carries rsi already; stale fallback gets it added
    // above) — now gates on direction (RSI zone), not score.
    if (!passesRsiDirectionGate(payload?.side, payload?.rsi)) {
      addLog('RETRY_SKIP', `${r.symbol} ${r.side} failed RSI direction gate: rsi=${payload?.rsi}`);
      continue;
    }

    const result = ingestCandidate(payload);
    if (result.ok) {
      captured++;
      console.log(`[v4.retry] captured ${r.symbol} ${r.side} score=${r.score}`);
    }
  }
  if (captured > 0) {
    console.log(`[v4.retry] auto-retry: ${captured}/${deduped.length} candidates captured`);
  }
}

// fix47: dead hour blocking fully removed — structureDetector handles quality across all hours.
// Hours 11,12,14,21,23 UTC historically low WR but structureDetector squeeze/trap/CHoCH filters
// are the correct mechanism. Hard hour blocks kill valid setups without data justification.
function isDeadHour() { return false; } // fix48b: DEAD STUB — dead hours removed in fix47. Kept for compat only.

async function scanOnce() {
  if (inFlight) return snapshot;
  inFlight = true;
  const startedAt = Date.now();
  _pctReset();
  try {
    const settings = currentSettings();
    const [tickers, btcRegime] = await Promise.all([fetchTickers(), updateBtcRegime()]);
    const priceMap = new Map(tickers.map(t => [t.symbol, t]));
    let signals = dedupeLiveSignals(getSignals());
    // fix48z: ZOMBIE SWEEP — force-EXPIRE any signal whose paperState is in neither ACTIVE nor
    // FINAL (the orphan/zombie: shows as "open" but ACTIVE=0, never resolves, drags the ledger).
    // Runs every tick, not just on manual cancel. This is the automatic version of the 48q cancel fix.
    {
      const now0 = Date.now();
      let _zombies = 0;
      for (const s of signals) {
        if (!s) continue;
        const ps = s.paperState;
        if (!ACTIVE_STATES.has(ps) && !FINAL_STATES.has(ps)) {
          s.paperState = 'EXPIRED'; s.displayState = 'EXPIRED'; s.status = 'EXPIRED';
          s.result = s.result && ['WIN','LOSS'].includes(String(s.result).toUpperCase()) ? s.result : 'EXPIRED';
          s.positionStatus = 'NONE'; s.updatedAt = now0; s.closedAt = s.closedAt || now0;
          s.stateReason = `${V4_VERSION}: zombie auto-expired (orphan state '${ps}')`;
          s.history = Array.isArray(s.history) ? s.history.concat([{ at: now0, state: 'EXPIRED', reason: `orphan '${ps}'` }]) : [{ at: now0, state: 'EXPIRED', reason: `orphan '${ps}'` }];
          _zombies++;
        }
      }
      if (_zombies) { try { console.log(`[zombie-sweep] force-expired ${_zombies} orphan signal(s)`); } catch {} saveSignals(signals); }
    }

    // fix75 → fixEQ1: PAPER EQUITY SELF-SNAPSHOT **REMOVED**.
    // fix75 self-recorded a synthetic paper equity (V4_PAPER_START_BALANCE default 1000 + net P&L)
    // so the chart wouldn't be empty in paper mode. In practice this was worse than empty: the curve
    // showed ~1000 USDT while the real Bybit wallet held ~52, and in PAPER_REAL_PRICE mode (which
    // forces testnet=true) there is no honest wallet number to show at all. A confidently-wrong
    // equity number on a screen you are about to trade real money against is a hazard, not a feature.
    // NEW RULE (single writer, honest or nothing):
    //   LIVE_REAL_BYBIT → frontend wallet poll is the sole author (real MAINNET balance).
    //   any paper/testnet mode → NOTHING is written. Chart renders its empty state.
    // Never synthetic, never testnet. Empty is a truthful reading; 1000.00 is not.
    // fix44a: skip alert system removed — v4_candidate_rejections no longer written

    // fix29: feed live price map to sentinel for market breadth/volume delta computation
    // fix49s: was a bare `catch {}` — any failure here silently starved sentinelBrain's breadth
    // calc forever with zero trace. Now logs so this specific failure mode can never again take
    // 12+ hours of manual archaeology to discover.
    try { sentinel.injectPriceMap(Object.fromEntries(priceMap)); } catch (e) { console.warn('[v4Brain] injectPriceMap failed:', e.message); }

    // fix49l(L): BREADTH-HISTORY LOGGER — read-only, once per minute. The sentinel only persists
    // on regime FLIPS (too sparse to compute a breadth slope), so we sample the continuous breadth
    // here to build the series the breadth-trend feature + simulation need. Pure recording; touches
    // no trading logic. 1-min throttle, 7-day retention enforced by trimming on write.
    try {
      const _bNow = Date.now();
      if (_bNow - _lastBreadthLogMs >= 60 * 1000) {
        _lastBreadthLogMs = _bNow;
        const _bs = (typeof sentinel?.getSentinel === 'function') ? sentinel.getSentinel() : null;
        const _bPairs = num(_bs?.vol?.pair_count, 0);
        if (_bPairs > 0) {
          store.appendNdjson('breadth_history', {
            ts: _bNow,
            iso: new Date(_bNow).toISOString(),
            bull_pct: num(_bs?.vol?.bull_pct, null),
            pair_count: _bPairs,
            market_regime: _bs?.market_regime || null,
            btc_regime: String(btcRegime?.regime || btcRegime || '').toUpperCase() || null,
            btc_rsi: num(btcRegime?.rsi, null),
            composite: num(_bs?.composite_score, null),
            funding_avg: num(_bs?.fund?.avg_rate, null)
          });
          // fix49m: 7-day retention, memory-bounded. The old hourly trim did readNdjsonTail(20000)
          // — a full-file readFileSync + split + JSON.parse of up to 20k rows, three copies of the
          // data resident at once. On a 512MB container under live 527-pair scan load that read was
          // a recurring spike; this caps the read at 2000 rows (~200% of expected daily volume at
          // 1/min), plenty for the 7-day cut while bounding the worst case.
          if ((_breadthLogWrites = (_breadthLogWrites + 1) % 60) === 0) {
            try {
              const _cut = _bNow - 7 * 24 * 60 * 60 * 1000;
              const _all = store.readNdjsonTail('breadth_history', 2000) || []; // newest-first, bounded
              const _keep = _all.filter(r => num(r?.ts, 0) >= _cut)
                                .sort((a, b) => num(a?.ts, 0) - num(b?.ts, 0)); // chronological for file
              if (_keep.length < _all.length) store.rewriteNdjson('breadth_history', _keep);
            } catch (_e) { /* trim is best-effort */ }
          }
        }
      }
    } catch (_e) { /* logger must never disrupt the scan */ }

    const signalPriceMap = await enrichOpenSignalMarketMap(signals, priceMap);
    if (ADAPT_ENABLED) computeAdaptiveRegime(); // fixADAPT: refresh per-side regime from realized results (1/tick)
    updateExistingSignals(signals, signalPriceMap);
    signals = dedupeLiveSignals(signals);

    // fix38h: sweep engine tick — detects cluster SL_HITs and sets fade state
    const ledgerForSweep = getLedger();
    try { sweepEngine.tick(ledgerForSweep, signals, Date.now()); } catch (e) { /* non-critical */ }

    const universe = tickers
      .filter(t => t.symbol !== 'BTCUSDT' && t.symbol.endsWith('USDT') && num(t.turnover24h) > 0)
      .sort((a, b) => num(b.turnover24h) - num(a.turnover24h))
      .slice(0, MAX_SYMBOLS);

    // fixMOVERLANE (4.6.9.0): universe above is a hard rank-and-slice by 24h $ volume — a coin ranked
    // 81st+ never enters the scan at all no matter how clean its setup, because volume ranking is sticky
    // day to day (same top names dominate). Real evidence: user's own screenshots (AKE/BANK/TAO/HYPE)
    // were genuine trending moves the coinTrend engine read correctly when checked manually, but never
    // got a leader built live — never in the volume-ranked universe to begin with. Adds a SMALL bounded
    // second lane: the top MOVER_LANE_SIZE symbols by absolute 24h % move that are NOT already in the
    // volume universe. Reuses the SAME already-fetched `tickers` array — zero new network calls to build
    // the candidate list; the added per-symbol kline-enrich cost is bounded and small (15 more, same
    // fixLOOP bounded-parallel prefetch batching already absorbs the existing 80 fine) — deliberately
    // small to avoid reintroducing the CPU-saturation problem fixLOOP fixed. Symbols added this way are
    // tagged (leader.moverLane = true) so they're visible/auditable, not silently blended in. Every
    // existing gate (score, RR, regime, breadth-fight, euph, coinTrend) still applies unchanged to these
    // symbols — this only affects whether they get EVALUATED, never whether they get ADMITTED.
    // Reversible: V4_MOVER_LANE_SIZE=0 fully restores the old volume-only universe.
    const MOVER_LANE_SIZE = Math.max(0, Math.min(40, Number(process.env.V4_MOVER_LANE_SIZE || '15')));
    const _moverLaneSymbols = new Set();
    if (MOVER_LANE_SIZE > 0) {
      const _inVolUniverse = new Set(universe.map(t => t.symbol));
      const _movers = tickers
        .filter(t => t.symbol !== 'BTCUSDT' && t.symbol.endsWith('USDT') && !_inVolUniverse.has(t.symbol) && num(t.turnover24h) > 0)
        .sort((a, b) => Math.abs(num(b.change24h)) - Math.abs(num(a.change24h)))
        .slice(0, MOVER_LANE_SIZE);
      for (const t of _movers) { universe.push(t); _moverLaneSymbols.add(t.symbol); }
    }

    // fix47: dead hour block removed entirely — all hours scan normally

    // fix44e: batch-read rejection store once per scan (was reading inside loop = 50 reads/scan)
    // Map keyed by symbol_side — one entry per pair, updated on re-rejection
    const _rejStore = store.read('v4_candidate_rejections', []);
    const _rejMap = new Map(_rejStore.map(r => [`${r.symbol}_${r.side}`, r]));

    // ── fixLOOP (hotfix 22): bounded-parallel kline PREFETCH ──────────────────────────────────────
    //   The build loop below is sequential (it mutates shared signal state, so it MUST stay serial to
    //   avoid maxOpenTrades / dedup races). The expensive part of each iteration is the network I/O in
    //   enrich() (kline fetches). We warm those in bounded-parallel batches FIRST — into the fixLOOP
    //   kline cache — so the sequential loop's enrich() calls hit the cache and do ~no network. This
    //   turns 500-1000 serial REST calls into ~50 parallel batches: the sweep finishes fast, stops
    //   saturating the link, and the awaits between batches yield the event loop so the sentinel and
    //   price-feed poll get bandwidth (kills the 90s watchdog + 307s stale-price + UI drop). Trade
    //   logic and what-gets-scanned are UNCHANGED — this only changes HOW the klines are fetched.
    const _PREFETCH_CONC = Math.max(1, Number(process.env.V4_PREFETCH_CONCURRENCY || '10'));
    const _ctxMap = new Map();
    for (let i = 0; i < universe.length; i += _PREFETCH_CONC) {
      const _batch = universe.slice(i, i + _PREFETCH_CONC);
      const _res = await Promise.all(_batch.map(t => enrich(t).then(ctx => ({ sym: t.symbol, ctx })).catch(() => null)));
      for (const r of _res) { if (r) _ctxMap.set(r.sym, r.ctx); } // enrich is pure (read-only), so parallel is safe
    }

    const entries = [];
    let _scanned = 0;
    for (const t of universe) {
      try {
        const ctx = _ctxMap.get(t.symbol) || await enrich(t); // reuse the parallel-prefetched ctx; fall back if a pair failed
        // fixPCT Phase 1.5: for a fresh-move coin (5m+15m agree, 1h lagging) fetch the 1m/3m/5m/15m read so
        // determineDirection's F4 vote can form a leader the 1h-gated F3 would miss. Bounded to fresh-move
        // coins only; cached 45s; fail-open. No fetch for the ~majority that aren't fresh moves.
        if (PCT_VOTE_ENABLED && isFreshMove(ctx) && !ctx.coinTrend) {
          if (_pctStats) _pctStats.fresh++;
          if (!_pctStats || _pctStats.fetched < PCT_MAX_FETCH) {
            try {
              ctx.coinTrend = await coinTrendEngine(t.symbol);
              if (_pctStats) { _pctStats.fetched++; if (ctx.coinTrend && ctx.coinTrend.strength >= PCT_STRONG) _pctStats.strong++; }
            } catch (_ct) { /* fail-open: no vote this pair */ }
          } else if (_pctStats) { _pctStats.capped++; } // load cap hit — skip fetch, coin just misses the vote this scan
        }
        const built = buildStructurePlan(ctx, settings, btcRegime);
        if (!built.ok) {
          entries.push({ symbol: t.symbol, side: built.leader?.side || 'NEU', score: 0, rejected: true, rejectReasons: [built.reason], price: roundPrice(t.lastPrice) });
          continue;
        }
        const leader = built.leader;
        // fix44f: set source on leader BEFORE shouldReject so _isPlanner gate works
  if (!leader.source) leader.source = `backend-planner-${V4_VERSION}`;
  if (_moverLaneSymbols.has(t.symbol)) leader.moverLane = true; // fixMOVERLANE: visible/auditable, not silently blended

  const gate = shouldReject(leader, settings, signals);
        leader.rejected = !gate.ok;
        leader.rejectReasons = gate.reasons;
        leader.rejectWarnings = gate.warnings || [];
        // fixPCT (Phase 1): per-coin multi-TF trend override/conflict.
        // Mutates leader.rejected / leader.rejectReasons / gate.ok in place, kept mutually consistent
        // inside the helper, so the max-open + rejection-store logic below reads the post-override state.
        await applyPerCoinTrend(leader, gate);
        // fixPCT (B): tally strong fresh-move coins so the scan summary shows if they formed leaders and why they didn't trade
        if (_pctStats && ctx.coinTrend && ctx.coinTrend.strength >= PCT_STRONG) {
          if (Array.isArray(leader.reasons) && leader.reasons.some(r => /^F4:/.test(String(r)))) _pctStats.f4leaders++;
          if (leader.rejected && Array.isArray(leader.rejectReasons) && leader.rejectReasons.length) _pctBlock(leader.rejectReasons[0]);
        }
        entries.push(leader);
        if (gate.ok && openSignalCount(signals) >= settings.maxOpenTrades) {
          leader.rejected = true;
          leader.rejectReasons = ['MAX_OPEN_TRADES_REACHED'];
        }
        // fix44e: write to rejection store for BOTH soft-gate failures AND max-trades-reached
        // fix44a had removed this entirely → 0 retry signals all session
        // fix44d restored it but missed MAX_OPEN_TRADES_REACHED (set after gate check)
        // fix44e: single write point covers all rejection paths, keyed map = no dupes
        const _isRejected = !gate.ok || (gate.ok && openSignalCount(signals) >= settings.maxOpenTrades);
        if (_isRejected) {
          const _rejKey = `${leader.symbol}_${leader.side}`;
          const _rejReasons = leader.rejectReasons || [];
          const _isHard = _rejReasons.some(rs => HARD_REJECT_PREFIXES.some(p => String(rs).startsWith(p)));
          if (!_isHard && leader.score >= RETRY_MIN_SCORE) {
            _rejMap.set(_rejKey, {
              symbol: leader.symbol, side: leader.side, score: leader.score,
              entryTimingScore: leader.entryTimingScore || 0,
              reasons: _rejReasons,
              btcRegime: leader.btcRegime || btcRegime?.regime || '',
              rr: leader.math?.rr || 0,
              plan: { entry: leader.entry, sl: leader.sl, tp1: leader.tp1 },
              rawPayload: null,
              at: Date.now(),
            });
          }
        }

        if (gate.ok && openSignalCount(signals) < settings.maxOpenTrades) {
          // fix44f: dead hour entry block removed — structureDetector now identifies
          // trap/CHoCH/squeeze setups during these hours instead of blocking all entries
          // High-quality structure signals (trap, CHoCH confirmed) can trade any hour
            const dupReason = symbolCooldownReason(signals, leader.symbol, leader.side, Date.now(), settings);
            if (dupReason === 'DUPLICATE_SYMBOL_SIDE_WAITING') {
              mergeLeaderIntoWaiting(signals, leader, settings);
            } else if (!dupReason && canCreateForSymbol(signals, leader.symbol, settings, leader.side)) {
              const sig = signalFromLeader(leader, settings);
              signals.unshift(sig);
              addLog('V4_SIGNAL', `${leader.symbol} ${leader.side} ${sig.paperState}`, { score: leader.score, rr: leader.math.rr });
              // fix49c: GTC limit at signal.entry on WAITING signal creation — price comes to us, no drift
              // ── fixCONFIRM (hotfix 21, 2026-07-24) — DISABLED ON PURPOSE ──────────────────────────────
              //   This birth-time resting limit was the LIVE knife-catch. It was placed the instant a signal
              //   was BORN (WAITING_ENTRY/WAITING_REACTION), then filled on the RAW first touch — price rising
              //   into a SELL limit / falling into a BUY limit — with NONE of the paper brain's entry logic:
              //   it bypassed signalEntryTiming()'s fresh `directional` reaction check and every ENTRY_TIMING
              //   block (>=44 held net-negative, ==100 momentum-chase revert). So LIVE took raw-touch knives the
              //   PAPER path never took → real 32% WR vs paper 49% (p=0.003), and the <5-min-duration cohort ran
              //   11% WR / -3.86U (the entire live loss). Root cause read straight from the 07/24 bybit ledger +
              //   16 loser screenshots (every S fills on a green up-tick, every B on a red down-tick).
              //   FIX = withhold the live order at birth. The CONFIRMED-entry hooks — fix57 (~L4858) and the
              //   fix44b legacy hook (~L4917) for signals waiting → confirming, plus the PAPER_ACTIVE-at-birth
              //   hook just below (~L5543) — become the SOLE live entry. They fire only after `inZone &&
              //   directional` (a fresh in-direction reaction, computed live each tick) AND all ENTRY_TIMING
              //   blocks pass, and they place a LIMIT nudged 0.15 ATR off the CONFIRMED price via
              //   buildExecutionPlan; hotfix 21b routes this through forceMarket (FIXCONFIRM_ENTRY_MARKET) so it
              //   enters at MARKET the instant confirmation prints — a limit lands back at the zone and misses
              //   the clean runners. Both-sides symmetric —
              //   this gates BUY and SELL identically (it's a placement removal, not a directional rule).
              //   REVERSIBLE: set FIXCONFIRM_BLIND_BIRTH_LIMIT = true to restore the old blind behaviour.
              const FIXCONFIRM_BLIND_BIRTH_LIMIT = false;
              if (FIXCONFIRM_BLIND_BIRTH_LIMIT && (sig.paperState === 'WAITING_ENTRY' || sig.paperState === 'WAITING_REACTION') && settings.botMode === 'LIVE_REAL_BYBIT' && settings.tradingEnabled) {
                const { placeLimitAtEntry: _placeLimit49c, activeTrades: _at49c } = require('./executor');
                if (sentinelBlind()) {
                  // fixENFORCE: blind -> place no resting limit now. Signal keeps WAITING on paper;
                  // if price reaches entry later, the fix57 hook re-checks blindness fresh and can
                  // still place then — a temporary outage costs nothing permanent.
                  addLog('LIVE_BLIND_SKIP', `${sig.symbol} ${sig.side} — sentinel blind >10min, resting limit withheld`);
                } else if (_at49c().length < (settings.maxOpenTrades || 3)) {
                  _placeLimit49c({ ...sig, leverage: settings.leverage || 5, margin: settings.maxTradeUsdt || 5 }, { settings })
                    .then(r => {
                      if (r && r.ok) {
                        const _sigs49c = getSignals();
                        const _idx49c = _sigs49c.findIndex(x => x.id === sig.id);
                        if (_idx49c >= 0) { _sigs49c[_idx49c].liveOrderId = r.orderId; _sigs49c[_idx49c].tradeId = r.tradeId; _sigs49c[_idx49c].orderStatus = 'LIMIT_WAITING'; saveSignals(_sigs49c); }
                        addLog('LIMIT_PLACED_WAITING', `${sig.symbol} ${sig.side} GTC limit @ ${sig.entry} (${sig.paperState})`, { orderId: r.orderId, tradeId: r.tradeId });
                      } else if (!r?.skipped) {
                        addLog('LIMIT_PLACE_FAILED', `${sig.symbol} ${sig.side}: ${r?.error || 'unknown'}`);
                      }
                    })
                    .catch(e => addLog('LIMIT_PLACE_ERROR', `${sig.symbol} ${sig.side}: ${e.message}`));
                } else {
                  addLog('LIMIT_SKIPPED', `${sig.symbol} ${sig.side} — maxOpenTrades reached`);
                }
              }
              // fix44b: live execution hook — planner immediate PAPER_ACTIVE
              // fixRETEST (07/26) — MISSED SITE, FOUND LATE: this is a THIRD live-order call site that
              // was not caught by the earlier grep (it used `sig`, not `s`, and a differently-shaped
              // condition, so the pattern search that found the other two didn't match it). Confirmed
              // live 07/26 on LPTUSDT — its log trail (PLACE_ATTEMPT/ENTRY_SMART_LIMIT/LIVE_PLACED) is
              // the OLD executeSignal→buildExecutionPlan smart-limit-nudge path, never fixRETEST's
              // placeLimitAtEntry. Root cause: a signal that's ALREADY PAPER_ACTIVE the instant the
              // planner creates it (price already past the zone with reaction at birth) has, by
              // construction, no retest history — sig.hadFirstTouch can never be true for a
              // brand-new signal, since that flag is only ever set incrementally inside
              // signalEntryTiming during the WAITING period this signal skipped entirely. This is the
              // exact same "no genuine retest" pattern fixRETEST was built to stop trading live
              // everywhere else — gating on hadFirstTouch here correctly disables this whole pathway
              // rather than leaving it as a silent gap. Paper is unaffected — sig.paperState stays
              // PAPER_ACTIVE and simulates normally; only the live order never fires.
              if (sig.paperState === 'PAPER_ACTIVE' && settings.botMode === 'LIVE_REAL_BYBIT' && settings.tradingEnabled && !sig._autoTraded && sig.hadFirstTouch) {
                const { activeTrades } = require('./executor');
                // fix44e: use activeTrades().length — previous filter missed ORDER_SUBMITTED
                const liveCount = activeTrades().length;
                if (sentinelBlind()) {
                  addLog('LIVE_BLIND_SKIP', `${sig.symbol} ${sig.side} — sentinel blind >10min, live order withheld`); // fixENFORCE
                  markSignalRejected(sig.id, 'SENTINEL_BLIND: no fresh market view for >10min — live order withheld', false);
                } else if (liveCount < (settings.maxOpenTrades || 3)) {
                sig._autoTraded = true;
                const _executor = require('./executor');
                _executor.executeSignal({ ...sig, plan: sig.plan || { entry: sig.entry, sl: sig.sl, tp1: sig.tp1 }, leverage: settings.leverage || 5, margin: settings.maxTradeUsdt || 5 }, { settings, forceMarket: FIXCONFIRM_ENTRY_MARKET })
                  .then(r => {
                    if (r && r.ok) {
                      const sigs = getSignals();
                      const idx = sigs.findIndex(x => x.id === sig.id);
                      if (idx >= 0) { sigs[idx].orderId = r.orderId; sigs[idx].tradeId = r.tradeId; sigs[idx].orderStatus = 'SENT_LIVE'; saveSignals(sigs); }
                      addLog('LIVE_PLACED', `${sig.symbol} ${sig.side} order placed`, { orderId: r.orderId, tradeId: r.tradeId });
                    } else {
                      addLog('LIVE_REJECTED', `${sig.symbol} ${sig.side} order failed`, { reason: r?.error || 'unknown' });
                      markSignalRejected(sig.id, r?.error, !!(r && r.permanentBlock)); // fixREJSTATE — this is the exact site that produced the user's phantom REUSDT/SKHYNIX wins/losses
                    }
                  })
                  .catch(e => { addLog('LIVE_ERROR', `${sig.symbol} ${sig.side} executor error: ${e.message}`); markSignalRejected(sig.id, e.message, false); });
                } // end liveCount check
              }
            } else if (dupReason && dupReason !== 'DUPLICATE_SYMBOL_SIDE_ACTIVE') {
              leader.rejected = true;
              leader.rejectReasons = [dupReason];
            }
        }
      } catch (e) {
        entries.push({ symbol: t.symbol, side: 'NEU', score: 0, rejected: true, rejectReasons: ['ENRICH_ERROR:' + e.message], price: roundPrice(t.lastPrice) });
      }
      // fixLOOP (hotfix 22): yield to the event loop every 40 pairs. With klines now cache-warm the
      // build loop is CPU-bound and its enrich() awaits resolve as microtasks (which do NOT let
      // setInterval/setTimeout run), so without this the sentinel + price-feed timers still starve on
      // the single 0.2-vCPU core. setImmediate is a macrotask — it lets those timers fire between batches.
      if ((++_scanned % 40) === 0) await new Promise(r => setImmediate(r));
    }

    // fix44e: batch write rejection store once per scan — trim to 200 entries (one per sym+side effectively)
    if (_rejMap.size > 0) {
      const _rejArr = [..._rejMap.values()].filter(r => (Date.now() - r.at) < RETRY_MAX_AGE_MS);
      store.write('v4_candidate_rejections', _rejArr.slice(-200));
    }

    // Persist every signal state into the permanent paper ledger before trimming the visible table.
    const ledger = upsertLedger(signals);

    signals = signals
      .sort((a, b) => num(b.createdAt) - num(a.createdAt))
      .slice(0, MAX_SIGNALS);
    saveSignals(signals);

    // Update all-time PnL accumulator every scan cycle (persists across ledger clears)
    try { updateAllTimePnl(ledger); } catch (e) { console.warn('[v4] updateAllTimePnl failed:', e.message); }

    const visibleSummary = computeSummary(signals);
    const ledgerSummary = computeLedgerSummary(ledger);
    // fix52: attach the permanent (decay-proof) summary so the frontend can show a win rate / all-
    // time net that never drifts as rows churn out of the visible window — no extra round-trip.
    let permanentSummary = null;
    try { permanentSummary = getPermanentSummary(7); } catch (e) { console.warn('[v4] getPermanentSummary failed:', e.message); }
    const summary = { ...ledgerSummary, visible: visibleSummary, permanent: permanentSummary, source: 'v4_paper_ledger' };
    snapshot = {
      ok: true,
      version: V4_VERSION,
      ts: Date.now(),
      scanMs: Date.now() - startedAt,
      entries: entries.sort((a, b) => num(b.score) - num(a.score)).slice(0, 120),
      rejectedPreview: entries.filter(e => e && e.rejected).sort((a,b)=>num(b.score)-num(a.score)).slice(0,40),
      signals,
      visibleSignals: signals.length,
      ledger: ledger.slice(0, RECENT_LEDGER_LIMIT),
      summary,
      btcRegime,
      sweepState: sweepEngine.getSweepState(), // fix38h
      breadthChop: getBreadthChopState(), // fix53: volatility breaker state for UI banner + health
      settings: {
        botMode: settings.botMode,
        tradingEnabled: settings.tradingEnabled,
        minScoreToTrade: settings.minScoreToTrade,
        v4MinBuyScore: settings.v4MinBuyScore,
        v4MinSellScore: settings.v4MinSellScore,
        v4AllowSells: settings.v4AllowSells,
        maxTradeUsdt: settings.maxTradeUsdt,
        leverage: settings.leverage,
        maxOpenTrades: settings.maxOpenTrades,
        safeMode: settings.safeMode,
        rejectMixedBtcRegime: settings.rejectMixedBtcRegime,
        rejectMildExtension: settings.rejectMildExtension,
        rejectMomentumConflict: settings.rejectMomentumConflict,
        minSlDistancePct: settings.minSlDistancePct,
        entryConfirmationRequired: settings.entryConfirmationRequired,
        minEntryTimingScore: settings.minEntryTimingScore,
        v4MinBuyEntryTimingScore: settings.v4MinBuyEntryTimingScore,
        v4MinSellEntryTimingScore: settings.v4MinSellEntryTimingScore,
        v4MinRR: settings.v4MinRR,
        v4MinSellRR: settings.v4MinSellRR,
        v4MinNetTpUsdt: settings.v4MinNetTpUsdt,
        v4MinNetTpFeeMult: settings.v4MinNetTpFeeMult,
        v4MinNetRR: settings.v4MinNetRR,
        v4MaxFrontendTpPct: settings.v4MaxFrontendTpPct,
        v4DiagnosticJournal: settings.v4DiagnosticJournal,
        v4MaxTpAtr: settings.v4MaxTpAtr,
        v4RiskWindowHours: settings.v4RiskWindowHours,
        v4MaxConsecutiveLosses: settings.v4MaxConsecutiveLosses,
        v4MaxSessionLossUsdt: settings.v4MaxSessionLossUsdt,
        v4EntryReactionBps: settings.v4EntryReactionBps,
        v4EntryWaitSeconds: settings.v4EntryWaitSeconds,
        v4EntryToleranceAtr: settings.v4EntryToleranceAtr,
        v4WaitingExpiryMinutes: settings.v4WaitingExpiryMinutes,
        v4SymbolLossCooldownMinutes: settings.v4SymbolLossCooldownMinutes,
        btcRegimeMode: settings.btcRegimeMode,
        v4BreadthChopBreaker: settings.v4BreadthChopBreaker, // fix53
        elliottWaveWeight: settings.elliottWaveWeight,
        experimentPresetMode: settings.experimentPresetMode,
      },
      lastError: ''
    };
    store.write('v4_snapshot', snapshot);
    lastScanAt = snapshot.ts;
    lastError = '';
    // fix44a: skip alert batch write removed
    // Auto-retry: replay recent soft-gate rejections every 5 min without browser
    autoRetryRejections(snapshot, settings).catch(e => console.warn('[v4.retry]', e.message));
    return snapshot;
  } catch (e) {
    lastError = e.message;
    snapshot = { ...snapshot, ok: false, lastError, ts: Date.now() };
    addLog('V4_ERROR', e.message);
    return snapshot;
  } finally {
    inFlight = false;
    // fixPCT (B): per-scan visibility — only when there was fresh-move activity, so no spam on dead scans
    try {
      if (_pctStats && (_pctStats.fresh > 0 || _pctStats.strong > 0)) {
        const b = Object.entries(_pctStats.blocks).map(([k, v]) => `${k}:${v}`).join(' ') || 'none';
        addLog('PCT_SCAN', `fresh=${_pctStats.fresh} fetched=${_pctStats.fetched}${_pctStats.capped ? ` capped=${_pctStats.capped}` : ''} strong=${_pctStats.strong} f4leaders=${_pctStats.f4leaders} overrides=${_pctStats.overrides} scoreBypass=${_pctStats.scoreBypass} breadthFightShadow=${_pctStats.breadthFightShadow} conflicts=${_pctStats.conflicts} moverLane=${_moverLaneSymbols.size} | strongBlocks: ${b}`);
      }
    } catch (_ps) {}
  }
}


function ingestCandidate(payload = {}) {
  // fix48v: harvest market-wide F&G from the incoming payload BEFORE any rejection logic — the
  // value is valid market context even when the candidate signal itself is blocked. Frontend posts
  // these every scan cycle, keeping _lastKnownFng fresh for convictionScore. null => fear leg no-ops.
  if (payload && payload.fearGreed != null && Number.isFinite(Number(payload.fearGreed))) {
    _lastKnownFng = Number(payload.fearGreed);
  }
  // fix47: frontend signals DISABLED — backend scanner is sole signal source.
  // Frontend submission caused duplicate floods, reload re-submissions, and A/B data contamination.
  // All signals must originate from backend scanOnce() → buildStructurePlan() → shouldReject().
  const _src = String(payload.source || '').toLowerCase();
  // fix47b: empty source = frontend submission (UI didn't set a source field). Block it.
  // Only allow sources that are explicitly backend-originated.
  const _isKnownBackend = _src.startsWith('backend-planner') || _src.startsWith('backend-retry');
  const _isFrontend = !_isKnownBackend; // anything that isn't explicitly backend = frontend
  const _isRetry = _src.startsWith('backend-retry');
  if (_isFrontend && !_isRetry) {
    return { ok: false, rejected: true, reasons: ['FRONTEND_SIGNALS_DISABLED'], warnings: [],
      note: 'fix47b: Only backend-planner and backend-retry sources accepted. Frontend and unknown sources blocked.' };
  }
  const settings = currentSettings();
  const symbol = String(payload.symbol || payload.sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const side = String(payload.side || '').toUpperCase();
  const scoreInputs = [payload.score, payload.confidence, payload.setupScore, payload.agentConfidence, payload.coinScore]
    .map(v => num(v, NaN))
    .filter(v => Number.isFinite(v));
  const score = scoreInputs.length ? Math.max(...scoreInputs) : 0;
  const entryTimingScore = num(payload.entryTimingScore || payload.timingScore || payload.entryScore, 0);
  const minEntryTimingScore = 0; // fix25b: entry timing disabled; kept for compat/diagnostics
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
  // fix44f: dead hour gate removed from ingestCandidate — structureDetector handles signal quality by hour

  const minScore = minScoreForSide(side, settings);
  const minRR = minRRFor(side, settings); // fix47: always Math.max(2.0, configValue) — no score tier

  // fix48i: mirror the narrow sentinel side-block here (ingestCandidate is the second entry path).
  // Same strict guards: only blocks when sentinel is FRESH, READY, in a clear directional regime,
  // and has removed this side. Self-disables if sentinel stale. No gate inflation.
  try {
    const _sent = sentinel.getSentinel();
    const _sentReady = _sent && _sent.market_regime !== 'UNKNOWN';
    const _sentAge = _sent && _sent.updatedAt ? Date.now() - _sent.updatedAt : Infinity;
    const _sentFresh = _sentAge <= 5 * 60 * 1000;
    const _sentAllowed = Array.isArray(_sent && _sent.allowed_sides) ? _sent.allowed_sides.map(x => String(x).toUpperCase()) : null;
    const _clear = ['STRONG_BULL', 'BULL', 'STRONG_BEAR', 'BEAR'].includes(String(_sent && _sent.market_regime || '').toUpperCase());
    if (_sentReady && _sentFresh && _clear && Array.isArray(_sentAllowed) && _sentAllowed.length > 0 && !_sentAllowed.includes(side)) {
      // fix49k: breadth-override supersedes this gate too (mirror of planner path) — full allowed.
      if (breadthOverrideSide(side, btcRegime, settings) === side) {
        warnings.push(`BREADTH_OVERRIDE_${side}_BEATS_SENTINEL_BLOCK_regime=${_sent.market_regime}`);
      } else {
        reasons.push(`SENTINEL_SIDE_BLOCKED_${side}_regime=${_sent.market_regime}`);
      }
    }
  } catch (_e) { /* sentinel unavailable — do not block */ }

  // fix49h(H2): mirror the breadth-fighting gate here — ingestCandidate is the second entry path
  // (retry signals). Same thresholds, same graded design, same fail-open rules as shouldReject.
  // Without this mirror a retry would replay a breadth-fighting setup straight past the gate
  // (same class of leak as the fix48q retry score-floor bypass).
  try {
    const { sent: _bSent, stale: _bStale, ageMs: _bAgeMs } = getSentinelForCapture();
    const _bPairs = num(_bSent?.vol?.pair_count, 0);
    const _bPct = _bPairs > 0 ? num(_bSent?.vol?.bull_pct, NaN) : NaN;
    if (Number.isFinite(_bPct) && (!_bStale || _bAgeMs <= 30 * 60 * 1000)) {
      // fix49o: mirrored 30/70 -> 50/50, same rationale as the planner-path copy above. Kept
      // identical to that block deliberately — these two sites must move together or they silently
      // diverge (flagged in the fix49n sweep as a known duplication risk; full merge deferred to a
      // dedicated refactor, not bundled into this threshold change).
      const BUY_MIN_BREADTH  = Math.max(0, Math.min(50, Number(process.env.V4_BUY_MIN_BREADTH  || '50')));
      const SELL_MAX_BREADTH = Math.max(50, Math.min(100, Number(process.env.V4_SELL_MAX_BREADTH || '50')));
      if (side === 'BUY') {
        if (_bPct <= BUY_MIN_BREADTH) reasons.push(`BREADTH_FIGHT_BUY_${_bPct.toFixed(0)}PCT_LE_${BUY_MIN_BREADTH}`);
        else if (_bPct <= 65) warnings.push(`BREADTH_SOFT_BUY_${_bPct.toFixed(0)}PCT`);
      } else if (side === 'SELL') {
        if (_bPct >= SELL_MAX_BREADTH) reasons.push(`BREADTH_FIGHT_SELL_${_bPct.toFixed(0)}PCT_GE_${SELL_MAX_BREADTH}`);
        else if (_bPct >= 35) warnings.push(`BREADTH_SOFT_SELL_${_bPct.toFixed(0)}PCT`);
      }
    } else {
      warnings.push('BREADTH_UNAVAILABLE_NO_GATE');
    }
  } catch (_e) { warnings.push('BREADTH_GATE_ERROR_NO_GATE'); }

  const slPct = entry && sl ? Math.abs(entry - sl) / Math.abs(entry) * 100 : 0;
  const minSlPct = Math.max(0, num(settings.minSlDistancePct, MIN_SL_DISTANCE_PCT));
  const leverageForGate = Math.max(1, num(settings.leverage, 5));
  const marginForGate = Math.max(1, num(settings.maxTradeUsdt, 10));
  const positionForGate = marginForGate * leverageForGate;
  const tpRawForGate = entry && tp1 ? Math.abs(tp1 - entry) / Math.abs(entry) : 0;
  const slRawForGate = entry && sl ? Math.abs(entry - sl) / Math.abs(entry) : 0;
  const grossTpForGate = positionForGate * tpRawForGate;
  const grossSlForGate = positionForGate * slRawForGate;
  const feeEstForGate = positionForGate * (FEE_RATE + SLIPPAGE_RATE) * 2;
  const netTpForGate = grossTpForGate - feeEstForGate;
  const netSlForGate = -(grossSlForGate + feeEstForGate);
  const netRrForGate = Math.abs(netSlForGate) ? Math.max(0, netTpForGate) / Math.abs(netSlForGate) : 0;
  const minNetTpInfo = minNetTpDetails(settings, { feeEstUSDT: feeEstForGate });
  const minNetTp = minNetTpInfo.required;
  const minNetRR = minNetRRFor(settings);
  const atrForGate = num(payload.atr || payload.keyLevels?.atr || payload.plan?.atr || payload.plan?.keyLevels?.atr, 0);
  const targetDistance = entry && tp1 ? Math.abs(tp1 - entry) : 0;
  const targetDistanceAtr = atrForGate > 0 ? targetDistance / atrForGate : 0;
  const targetDistancePct = entry ? targetDistance / Math.abs(entry) * 100 : 0;
  const maxTargetAtr = maxTpAtrFor(settings);
  const maxFrontendTpPct = frontendMaxTpPctFor(settings);

  if (!sideAllowed(side, settings)) reasons.push('SELL_SIDE_DISABLED');
  // fix73: DEAD_HOUR birth block — retry path (second entry site, mirrors the shouldReject copy;
  // same dual-site pattern already used for the breadth-fight gate above). Side-agnostic.
  if (isDeadHourLK()) reasons.push(`DEAD_HOUR_NO_NEW_SIGNALS_${deadHourLabel().replace(/\s+/g, '')}`);
  if (!passesRsiDirectionGate(side, payload.rsi)) reasons.push(`RSI_GATE_${side}_${payload.rsi}`);
  if (rr < minRR) reasons.push(`RR_LT_${minRR}`);
  if (slPct > 0 && slPct < minSlPct) reasons.push(`SL_TOO_TIGHT_${slPct.toFixed(2)}_LT_${minSlPct}`);
  // fix42: hard cap on SL width — data: SL>2.5% = 0W 4L, -6.71U across 2 sessions
  if (slPct > 2.5) reasons.push(`SL_TOO_WIDE_${slPct.toFixed(2)}_GT_2.5PCT`);
  if (netTpForGate < minNetTp) reasons.push(`NET_TP_TOO_SMALL_${netTpForGate.toFixed(4)}_LT_${minNetTp}`);
  if (minNetRR > 0 && netRrForGate < minNetRR) reasons.push(`NET_RR_LT_${minNetRR}`);
  // FIX21: score-tiered TP ATR — same logic as shouldReject
  // fix27: same Math.min bug fixed here as in shouldReject
  const scoreTpBonusIngest = score >= 85 ? 2.5 : score >= 75 ? 1.5 : 0;
  const effectiveMaxTpAtrIngest = maxTargetAtr + scoreTpBonusIngest; // no Math.min cap
  if (targetDistanceAtr && targetDistanceAtr > effectiveMaxTpAtrIngest * 1.10) reasons.push(`TP_TOO_FAR_${targetDistanceAtr.toFixed(2)}ATR_GT_${effectiveMaxTpAtrIngest.toFixed(1)}`);
  if (!targetDistanceAtr && targetDistancePct > maxFrontendTpPct) reasons.push(`TP_TOO_FAR_${targetDistancePct.toFixed(2)}PCT_GT_${maxFrontendTpPct}`);

  const btcDecision = btcRegimeDecision({ side, btcRegime: btcRegime || 'unknown', score, math: { rr }, reasons: [], risks: [] }, settings, false);
  reasons.push(...btcDecision.reasons);
  warnings.push(...btcDecision.warnings);

  const text = String([payload.reason, payload.reasons, payload.risks, payload.confluence, payload.elliott, payload.wave, payload.volumeDelta, payload.debug].flat().join(' '));
  if (/watch/i.test(String(payload.state || payload.plannerState || '')) && !/ready/i.test(String(payload.state || payload.plannerState || ''))) reasons.push('NOT_READY_WATCH_ONLY');
  // FIX: In a strongly aligned BTC regime, counter-trend momentum = pullback = ideal entry.
  // SELL in STRONG_BEAR/BEAR with momentary "buy-accel" is selling into a bounce — not a conflict.
  // BUY in STRONG_BULL/BULL with momentary "sell-accel" is buying the dip — not a conflict.
  const btcR = String(btcRegime || '').toUpperCase();
  // fix36: normalize both regimeBrain and sentinelBrain label spaces in ingestCandidate
  const isBearAligned  = side === 'SELL' && ['STRONG_BEAR','BEAR','BEAR_TREND'].includes(btcR);
  const isBullAligned  = side === 'BUY'  && ['STRONG_BULL','BULL','BULL_TREND','BREAKOUT'].includes(btcR);
  // fix43d: mirror shouldReject() fix43 — EXTENSION/MOMENTUM/EW → warnings not hard rejects in ingestCandidate
  // These were still pushing to reasons[] here while shouldReject() was converted to warnings in fix43
  if (settings.rejectMomentumConflict && !isBullAligned && side === 'BUY'  && /short momentum down|bearish divergence|sell[-\s]?accel/i.test(text)) warnings.push('MOMENTUM_OR_VOLUME_CONFLICT_LONG_WARN');
  if (settings.rejectMomentumConflict && !isBearAligned && side === 'SELL' && /short momentum up|bullish divergence|buy[-\s]?accel/i.test(text))  warnings.push('MOMENTUM_OR_VOLUME_CONFLICT_SHORT_WARN');
  if (settings.rejectMildExtension && /mild extension|strong extension|overextended|late wave 5/i.test(text)) warnings.push('EXTENSION_RISK_WARN');
  if (settings.rejectElliottConflict) {
    if (side === 'BUY' && /impulse down|bearish impulse|correction down|bounce sell/i.test(text)) warnings.push('ELLIOTT_WAVE_CONFLICT_LONG_WARN');
    if (side === 'SELL' && /impulse up|bullish impulse|correction up|pullback buy/i.test(text)) warnings.push('ELLIOTT_WAVE_CONFLICT_SHORT_WARN');
  }

  let signals = dedupeLiveSignals(getSignals());

  // fix33-obs12: reject if existing WAITING signal for same sym+side within 0.5% entry
  // This prevents page reloads from re-submitting identical signals that are already queued
  const existingWaiting = signals.find(s =>
    (s.sym === symbol || s.symbol === symbol) &&
    s.side === side &&
    ['WAITING_ENTRY','WAITING_REACTION'].includes(s.paperState) &&
    entry && s.entry && Math.abs(s.entry - entry) / Math.abs(s.entry) < 0.005
  );
  if (existingWaiting) {
    return { ok: false, rejected: true, reasons: ['DUPLICATE_WAITING_ENTRY_SAME_LEVEL'], warnings: [], note: 'Existing WAITING signal at same entry level — not re-queued' };
  }

  // fix35-obs22 (now dead for frontend — blocked above): keep cooldown for backend-retry dedup
  // Backend-retry path can still have duplicate submissions within 15min if retry runs fast

  const duplicateReason = settings.oneTradePerSymbol !== false ? symbolCooldownReason(signals, symbol, side, Date.now(), settings) : '';
  const waitingDuplicate = duplicateReason === 'DUPLICATE_SYMBOL_SIDE_WAITING';
  if (duplicateReason && !waitingDuplicate) reasons.push(duplicateReason);
  if (clusterLossBlocked(signals, side)) reasons.push(`CLUSTER_${side}_LOSSES_COOLDOWN`);
  // fix48f: RR>3.0 HARD block mirrored from shouldReject — NO exemptions (was skeleton-keyed by
  // structureSignal/contrarianFlip, which let every RR>3 counter-trend SELL through). 0 wins/5 losses.
  if (rr > 3.0) reasons.push(`RR_GT_3.0_BLOCKED_${rr.toFixed(2)}`);
  // data-driven: LOCAL_BEAR = 0% WR — block frontend candidates too
  // fix43b: mirror shouldReject() LOCAL_BEAR logic — was unconditional hard reject
  // Now: only hard-block if payload also indicates trend15=bear (k15 confirmation)
  const _ingLocalR = String(payload.localRegime || payload.scoreInfo?.localRegime || '').toUpperCase();
  const _ingTrend15 = String(payload.trend15 || '').toLowerCase();
  if (_ingLocalR === 'LOCAL_BEAR' && _ingTrend15 === 'bear') reasons.push('LOCAL_BEAR_BLOCKED_CONFIRMED');
  else if (_ingLocalR === 'LOCAL_BEAR') warnings.push('LOCAL_BEAR_5M_ONLY_WARN');
  const riskBlock = globalRiskBlockReason(signals, settings);
  if (riskBlock) reasons.push(riskBlock);
  if (!waitingDuplicate && openSignalCount(signals) >= settings.maxOpenTrades) reasons.push('MAX_OPEN_TRADES_REACHED');

  const rejected = reasons.length > 0;
  if (rejected) {
    addLog('V4_CANDIDATE_REJECTED', `${symbol || 'UNKNOWN'} ${side || 'NEU'} ${reasons.slice(0,3).join(',')}`, {score, rr, slPct, btcRegime, warnings});
    // fix44a: skip alert store write removed
    return { ok: false, rejected: true, reasons, warnings, minNetTpInfo, minNetRR, netRr: Number(netRrForGate.toFixed(3)) };
  }

  const now = Date.now();
  const leverage = Math.max(1, num(settings.leverage, 5));
  const margin = Math.max(1, num(settings.maxTradeUsdt, 10));
  const position = margin * leverage;
  const tpPct = Math.abs(tp1 - entry) / Math.abs(entry) * 100;
  const grossTp = position * tpPct / 100;
  const grossSl = position * slPct / 100;
  const feeEst = position * (FEE_RATE + SLIPPAGE_RATE) * 2;
  const netTp = grossTp - feeEst;
  const netSl = -(grossSl + feeEst);
  const netRr = Math.abs(netSl) ? Math.max(0, netTp) / Math.abs(netSl) : 0;
  const sig = {
    id: `v4c_${symbol}_${side}_${now}`,
    source: payload.source || `backend-retry-${V4_VERSION}`, // fix47: use caller's source — never default to frontend label
    plannerVersion: V4_VERSION,
    sym: symbol,
    symbol,
    side,
    contrarianFlip: !!payload.contrarianFlip, // fix48t: arbitration tag (payload spreads built.leader)
    preFlip: payload.preFlip || null,         // fix48t: frozen phantom-BUY plan for offline replay
    contextDiag: payload.contextDiag || null, // fix48w: 48v per-pair/breadth/fear breakdown
    status: 'DETECTED',
    paperState: 'WAITING_ENTRY',
    displayState: 'WAITING_ENTRY',
    positionStatus: 'NONE',
    orderStatus: 'NOT_SENT_PAPER',
    score,
    setupScore: score,
    entryTimingScore,
    minEntryTimingScoreAtCapture: minEntryTimingScore,
    experimentPresetMode: settings.experimentPresetMode || 'research', // fix-preset: was 'balanced' — Research is the only standard
    experimentSettingsSnapshot: { preset: settings.experimentPresetMode || 'research', minScoreToTrade: settings.minScoreToTrade, v4MinBuyScore: settings.v4MinBuyScore, v4MinSellScore: settings.v4MinSellScore, v4AllowSells: settings.v4AllowSells, minEntryTimingScore, v4MinBuyEntryTimingScore: settings.v4MinBuyEntryTimingScore, v4MinSellEntryTimingScore: settings.v4MinSellEntryTimingScore, v4MinRR: settings.v4MinRR, v4MinSellRR: settings.v4MinSellRR, v4MinNetTpUsdt: settings.v4MinNetTpUsdt, v4MinNetTpFeeMult: settings.v4MinNetTpFeeMult, v4MinNetRR: settings.v4MinNetRR, v4MaxTpAtr: settings.v4MaxTpAtr, v4EntryReactionBps: settings.v4EntryReactionBps, v4EntryWaitSeconds: settings.v4EntryWaitSeconds, v4EntryToleranceAtr: settings.v4EntryToleranceAtr, btcRegimeMode: settings.btcRegimeMode, elliottWaveWeight: settings.elliottWaveWeight },
    tier: payload.tier || '',
    entry,
    sl,
    tp1,
    rr,
    rr1: rr,
    netRr: Number(netRr.toFixed(3)),
    margin,
    leverage,
    position,
    tp1Profit: tpPct,
    slPct,
    tp1ProfitUSDT: grossTp,
    slLossUSDT: grossSl,
    netTpUSDT: netTp,
    netSlUSDT: netSl,
    feeEstUSDT: feeEst,
    btcRegime: btcRegime || 'unknown',
    rejectWarnings: warnings,
    diagnostic: { version: V4_VERSION, capturedAt: now, source: payload.source || `backend-retry-${V4_VERSION}`, minNetTpInfo: minNetTpDetails(settings, { feeEstUSDT: feeEst }), gateSnapshot: { minScoreToTrade: settings.minScoreToTrade, minScore, v4MinBuyScore: settings.v4MinBuyScore, v4MinSellScore: settings.v4MinSellScore, v4AllowSells: settings.v4AllowSells, minEntryTimingScore, v4MinBuyEntryTimingScore: settings.v4MinBuyEntryTimingScore, v4MinSellEntryTimingScore: settings.v4MinSellEntryTimingScore, minRR, minNetTp, minNetRR: minNetRRFor(settings), maxTargetAtr, maxFrontendTpPct, btcRegimeMode: settings.btcRegimeMode }, math: { grossTpUSDT: grossTp, grossSlUSDT: grossSl, feeEstUSDT: feeEst, netTpUSDT: netTp, netSlUSDT: netSl, netRr, targetDistanceAtr, targetDistancePct },
      // fix46c: add scoreBreakdown so CSV export can read sc_btcRegime, sc_localRegime etc for retry signals
      scoreBreakdown: payload.scoreInfo || payload.scoring || { btcRegime: btcR, localRegime: payload.localRegime || '', components: {}, rawScore: score, penalties: 0 },
      rawPayload: payload },
    reasons: Array.isArray(payload.reasons) ? payload.reasons.slice(0, 8) : [],
    risks: Array.isArray(payload.risks) ? payload.risks.slice(0, 8) : [],
    planner: {
      source: payload.source || `backend-retry-${V4_VERSION}`, // fix47: use actual source — was hardcoded 'frontend-search-modal'
      entrySource: payload.entrySource || payload.plan?.entrySource || 'retry candidate entry',
      slSource: payload.slSource || payload.plan?.slSource || 'retry candidate SL',
      tpSource: payload.tpSource || payload.plan?.tpSource || 'retry candidate TP',
      confluence: Array.isArray(payload.confluence) ? payload.confluence.slice(0, 10) : [],
      risks: Array.isArray(payload.risks) ? payload.risks.slice(0, 10) : [],
      keyLevels: payload.keyLevels || {},
    },
    entryHit: false,
    stateReason: `${V4_VERSION}: READY setup captured as WAITING_ENTRY; activation requires tight entry zone + directional reaction`,
    history: [{ at: now, state: 'WAITING_ENTRY', reason: `${V4_VERSION}: backend-retry candidate captured; waiting for tight entry zone + directional reaction` }],
    time: new Date(now).toLocaleTimeString().slice(0,5),
    createdAt: now,
    openedAt: null,
    updatedAt: now,
    expireMs: expiryMsFor(settings),
  };
  if (waitingDuplicate) {
    const existing = signals.find(s => s && (s.sym === symbol || s.symbol === symbol) && s.side === side && ['WAITING_ENTRY', 'WAITING_REACTION'].includes(s.paperState));
    if (existing && refreshSignalPlan(existing, sig, 'REFRESHED_WAITING_SETUP_FROM_RETRY')) {
      saveSignals(signals);
      const ledger = upsertLedger(signals);
      snapshot = { ...snapshot, ok: true, ts: now, version: V4_VERSION, signals, ledger: ledger.slice(0, RECENT_LEDGER_LIMIT), summary: { ...computeLedgerSummary(ledger), visible: computeSummary(signals), source: 'v4_paper_ledger' }, settings: currentSettings() };
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
  snapshot = { ...snapshot, ok: true, ts: now, version: V4_VERSION, signals, ledger: ledger.slice(0, RECENT_LEDGER_LIMIT), summary: { ...computeLedgerSummary(ledger), visible: computeSummary(signals), source: 'v4_paper_ledger' }, settings: currentSettings() };
  store.write('v4_snapshot', snapshot);
  addLog('V4_CANDIDATE_CAPTURED', `${symbol} ${side} WAITING_ENTRY`, {score, rr, slPct, btcRegime, warnings});
  appendDiagnosticJournal({ at: now, iso: new Date(now).toISOString(), type: 'BACKEND_CANDIDATE_ACCEPTED', version: V4_VERSION, symbol, side, score, entryTimingScore, rr, slPct, btcRegime, warnings, minNetTpInfo: minNetTpDetails(settings, { feeEstUSDT: feeEst }), minNetRR: minNetRRFor(settings), math: sig.diagnostic.math, signal: normalizeLedgerTrade(sig) }, settings);
  return { ok: true, signal: sig, summary: snapshot.summary, warnings, minNetTpInfo: minNetTpDetails(settings, { feeEstUSDT: feeEst }) };
}

function getSnapshot() {
  const persisted = store.read('v4_snapshot', null);
  if (persisted && persisted.ts && (!snapshot.ts || persisted.ts > snapshot.ts)) snapshot = persisted;
  const signals = getSignals(); const ledger = upsertLedger(signals); return { ...snapshot, signals, visibleSignals: signals.length, ledger: ledger.slice(0, RECENT_LEDGER_LIMIT), summary: { ...computeLedgerSummary(ledger), visible: computeSummary(signals), source: 'v4_paper_ledger' }, settings: currentSettings(), lastError };
}

function start() {
  if (running) return;
  running = true;
  console.log('[Orayan v4] Backend paper signal engine starting');
  try { store.startupDiagnostic(); } catch (_e) {} // fix49l: log resolved DATA_DIR + ephemeral warning
  // fix35-obs20/21: startup purge — expire ALL previous-session WAITING signals
  // fix33 bug: createdAt=0 → num(0, now) = now → age=0 → signal looked fresh → NOT purged
  // fix35: createdAt=0 means NO TIMESTAMP = definitely stale → always purge
  // Also purge signals from previous backend version (obs21) — stale structure
  try {
    const now = Date.now();
    const raw = store.read('v4_signals', []);
    let purged = 0;
    const cleaned = raw.map(s => {
      if (!s) return s;
      // fix48q: ORPHAN-STATE PURGE. Old-build signals (e.g. OPN, BCH — source:NaN, timing '–')
      // carry a paperState in NEITHER ACTIVE_STATES NOR FINAL_STATES. Both the purge below and
      // cancelSignal gate on ACTIVE_STATES.has(), so they skip the orphan → it's immortal AND
      // the cancel button does nothing on it, while the frontend still renders it. Any state
      // outside both sets is by definition corrupt/stale → force-expire it. This can ONLY catch
      // unclassifiable records; no valid live signal is outside both sets.
      // fixZOMBIE: same blind spot as the dedupe-site purge. LIVE_RESTING / LIVE_OPEN come from the
      // unified-brain state machine (lifecycle.js) and are NOT in this older ACTIVE_STATES set, so an
      // order resting on Bybit looked like a corrupt orphan and got force-expired on restart —
      // abandoning real money. Never purge an order-bearing signal; the exchange owns its fate.
      const _orderBearing = !!(s.tradeId || s.orderId || s.orderClaimAt || s.paperState === 'LIVE_RESTING' || s.paperState === 'LIVE_OPEN' || s.paperState === 'LIVE_PENDING');
      if (_orderBearing) return s;
      if (!ACTIVE_STATES.has(s.paperState) && !FINAL_STATES.has(s.paperState)) {
        purged++;
        return { ...s, paperState: 'EXPIRED', displayState: 'EXPIRED', status: 'EXPIRED',
                 positionStatus: 'NONE', closedAt: now,
                 stateReason: `${V4_VERSION}: orphan state (${String(s.paperState)}) — purged on restart` };
      }
      if (!ACTIVE_STATES.has(s.paperState)) return s;
      const createdAt = num(s.createdAt, 0);
      const updatedAt = num(s.updatedAt, 0);
      // fix48l: for WAITING setups use immutable birth epoch (updatedAt bumps every scan and defeated the cap here too).
      const _isWaiting0 = s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION' || s.paperState === 'CANDIDATE';
      const tsRaw = _isWaiting0 ? signalBirthMs(s) : (createdAt || updatedAt); // 0 if both missing
      // fix35-obs20: missing timestamp = unknown age = treat as fully expired
      const age = tsRaw > 0 ? now - tsRaw : EXPIRY_MS + 1;
      const expMs = num(s.expireMs, EXPIRY_MS);
      // fix48g: WAITING/WAITING_REACTION setups respect the 45-min hard cap here too (consistency).
      const _isWaiting = s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION' || s.paperState === 'CANDIDATE';
      const _effExpMs = _isWaiting ? Math.min(expMs, WAITING_HARD_CAP_MS) : expMs;
      // fix35-obs21: signals from previous backend version = stale structure
      const src = String(s.source || '');
      // fix43: removed isOldVersion purge — every version bump was wiping all WAITING signals mid-session.
      // Age-based expiry is sufficient. Signals survive redeploys as long as they're within expiry window.
      const isOldVersion = false; // disabled
      if (age > _effExpMs || tsRaw === 0) {
        purged++;
        const reason = tsRaw === 0 ? 'no timestamp — purged on restart'
                     : isOldVersion ? `old version (${src}) — purged on restart`
                     : 'past signal window — purged on restart';
        return { ...s, paperState: 'EXPIRED', displayState: 'EXPIRED', status: 'EXPIRED',
                 positionStatus: 'NONE', closedAt: now,
                 stateReason: `${V4_VERSION}: ${reason}` };
      }
      return s;
    });
    if (purged > 0) {
      store.write('v4_signals', dedupeLiveSignals(cleaned).slice(0, MAX_SIGNALS));
      console.log(`[Orayan v4] Startup: purged ${purged} stale WAITING signals (no-timestamp or old version)`);
    }
  } catch(e) { console.warn('[Orayan v4] startup purge failed:', e.message); }
  scanOnce().catch(e => console.error('[Orayan v4] first scan failed:', e.message));
  timer = setInterval(() => scanOnce().catch(e => console.error('[Orayan v4] scan failed:', e.message)), LOOP_MS);
  // fixFASTSYNC (07/22): start the decoupled signal↔trade truth loop — see fastSyncOnce().
  setTimeout(() => { try { fastSyncOnce(); } catch (_e) {} }, 7000);
  fastTimer = setInterval(() => { try { fastSyncOnce(); } catch (e) { console.warn('[fastSync]', e.message); } }, FAST_SYNC_MS);
  // fixRETEST (07/26): start the resting-order watch — see restingOrderWatch().
  setTimeout(() => { restingOrderWatch().catch(e => console.warn('[restingWatch]', e.message)); }, 9000);
  restingTimer = setInterval(() => { restingOrderWatch().catch(e => console.warn('[restingWatch]', e.message)); }, RESTING_WATCH_MS);
}

// ============================================================================================
// fixFASTSYNC (07/22): DECOUPLED SIGNAL↔TRADE TRUTH SYNC.
// PROBLEM (live 07/22 morning): signal state only ever advanced inside scanOnce(), at the END of a
// full heavy tick (530-pair fetch + BTC regime + sentinel + planner). When Bybit REST turned slow
// (repeated [bybit/wallet] 10s timeouts, sentinel watchdog 90s force-resets in the Northflank log),
// scan ticks stretched to minutes — so the RECONCILER had already written Bybit truth into the
// trade record (HYPE manually closed on the exchange 06:40, PnL +0.293 booked; PUMPFUN order
// cancelled 06:37) while the SIGNALS and the snapshot the UI renders stayed frozen at LIVE_OPEN /
// LIVE_RESTING for many minutes. The user watched "ACTIVE 1" against an exchange with zero
// positions. Same starvation is why the UI feels laggy: getSnapshot() serves a snapshot only
// scanOnce() refreshes.
// FIX: a lightweight loop on the reconciler's own cadence (15s) that does ONLY the cheap half —
// run unifiedTick (Bybit authority; ignores snapshot price by design) over order-bearing signals
// against the freshly reconciled trade store, and if anything moved, save + refresh ledger +
// snapshot. No tickers, no regime, no planner, no network: pure local disk reads. A wedged
// scanOnce can no longer starve state truth or the UI.
// SAFETY: store.read() parses fresh JSON per call, so this loop and scanOnce hold SEPARATE arrays —
// no shared-object mutation races. Both loops compute signal state through the SAME unifiedTick
// against the same trade store, so whichever saves last writes the same truth (self-converging);
// saveSignals' fixSAVE merge additionally preserves live-link fields across interleavings.
// Skips paper-authority signals entirely (they need a snapshot price; that remains scanOnce's job)
// and skips terminal signals unless reclaimableFinal — the exact predicate the scan loop uses.
const FAST_SYNC_MS = 15000;
let fastTimer = null;
let _fastSyncBusy = false;
function fastSyncOnce() {
  if (_fastSyncBusy) return;
  const _ub = require('./unifiedBrain');
  if (!_ub.flagEnabled()) return; // legacy mode: scanOnce/liveStateAuthority remain sole authors
  _fastSyncBusy = true;
  try {
    const signals = getSignals();
    if (!signals || !signals.length) return;
    let trades = {};
    try { trades = store.read('trades', {}) || {}; } catch (_e) { return; } // no trade truth → nothing to sync
    const now = Date.now();
    let changed = 0;
    for (const s of signals) {
      if (!s) continue;
      if (FINAL_STATES.has(s.paperState) && !reclaimableFinal(s)) continue; // properly terminal — frozen
      // fixFASTCHURN (07/22): MY OWN BUG from fixFASTSYNC, confirmed in the live Northflank log
      // ("FAST_SYNC: 1 signal(s) advanced" repeating every cycle for hours). The change key below
      // included s.realizedPnl — but for a LIVE_OPEN position, lifecycle sets that field to the
      // trade's UNREALISED P&L (lifecycle.js line ~112), which moves with price on every reconciler
      // refresh. So with even one position open, every 15s cycle counted as "changed" and triggered
      // saveSignals + full upsertLedger + snapshot rebuild + disk writes — nonstop, forever — on a
      // 0.2 vCPU box. That constant load is what degraded the whole backend this week. The key now
      // tracks STATE transitions only (paperState/status/result); a real close changes paperState
      // AND result, so terminal P&L still persists exactly as fixUB1 intended. Unrealized display
      // values persist via the normal scanOnce path instead of every 15s.
      const _before = `${s.paperState}|${s.status}|${s.result}`;
      const r = _ub.unifiedTick(s, trades, null, now); // null price: BYBIT authority never reads it,
                                                       // and unhandled (paper) signals are untouched
      if (!r.handled) continue;
      if (`${s.paperState}|${s.status}|${s.result}` !== _before) changed++;
    }
    if (!changed) return;
    saveSignals(signals);
    const ledger = upsertLedger(signals);
    snapshot = { ...snapshot, ok: true, ts: now, version: V4_VERSION, signals, visibleSignals: signals.length, ledger: ledger.slice(0, RECENT_LEDGER_LIMIT), summary: { ...computeLedgerSummary(ledger), visible: computeSummary(signals), source: 'v4_paper_ledger' } };
    store.write('v4_snapshot', snapshot);
    addLog('FAST_SYNC', `${changed} signal(s) advanced from Bybit trade truth (scan-independent)`);
  } catch (e) {
    console.warn('[fastSync]', e && e.message ? e.message : e);
  } finally {
    _fastSyncBusy = false;
  }
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (fastTimer) clearInterval(fastTimer); // fixFASTSYNC
  fastTimer = null;
  if (restingTimer) clearInterval(restingTimer); // fixRETEST
  restingTimer = null;
  running = false;
}

// ============================================================================================
// fixRETEST (07/26): RESTING-ORDER WATCH — tight cadence, existing checks only.
// The new fixRETEST hook (see updateExistingSignals, near signalEntryTiming) rests a real GTC limit
// at the structural entry the moment a genuine retest is detected (s.hadFirstTouch), rather than
// chasing price at confirmation. The precision of the FILL now comes entirely from Bybit's own order
// book — no polling speed matters for that part any more. What still needs watching is the opposite
// question: should this resting order be CANCELLED before it ever fills, because the thesis is dying?
// That check already exists and already runs every scan tick (20s) for ANY waiting signal, live-order
// or not: the SL-breach invalidation (updateExistingSignals ~line 5150) and revalidateWaitingSignal()
// (regime drift / adverse pre-entry drift / momentum reversal). This function does NOT invent new
// judgment — it re-runs those exact two checks, unmodified, at a tighter user-requested cadence
// (RESTING_WATCH_MS, default 10s) but ONLY for the small subset of signals that actually carry a
// resting order (s.liveOrderId set, orderStatus LIMIT_WAITING, not yet filled/terminal) — realistically
// 0-a handful at once, bounded by maxOpenTrades, so this is a few ticker fetches, nothing like the
// 529-pair full sweep that caused the original fixLOOP overload. On ABANDON/breach it calls the same
// flagTradeForCancel() the main loop uses, which the reconciler already honours for a resting PENDING
// order (fix49h(H1)) — cancellation on Bybit is not new code either.
const RESTING_WATCH_MS = Math.max(5000, Number(process.env.V4_RESTING_WATCH_MS || '10000'));
let restingTimer = null;
let _restingWatchBusy = false;
async function restingOrderWatch() {
  if (_restingWatchBusy) return;
  _restingWatchBusy = true;
  try {
    const signals = getSignals();
    if (!signals || !signals.length) return;
    const watching = signals.filter(s => s && s.liveOrderId && s.orderStatus === 'LIMIT_WAITING' && !FINAL_STATES.has(s.paperState));
    if (!watching.length) return; // the common case — zero network calls most ticks
    const { getBybitPrice } = require('./instruments');
    const now = Date.now();
    let changed = 0;
    for (const s of watching) {
      let price;
      try { price = await getBybitPrice(s.symbol); } catch (_e) { continue; } // fail-open — try again next tick
      if (!price) continue;
      const side = String(s.side || '').toUpperCase();
      const sl = num(s.sl);
      // 1. SL-breach — mirrors updateExistingSignals' pre-fill invalidation, unmodified logic.
      const slBreached = (side === 'BUY' && sl > 0 && price <= sl) || (side === 'SELL' && sl > 0 && price >= sl);
      if (slBreached) {
        s.paperState = 'INVALIDATED'; s.status = 'INVALID'; s.displayState = 'INVALIDATED';
        s.positionStatus = 'NONE'; s.closedAt = now;
        s.stateReason = `${V4_VERSION}: RESTING_WATCH — structure broke before fill (SL touched pre-entry)`;
        s.history = [...(s.history || []), { at: now, state: 'INVALIDATED', reason: s.stateReason, price }];
        appendSignalDiagnostic('SIGNAL_INVALIDATED', s, { price, source: 'restingOrderWatch' }, currentSettings());
        flagTradeForCancel(s, 'STRUCTURE_BROKE_PRE_FILL');
        changed++;
        continue;
      }
      // 2. Adaptive re-validation — same revalidateWaitingSignal() the main loop calls; empty market
      // context ({}) degrades gracefully (only the momentum-reversal FREEZE check needs live rsi5, and
      // simply skips itself when absent) — regime drift + adverse pre-entry drift still run in full.
      const reval = revalidateWaitingSignal(s, {}, price, now);
      if (reval.action === 'ABANDON') {
        s.paperState = 'STALE_CANCELLED'; s.status = 'STALE_CANCELLED'; s.displayState = 'STALE_CANCELLED';
        s.positionStatus = 'NONE'; s.closedAt = now;
        s.stateReason = `${V4_VERSION}: RESTING_WATCH — setup cancelled — ${reval.reason}`;
        s.history = [...(s.history || []), { at: now, state: 'STALE_CANCELLED', reason: s.stateReason, price }];
        appendSignalDiagnostic('SIGNAL_STALE_CANCELLED', s, { price, reval, source: 'restingOrderWatch' }, currentSettings());
        flagTradeForCancel(s, 'REVALIDATION_ABANDON');
        changed++;
      }
    }
    if (!changed) return;
    saveSignals(signals);
    const ledger = upsertLedger(signals);
    snapshot = { ...snapshot, ok: true, ts: now, version: V4_VERSION, signals, visibleSignals: signals.length, ledger: ledger.slice(0, RECENT_LEDGER_LIMIT), summary: { ...computeLedgerSummary(ledger), visible: computeSummary(signals), source: 'v4_paper_ledger' } };
    store.write('v4_snapshot', snapshot);
    addLog('RESTING_WATCH', `${changed} resting order(s) cancelled — structure broke before fill`);
  } catch (e) {
    console.warn('[restingWatch]', e && e.message ? e.message : e);
  } finally {
    _restingWatchBusy = false;
  }
}


function cancelSignal({ id = '', signalId = '', symbol = '', side = '', reason = 'USER_CANCELLED' } = {}) {
  const now = Date.now();
  const targetId = String(signalId || id || '').trim();
  const targetSymbol = String(symbol || '').toUpperCase().replace(/USDT$/, 'USDT');
  const targetSide = String(side || '').toUpperCase();
  let signals = getSignals();
  let changed = false;
  let cancelled = [];
  signals = signals.map(s => {
    if (!s) return s;
    const sid = String(s.id || s.signalId || '').trim();
    const ssym = String(s.sym || s.symbol || '').toUpperCase();
    const sside = String(s.side || '').toUpperCase();
    const idMatch = targetId && sid === targetId;
    const symbolMatch = targetSymbol && ssym === targetSymbol && (!targetSide || sside === targetSide);
    if (!(idMatch || symbolMatch)) return s;
    // fix48q: allow cancel on ACTIVE signals AND on ORPHAN-state signals (paperState in neither
    // ACTIVE nor FINAL — the zombie). Previously gated on ACTIVE_STATES.has() alone, so the
    // cancel button silently did nothing on an orphan (returned SIGNAL_NOT_FOUND_OR_TERMINAL).
    // Still refuse to re-touch a properly-terminal (FINAL) signal.
    const _isOrphan = !ACTIVE_STATES.has(s.paperState) && !FINAL_STATES.has(s.paperState);
    if (!ACTIVE_STATES.has(s.paperState) && !_isOrphan) return s;
    const next = {
      ...s,
      paperState: 'INVALIDATED',
      displayState: 'INVALIDATED',
      status: 'INVALIDATED',
      result: 'INVALIDATED',
      positionStatus: 'NONE',
      updatedAt: now,
      closedAt: now,
      stateReason: `${V4_VERSION}: ${reason}`,
    };
    next.history = Array.isArray(s.history) ? s.history.concat([{ at: now, state: 'INVALIDATED', reason }]) : [{ at: now, state: 'INVALIDATED', reason }];
    changed = true;
    cancelled.push(next);
    return next;
  });
  if (!changed) return { ok: false, error: 'SIGNAL_NOT_FOUND_OR_TERMINAL', id: targetId, symbol: targetSymbol, side: targetSide };
  saveSignals(signals);
  // fixUICANCEL (07/22, live EPICUSDT −0.42U): cancelSignal only ever moved the PAPER signal to
  // INVALIDATED. It never touched the trade record, so trades[tradeId].signalInvalidated stayed
  // false and the reconciler's invalidate-cancel block (fix44b/fix49h) had nothing to act on — the
  // resting GTC limit stayed live on Bybit. Observed: user cancelled EPIC 21:41, the abandoned order
  // filled 57 min later at 22:38 and closed −0.42U at 22:39. That loss is real money and it is
  // INVISIBLE in the paper ledger, which still reads INVALIDATED / realizedPnl 0 — so both the
  // equity curve and every win-rate/expectancy number are understating live losses.
  // Flag only; the reconciler still decides. Its _unfilled guard means an order that already filled
  // is never cancelled here — a real position belongs to liveStateAuthority.
  // ROUND-3: batched into ONE read/write. flagTradeForCancel() does its own store.read + store.write
  // per call; a symbol-match cancel can hit several signals at once, and N read-modify-write cycles
  // against a reconciler running concurrently is exactly the last-write-wins race fixSAVE was built
  // to kill. One read, mutate all, one write.
  try {
    const _trades = store.read('trades', {});
    let _flagged = 0;
    for (const c of cancelled) {
      if (!c || !c.tradeId || !_trades[c.tradeId]) continue;
      _trades[c.tradeId].signalInvalidated = true;
      _trades[c.tradeId].invalidateReason = String(reason || 'USER_CANCELLED');
      _trades[c.tradeId].invalidateFlaggedAt = now;
      _flagged++;
    }
    if (_flagged) store.write('trades', _trades);
  } catch (_e) { /* never fail the cancel because the trade store hiccupped */ }
  const ledger = upsertLedger(signals);
  snapshot = { ...snapshot, ok: true, ts: now, version: V4_VERSION, signals, visibleSignals: signals.length, ledger: ledger.slice(0, RECENT_LEDGER_LIMIT), summary: { ...computeLedgerSummary(ledger), visible: computeSummary(signals), source: 'v4_paper_ledger' } };
  store.write('v4_snapshot', snapshot);
  addLog('V4_SIGNAL_CANCELLED', `${cancelled[0]?.symbol || cancelled[0]?.sym || targetSymbol} ${cancelled[0]?.side || targetSide} cancelled`, { id: targetId, reason });
  return { ok: true, cancelled: cancelled.length, signal: cancelled[0], summary: snapshot.summary };
}

function clearSignals({ archive = true, clearLedger = false } = {}) {
  // fix39b: stamp the reset time so globalRiskBlockReason ignores pre-reset losses
  store.write('v4_risk_reset_ts', { ts: Date.now() });
  const signals = getSignals();
  const ledgerBefore = upsertLedger(signals);
  if (archive && signals.length) {
    const sessions = getSessions();
    sessions.unshift({ at: Date.now(), summary: computeSummary(signals), ledgerSummary: computeLedgerSummary(ledgerBefore), signals });
    saveSessions(sessions);
  }
  saveSignals([]);
  if (clearLedger) saveLedger([]);
  store.write('trades', {}); // fix44b: clear trade slots on session reset
  store.write('v4_candidate_rejections', []); // fix44d: clear stale rejections on session reset
  const ledger = clearLedger ? [] : getLedger();
  snapshot = { ...snapshot, signals: [], visibleSignals: 0, ledger: ledger.slice(0, RECENT_LEDGER_LIMIT), summary: { ...computeLedgerSummary(ledger), visible: computeSummary([]), source: 'v4_paper_ledger' }, ts: Date.now() };
  store.write('v4_snapshot', snapshot);
  return { ok: true, archived: archive && signals.length ? 1 : 0, total: 0, ledgerTotal: ledger.length, ledgerCleared: !!clearLedger };
}


function freshJournal() {
  saveSignals([]);
  saveLedger([]);
  store.write('trades', {}); // fix44b: clear trade slots on fresh session
  store.write('v4_candidate_rejections', []); // fix44d: clear stale rejections on fresh session
  // fix44a: v4_candidate_rejections clear removed (system disabled)
  store.write('v4_diagnostic_journal', []);
  if (typeof store.clearNdjson === 'function') store.clearNdjson('v4_diagnostic_journal');
  diagnosticRecentCache = [];
  store.write('legacy_browser_signals', { at: Date.now(), total: 0, note: `cleared by v${V4_VERSION} freshJournal` });
  snapshot = { ...snapshot, ts: Date.now(), signals: [], visibleSignals: 0, ledger: [], summary: computeLedgerSummary([]) };
  store.write('v4_snapshot', snapshot);
  return { ok: true, cleared: true, source: `v${V4_VERSION} freshJournal` };
}

function getLeaderboard() {
  return getSnapshot().entries || [];
}

// manual retry endpoint — called by frontend /api/v4/retry-rejections
async function manualRetryRejections({ maxAgeMinutes = 240, minScore = 60 } = {}) {
  const settings = currentSettings();
  const now = Date.now();
  const cutoff = now - Math.max(10, Math.min(1440, maxAgeMinutes)) * 60 * 1000;
  const HARD_PREFIXES = [
    'BAD_SYMBOL','NO_DIRECTION','PLAN_MISSING',
    'BUY_PLAN_DIRECTION_INVALID','SELL_PLAN_DIRECTION_INVALID',
    'DUPLICATE_SYMBOL_SIDE_ACTIVE','MAX_OPEN_TRADES_REACHED',
    'CLUSTER_BUY_LOSSES_COOLDOWN','CLUSTER_SELL_LOSSES_COOLDOWN',
    'GLOBAL_RISK_BLOCK','ENRICH_ERROR',
  ];
  const rows = store.read('v4_candidate_rejections', []);
  const candidates = rows.filter(r => {
    if (!r || !r.at || r.at < cutoff) return false;
    if (num(r.score, 0) < Math.max(0, minScore)) return false;
    const reasons = Array.isArray(r.reasons) ? r.reasons : [];
    return !reasons.some(rs => HARD_PREFIXES.some(p => String(rs).startsWith(p)));
  });
  const seen = new Map();
  for (const r of candidates) {
    const k = `${r.symbol}_${r.side}`;
    if (!seen.has(k) || r.at > seen.get(k).at) seen.set(k, r);
  }
  const deduped = [...seen.values()].sort((a, b) => num(b.score, 0) - num(a.score, 0));
  let captured = 0, retried = 0;
  for (const r of deduped) {
    if (openSignalCount(getSignals()) >= settings.maxOpenTrades) break;
    retried++;
    const payload = r.rawPayload || {
      symbol: r.symbol, sym: r.symbol, side: r.side,
      score: r.score, setupScore: r.score, confidence: r.score,
      entryTimingScore: r.entryTimingScore || 0, // fix42: was 68 (frontend default)
      source: `backend-retry-${V4_VERSION}`,     // fix42: correct attribution
      entry: r.plan?.entry, sl: r.plan?.sl, tp1: r.plan?.tp1,
      rr: r.rr, atr: 0, btcRegime: r.btcRegime || '',
      state: 'READY', keyLevels: {}, plan: r.plan || {},
    };
    // fix42: override stale btcRegime with current live regime
    payload.btcRegime = getBTCRegime()?.regime || payload.btcRegime || '';
    const result = ingestCandidate(payload);
    if (result.ok) captured++;
  }
  return { ok: true, retried, captured, stillRejected: retried - captured, total: deduped.length };
}

module.exports = {
  V4_VERSION, // fix48u: export so /health + /api/v4/status report the live code version
  getConfigFlags: () => ({ FIXCONFIRM_ENTRY_MARKET, fixRetestEnabled: true, restingWatchMs: RESTING_WATCH_MS }), // fixVERIFY (07/26): lets /health report the live value of entry-placement flags directly from the running process, so a deploy can be confirmed correct with zero live trades — needed because these hooks only fire when tradingEnabled=true, so logs alone can't verify a dry/warmup run.
  getLedgerReconcileStats, // fix49s: zombie-reconcile heartbeat — lastAt/totalReconciled for /health
  start,
  stop,
  fastSyncOnce, // fixFASTSYNC: exported for tests + manual ops trigger; timer in start() is the normal driver
  scanOnce,
  getSnapshot,
  getSignals,
  getLedger,
  computeLedgerSummary,
  clearSignals,
  computeSummary,
  getLeaderboard,
  getDiagnostics,
  getBreadthHistory,
  getBybitTruthSummary, // fixTRUTHPERM: permanent, incrementally-folded Bybit Truth stats — instant, no 1500-row rescan
  freshJournal,
  cancelSignal,
  ingestCandidate,
  manualRetryRejections,
  // New: PnL history + balance recording
  computeDailyPnl,
  updateAllTimePnl,
  getAllTimePnl,
  recordBalanceSnapshot,
  getBalanceHistory,
  // fix52: permanent (decay-proof) stats + dead-hour helpers
  getPermanentStats,
  recordPermanentResults,
  getPermanentSummary,
  isDeadHourLK,
  lkMinuteOfDay,
  // fix53: breadth-volatility circuit breaker
  breadthChop,
  breadthChopActive,
  getBreadthChopState,
  // fix57: read-only live divergence detector
  detectLiveDivergences,
  // fixADAPT: adaptive per-side regime (trailing-WR) for /health observability
  getAdaptiveRegime,
  // fixPHASE2: expired-signal opportunity-cost analysis (manual trigger, see routes/v4.js)
  analyzeExpiredOpportunityCost,
  // fixPHASE1: shadow-only unified entry-decision engine (not wired into any live gate yet)
  decideLiveEntry,
  // fixREVERSAL: real backtest of the mirror-trade hypothesis on actual closed Bybit trades
  analyzeReversalHypothesis,
};
