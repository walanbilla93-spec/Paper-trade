'use strict';

const store = require('./store');

const DEFAULT_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || 'https://p01--bybit-back--rpfg4d97xnm6.code.run';

// ── Resolved conflicts & data-driven defaults (v4.6.8.19-opt) ──────────────
// Data source: 109 signals across 2 sessions (2026-05-11).
// KEY FINDINGS used to set defaults:
//   • entryTimingScore distribution: 68 (53 signals), 97 (39), 100 (16), 83 (1)
//   • ets=100 → 15.4% WR, -2.78 PnL — ANTI-predictive. Gate must NOT be 85+.
//   • score 65-69 bucket → 55.6% WR (best volume+accuracy trade-off)
//   • RR 1.6-2.0 → 77.8% WR (best bucket). Do NOT raise V4_MIN_RR.
//   • V4_ALLOW_SELLS=false (old env) vs true (config) was a hard SELL kill switch.
//   • V4_REJECT_MIXED_BTC_REGIME=true (old env) blocked all sideways-BTC sessions.
//   • V4_MIN_SELL_ENTRY_TIMING_SCORE=92 (old env) — no signal ever reaches 92.
//   • LEVERAGE declared twice in old env (3 then 5); dotenv kept 3 silently.
//   • BOT_MODE declared twice in old env; dotenv kept first value (TESTNET_BYBIT_PRICE).
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULTS = Object.freeze({
  botMode: process.env.BOT_MODE || 'PAPER_REAL_PRICE',
  tradingEnabled: parseBool(process.env.AUTO_TRADE_ENABLED || process.env.TRADING_ENABLED, false),
  testnet: process.env.BYBIT_TESTNET === 'false' ? false : true,
  orderType: process.env.ORDER_TYPE || 'Market',
  marketOrdersOnTestnet: parseBool(process.env.MARKET_ORDERS_ON_TESTNET, true),
  maxTradeUsdt: parseNumber(process.env.MAX_TRADE_USDT, parseNumber(process.env.AUTO_TRADE_MARGIN_USDT, 10)),
  leverage: parseInt(process.env.LEVERAGE || process.env.AUTO_TRADE_LEVERAGE || '5', 10) || 5,
  maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES || process.env.AUTO_TRADE_MAX_OPEN || '10', 10) || 10,

  // fix25: score scale changed. stableScore now uses calcFundamentalScore (0-100, no AI).
  // compositeScore=12 (A-tier) + regime match = ~45. Setting floor at 45.
  minScoreToTrade: parseNumber(process.env.MIN_SCORE_TO_TRADE, 70), // fix28: data 40-69=25%WR(-11.3U), 70-79=57%WR(+7.09U). Gate 70 = proven breakeven.

  v4MinBuyScore: parseNumber(process.env.V4_MIN_BUY_SCORE, 70), // fix28: matches minScoreToTrade=70. BUY WR 31%→expected 57% at gate 70.

  // fix28: SELL gate = 70 (same as global). Was 68 (fix27). Data: SELL 33% WR needs stricter gate.
  v4MinSellScore: parseNumber(process.env.V4_MIN_SELL_SCORE, 70),

  cooldownMinutes: parseNumber(process.env.COOLDOWN_MINUTES, 60),
  pendingTimeoutMinutes: parseNumber(process.env.PENDING_TIMEOUT_MINUTES, 360),
  defaultRiskPct: parseNumber(process.env.DEFAULT_RISK_PCT, 0.006),
  defaultRewardPct: parseNumber(process.env.DEFAULT_REWARD_PCT, 0.012),
  useSignalTpSlPercent: parseBool(process.env.USE_SIGNAL_TP_SL_PERCENT, true),
  safeMode: parseBool(process.env.SAFE_MODE, true),
  oneTradePerSymbol: parseBool(process.env.ONE_TRADE_PER_SYMBOL, true),
  rejectUnknownBtcRegime: parseBool(process.env.REJECT_UNKNOWN_BTC_REGIME, false),

  // CONFLICT FIX: was false (env) vs true (config). Resolved to true. SELLs are viable (44.4% WR, positive PnL).
  v4AllowSells: parseBool(process.env.V4_ALLOW_SELLS, true),

  rejectTrendConflict: parseBool(process.env.REJECT_TREND_CONFLICT, true),
  rejectRsiConflict: parseBool(process.env.REJECT_RSI_CONFLICT, true),
  // DATA: ets=100 losses clustered on high-momentum entries — keep this filter.
  rejectVolumeDeltaConflict: parseBool(process.env.REJECT_VOLUME_DELTA_CONFLICT, true),

  // CONFLICT FIX: was true (env) vs false (config). Resolved to false. Sideways BTC is common; blocking it kills volume.
  rejectMixedBtcRegime: parseBool(process.env.V4_REJECT_MIXED_BTC_REGIME || process.env.REJECT_MIXED_BTC_REGIME, false),

  rejectMildExtension: parseBool(process.env.V4_REJECT_MILD_EXTENSION || process.env.REJECT_MILD_EXTENSION, true),
  rejectMomentumConflict: parseBool(process.env.V4_REJECT_MOMENTUM_CONFLICT || process.env.REJECT_MOMENTUM_CONFLICT, true),
  entryConfirmationRequired: parseBool(process.env.V4_ENTRY_CONFIRMATION_REQUIRED || process.env.ENTRY_CONFIRMATION_REQUIRED, true),
  rejectElliottConflict: parseBool(process.env.V4_REJECT_ELLIOTT_CONFLICT || process.env.REJECT_ELLIOTT_CONFLICT, true),
  elliottWaveFilterEnabled: parseBool(process.env.V4_ELLIOTT_WAVE_FILTER || process.env.ELLIOTT_WAVE_FILTER, true),
  // JOURNAL: SL <0.4% dist = 27.3% WR. Raised from 0.25 to 0.40.
  minSlDistancePct: parseNumber(process.env.V4_MIN_SL_DISTANCE_PCT || process.env.MIN_SL_DISTANCE_PCT, 0.40),
  // DATA (2026-05-13): timing=97 → 4/4 INVALIDATED (100% fail). entryDistanceAtr<=0.25
  // means price already in zone but structure broke before entry every time.
  // ETS=100 also anti-predictive (15.4% WR). Block both by lowering ceiling to 95.
  maxEntryTimingScore: parseNumber(process.env.V4_MAX_ENTRY_TIMING_SCORE, 95),
  minTurnover24h: parseNumber(process.env.MIN_TURNOVER_24H, 0),
  maxSignalAgeMinutes: parseNumber(process.env.MAX_SIGNAL_AGE_MINUTES, 5),
  v4BackendOnly: parseBool(process.env.V4_BACKEND_ONLY, true),

  // DATA: RR 1.6-2.0 bucket has 77.8% WR. Do NOT raise this floor.
  // fix28: tiered RR gate. Base = 1.8 (score<75). v4Brain.js minRRFor() applies 1.5 if score>=75.
  // Data: low-RR low-score trades (RR 1.6-1.8, score 40-69) = lottery. 25% WR = account destruction.
  v4MinRR: parseNumber(process.env.V4_MIN_RR, 1.8),
  // fix28: SELL RR base = 1.8. Score>=75 SELLs get 1.5 via minRRFor() in v4Brain.js.
  v4MinSellRR: parseNumber(process.env.V4_MIN_SELL_RR, 1.8),

  // Legacy global ETS fallback. Lowered from 85 to 68 — matches dominant signal bucket.
  minEntryTimingScore: parseNumber(process.env.V4_MIN_ENTRY_TIMING_SCORE || process.env.MIN_ENTRY_TIMING_SCORE, 0), // fix25b: entry timing disabled (fix24-b)

  // DATA: 53 of 109 signals score exactly 68. Old env=85 blocked ALL of them.
  v4MinBuyEntryTimingScore: parseNumber(process.env.V4_MIN_BUY_ENTRY_TIMING_SCORE, 0), // fix25b: entry timing disabled

  // Old env=92 — no signal ever reaches 92. Was a permanent SELL kill switch. Fixed to 70.
  v4MinSellEntryTimingScore: parseNumber(process.env.V4_MIN_SELL_ENTRY_TIMING_SCORE, 0), // fix25b: entry timing disabled

  v4EntryReactionBps: parseNumber(process.env.V4_ENTRY_REACTION_BPS, 5),
  v4EntryWaitSeconds: parseNumber(process.env.V4_ENTRY_CONFIRMATION_WINDOW_SECONDS, 10),
  v4EntryToleranceAtr: parseNumber(process.env.V4_ENTRY_TOLERANCE_ATR, 0.25),
  v4WaitingExpiryMinutes: parseNumber(process.env.V4_SIGNAL_EXPIRY_MINUTES || process.env.SIGNAL_EXPIRY_MINUTES, 30),
  // FIX21: Reduced from 60 to 45 min — 60min blocks too many valid recovery setups.
  v4SymbolLossCooldownMinutes: parseNumber(process.env.V4_SYMBOL_COOLDOWN_MINUTES || process.env.COOLDOWN_MINUTES, 45),
  btcRegimeMode: process.env.V4_BTC_REGIME_MODE || 'direction_match',
  elliottWaveWeight: process.env.V4_ELLIOTT_WAVE_WEIGHT || 'normal',
  experimentPresetMode: process.env.V4_EXPERIMENT_PRESET || process.env.EXPERIMENT_PRESET || 'research',
  v4MinNetTpUsdt: parseNumber(process.env.V4_MIN_NET_TP_USDT, 0.25),
  v4MinNetTpFeeMult: parseNumber(process.env.V4_MIN_NET_TP_FEE_MULT, 2.5),
  v4MinNetRR: parseNumber(process.env.V4_MIN_NET_RR, 0.85),
  v4MaxFrontendTpPct: parseNumber(process.env.V4_MAX_FRONTEND_TP_PCT, 4.5),
  v4DiagnosticJournal: parseBool(process.env.V4_DIAGNOSTIC_JOURNAL, true),
  v4MaxTpAtr: parseNumber(process.env.V4_MAX_TP_ATR, 8.0), // fix25b: raised 3.0→8.0
  v4RiskWindowHours: parseNumber(process.env.V4_RISK_WINDOW_HOURS, 6),
  // Lowered from 5 to 4 — tighter consecutive loss guard without being too restrictive.
  v4MaxConsecutiveLosses: parseInt(process.env.V4_MAX_CONSECUTIVE_LOSSES || '4', 10) || 4,
  v4MaxSessionLossUsdt: parseNumber(process.env.V4_MAX_SESSION_LOSS_USDT, 5.0),
  symbolSettleCoin: process.env.SYMBOL_SETTLE_COIN || 'USDT',
  publicBackendUrl: DEFAULT_BACKEND_URL,
  confirmLiveTrading: parseBool(process.env.CONFIRM_LIVE_TRADING, false),
  version: '4.6.8.28'
});

