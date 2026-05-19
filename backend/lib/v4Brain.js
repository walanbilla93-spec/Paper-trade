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
const sentinel = require('./sentinelBrain'); // fix29: market sentinel

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
const MAX_FRONTEND_TP_PCT = Math.max(0.2, Number(process.env.V4_MAX_FRONTEND_TP_PCT || '4.5'));
const DIAGNOSTIC_JOURNAL = String(process.env.V4_DIAGNOSTIC_JOURNAL || 'true').toLowerCase() !== 'false';
const MAX_DIAGNOSTIC_ROWS = Math.max(500, Math.min(50000, parseInt(process.env.V4_MAX_DIAGNOSTIC_ROWS || '5000', 10)));
const MAX_TP_ATR = Math.max(1.0, Number(process.env.V4_MAX_TP_ATR || '8.0')); // fix25b: raised 3.0→8.0; market median TP is 6.3x ATR, gate at 8.0 passes 82% of candidates
const RISK_WINDOW_HOURS = Math.max(1, Number(process.env.V4_RISK_WINDOW_HOURS || '6')); // fix30: realigned with config.js DEFAULTS.v4RiskWindowHours=6
const MAX_CONSECUTIVE_LOSSES = Math.max(1, parseInt(process.env.V4_MAX_CONSECUTIVE_LOSSES || '4', 10)); // fix30: align with config.js DEFAULTS.v4MaxConsecutiveLosses=4
const MAX_SESSION_LOSS_USDT = Math.max(0, Number(process.env.V4_MAX_SESSION_LOSS_USDT || '5.0')); // fix30: align with config.js DEFAULTS.v4MaxSessionLossUsdt=5.0
const ENTRY_TOLERANCE_ATR = Math.max(0.05, Number(process.env.V4_ENTRY_TOLERANCE_ATR || '0.25'));
const ENTRY_TOLERANCE_MIN_PCT = Math.max(0.01, Number(process.env.V4_ENTRY_TOLERANCE_MIN_PCT || '0.08'));
const ENTRY_TOLERANCE_MAX_PCT = Math.max(0.05, Number(process.env.V4_ENTRY_TOLERANCE_MAX_PCT || '0.35'));
const ENTRY_REACTION_BPS = Math.max(1, Number(process.env.V4_ENTRY_REACTION_BPS || '5'));
const ENTRY_REACTION_ATR = Math.max(0.02, Number(process.env.V4_ENTRY_REACTION_ATR || '0.10'));
const ENTRY_CONFIRMATION_WINDOW_MS = Math.max(1000, Number(process.env.V4_ENTRY_CONFIRMATION_WINDOW_SECONDS || '10') * 1000);
const MEME_SL_ATR_MULT = Math.max(0.1, Number(process.env.V4_MEME_SL_ATR_MULT || '0.45'));
const NORMAL_SL_ATR_MULT = Math.max(0.1, Number(process.env.V4_NORMAL_SL_ATR_MULT || '0.35'));
const EXPIRY_MS = Math.max(5, Number(process.env.V4_SIGNAL_EXPIRY_MINUTES || process.env.SIGNAL_EXPIRY_MINUTES || 90)) * 60 * 1000; // fix31: 30→90 min — trending markets need longer window for price to pull back to entry
const COOLDOWN_MS = Math.max(EXPIRY_MS, Math.max(0, Number(process.env.V4_SYMBOL_COOLDOWN_MINUTES || process.env.COOLDOWN_MINUTES || 45)) * 60 * 1000); // fix30: align with config.js DEFAULTS.v4SymbolLossCooldownMinutes=45
const PUBLIC_BASE = process.env.V4_MARKET_BASE_URL || 'https://api.bybit.com';
const FEE_RATE = Math.max(0, Number(process.env.V4_FEE_RATE || '0.0006'));
const SLIPPAGE_RATE = Math.max(0, Number(process.env.V4_SLIPPAGE_RATE || '0.0004'));
const V4_VERSION = '4.6.8.31';
const SCORE_A_PLUS = Math.max(80, Number(process.env.V4_SCORE_A_PLUS || '90'));
const SCORE_A = Math.max(70, Number(process.env.V4_SCORE_A || '84'));
const SCORE_B = Math.max(60, Number(process.env.V4_SCORE_B || '80'));
const MAX_SCORE_WITH_RISK = Math.max(70, Number(process.env.V4_MAX_SCORE_WITH_RISK || '82'));
const MAX_SCORE_IF_ENTRY_FAR_ATR = Math.max(60, Number(process.env.V4_MAX_SCORE_IF_ENTRY_FAR_ATR || '78'));
const MAX_SCORE_IF_NO_FULL_TREND = Math.max(60, Number(process.env.V4_MAX_SCORE_IF_NO_FULL_TREND || '78'));
const MIN_SL_DISTANCE_PCT = Math.max(0, Number(process.env.V4_MIN_SL_DISTANCE_PCT || '0.25'));
// fix30: REJECT_MIXED_BTC_REGIME module const removed — dead code. Runtime always uses config.rejectMixedBtcRegime (default=false per config.js DEFAULTS). Old default 'true' contradicted config.
const REJECT_MILD_EXTENSION = String(process.env.V4_REJECT_MILD_EXTENSION || 'true').toLowerCase() !== 'false';
const REJECT_MOMENTUM_CONFLICT = String(process.env.V4_REJECT_MOMENTUM_CONFLICT || 'true').toLowerCase() !== 'false';
const ENTRY_CONFIRMATION_REQUIRED = String(process.env.V4_ENTRY_CONFIRMATION_REQUIRED || 'true').toLowerCase() !== 'false';
const ELLIOTT_WAVE_FILTER = String(process.env.V4_ELLIOTT_WAVE_FILTER || 'true').toLowerCase() !== 'false';
const REJECT_ELLIOTT_CONFLICT = String(process.env.V4_REJECT_ELLIOTT_CONFLICT || 'true').toLowerCase() !== 'false';
// FIX21: Cluster loss cooldown tuning.
// Old: 2 losses in 30min → block for 30min. Too aggressive — blocked good setups in recovery.
// New: 3 losses in 30min → block for 20min. Still protective but allows faster resumption.
const CLUSTER_LOSS_COUNT = Math.max(1, parseInt(process.env.V4_CLUSTER_LOSS_COUNT || '3', 10));
const CLUSTER_LOSS_WINDOW_MS = Math.max(1, Number(process.env.V4_CLUSTER_LOSS_WINDOW_MINUTES || '30')) * 60 * 1000;
const CLUSTER_LOSS_COOLDOWN_MS = Math.max(1, Number(process.env.V4_CLUSTER_LOSS_COOLDOWN_MINUTES || '20')) * 60 * 1000;
const SYMBOL_LOSS_LOCKOUT_MS = Math.max(1, Number(process.env.V4_SYMBOL_LOSS_LOCKOUT_MINUTES || '45')) * 60 * 1000; // fix30: align with config.js DEFAULTS.v4SymbolLossCooldownMinutes=45
const SYMBOL_SESSION_LOCKOUT_LOSSES = Math.max(1, parseInt(process.env.V4_SYMBOL_SESSION_LOCKOUT_LOSSES || '2', 10));

const SYMBOL_WIN_COOLDOWN_MS = Math.max(1, Number(process.env.V4_SYMBOL_WIN_COOLDOWN_MINUTES || '20')) * 60 * 1000;
const WAITING_REFRESH_MIN_SCORE_DELTA = Number(process.env.V4_WAITING_REFRESH_MIN_SCORE_DELTA || '0');
const WAITING_REFRESH_MAX_ENTRY_WORSE_PCT = Math.max(0, Number(process.env.V4_WAITING_REFRESH_MAX_ENTRY_WORSE_PCT || '0.15'));


