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
const { detectBTCRegime, getBTCRegime, detectLocalRegime, getAllowedSides } = require('./regimeBrain');
const sentinel   = require('./sentinelBrain'); // fix29: market sentinel
const sweepEngine = require('./sweepEngine');    // fix38h: liquidity sweep detector
const structureDetector = require('./structureDetector'); // fix44f: squeeze/trap/BOS/CHoCH/divergence + fix46c: Elliott Waves
const { analyzeStructure, analyzeElliottWaves } = structureDetector;

const LOOP_MS = Math.max(15000, parseInt(process.env.V4_SCAN_INTERVAL_MS || process.env.BACKEND_SCAN_INTERVAL_MS || '20000', 10));
const MAX_SYMBOLS = Math.max(20, Math.min(160, parseInt(process.env.V4_SCAN_SYMBOLS || process.env.BACKEND_SCAN_SYMBOLS || '80', 10)));
const MAX_SIGNALS = Math.max(40, Math.min(250, parseInt(process.env.V4_MAX_SIGNALS || '120', 10)));
const MAX_LEDGER = Math.max(500, Math.min(20000, parseInt(process.env.V4_MAX_LEDGER || '5000', 10)));
const RECENT_LEDGER_LIMIT = Math.max(50, Math.min(1000, parseInt(process.env.V4_RECENT_LEDGER_LIMIT || '250', 10)));
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
const COOLDOWN_MS = Math.max(0, Number(process.env.V4_SYMBOL_COOLDOWN_MINUTES || process.env.COOLDOWN_MINUTES || 240)) * 60 * 1000; // fix47: removed EXPIRY_MS floor — cooldown is independent of signal expiry window
const PUBLIC_BASE = process.env.V4_MARKET_BASE_URL || 'https://api.bybit.com';
const FEE_RATE = Math.max(0, Number(process.env.V4_FEE_RATE || '0')); // fix48y: fees removed from paper P&L (real Bybit taker ~0.013-0.02/trade — extract from exchange instead). Restore via V4_FEE_RATE env.
const SLIPPAGE_RATE = Math.max(0, Number(process.env.V4_SLIPPAGE_RATE || '0')); // fix48y: slippage padding removed (was inflating netSl, crushing realized RR). Restore via V4_SLIPPAGE_RATE env.
const V4_VERSION = '4.6.8.48z'; // fix48z: (1) SELL unblocked in bull-LABEL when breadth is bearish (<45% bull) — the label lags/lies, breadth governs; good SELL setups (CHoCH BEAR, divergence) were wrongly blocked. (2) ZOMBIE SWEEP — auto force-EXPIRE orphan paperStates (neither ACTIVE nor FINAL) every scan tick, not just on manual cancel. Carries all prior fixes.

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


const ACTIVE_STATES = new Set(['WAITING_ENTRY', 'WAITING_REACTION', 'PAPER_ACTIVE']);
const FINAL_STATES = new Set(['TP_HIT', 'SL_HIT', 'INVALIDATED', 'EXPIRED', 'REJECTED', 'STALE_CANCELLED', 'REGIME_FLIP_EXIT']);

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
let lastAutoRetryAt = 0; // throttle: auto-retry runs at most every 5 min
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
  // "fresh" = sentinel actually has breadth data AND a known regime
  const _volPairs = num(live?.vol?.pair_count, num(live?.components?.vol?.pair_count, 0));
  const _regimeKnown = live && live.market_regime && live.market_regime !== 'UNKNOWN';
  const _fresh = !!live && _volPairs > 0 && _regimeKnown;
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