function parseBool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(s)) return false;
  return dflt;
}

function parseNumber(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function clampSettings(s) {
  const out = { ...DEFAULTS, ...(s || {}) };
  out.tradingEnabled = !!out.tradingEnabled;
  const allowedModes = ['PAPER_REAL_PRICE','TESTNET_BYBIT_PRICE','LIVE_REAL_BYBIT'];
  if(!allowedModes.includes(out.botMode)) out.botMode = DEFAULTS.botMode;
  if(out.botMode === 'LIVE_REAL_BYBIT' && !DEFAULTS.confirmLiveTrading){
    out.botMode = 'PAPER_REAL_PRICE';
    out.tradingEnabled = false;
    out.liveBlockedReason = 'LIVE_REAL_BYBIT requires CONFIRM_LIVE_TRADING=true on the backend host.';
  }
  out.testnet = out.botMode === 'LIVE_REAL_BYBIT' ? false : true;
  if (String(out.botMode || '').includes('TESTNET')) out.testnet = true;
  out.orderType = String(out.orderType || 'Market') === 'Limit' ? 'Limit' : 'Market';
  out.maxTradeUsdt = Math.max(1, Math.min(1000, parseNumber(out.maxTradeUsdt, DEFAULTS.maxTradeUsdt)));
  out.leverage = Math.max(1, Math.min(25, parseInt(out.leverage || DEFAULTS.leverage, 10) || DEFAULTS.leverage));
  out.maxOpenTrades = Math.max(1, Math.min(50, parseInt(out.maxOpenTrades || DEFAULTS.maxOpenTrades, 10) || DEFAULTS.maxOpenTrades));
  out.minScoreToTrade = Math.max(0, Math.min(100, parseNumber(out.minScoreToTrade, DEFAULTS.minScoreToTrade))); // fix28: default 70 (data-proven breakeven)
  out.v4MinBuyScore = Math.max(0, Math.min(100, parseNumber(out.v4MinBuyScore, DEFAULTS.v4MinBuyScore)));
  out.v4MinSellScore = Math.max(0, Math.min(100, parseNumber(out.v4MinSellScore, DEFAULTS.v4MinSellScore)));
  out.cooldownMinutes = Math.max(0, Math.min(1440, parseNumber(out.cooldownMinutes, DEFAULTS.cooldownMinutes)));
  out.pendingTimeoutMinutes = Math.max(5, Math.min(1440, parseNumber(out.pendingTimeoutMinutes, DEFAULTS.pendingTimeoutMinutes)));
  out.defaultRiskPct = Math.max(0.001, Math.min(0.10, parseNumber(out.defaultRiskPct, DEFAULTS.defaultRiskPct)));
  out.defaultRewardPct = Math.max(0.001, Math.min(0.25, parseNumber(out.defaultRewardPct, DEFAULTS.defaultRewardPct)));
  out.marketOrdersOnTestnet = !!out.marketOrdersOnTestnet;
  out.useSignalTpSlPercent = !!out.useSignalTpSlPercent;
  out.safeMode = !!out.safeMode;
  out.oneTradePerSymbol = out.oneTradePerSymbol !== false;
  out.v4AllowSells = out.v4AllowSells === true; // FIX6: correct — respects both env and saved settings
  out.rejectUnknownBtcRegime = out.rejectUnknownBtcRegime === true;
  out.rejectTrendConflict = out.rejectTrendConflict !== false;
  out.rejectRsiConflict = out.rejectRsiConflict !== false;
  out.rejectVolumeDeltaConflict = out.rejectVolumeDeltaConflict !== false;
  out.rejectMixedBtcRegime = out.rejectMixedBtcRegime === true; // FIX5: was !== false which forced it always true even if default changed
  out.rejectMildExtension = out.rejectMildExtension !== false;
  out.rejectMomentumConflict = out.rejectMomentumConflict !== false;
  out.entryConfirmationRequired = out.entryConfirmationRequired !== false;
  out.rejectElliottConflict = out.rejectElliottConflict !== false;
  out.elliottWaveFilterEnabled = out.elliottWaveFilterEnabled !== false;
  out.minSlDistancePct = Math.max(0, Math.min(5, parseNumber(out.minSlDistancePct, DEFAULTS.minSlDistancePct)));
  // JOURNAL: cap ETS at 97 — ETS=100 is anti-predictive (15.4% WR)
  out.maxEntryTimingScore = Math.max(68, Math.min(100, parseNumber(out.maxEntryTimingScore, DEFAULTS.maxEntryTimingScore)));
  out.v4MinRR = Math.max(1.2, Math.min(10, parseNumber(out.v4MinRR, DEFAULTS.v4MinRR)));
  out.v4MinSellRR = Math.max(1.2, Math.min(10, parseNumber(out.v4MinSellRR, DEFAULTS.v4MinSellRR)));
  out.minEntryTimingScore = Math.max(0, Math.min(100, parseNumber(out.minEntryTimingScore, DEFAULTS.minEntryTimingScore))); // fix25b: entry timing disabled; floor=0 allows disabled state
  out.v4MinBuyEntryTimingScore = Math.max(0, Math.min(100, parseNumber(out.v4MinBuyEntryTimingScore, DEFAULTS.v4MinBuyEntryTimingScore))); // fix25b: floor=0 allows disabled state
  out.v4MinSellEntryTimingScore = Math.max(0, Math.min(100, parseNumber(out.v4MinSellEntryTimingScore, DEFAULTS.v4MinSellEntryTimingScore))); // fix25b: floor=0 allows disabled state
  out.v4EntryReactionBps = Math.max(1, Math.min(15, parseNumber(out.v4EntryReactionBps, DEFAULTS.v4EntryReactionBps)));
  out.v4EntryWaitSeconds = Math.max(5, Math.min(60, parseNumber(out.v4EntryWaitSeconds, DEFAULTS.v4EntryWaitSeconds)));
  out.v4EntryToleranceAtr = Math.max(0.15, Math.min(0.50, parseNumber(out.v4EntryToleranceAtr, DEFAULTS.v4EntryToleranceAtr)));
  out.v4WaitingExpiryMinutes = Math.max(10, Math.min(60, parseNumber(out.v4WaitingExpiryMinutes, DEFAULTS.v4WaitingExpiryMinutes)));
  out.v4MinNetTpUsdt = Math.max(0, Math.min(100, parseNumber(out.v4MinNetTpUsdt, DEFAULTS.v4MinNetTpUsdt)));
  out.v4MinNetTpFeeMult = Math.max(0, Math.min(10, parseNumber(out.v4MinNetTpFeeMult, DEFAULTS.v4MinNetTpFeeMult)));
  out.v4MinNetRR = Math.max(0, Math.min(5, parseNumber(out.v4MinNetRR, DEFAULTS.v4MinNetRR)));
  out.v4MaxFrontendTpPct = Math.max(0.2, Math.min(50, parseNumber(out.v4MaxFrontendTpPct, DEFAULTS.v4MaxFrontendTpPct)));
  out.v4DiagnosticJournal = out.v4DiagnosticJournal !== false;
  out.v4MaxTpAtr = Math.max(1.0, Math.min(8.0, parseNumber(out.v4MaxTpAtr, DEFAULTS.v4MaxTpAtr)));
  out.v4RiskWindowHours = Math.max(1, Math.min(72, parseNumber(out.v4RiskWindowHours, DEFAULTS.v4RiskWindowHours)));
  out.v4MaxConsecutiveLosses = Math.max(1, Math.min(20, parseInt(out.v4MaxConsecutiveLosses || DEFAULTS.v4MaxConsecutiveLosses, 10) || DEFAULTS.v4MaxConsecutiveLosses));
  out.v4MaxSessionLossUsdt = Math.max(0, Math.min(1000, parseNumber(out.v4MaxSessionLossUsdt, DEFAULTS.v4MaxSessionLossUsdt)));
  out.v4SymbolLossCooldownMinutes = Math.max(15, Math.min(180, parseNumber(out.v4SymbolLossCooldownMinutes, DEFAULTS.v4SymbolLossCooldownMinutes)));
  const btcModes = ['off','neutral_allowed','direction_match','strict'];
  if(!btcModes.includes(String(out.btcRegimeMode || ''))) out.btcRegimeMode = DEFAULTS.btcRegimeMode;
  const ewWeights = ['off','light','normal','strong'];
  if(!ewWeights.includes(String(out.elliottWaveWeight || ''))) out.elliottWaveWeight = DEFAULTS.elliottWaveWeight;
  const presetModes = ['conservative','balanced','research'];
  if(!presetModes.includes(String(out.experimentPresetMode || ''))) out.experimentPresetMode = DEFAULTS.experimentPresetMode;
  out.minTurnover24h = Math.max(0, parseNumber(out.minTurnover24h, DEFAULTS.minTurnover24h));
  out.maxSignalAgeMinutes = Math.max(1, Math.min(120, parseNumber(out.maxSignalAgeMinutes, DEFAULTS.maxSignalAgeMinutes)));
  // Safe Mode is now a preset, not a permanent clamp.
  // Applying /bot/safe-mode writes conservative values once, but later custom
  // settings must be saved exactly instead of being forced back to 5 USDT / 1x / 3 trades.
  out.updatedAt = out.updatedAt || Date.now();
  return out;
}

function getSettings() {
  const stored = store.read('bot-settings', {});
  return clampSettings(stored);
}

function saveSettings(patch) {
  const current = getSettings();
  const next = clampSettings({ ...current, ...(patch || {}), updatedAt: Date.now() });
  store.write('bot-settings', next);
  return next;
}

function isTestnet(settings = getSettings()) {
  return settings.testnet !== false;
}

module.exports = {
  DEFAULTS,
  getSettings,
  saveSettings,
  parseBool,
  parseNumber,
  isTestnet,
};