const ACTIVE_STATES = new Set(['WAITING_ENTRY', 'WAITING_REACTION', 'PAPER_ACTIVE']);
const FINAL_STATES = new Set(['TP_HIT', 'SL_HIT', 'INVALIDATED', 'EXPIRED', 'REJECTED']);

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

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
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
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
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
    minScoreToTrade: num(s.minScoreToTrade, 70), // fix28: data-proven. 40-69=25%WR(-11U), 70-79=57%WR(+7U)
    maxTradeUsdt: num(s.maxTradeUsdt, 10),
    leverage: Math.max(1, num(s.leverage, 1)),
    maxOpenTrades: Math.max(1, num(s.maxOpenTrades, 10)),
    safeMode: s.safeMode !== false,
    oneTradePerSymbol: s.oneTradePerSymbol !== false,
    rejectUnknownBtcRegime: s.rejectUnknownBtcRegime === true,
    rejectTrendConflict: s.rejectTrendConflict !== false,
    rejectRsiConflict: s.rejectRsiConflict !== false,
    rejectVolumeDeltaConflict: false, // FIX11: was s.rejectVolumeDeltaConflict !== false; filter is dead (no volume delta computed), always disable to stop misleading diagnostics
    rejectMixedBtcRegime: s.rejectMixedBtcRegime === true, // fix27: was !== false → forced true even when config default is false. Now respects config.js DEFAULTS.rejectMixedBtcRegime=false
    rejectMildExtension: s.rejectMildExtension !== false,
    rejectMomentumConflict: s.rejectMomentumConflict !== false,
    entryConfirmationRequired: s.entryConfirmationRequired !== false,
    elliottWaveFilterEnabled: s.elliottWaveFilterEnabled !== false,
    rejectElliottConflict: s.rejectElliottConflict !== false,
    v4MinRR: Math.max(1.2, num(s.v4MinRR, MIN_RR)),
    v4MinSellRR: Math.max(1.2, num(s.v4MinSellRR, MIN_SELL_RR)),
    minEntryTimingScore: 0, // fix24-b: replaced by two-gate system — kept for compat, not used for blocking
    v4MinBuyEntryTimingScore: 0,
    v4MinSellEntryTimingScore: 0,
    v4EntryReactionBps: Math.max(1, Math.min(15, num(s.v4EntryReactionBps, ENTRY_REACTION_BPS))),
    v4EntryWaitSeconds: Math.max(5, Math.min(60, num(s.v4EntryWaitSeconds, ENTRY_CONFIRMATION_WINDOW_MS / 1000))),
    v4EntryToleranceAtr: Math.max(0.15, Math.min(0.50, num(s.v4EntryToleranceAtr, ENTRY_TOLERANCE_ATR))),
    v4WaitingExpiryMinutes: Math.max(10, Math.min(240, num(s.v4WaitingExpiryMinutes, EXPIRY_MS / 60000))),
    v4SymbolLossCooldownMinutes: Math.max(15, Math.min(180, num(s.v4SymbolLossCooldownMinutes, COOLDOWN_MS / 60000))),
    btcRegimeMode: String(s.btcRegimeMode || 'direction_match'),
    elliottWaveWeight: String(s.elliottWaveWeight || 'normal'),
    experimentPresetMode: String(s.experimentPresetMode || 'balanced'),
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