function appendDiagnosticJournal(row, settings = currentSettings()) {
  if (!diagnosticEnabled(settings)) return;
  try {
    const cleanRow = normalizeDiagnosticRow(row || {});
    // Append-only NDJSON is the durable diagnostic source of truth. This avoids
    // repeatedly rewriting a large JSON array during high-frequency scans.
    if (typeof store.appendNdjson === 'function') {
      store.appendNdjson('v4_diagnostic_journal', cleanRow);
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
  const position = margin * leverage;
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
function determineDirection(trend5, trend15, trend1h, elliottAnalysis, structure) {
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
    // Contested bull label → neutral for whichever side we're scoring. No bonus, no penalty.
    regimeMult = 0.90;
    regimeNote = _conflictNote;
    risks.push(_conflictNote);
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
  } else {
    // CHOP / UNKNOWN — no directional edge from regime, but should NOT punish.
    // fix48h-cal: 0.75→0.90. At 0.75 every signal during the post-restart UNKNOWN-regime warmup
    // window scored ~44 and the system went fully silent. 0.90 is neutral: no help, no penalty.
    regimeMult = 0.90;
    if (btcR === 'CHOP') risks.push('BTC chop — regime gives no directional edge');
  }

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
  const structure = structureDetector.analyzeStructure(k5, Array.isArray(k15) ? k15 : [], trend5);
  const elliottAnalysis = analyzeElliottWaves(k5c, k15c, k60c);
  ctx.elliottAnalysis = elliottAnalysis; // passed into convictionScore via ctx
  ctx.structure = structure;             // passed into convictionScore via ctx

  // fix48: determineDirection — 2-of-3 family vote (Elliott, structure, all-3TF trend)
  const decision = determineDirection(trend5, trend15, trend1h, elliottAnalysis, structure);
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
    entry = nearSupport ? price : Math.max(support + minBuffer * 0.35, price - atr * 0.6);
    sl = Math.min(support - minBuffer, entry - atr * 0.55);
    const structureTp = resistance;
    tp1 = structureTp > entry ? structureTp : 0;
    entrySource = nearSupport ? 'current price near support' : 'pullback toward support';
    slSource = 'below support invalidation';
    tpSource = 'nearest resistance liquidity';
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
    entry = nearResistance ? price : Math.min(resistance - minBuffer * 0.35, price + atr * 0.6);
    sl = Math.max(resistance + minBuffer, entry + atr * 0.55);
    const structureTp = support;
    tp1 = structureTp < entry ? structureTp : 0;
    entrySource = nearResistance ? 'current price near resistance' : 'pullback toward resistance';
    slSource = 'above resistance invalidation';
    tpSource = 'nearest support liquidity';
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
    rsi: Number(rsi.toFixed(1)),
    volRatio: Number(volRatio.toFixed(2)),
    change24h: Number(num(ticker.change24h).toFixed(2)),
    turnover24h: num(ticker.turnover24h),
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
  if (st === 'TP_HIT' || st === 'WIN') return 'TP_HIT';
  if (st === 'SL_HIT' || st === 'LOSS') return 'SL_HIT';
  if (st === 'INVALIDATED' || st === 'INVALID') return 'INVALIDATED';
  if (st === 'EXPIRED') return 'EXPIRED';
  if (st === 'STALE_CANCELLED') return 'STALE_CANCELLED';
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
  if (st === 'PAPER_ACTIVE') return 1000000 + num(s.updatedAt || s.createdAt);
  if (st === 'WAITING_REACTION') return 500000 + num(s.score) * 100 + num(s.rr || s.rr1) * 10 + num(s.updatedAt || s.createdAt) / 1000000;
  if (st === 'WAITING_ENTRY') return 250000 + num(s.score) * 100 + num(s.rr || s.rr1) * 10 + num(s.updatedAt || s.createdAt) / 1000000;
  return num(s.updatedAt || s.createdAt);
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
  for (const s of list || []) {
    if (!s || !ACTIVE_STATES.has(s.paperState)) continue;
    const id = s.id || tradeKey(s);
    if (!liveKeep.has(id) || seenLive.has(id)) continue;
    seenLive.add(id);
    out.push(s);
  }
  return out.sort((a, b) => num(b.createdAt || b.updatedAt) - num(a.createdAt || a.updatedAt)).slice(0, MAX_SIGNALS);
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
    // direction_match and strict both block BUY in bear regime
    if (mode === 'direction_match' || mode === 'strict') {
      reasons.push(`BTC_${regime}_BLOCKS_BUY`);
      return { reasons, warnings };
    }
    warnings.push(`BTC_${regime}_WEAK_FOR_BUY`);
  }
  if (side === 'SELL' && BULL_REGIMES.includes(regime)) {
    // direction_match and strict both block SELL in bull regime
    if (mode === 'direction_match' || mode === 'strict') {
      reasons.push(`BTC_${regime}_BLOCKS_SELL`);
      return { reasons, warnings };
    }
    warnings.push(`BTC_${regime}_WEAK_FOR_SELL`);
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
  if (_sentinelSideBlock) {
    reasons.push(`SENTINEL_SIDE_BLOCKED_${_sideUp}_regime=${sent.market_regime}`);
  }
  // NOTE: sentinel score/RR gate INFLATION remains disabled — only the binary side-block above is active.

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
  // fix38h: sweep engine — suppress swept-side, boost confirmed fade-side
  const _sweepCtx = { k5: leader.k5 || [], k15: leader.k15 || [] };
  const _sweepResult = sweepEngine.applyToSignal(leader, _sweepCtx, reasons);
  if (_sweepResult.suppressed) {
    // already pushed reason inside applyToSignal
  }
  if (_sweepResult.scoreBoost) {
    leader._sweepBoost = _sweepResult.scoreBoost;
    leader._sweepTag   = _sweepResult.tag;
    leader._sweepConfirmations = _sweepResult.confirmations;
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

  if (!['BUY', 'SELL'].includes(leader.side)) reasons.push('NO_DIRECTION');
  // fix44f: contrarian flip SELLs bypass SELL_SIDE_DISABLED — they're high-conviction counter-trend trades
  if (!sideAllowed(leader.side, settings) && !leader.contrarianFlip) reasons.push('SELL_SIDE_DISABLED');
  // fix48: block entries where price is already at/past the planned zone (entryDistanceAtr ≤ 0.25)
  // Data: 16 losses vs 3 wins (16% WR) when entry is this tight.
  // Root cause: tight entries = momentum-chase with noise stop, no pullback, gets stopped immediately.
  const _entryAtr = num(leader?.scoreInfo?.entryDistanceAtr, 0);
  if (_entryAtr > 0 && _entryAtr <= 0.25) reasons.push('ENTRY_ALREADY_AT_ZONE');

  if (leader.score < minScore) reasons.push(`SCORE_LT_${minScore}`);
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
    if (leader.side === 'BUY' && leader.trend5 === 'bear' && leader.trend15 === 'bear' && leader.trend1h === 'bear' && !leader.structureSignal && !leader.contrarianFlip) reasons.push('TREND_CONFLICT_LONG');
    if (leader.side === 'SELL' && leader.trend5 === 'bull' && leader.trend15 === 'bull' && leader.trend1h === 'bull' && !leader.structureSignal && !leader.contrarianFlip) reasons.push('TREND_CONFLICT_SHORT');
  }

  if (settings.rejectRsiConflict) {
    if (leader.side === 'BUY' && leader.rsi >= 78) reasons.push('RSI_OVERBOUGHT_ON_LONG');
    if (leader.side === 'SELL' && leader.rsi <= 22) reasons.push('RSI_OVERSOLD_ON_SHORT');
  }

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

  const gate = {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    warnings: [...new Set(warnings)],
    minNetTpInfo, minNetRR, netRr: num(leader.math.netRr, 0),
    // fix24-b: new timing fields replace entryTimingScore. fix27: NOT_IN_ENTRY_ZONE moved to warnings
    zoneTouchScore, reactionScore,
    minZoneTouch, minRR, minScore, slPct, minSlPct
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
    if ((s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION') && _waitingAge > Math.min(num(s.expireMs, EXPIRY_MS), WAITING_HARD_CAP_MS)) {
      changed = true;
      return { ...s, paperState: 'EXPIRED', displayState: 'EXPIRED', status: 'EXPIRED', positionStatus: 'NONE', updatedAt: now, closedAt: now, stateReason: `${V4_VERSION}: stale waiting setup expired (hard cap; age ${Math.round(_waitingAge/60000)}min)` };
    }
    return s;
  });
  const deduped = dedupeLiveSignals(normalized);
  if (changed || deduped.length !== data.length) store.write('v4_signals', deduped.slice(0, MAX_SIGNALS));
  return deduped;
}

function saveSignals(signals) {
  store.write('v4_signals', dedupeLiveSignals(signals || []).slice(0, MAX_SIGNALS));
}

function tradeKey(s) {
  s = s || {};
  return `${s.sym || s.symbol || ''}|${s.side || ''}|${s.entry || ''}|${s.sl || ''}|${s.tp1 || ''}`;
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
    s.paperState === 'TP_HIT' || s.status === 'WIN' ? 'WIN' :
    s.paperState === 'SL_HIT' || s.status === 'LOSS' ? 'LOSS' :
    s.paperState === 'REGIME_FLIP_EXIT' ? (s.status === 'WIN' ? 'WIN' : 'LOSS') :
    s.paperState === 'INVALIDATED' ? 'INVALIDATED' :
    s.paperState === 'EXPIRED' ? 'EXPIRED' :
    s.paperState === 'STALE_CANCELLED' ? 'STALE_CANCELLED' :
    s.paperState === 'REJECTED' ? 'REJECTED' :
    s.paperState === 'PAPER_ACTIVE' ? 'ACTIVE' :
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

function upsertLedger(signals = []) {
  const ledger = getLedger();
  const merged = saveLedger([...ledger, ...(signals || []).map(normalizeLedgerTrade)]);
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
  const waiting = rows.filter(s => s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION').length;
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
  s.diag.rsiAtEntry = num(s.rsi,
                       num(s.scoreInfo?.rsi,
                       num(s.scoring?.rsi,
                       num(s.leader?.rsi,
                       num(s.candidate?.rsi, null)))));
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
  } catch (_e) {
    s.diag.breadthBullPctAtEntry = null;
    s.diag.sentinelStaleAtEntry = null;
    s.diag.breadthOverrideAtEntry = null; // fix48s
    s.diag.contrarianFlipAtEntry = null;  // fix48t
    s.diag.fearGreedAtEntry = null;       // fix48v
    s.diag.contextMultAtEntry = null;     // fix48v
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

  return { action: 'OK', reason: '' };
}

function updateExistingSignals(signals, priceMap) {
  const now = Date.now();
  const settings = currentSettings();
  let changed = false;
  for (const s of signals) {
    if (!s || FINAL_STATES.has(s.paperState)) continue;

    // fix48g: TIME-BASED EXPIRY runs BEFORE the price guard.
    // Bug: a WAITING signal whose symbol has no price in priceMap (illiquid/delisted pair) hit
    // `if(!price) continue` below and skipped the 45-min hard cap entirely — sitting for HOURS
    // (PLAYSOUT observed at 388 min). Age needs no price. Expire stale waiting setups here first.
    if (s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION') {
      const _ageNoPrice = now - signalBirthMs(s); // fix48l: immutable birth epoch, not createdAt||updatedAt (updatedAt bumps every scan → zombie)
      const _capNoPrice = Math.min(num(s.expireMs, expiryMsFor(settings)), WAITING_HARD_CAP_MS);
      if (_ageNoPrice > _capNoPrice) {
        s.paperState = 'EXPIRED';
        s.status = 'EXPIRED';
        s.displayState = 'EXPIRED';
        s.positionStatus = 'NONE';
        s.closedAt = now;
        s.updatedAt = now;
        s.stateReason = `${V4_VERSION}: waiting setup expired at ${Math.round(_ageNoPrice/60000)}min (cap ${Math.round(_capNoPrice/60000)}min)${num(priceMap.get(s.sym)?.markPrice||priceMap.get(s.symbol)?.markPrice,0) ? '' : ' — no live price feed'}`;
        s.history = [...(s.history || []), { at: now, state: 'EXPIRED', reason: s.stateReason }];
        changed = true;
        continue;
      }
    }

    const market = priceMap.get(s.sym) || priceMap.get(s.symbol) || {};
    const price = num(market.markPrice || market.lastPrice || market.close || s.backendLastPrice);
    if (!price) continue;

    const prevState = s.paperState;
    s.backendLastPrice = roundPrice(price);
    s.updatedAt = now;

    const entry = num(s.entry), sl = num(s.sl);
    const side = s.side;
    const age = now - signalBirthMs(s); // fix48l: immutable birth epoch (was num(s.createdAt, now) — missing createdAt made age=0, dodging cap)
    const atr = num(s.planner?.keyLevels?.atr, Math.abs(entry - sl));

    if (s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION') {
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
        // fix44b: flag trade for cancel in reconciler
        if (s.tradeId) { const trades = store.read('trades', {}); if (trades[s.tradeId]) { trades[s.tradeId].signalInvalidated = true; store.write('trades', trades); } }
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
        // fix44b: flag trade for cancel in reconciler
        if (s.tradeId) { const trades = store.read('trades', {}); if (trades[s.tradeId]) { trades[s.tradeId].signalInvalidated = true; store.write('trades', trades); } }
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
        // mirror the invalidation cancel path so any pending live order is pulled
        if (s.tradeId) { const trades = store.read('trades', {}); if (trades[s.tradeId]) { trades[s.tradeId].signalInvalidated = true; store.write('trades', trades); } }
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
      if (timing.inZone && timing.directional) {
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
        // fix44b: live execution hook
        if (settings.botMode === 'LIVE_REAL_BYBIT' && settings.tradingEnabled && !s._autoTraded) {
          const { activeTrades } = require('./executor');
          // fix44e: use activeTrades() directly — previous filter missed ORDER_SUBMITTED status
          const liveCount = activeTrades().length;
          if (liveCount >= (settings.maxOpenTrades || 3)) {
            addLog('LIVE_SKIPPED', `${s.symbol} ${s.side} — maxOpenTrades reached (${liveCount})`);
          } else {
          s._autoTraded = true;
          const _executor = require('./executor');
          _executor.executeSignal({ ...s, plan: s.plan || { entry: s.entry, sl: s.sl, tp1: s.tp1 }, leverage: settings.leverage || 5, margin: settings.maxTradeUsdt || 5 }, settings)
            .then(r => {
              if (r && r.ok) {
                const sigs = getSignals();
                const idx = sigs.findIndex(x => x.id === s.id);
                if (idx >= 0) { sigs[idx].orderId = r.orderId; sigs[idx].tradeId = r.tradeId; sigs[idx].orderStatus = 'SENT_LIVE'; saveSignals(sigs); }
                addLog('LIVE_PLACED', `${s.symbol} ${s.side} order placed`, { orderId: r.orderId, tradeId: r.tradeId });
              } else {
                addLog('LIVE_REJECTED', `${s.symbol} ${s.side} order failed`, { reason: r?.error || 'unknown' });
              }
            })
            .catch(e => addLog('LIVE_ERROR', `${s.symbol} ${s.side} executor error: ${e.message}`));
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
      // against its side (e.g. SELL when BEAR→BULL). Close at the CURRENT market price now — cutting
      // the loss early instead of riding to full SL. This is the active-position half of the adaptive
      // guard; the data showed 4 of 6 losing SELLs were already open when the flip happened.
      if (s.regimeFlipExit && price) {
        finalizeActiveDiagnostics(s, now);
        const entryPx = num(s.entry);
        const slDist = Math.abs(entryPx - num(s.sl)) || 1e-9;
        // realised R at the moment of the flip exit (signed): + if in profit, - if underwater
        const rAtExit = String(s.side).toUpperCase() === 'BUY'
          ? (price - entryPx) / slDist
          : (entryPx - price) / slDist;
        // map R to USDT using the same risk unit the trade was sized with
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
    .filter(s => s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION')
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
          }
        } catch (_e5) { /* keep 1m-only data if 5m fetch fails */ }
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
        rr: r.rr, atr: atrEst,
        btcRegime: getBTCRegime()?.regime || r.btcRegime || '',
        state: 'READY', keyLevels: {}, plan: r.plan || {},
      };
    }

    // fix48q: SCORE-FLOOR ENFORCEMENT ON RETRY. The retry path (fresh build + stale fallback)
    // reached ingestCandidate without re-checking minScoreToTrade — OPN fired at score 68 after
    // the user set the floor to 70. Enforce the floor here, covering BOTH payload branches.
    const _retryScore = num(payload?.score, 0);
    const _retryFloor = Math.max(0, Math.min(100, num(settings.minScoreToTrade, 70)));
    if (_retryScore < _retryFloor) {
      addLog('RETRY_SKIP', `${r.symbol} ${r.side} below score floor: ${_retryScore} < ${_retryFloor}`);
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
    // fix44a: skip alert system removed — v4_candidate_rejections no longer written

    // fix29: feed live price map to sentinel for market breadth/volume delta computation
    try { sentinel.injectPriceMap(Object.fromEntries(priceMap)); } catch { /* non-critical */ }

    const signalPriceMap = await enrichOpenSignalMarketMap(signals, priceMap);
    updateExistingSignals(signals, signalPriceMap);
    signals = dedupeLiveSignals(signals);

    // fix38h: sweep engine tick — detects cluster SL_HITs and sets fade state
    const ledgerForSweep = getLedger();
    try { sweepEngine.tick(ledgerForSweep, signals, Date.now()); } catch (e) { /* non-critical */ }

    const universe = tickers
      .filter(t => t.symbol !== 'BTCUSDT' && t.symbol.endsWith('USDT') && num(t.turnover24h) > 0)
      .sort((a, b) => num(b.turnover24h) - num(a.turnover24h))
      .slice(0, MAX_SYMBOLS);

    // fix47: dead hour block removed entirely — all hours scan normally

    // fix44e: batch-read rejection store once per scan (was reading inside loop = 50 reads/scan)
    // Map keyed by symbol_side — one entry per pair, updated on re-rejection
    const _rejStore = store.read('v4_candidate_rejections', []);
    const _rejMap = new Map(_rejStore.map(r => [`${r.symbol}_${r.side}`, r]));

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
        // fix44f: set source on leader BEFORE shouldReject so _isPlanner gate works
  if (!leader.source) leader.source = `backend-planner-${V4_VERSION}`;

  const gate = shouldReject(leader, settings, signals);
        leader.rejected = !gate.ok;
        leader.rejectReasons = gate.reasons;
        leader.rejectWarnings = gate.warnings || [];
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
              // fix44b: live execution hook — planner immediate PAPER_ACTIVE
              if (sig.paperState === 'PAPER_ACTIVE' && settings.botMode === 'LIVE_REAL_BYBIT' && settings.tradingEnabled && !sig._autoTraded) {
                const { activeTrades } = require('./executor');
                // fix44e: use activeTrades().length — previous filter missed ORDER_SUBMITTED
                const liveCount = activeTrades().length;
                if (liveCount < (settings.maxOpenTrades || 3)) {
                sig._autoTraded = true;
                const _executor = require('./executor');
                _executor.executeSignal({ ...sig, plan: sig.plan || { entry: sig.entry, sl: sig.sl, tp1: sig.tp1 }, leverage: settings.leverage || 5, margin: settings.maxTradeUsdt || 5 }, settings)
                  .then(r => {
                    if (r && r.ok) {
                      const sigs = getSignals();
                      const idx = sigs.findIndex(x => x.id === sig.id);
                      if (idx >= 0) { sigs[idx].orderId = r.orderId; sigs[idx].tradeId = r.tradeId; sigs[idx].orderStatus = 'SENT_LIVE'; saveSignals(sigs); }
                      addLog('LIVE_PLACED', `${sig.symbol} ${sig.side} order placed`, { orderId: r.orderId, tradeId: r.tradeId });
                    } else {
                      addLog('LIVE_REJECTED', `${sig.symbol} ${sig.side} order failed`, { reason: r?.error || 'unknown' });
                    }
                  })
                  .catch(e => addLog('LIVE_ERROR', `${sig.symbol} ${sig.side} executor error: ${e.message}`));
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
    const summary = { ...ledgerSummary, visible: visibleSummary, source: 'v4_paper_ledger' };
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
      reasons.push(`SENTINEL_SIDE_BLOCKED_${side}_regime=${_sent.market_regime}`);
    }
  } catch (_e) { /* sentinel unavailable — do not block */ }

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
  if (score < minScore) reasons.push(`SCORE_LT_${minScore}`);
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
      const _isWaiting0 = s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION';
      const tsRaw = _isWaiting0 ? signalBirthMs(s) : (createdAt || updatedAt); // 0 if both missing
      // fix35-obs20: missing timestamp = unknown age = treat as fully expired
      const age = tsRaw > 0 ? now - tsRaw : EXPIRY_MS + 1;
      const expMs = num(s.expireMs, EXPIRY_MS);
      // fix48g: WAITING/WAITING_REACTION setups respect the 45-min hard cap here too (consistency).
      const _isWaiting = s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION';
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
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
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
  start,
  stop,
  scanOnce,
  getSnapshot,
  getSignals,
  getLedger,
  computeLedgerSummary,
  clearSignals,
  computeSummary,
  getLeaderboard,
  getDiagnostics,
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
};