function minRRFor(side, settings = currentSettings(), score = null) {
  // fix28: tiered RR gate based on score confidence.
  // score<75  → base RR (1.8) — low confidence needs better risk:reward to compensate.
  // score>=75 → relaxed RR (1.5) — higher confidence signals can be taken with tighter RR.
  // Data: low-score (40-69) + low-RR trades = 25% WR, -11.3 USDT. Tiered gate stops this.
  const baseRR = Math.max(1.2, num(side === 'SELL' ? settings.v4MinSellRR : settings.v4MinRR, side === 'SELL' ? MIN_SELL_RR : MIN_RR));
  if (score !== null && score >= 75) return Math.max(1.2, Math.min(baseRR, 1.5));
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
  if (settings.v4UseSideMinScores === false) return fallback;
  return String(side || '').toUpperCase() === 'SELL'
    ? Math.max(0, Math.min(100, num(settings.v4MinSellScore, fallback)))
    : Math.max(0, Math.min(100, num(settings.v4MinBuyScore, fallback)));
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
  const leverage = Math.max(1, num(settings.leverage, 1));
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

function sideFromTrends(trend5, trend15, trend1h, rsi, momentumPct, volRatio) {
  let bull = 0, bear = 0;
  const reasons = [];
  if (trend5 === 'bull') { bull += 18; reasons.push('5m trend bull'); }
  if (trend5 === 'bear') { bear += 18; reasons.push('5m trend bear'); }
  if (trend15 === 'bull') { bull += 16; reasons.push('15m trend bull'); }
  if (trend15 === 'bear') { bear += 16; reasons.push('15m trend bear'); }
  if (trend1h === 'bull') { bull += 10; reasons.push('1h trend bull'); }
  if (trend1h === 'bear') { bear += 10; reasons.push('1h trend bear'); }

  if (momentumPct > 0.25) { bull += clamp(Math.abs(momentumPct) * 2, 2, 10); reasons.push('short momentum up'); }
  if (momentumPct < -0.25) { bear += clamp(Math.abs(momentumPct) * 2, 2, 10); reasons.push('short momentum down'); }

  if (volRatio > 1.25) { bull += 4; bear += 4; reasons.push('volume expansion'); }
  if (rsi >= 45 && rsi <= 72) bull += 5;
  if (rsi >= 28 && rsi <= 55) bear += 5;
  if (rsi > 82) bull -= 12;
  if (rsi < 18) bear -= 12;

  if (bull >= bear + 8) return { side: 'BUY', edge: bull - bear, reasons };
  if (bear >= bull + 8) return { side: 'SELL', edge: bear - bull, reasons };
  return { side: 'NEU', edge: Math.max(bull, bear) - Math.min(bull, bear), reasons: ['no clear directional edge', ...reasons] };
}


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
function calibratedScore(ctx, decision, plan, math, btcRegime, levels) {
  const { side } = plan;
  const { price, trend5, trend15, trend1h, rsi, volRatio, momentumPct, ticker, k5 } = ctx;
  const atr = Math.max(num(levels.atr, price * 0.006), price * 0.0005);
  const entryDistanceAtr = Math.abs(num(price) - num(plan.entry)) / atr;
  const targetDistanceAtr = Math.abs(num(plan.tp1) - num(plan.entry)) / atr;
  const stopDistanceAtr = Math.abs(num(plan.entry) - num(plan.sl)) / atr;
  const maxTargetAtr = Math.max(1.0, num(levels.maxTpAtr, MAX_TP_ATR));
  const last = Array.isArray(k5) && k5.length ? k5[k5.length - 1] : null;
  const lastRangeAtr = last ? Math.abs(num(last.high) - num(last.low)) / atr : 0;

  // Per-pair local regime from candles already in ctx
  const localRegimeData = detectLocalRegime(k5, Array.isArray(ctx.k15) ? ctx.k15 : []);
  const localRegime = localRegimeData.localRegime;
  const sideAllowance = getAllowedSides(btcRegime.regime, localRegime);

  const components = {};
  const confluence = [];
  const risks = [];
  let penalties = 0;

  components.base = 8;

  const ew = elliottWaveContext(ctx, side, levels);
  components.elliottWave = ELLIOTT_WAVE_FILTER ? ew.scoreBonus : 0;
  if (ELLIOTT_WAVE_FILTER) {
    if (ew.notes && ew.notes.length) confluence.push(...ew.notes);
    if (ew.risks && ew.risks.length) risks.push(...ew.risks);
    penalties += ew.penalty;
  }

  // ── fix24-b: regimeAlignment (30pts max) ─────────────────────────────────
  // Replaces the old BTC regime penalty approach. Regime is now the primary signal.
  const btcR = String(btcRegime.regime || 'UNKNOWN').toUpperCase();
  let regimeAlignPts = 0;
  let regimeNote = '';
  if (side === 'BUY') {
    switch(btcR) {
      case 'BULL_TREND': regimeAlignPts = localRegime === 'LOCAL_BEAR' ? 15 : 30; regimeNote = 'BTC bull trend aligns BUY'; break;
      case 'BREAKOUT':   regimeAlignPts = 25; regimeNote = 'BTC breakout — BUY directional'; break;
      case 'BULL_RANGE': regimeAlignPts = localRegime === 'LOCAL_BULL' ? 22 : 14; regimeNote = 'BTC bull range — BUY at support'; break;
      case 'BEAR_RANGE': regimeAlignPts = 8;  regimeNote = 'BTC bear range — BUY weak'; break;
      case 'BEAR_TREND': regimeAlignPts = 0;  penalties += 20; risks.push('BTC bear trend blocks BUY'); break;
      case 'CHOP':       regimeAlignPts = 0;  penalties += 12; risks.push('BTC chop — BUY unreliable'); break;
      default:           regimeAlignPts = 8;  risks.push('BTC regime unknown'); break;
    }
  } else { // SELL
    switch(btcR) {
      case 'BEAR_TREND': regimeAlignPts = localRegime === 'LOCAL_BULL' ? 15 : 30; regimeNote = 'BTC bear trend aligns SELL'; break;
      case 'BREAKOUT':   regimeAlignPts = 25; regimeNote = 'BTC breakout — SELL directional'; break;
      case 'BEAR_RANGE': regimeAlignPts = localRegime === 'LOCAL_BEAR' ? 22 : 14; regimeNote = 'BTC bear range — SELL at resistance'; break;
      case 'BULL_RANGE': regimeAlignPts = 8;  regimeNote = 'BTC bull range — SELL weak'; break;
      case 'BULL_TREND': regimeAlignPts = 0;  penalties += 20; risks.push('BTC bull trend blocks SELL'); break;
      case 'CHOP':       regimeAlignPts = 0;  penalties += 12; risks.push('BTC chop — SELL unreliable'); break;
      default:           regimeAlignPts = 8;  risks.push('BTC regime unknown'); break;
    }
  }
  components.regimeAlignment = clamp(regimeAlignPts, 0, 30);
  if (regimeNote) confluence.push(regimeNote);
  if (localRegime === 'LOCAL_CHOP') { penalties += 8; risks.push('local pair in chop'); }

  components.direction = clamp(num(decision.edge) * 0.65, 0, 18);
  if (components.direction >= 12) confluence.push('clear directional edge');

  const trend = alignedTrendScore(side, trend5, trend15, trend1h);
  components.trend = trend.score;
  if (trend.aligned >= 2) confluence.push(`${trend.aligned}/3 trend alignment`);
  if (trend.aligned < 2) { penalties += 8; risks.push('weak multi-timeframe alignment'); }

  const hasStructure = !!(levels.support && levels.resistance);
  components.structure = hasStructure ? 10 : 0;
  if (hasStructure) confluence.push('support/resistance structure present');
  else { penalties += 20; risks.push('missing nearby S/R structure'); }

  if (entryDistanceAtr <= 0.25) components.entry = 12;
  else if (entryDistanceAtr <= 0.50) components.entry = 9;
  else if (entryDistanceAtr <= 1.00) components.entry = 5;
  else if (entryDistanceAtr <= 1.80) components.entry = 2;
  else components.entry = 0;

  if (entryDistanceAtr <= 0.50) confluence.push('entry close to planner zone');
  if (entryDistanceAtr > 1.80) { penalties += 8; risks.push('entry too far from current price'); }
  if (entryDistanceAtr > 3.00) { penalties += 10; risks.push('entry extremely far from current price'); }

  // fix24-b: RR sweet spot 2-4. Penalise unrealistic RR > 6.
  const rr = num(math.rr, 0);
  if (rr >= 2.0 && rr <= 4.0) { components.rr = rrScore(rr); confluence.push(`RR ${rr.toFixed(2)}`); }
  else if (rr > 4.0 && rr <= 6.0) { components.rr = rrScore(rr) - 3; risks.push(`RR ${rr.toFixed(2)} — stretched`); }
  else if (rr > 6.0) { components.rr = 5; penalties += 10; risks.push(`RR ${rr.toFixed(2)} — unrealistic, penalised`); }
  else { components.rr = rrScore(rr); }

  if (targetDistanceAtr <= maxTargetAtr) {
    confluence.push(`TP inside ${maxTargetAtr.toFixed(1)} ATR reach`);
  } else if (targetDistanceAtr > maxTargetAtr * 1.6) {
    penalties += 14; risks.push(`target too far vs ATR (${targetDistanceAtr.toFixed(2)}x)`);
  } else {
    penalties += 7; risks.push(`target stretched vs ATR (${targetDistanceAtr.toFixed(2)}x)`);
  }

  if (stopDistanceAtr > 3.0) { penalties += 10; risks.push(`SL too wide vs ATR (${stopDistanceAtr.toFixed(2)}x)`); }
  else if (stopDistanceAtr > 2.4) { penalties += 4; risks.push(`SL wide vs ATR (${stopDistanceAtr.toFixed(2)}x)`); }

  components.volume = volumeScore(volRatio);
  if (components.volume >= 4) confluence.push('volume expansion');

  const rsiPart = rsiScoreAndPenalty(side, rsi);
  components.rsi = rsiPart.score;
  if (rsiPart.note) confluence.push(rsiPart.note);
  if (rsiPart.risk) risks.push(rsiPart.risk);
  penalties += rsiPart.penalty;

  components.liquidity = liquidityScore(num(ticker.turnover24h));

  const momo = Math.abs(num(momentumPct));
  if (momo > 10) { penalties += 22; risks.push('extreme short-term extension'); }
  else if (momo > 6) { penalties += 14; risks.push('overextended move'); }
  else if (momo > 3.5) { penalties += 6; risks.push('mild extension'); }

  if (lastRangeAtr > 2.5) { penalties += 10; risks.push('last candle too large vs ATR'); }
  else if (lastRangeAtr > 1.8) { penalties += 5; risks.push('large recent candle'); }

  const requiredRR = num(levels.requiredRR, side === 'SELL' ? MIN_SELL_RR : MIN_RR);
  if (math.rr < requiredRR) { penalties += 22; risks.push(`RR ${math.rr} below ${requiredRR}`); }
  const minNetTp = num(levels.minNetTpUsdt, MIN_NET_TP);
  if (math.netTpUSDT < minNetTp) { penalties += 12; risks.push(`net TP ${math.netTpUSDT} below ${minNetTp}`); }

  let raw = Object.values(components).reduce((a, b) => a + num(b), 0);
  let score = raw - penalties;

  if (risks.length) score = Math.min(score, MAX_SCORE_WITH_RISK);
  if (entryDistanceAtr > 1.0) score = Math.min(score, MAX_SCORE_IF_ENTRY_FAR_ATR);
  if (trend.aligned < 3) score = Math.min(score, MAX_SCORE_IF_NO_FULL_TREND);
  if (math.rr < requiredRR) score = Math.min(score, 76);
  else if (math.rr < 2.0) score = Math.min(score, 86);
  if (!hasStructure) score = Math.min(score, 62);
  // fix24-b: hard cap when regime is directly opposed
  if (components.regimeAlignment === 0 && penalties >= 20) score = Math.min(score, 55);

  const exceptional =
    score >= 95 && !risks.length && trend.aligned === 3 &&
    math.rr >= 2.4 && entryDistanceAtr <= 0.5 &&
    components.volume >= 4 && components.liquidity >= 3 &&
    components.regimeAlignment >= 25;

  if (score > 94 && !exceptional) score = 94;
  score = clamp(Math.round(score), 0, 100);

  return {
    score,
    rawScore: Number(raw.toFixed(2)),
    penalties: Number(penalties.toFixed(2)),
    components,
    confluence,
    risks,
    entryDistanceAtr: Number(entryDistanceAtr.toFixed(3)),
    lastRangeAtr: Number(lastRangeAtr.toFixed(3)),
    targetDistanceAtr: Number(targetDistanceAtr.toFixed(3)),
    stopDistanceAtr: Number(stopDistanceAtr.toFixed(3)),
    maxTargetAtr: Number(maxTargetAtr.toFixed(3)),
    exceptional,
    elliottWave: ew,
    regimeAlignment: components.regimeAlignment,
    btcRegime: btcR,
    localRegime,
    regimeAllowedBuy: sideAllowance.allowedBuy,
    regimeAllowedSell: sideAllowance.allowedSell,
  };
}

function buildStructurePlan(ctx, settings, btcRegime) {
  const { symbol, price, k5, k15, k60, trend5, trend15, trend1h, rsi, volRatio, momentumPct, ticker } = ctx;
  const decision = sideFromTrends(trend5, trend15, trend1h, rsi, momentumPct, volRatio);
  if (decision.side === 'NEU') return { ok: false, reason: 'NO_DIRECTION', leader: { symbol, score: 0, side: 'NEU' } };

  const side = decision.side;
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
    if (!support || !resistance) return { ok: false, reason: 'NO_STRUCTURE_LEVELS', leader: { symbol, score: 0, side } };
    const nearSupport = Math.abs(price - support) <= Math.max(atr * 0.75, price * 0.0075);
    entry = nearSupport ? price : Math.max(support + minBuffer * 0.35, price - atr * 0.6);
    sl = Math.min(support - minBuffer, entry - atr * 0.55);
    const structureTp = resistance;
    tp1 = structureTp > entry ? structureTp : 0;
    entrySource = nearSupport ? 'current price near support' : 'pullback toward support';
    slSource = 'below support invalidation';
    tpSource = 'nearest resistance liquidity';
  } else {
    if (!support || !resistance) return { ok: false, reason: 'NO_STRUCTURE_LEVELS', leader: { symbol, score: 0, side } };
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

  const plan = { entry: roundPrice(entry), sl: roundPrice(sl), tp1: roundPrice(tp1), side };
  const math = calculatePaperMath(plan, settings);

  const scoreInfo = calibratedScore(ctx, decision, plan, math, btcRegime, { support, resistance, support2, resistance2, atr, requiredRR: minRRFor(side, settings), minNetTpUsdt: minNetTpFor(settings, math), maxTpAtr: maxTpAtrFor(settings) });
  const entryTiming = computeEntryTiming(ctx, plan, side, atr, settings);
  const score = scoreInfo.score;
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
    plan,
    math,
    reasons: confluence.slice(0, 8),
    risks,
    scoreInfo,
    scoring: scoreInfo,
    entryTiming,
    entrySource, slSource, tpSource,
    keyLevels: { support: roundPrice(support), resistance: roundPrice(resistance), support2: roundPrice(support2), resistance2: roundPrice(resistance2), atr: roundPrice(atr) },
  };
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
  let directional = false;
  if (s.side === 'BUY') directional = price >= Math.max(entry, touch) + reaction;
  if (s.side === 'SELL') directional = price <= Math.min(entry, touch) - reaction;
  const expiredWindow = elapsed > maxWaitMs;

  if (!directional && expiredWindow) {
    // Do not let an old touch arm the trade forever. Start a fresh confirmation window.
    s.entryZoneTouchedAt = now;
    s.entryZoneTouchPrice = roundPrice(price);
  }

  const reason = directional
    ? 'ENTRY_CONFIRMED: price touched zone and reacted in trade direction'
    : expiredWindow
      ? 'WAITING_REACTION: confirmation window expired without direction; reset touch and waiting again'
      : 'WAITING_REACTION: price touched zone; waiting for direction';
  return { inZone, directional, tolerance, reaction, elapsed, expiredWindow, reason };
}

function terminalStateOf(s) {
  const st = String(s?.paperState || s?.displayState || s?.status || '').toUpperCase();
  if (st === 'TP_HIT' || st === 'WIN') return 'TP_HIT';
  if (st === 'SL_HIT' || st === 'LOSS') return 'SL_HIT';
  if (st === 'INVALIDATED' || st === 'INVALID') return 'INVALIDATED';
  if (st === 'EXPIRED') return 'EXPIRED';
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
    stateReason: `V4.6.8.31: ${reason}; refreshed waiting setup with newer/better planner data`,
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
    warnings.push('BTC_CHOP_REGIME');
    // FIX: neutral_allowed mode permits trades in CHOP with a warning; direction_match and strict block.
    if (mode === 'direction_match' || mode === 'strict') reasons.push('BTC_CHOP_BLOCKS_TRADE');
    return { reasons, warnings };
  }

  // Hard blocks — regime directly opposed to side.
  // FIX: sentinelBrain emits STRONG_BULL/BULL/CHOP/BEAR/STRONG_BEAR — not old BEAR_TREND/BULL_TREND labels.
  const BULL_REGIMES = ['STRONG_BULL', 'BULL'];
  const BEAR_REGIMES = ['STRONG_BEAR', 'BEAR'];

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
  for (const r of [...getLedger(), ...signalRows]) {
    if (!r) continue;
    const key = r.id || r.key || ledgerKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    const result = String(r.result || r.status || '').toUpperCase();
    if (result !== 'WIN' && result !== 'LOSS') continue;
    const ts = num(r.closedAt || r.updatedAt || r.createdAt || r.openedAt, 0);
    if (!ts || ts < cutoff) continue;
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
  // Use the higher of: all-side count OR per-side count to decide block
  const consecutiveLosses = consecutiveLossesAll;
  if (consecutiveLosses >= maxConsecutive) {
    // fix31: 2hr → 1hr cooldown. BTC regime gate now prevents wrong-side trades; shorter cooldown is safer.
    const blockHoldMs = Math.max(1, Number(process.env.V4_CONSEC_LOSS_HOLD_HOURS || '1')) * 60 * 60 * 1000;
    const timeSinceLastLoss = now - lastLossTs;
    if (timeSinceLastLoss < blockHoldMs) {
      const resumeInMin = Math.ceil((blockHoldMs - timeSinceLastLoss) / 60000);
      return `RISK_BLOCK_${consecutiveLosses}_CONSECUTIVE_LOSSES_RESUME_IN_${resumeInMin}MIN`;
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

  // fix29: sentinel gates — ADDITIVE (never lower than user settings)
  const sent = sentinel.getSentinel();
  const sentimentReady = sent && sent.market_regime !== 'UNKNOWN';
  const isBuy = String(leader.side).toUpperCase() === 'BUY';

  // Sentinel side block — regime doesn't allow this side right now
  if (sentimentReady && sent.allowed_sides && !sent.allowed_sides.includes(leader.side)) {
    reasons.push(`SENTINEL_SIDE_BLOCK_${sent.market_regime}`);
  }

  // Sentinel-adjusted gates (take stricter of user setting vs sentinel)
  const userMinScore = minScoreForSide(leader.side, settings);
  const sentMinScore = sentimentReady ? (isBuy ? sent.buy_score_gate : sent.sell_score_gate) : userMinScore;
  const minScore = Math.max(userMinScore, sentMinScore);

  const userMinRR = minRRFor(leader.side, settings, leader.score); // fix28: tiered
  const sentMinRR = sentimentReady ? (isBuy ? sent.buy_rr_gate : sent.sell_rr_gate) : userMinRR;
  const minRR = Math.max(userMinRR, sentMinRR);

  const minNetTpInfo = minNetTpDetails(settings, leader.math);
  const minNetTp = minNetTpInfo.required;
  const minNetRR = minNetRRFor(settings);
  const atr = num(leader?.keyLevels?.atr, 0);
  const px = num(leader?.price || leader?.plan?.entry, 0);
  const minSlPct = minSlDistancePctFor(leader?.symbol, px, atr, settings);
  const slPct = slDistancePct(leader);
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
  if (!sideAllowed(leader.side, settings)) reasons.push('SELL_SIDE_DISABLED');
  if (leader.score < minScore) reasons.push(`SCORE_LT_${minScore}`);
  if (leader.math.rr < minRR) reasons.push(`RR_LT_${minRR}`);
  if (leader.math.netTpUSDT < minNetTp) reasons.push(`NET_TP_TOO_SMALL_${leader.math.netTpUSDT}_LT_${minNetTp}`);
  if (minNetRR > 0 && num(leader.math.netRr, 0) < minNetRR) reasons.push(`NET_RR_LT_${minNetRR}`);
  if (slPct > 0 && slPct < minSlPct) reasons.push(`SL_TOO_TIGHT_${slPct.toFixed(2)}_LT_${minSlPct}`);

  const targetAtr = num(leader?.scoreInfo?.targetDistanceAtr, 0);
  const maxTargetAtr = maxTpAtrFor(settings);
  // fix27: was Math.min(8.0, maxTargetAtr + scoreTpBonus) — Math.min capped the bonus to zero
  // when maxTargetAtr=8.0 (default). Score bonus now actually extends the gate.
  // Data: median TP is 11.87x ATR. Gate 8.0*1.10=8.8 blocked 737 signals (dominant skip reason).
  const scoreTpBonus = leader.score >= 85 ? 2.5 : leader.score >= 75 ? 1.5 : 0;
  const effectiveMaxTpAtr = maxTargetAtr + scoreTpBonus; // no Math.min cap — bonus is real
  if (targetAtr && targetAtr > effectiveMaxTpAtr * 1.10) reasons.push(`TP_TOO_FAR_${targetAtr.toFixed(2)}ATR_GT_${effectiveMaxTpAtr.toFixed(1)}`);

  const btc = btcRegimeDecision(leader, settings, btcUnknownException);
  reasons.push(...btc.reasons);
  warnings.push(...btc.warnings);

  if (settings.rejectTrendConflict) {
    // fix27: was any-TF conflict (trend5=bear OR trend15=bear OR trend1h=bear for BUY)
    // That killed pullback BUY setups where 5m is naturally bear during the pullback.
    // Now requires ALL 3 timeframes to conflict — true structural opposition, not a pullback.
    if (leader.side === 'BUY' && leader.trend5 === 'bear' && leader.trend15 === 'bear' && leader.trend1h === 'bear') reasons.push('TREND_CONFLICT_LONG');
    if (leader.side === 'SELL' && leader.trend5 === 'bull' && leader.trend15 === 'bull' && leader.trend1h === 'bull') reasons.push('TREND_CONFLICT_SHORT');
  }

  if (settings.rejectRsiConflict) {
    if (leader.side === 'BUY' && leader.rsi >= 78) reasons.push('RSI_OVERBOUGHT_ON_LONG');
    if (leader.side === 'SELL' && leader.rsi <= 22) reasons.push('RSI_OVERSOLD_ON_SHORT');
  }

  if (settings.rejectMildExtension && hasRiskOrReason(leader, /mild extension|overextended|extreme short-term extension|late wave 5/i)) reasons.push('EXTENSION_RISK');
  if (settings.rejectMomentumConflict) {
    // FIX: Exempt regime-aligned trades — counter-trend momentum in a strong regime = pullback entry.
    const _btcR = String(leader.btcRegime || settings.currentBtcRegime || '').toUpperCase();
    const _bearAligned = leader.side === 'SELL' && (_btcR === 'STRONG_BEAR' || _btcR === 'BEAR');
    const _bullAligned = leader.side === 'BUY'  && (_btcR === 'STRONG_BULL' || _btcR === 'BULL');
    if (!_bullAligned && leader.side === 'BUY'  && hasRiskOrReason(leader, /short momentum down/i)) reasons.push('MOMENTUM_CONFLICT_LONG');
    if (!_bearAligned && leader.side === 'SELL' && hasRiskOrReason(leader, /short momentum up/i))   reasons.push('MOMENTUM_CONFLICT_SHORT');
  }

  const ew = leader?.scoreInfo?.elliottWave || leader?.scoring?.elliottWave || null;
  if (settings.rejectElliottConflict && ew && ew.reject) reasons.push('ELLIOTT_WAVE_CONFLICT');
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
    experimentPresetMode: settings.experimentPresetMode || 'balanced',
    experimentSettingsSnapshot: { preset: settings.experimentPresetMode || 'balanced', minScoreToTrade: settings.minScoreToTrade, v4MinBuyScore: settings.v4MinBuyScore, v4MinSellScore: settings.v4MinSellScore, v4AllowSells: settings.v4AllowSells, v4MinRR: settings.v4MinRR, v4MinSellRR: settings.v4MinSellRR, v4MinNetTpUsdt: settings.v4MinNetTpUsdt, v4MinNetTpFeeMult: settings.v4MinNetTpFeeMult, v4MinNetRR: settings.v4MinNetRR, v4MaxTpAtr: settings.v4MaxTpAtr, v4EntryReactionBps: settings.v4EntryReactionBps, v4EntryWaitSeconds: settings.v4EntryWaitSeconds, v4EntryToleranceAtr: settings.v4EntryToleranceAtr, btcRegimeMode: settings.btcRegimeMode, elliottWaveWeight: settings.elliottWaveWeight },
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
    stateReason: state === 'PAPER_ACTIVE' ? `V4.6.8.31: ${timing.reason}` : `V4.6.8.31: ${timing.reason}`,
    reasons: leader.reasons,
    risks: leader.risks,
    entryTiming: timing,
    entryZoneTouchedAt: timing.inZone ? now : null,
    entryZoneTouchPrice: timing.inZone ? roundPrice(price) : null,
    diagnostic: {
      version: V4_VERSION,
      capturedAt: now,
      minNetTpInfo: minNetTpDetails(settings, leader.math),
      gateSnapshot: { minScoreToTrade: settings.minScoreToTrade, minScore, v4MinBuyScore: settings.v4MinBuyScore, v4MinSellScore: settings.v4MinSellScore, v4AllowSells: settings.v4AllowSells, minRR: minRRFor(leader.side, settings, leader.score), minNetTp: minNetTpFor(settings, leader.math), minNetRR: minNetRRFor(settings), maxTpAtr: maxTpAtrFor(settings), btcRegimeMode: settings.btcRegimeMode, sentinelRegime: sentinel.getSentinel()?.market_regime, sentinelAllowed: sentinel.getSentinel()?.allowed_sides },
      marketSnapshot: { price: leader.price, trend5: leader.trend5, trend15: leader.trend15, trend1h: leader.trend1h, rsi: leader.rsi, volRatio: leader.volRatio, change24h: leader.change24h, turnover24h: leader.turnover24h, btcRegime: leader.btcRegime },
      scoreBreakdown: leader.scoreInfo || leader.scoring || null,
      entryTiming: timing,
      keyLevels: leader.keyLevels,
      math: leader.math
    },
    planner: {
      source: 'backend-planner-v4.6.8.24b',
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
    if ((s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION') && now - num(s.createdAt || s.updatedAt, now) > num(s.expireMs, EXPIRY_MS)) {
      changed = true;
      return { ...s, paperState: 'EXPIRED', displayState: 'EXPIRED', status: 'EXPIRED', positionStatus: 'NONE', updatedAt: now, closedAt: now, stateReason: 'V4.6.8.31: stale waiting setup expired' };
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
    s.paperState === 'INVALIDATED' ? 'INVALIDATED' :
    s.paperState === 'EXPIRED' ? 'EXPIRED' :
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
    experimentPresetMode: s.experimentPresetMode || s.experimentSettingsSnapshot?.preset || 'balanced',
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
    if ((state === 'WAITING_ENTRY' || state === 'WAITING_REACTION') && age > num(r.expireMs, EXPIRY_MS)) {
      return { ...r, paperState: 'EXPIRED', displayState: 'EXPIRED', status: 'EXPIRED', result: 'EXPIRED', updatedAt: now, closedAt: now, stateReason: r.stateReason || 'V4.6.8.31: stale waiting setup expired by ledger cleanup' };
    }
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
  if (tpHit && slHit) return { state: 'SL_HIT', status: 'LOSS', reason: 'V4: SL and TP touched same range; conservative SL first-hit rule', exitPx: sl, rangeUsable };
  if (slHit) return { state: 'SL_HIT', status: 'LOSS', reason: 'V4: SL hit', exitPx: sl, rangeUsable };
  return { state: 'TP_HIT', status: 'WIN', reason: 'V4: TP hit', exitPx: tp, rangeUsable };
}

function updateExistingSignals(signals, priceMap) {
  const now = Date.now();
  const settings = currentSettings();
  let changed = false;
  for (const s of signals) {
    if (!s || FINAL_STATES.has(s.paperState)) continue;
    const market = priceMap.get(s.sym) || priceMap.get(s.symbol) || {};
    const price = num(market.markPrice || market.lastPrice || market.close || s.backendLastPrice);
    if (!price) continue;

    const prevState = s.paperState;
    s.backendLastPrice = roundPrice(price);
    s.updatedAt = now;

    const entry = num(s.entry), sl = num(s.sl);
    const side = s.side;
    const age = now - num(s.createdAt, now);
    const atr = num(s.planner?.keyLevels?.atr, Math.abs(entry - sl));

    if (s.paperState === 'WAITING_ENTRY' || s.paperState === 'WAITING_REACTION') {
      if (age > num(s.expireMs, expiryMsFor(settings))) {
        s.paperState = 'EXPIRED';
        s.status = 'EXPIRED';
        s.displayState = 'EXPIRED';
        s.positionStatus = 'NONE';
        s.closedAt = now;
        s.stateReason = 'V4.6.8.31: setup expired before entry confirmation';
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
        s.stateReason = 'V4: structure broke before entry';
        s.history = [...(s.history || []), { at: now, state: 'INVALIDATED', reason: s.stateReason, price }];
        appendSignalDiagnostic('SIGNAL_INVALIDATED', s, { prevState, ageMs: age, price }, settings);
        changed = true;
        continue;
      }
      if (side === 'SELL' && price >= sl) {
        s.paperState = 'INVALIDATED';
        s.status = 'INVALID';
        s.displayState = 'INVALIDATED';
        s.positionStatus = 'NONE';
        s.closedAt = now;
        s.stateReason = 'V4: structure broke before entry';
        s.history = [...(s.history || []), { at: now, state: 'INVALIDATED', reason: s.stateReason, price }];
        appendSignalDiagnostic('SIGNAL_INVALIDATED', s, { prevState, ageMs: age, price }, settings);
        changed = true;
        continue;
      }
      const timing = signalEntryTiming(s, price, atr, now, settings);
      if (timing.inZone && timing.directional) {
        s.paperState = 'PAPER_ACTIVE';
        s.status = 'ACTIVE';
        s.displayState = 'PAPER_ACTIVE';
        s.positionStatus = 'PAPER';
        s.entryHit = true;
        s.openedAt = now;
        s.stateReason = 'V4.6.8.31: ' + timing.reason;
        s.history = [...(s.history || []), { at: now, state: 'PAPER_ACTIVE', reason: s.stateReason, price }];
        appendSignalDiagnostic('TRADE_ACTIVATED', s, { prevState, price, timing }, settings);
        changed = true;
      } else if (timing.inZone) {
        if (s.paperState !== 'WAITING_REACTION') changed = true;
        s.paperState = 'WAITING_REACTION';
        s.displayState = 'WAITING_REACTION';
        s.status = 'DETECTED';
        s.positionStatus = 'NONE';
        s.stateReason = 'V4.6.8.31: ' + timing.reason;
        if (prevState !== s.paperState) appendSignalDiagnostic('WAITING_STATE_CHANGED', s, { prevState, price, timing }, settings);
      } else {
        if (s.paperState !== 'WAITING_ENTRY') changed = true;
        s.paperState = 'WAITING_ENTRY';
        s.displayState = 'WAITING_ENTRY';
        s.status = 'DETECTED';
        s.positionStatus = 'NONE';
        s.stateReason = 'V4.6.8.31: ' + timing.reason;
        if (prevState !== s.paperState || timing.expiredWindow) {
          appendSignalDiagnostic(prevState !== s.paperState ? 'WAITING_STATE_CHANGED' : 'ENTRY_CONFIRMATION_RESET', s, { prevState, price, timing }, settings);
        }
      }
      continue;
    }

    if (s.paperState === 'PAPER_ACTIVE') {
      const final = activeFinalFromMarket(s, market, price);
      if (final) {
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
  const symbols = [...new Set((signals || [])
    .filter(s => s && ACTIVE_STATES.has(s.paperState))
    .map(s => String(s.sym || s.symbol || '').toUpperCase())
    .filter(Boolean))].slice(0, 30);

  await Promise.all(symbols.map(async symbol => {
    try {
      const candles = await fetchKline(symbol, '1', 3);
      const last = candles[candles.length - 1] || null;
      const base = out.get(symbol) || {};
      out.set(symbol, {
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
      });
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
const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const RETRY_MAX_AGE_MS  = 4 * 60 * 60 * 1000; // look back 4 hours
const RETRY_MIN_SCORE   = 60;
const HARD_REJECT_PREFIXES = [
  'BAD_SYMBOL','NO_DIRECTION','PLAN_MISSING',
  'BUY_PLAN_DIRECTION_INVALID','SELL_PLAN_DIRECTION_INVALID',
  'DUPLICATE_SYMBOL_SIDE_ACTIVE','MAX_OPEN_TRADES_REACHED',
  'CLUSTER_BUY_LOSSES_COOLDOWN','CLUSTER_SELL_LOSSES_COOLDOWN',
  'GLOBAL_RISK_BLOCK','ENRICH_ERROR',
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

  // Deduplicate — most recent per symbol+side
  const seen = new Map();
  for (const r of candidates) {
    const k = `${r.symbol}_${r.side}`;
    if (!seen.has(k) || r.at > seen.get(k).at) seen.set(k, r);
  }
  const deduped = [...seen.values()].sort((a, b) => num(b.score, 0) - num(a.score, 0));

  if (!deduped.length) return;

  let captured = 0;
  for (const r of deduped) {
    // Stop if slots filled up mid-loop
    if (openSignalCount(getSignals()) >= settings.maxOpenTrades) break;
    const payload = r.rawPayload || {
      symbol: r.symbol, sym: r.symbol, side: r.side,
      score: r.score, setupScore: r.score, confidence: r.score,
      entryTimingScore: r.entryTimingScore || 68,
      entry: r.plan?.entry, sl: r.plan?.sl, tp1: r.plan?.tp1,
      rr: r.rr, atr: 0,
      btcRegime: r.btcRegime || '',
      state: 'READY',
      keyLevels: {},
      plan: r.plan || {},
    };
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

async function scanOnce() {
  if (inFlight) return snapshot;
  inFlight = true;
  const startedAt = Date.now();
  try {
    const settings = currentSettings();
    const [tickers, btcRegime] = await Promise.all([fetchTickers(), updateBtcRegime()]);
    const priceMap = new Map(tickers.map(t => [t.symbol, t]));
    let signals = dedupeLiveSignals(getSignals());

    // fix29: feed live price map to sentinel for market breadth/volume delta computation
    try { sentinel.injectPriceMap(Object.fromEntries(priceMap)); } catch { /* non-critical */ }

    const signalPriceMap = await enrichOpenSignalMarketMap(signals, priceMap);
    updateExistingSignals(signals, signalPriceMap);
    signals = dedupeLiveSignals(signals);

    const universe = tickers
      .filter(t => t.symbol !== 'BTCUSDT' && t.symbol.endsWith('USDT') && num(t.turnover24h) > 0)
      .sort((a, b) => num(b.turnover24h) - num(a.turnover24h))
      .slice(0, MAX_SYMBOLS);

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
        const gate = shouldReject(leader, settings, signals);
        leader.rejected = !gate.ok;
        leader.rejectReasons = gate.reasons;
        leader.rejectWarnings = gate.warnings || [];
        entries.push(leader);
        if (gate.ok && openSignalCount(signals) >= settings.maxOpenTrades) {
          leader.rejected = true;
          leader.rejectReasons = ['MAX_OPEN_TRADES_REACHED'];
        }
        if (gate.ok && openSignalCount(signals) < settings.maxOpenTrades) {
          const dupReason = symbolCooldownReason(signals, leader.symbol, leader.side, Date.now(), settings);
          if (dupReason === 'DUPLICATE_SYMBOL_SIDE_WAITING') {
            mergeLeaderIntoWaiting(signals, leader, settings);
          } else if (!dupReason && canCreateForSymbol(signals, leader.symbol, settings, leader.side)) {
            const sig = signalFromLeader(leader, settings);
            signals.unshift(sig);
            addLog('V4_SIGNAL', `${leader.symbol} ${leader.side} ${sig.paperState}`, { score: leader.score, rr: leader.math.rr });
          } else if (dupReason && dupReason !== 'DUPLICATE_SYMBOL_SIDE_ACTIVE') {
            leader.rejected = true;
            leader.rejectReasons = [dupReason];
          }
        }
      } catch (e) {
        entries.push({ symbol: t.symbol, side: 'NEU', score: 0, rejected: true, rejectReasons: ['ENRICH_ERROR:' + e.message], price: roundPrice(t.lastPrice) });
      }
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

  const minScore = minScoreForSide(side, settings);
  const minRR = minRRFor(side, settings, score); // fix28: tiered — score>=75 gets 1.5, score<75 gets 1.8
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
  const isBearAligned  = side === 'SELL' && (btcR === 'STRONG_BEAR' || btcR === 'BEAR');
  const isBullAligned  = side === 'BUY'  && (btcR === 'STRONG_BULL' || btcR === 'BULL');
  if (settings.rejectMomentumConflict && !isBullAligned && side === 'BUY'  && /short momentum down|bearish divergence|sell[-\s]?accel/i.test(text)) reasons.push('MOMENTUM_OR_VOLUME_CONFLICT_LONG');
  if (settings.rejectMomentumConflict && !isBearAligned && side === 'SELL' && /short momentum up|bullish divergence|buy[-\s]?accel/i.test(text))  reasons.push('MOMENTUM_OR_VOLUME_CONFLICT_SHORT');
  if (settings.rejectMildExtension && /mild extension|strong extension|overextended|late wave 5/i.test(text)) reasons.push('EXTENSION_RISK');
  if (settings.rejectElliottConflict) {
    if (side === 'BUY' && /impulse down|bearish impulse|correction down|bounce sell/i.test(text)) reasons.push('ELLIOTT_WAVE_CONFLICT_LONG');
    if (side === 'SELL' && /impulse up|bullish impulse|correction up|pullback buy/i.test(text)) reasons.push('ELLIOTT_WAVE_CONFLICT_SHORT');
  }

  let signals = dedupeLiveSignals(getSignals());
  const duplicateReason = settings.oneTradePerSymbol !== false ? symbolCooldownReason(signals, symbol, side, Date.now(), settings) : '';
  const waitingDuplicate = duplicateReason === 'DUPLICATE_SYMBOL_SIDE_WAITING';
  if (duplicateReason && !waitingDuplicate) reasons.push(duplicateReason);
  if (clusterLossBlocked(signals, side)) reasons.push(`CLUSTER_${side}_LOSSES_COOLDOWN`);
  const riskBlock = globalRiskBlockReason(signals, settings);
  if (riskBlock) reasons.push(riskBlock);
  if (!waitingDuplicate && openSignalCount(signals) >= settings.maxOpenTrades) reasons.push('MAX_OPEN_TRADES_REACHED');

  const rejected = reasons.length > 0;
  if (rejected) {
    addLog('V4_CANDIDATE_REJECTED', `${symbol || 'UNKNOWN'} ${side || 'NEU'} ${reasons.slice(0,3).join(',')}`, {score, rr, slPct, btcRegime, warnings});
    const rej = store.read('v4_candidate_rejections', []);
    const row = { at: Date.now(), iso: new Date().toISOString(), symbol, side, score, entryTimingScore, rr, slPct, btcRegime, reasons, warnings, source: V4_VERSION, minNetTpInfo, math: { position: positionForGate, grossTpUSDT: Number(grossTpForGate.toFixed(4)), grossSlUSDT: Number(grossSlForGate.toFixed(4)), feeEstUSDT: Number(feeEstForGate.toFixed(4)), netTpUSDT: Number(netTpForGate.toFixed(4)), netSlUSDT: Number(netSlForGate.toFixed(4)), netRr: Number(netRrForGate.toFixed(3)), targetDistanceAtr: Number(targetDistanceAtr.toFixed(3)), targetDistancePct: Number(targetDistancePct.toFixed(3)) }, plan: { entry, sl, tp1 }, rawPayload: payload };
    store.write('v4_candidate_rejections', [row].concat(Array.isArray(rej)?rej:[]).slice(0,1000));
    appendDiagnosticJournal({ ...row, type: 'FRONTEND_CANDIDATE_REJECTED', version: V4_VERSION }, settings);
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
    source: 'frontend-candidate-v4.6.8.24b',
    plannerVersion: V4_VERSION,
    sym: symbol,
    symbol,
    side,
    status: 'DETECTED',
    paperState: 'WAITING_ENTRY',
    displayState: 'WAITING_ENTRY',
    positionStatus: 'NONE',
    orderStatus: 'NOT_SENT_PAPER',
    score,
    setupScore: score,
    entryTimingScore,
    minEntryTimingScoreAtCapture: minEntryTimingScore,
    experimentPresetMode: settings.experimentPresetMode || 'balanced',
    experimentSettingsSnapshot: { preset: settings.experimentPresetMode || 'balanced', minScoreToTrade: settings.minScoreToTrade, v4MinBuyScore: settings.v4MinBuyScore, v4MinSellScore: settings.v4MinSellScore, v4AllowSells: settings.v4AllowSells, minEntryTimingScore, v4MinBuyEntryTimingScore: settings.v4MinBuyEntryTimingScore, v4MinSellEntryTimingScore: settings.v4MinSellEntryTimingScore, v4MinRR: settings.v4MinRR, v4MinSellRR: settings.v4MinSellRR, v4MinNetTpUsdt: settings.v4MinNetTpUsdt, v4MinNetTpFeeMult: settings.v4MinNetTpFeeMult, v4MinNetRR: settings.v4MinNetRR, v4MaxTpAtr: settings.v4MaxTpAtr, v4EntryReactionBps: settings.v4EntryReactionBps, v4EntryWaitSeconds: settings.v4EntryWaitSeconds, v4EntryToleranceAtr: settings.v4EntryToleranceAtr, btcRegimeMode: settings.btcRegimeMode, elliottWaveWeight: settings.elliottWaveWeight },
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
    diagnostic: { version: V4_VERSION, capturedAt: now, source: 'frontend-candidate', minNetTpInfo: minNetTpDetails(settings, { feeEstUSDT: feeEst }), gateSnapshot: { minScoreToTrade: settings.minScoreToTrade, minScore, v4MinBuyScore: settings.v4MinBuyScore, v4MinSellScore: settings.v4MinSellScore, v4AllowSells: settings.v4AllowSells, minEntryTimingScore, v4MinBuyEntryTimingScore: settings.v4MinBuyEntryTimingScore, v4MinSellEntryTimingScore: settings.v4MinSellEntryTimingScore, minRR, minNetTp, minNetRR: minNetRRFor(settings), maxTargetAtr, maxFrontendTpPct, btcRegimeMode: settings.btcRegimeMode }, math: { grossTpUSDT: grossTp, grossSlUSDT: grossSl, feeEstUSDT: feeEst, netTpUSDT: netTp, netSlUSDT: netSl, netRr, targetDistanceAtr, targetDistancePct }, rawPayload: payload },
    reasons: Array.isArray(payload.reasons) ? payload.reasons.slice(0, 8) : [],
    risks: Array.isArray(payload.risks) ? payload.risks.slice(0, 8) : [],
    planner: {
      source: 'frontend-search-modal',
      entrySource: payload.entrySource || payload.plan?.entrySource || 'frontend candidate entry',
      slSource: payload.slSource || payload.plan?.slSource || 'frontend candidate SL',
      tpSource: payload.tpSource || payload.plan?.tpSource || 'frontend candidate TP',
      confluence: Array.isArray(payload.confluence) ? payload.confluence.slice(0, 10) : [],
      risks: Array.isArray(payload.risks) ? payload.risks.slice(0, 10) : [],
      keyLevels: payload.keyLevels || {},
    },
    entryHit: false,
    stateReason: 'V4.6.8.31: READY setup captured as WAITING_ENTRY; activation requires tight entry zone + directional reaction',
    history: [{ at: now, state: 'WAITING_ENTRY', reason: 'Frontend READY candidate captured; waiting for tight entry zone + directional reaction' }],
    time: new Date(now).toLocaleTimeString().slice(0,5),
    createdAt: now,
    openedAt: null,
    updatedAt: now,
    expireMs: expiryMsFor(settings),
  };
  if (waitingDuplicate) {
    const existing = signals.find(s => s && (s.sym === symbol || s.symbol === symbol) && s.side === side && ['WAITING_ENTRY', 'WAITING_REACTION'].includes(s.paperState));
    if (existing && refreshSignalPlan(existing, sig, 'REFRESHED_WAITING_SETUP_FROM_FRONTEND')) {
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
  appendDiagnosticJournal({ at: now, iso: new Date(now).toISOString(), type: 'FRONTEND_CANDIDATE_ACCEPTED', version: V4_VERSION, symbol, side, score, entryTimingScore, rr, slPct, btcRegime, warnings, minNetTpInfo: minNetTpDetails(settings, { feeEstUSDT: feeEst }), minNetRR: minNetRRFor(settings), math: sig.diagnostic.math, signal: normalizeLedgerTrade(sig) }, settings);
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
    if (!ACTIVE_STATES.has(s.paperState)) return s;
    const next = {
      ...s,
      paperState: 'INVALIDATED',
      displayState: 'INVALIDATED',
      status: 'INVALIDATED',
      result: 'INVALIDATED',
      positionStatus: 'NONE',
      updatedAt: now,
      closedAt: now,
      stateReason: `V4.6.8.31: ${reason}`,
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
  const signals = getSignals();
  const ledgerBefore = upsertLedger(signals);
  if (archive && signals.length) {
    const sessions = getSessions();
    sessions.unshift({ at: Date.now(), summary: computeSummary(signals), ledgerSummary: computeLedgerSummary(ledgerBefore), signals });
    saveSessions(sessions);
  }
  saveSignals([]);
  if (clearLedger) saveLedger([]);
  const ledger = clearLedger ? [] : getLedger();
  snapshot = { ...snapshot, signals: [], visibleSignals: 0, ledger: ledger.slice(0, RECENT_LEDGER_LIMIT), summary: { ...computeLedgerSummary(ledger), visible: computeSummary([]), source: 'v4_paper_ledger' }, ts: Date.now() };
  store.write('v4_snapshot', snapshot);
  return { ok: true, archived: archive && signals.length ? 1 : 0, total: 0, ledgerTotal: ledger.length, ledgerCleared: !!clearLedger };
}


function freshJournal() {
  saveSignals([]);
  saveLedger([]);
  store.write('v4_candidate_rejections', []);
  store.write('v4_diagnostic_journal', []);
  if (typeof store.clearNdjson === 'function') store.clearNdjson('v4_diagnostic_journal');
  diagnosticRecentCache = [];
  store.write('legacy_browser_signals', { at: Date.now(), total: 0, note: 'cleared by v4.6.8.24b freshJournal' });
  snapshot = { ...snapshot, ts: Date.now(), signals: [], visibleSignals: 0, ledger: [], summary: computeLedgerSummary([]) };
  store.write('v4_snapshot', snapshot);
  return { ok: true, cleared: true, source: 'v4.6.8.24b freshJournal' };
}

function getLeaderboard() {
  return getSnapshot().entries || [];
}

module.exports = {
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
  // New: PnL history + balance recording
  computeDailyPnl,
  updateAllTimePnl,
  getAllTimePnl,
  recordBalanceSnapshot,
  getBalanceHistory,
};
