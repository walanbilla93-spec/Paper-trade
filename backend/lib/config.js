'use strict';

const store = require('./store');

const DEFAULT_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || 'https://p01--bybit-back--rpfg4d97xnm6.code.run';

const DEFAULTS = Object.freeze({
  botMode: process.env.BOT_MODE || 'PAPER_REAL_PRICE',
  tradingEnabled: parseBool(process.env.AUTO_TRADE_ENABLED || process.env.TRADING_ENABLED, false),
  testnet: process.env.BYBIT_TESTNET === 'false' ? false : true,
  orderType: process.env.ORDER_TYPE || 'Market',
  marketOrdersOnTestnet: parseBool(process.env.MARKET_ORDERS_ON_TESTNET, true),
  maxTradeUsdt: parseNumber(process.env.MAX_TRADE_USDT, parseNumber(process.env.AUTO_TRADE_MARGIN_USDT, 5)),
  leverage: parseInt(process.env.LEVERAGE || process.env.AUTO_TRADE_LEVERAGE || '1', 10) || 1,
  maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES || process.env.AUTO_TRADE_MAX_OPEN || '3', 10) || 3,
  minScoreToTrade: parseNumber(process.env.MIN_SCORE_TO_TRADE, 70),
  cooldownMinutes: parseNumber(process.env.COOLDOWN_MINUTES, 30),
  pendingTimeoutMinutes: parseNumber(process.env.PENDING_TIMEOUT_MINUTES, 360),
  defaultRiskPct: parseNumber(process.env.DEFAULT_RISK_PCT, 0.006),
  defaultRewardPct: parseNumber(process.env.DEFAULT_REWARD_PCT, 0.012),
  useSignalTpSlPercent: parseBool(process.env.USE_SIGNAL_TP_SL_PERCENT, true),
  safeMode: parseBool(process.env.SAFE_MODE, true),
  oneTradePerSymbol: parseBool(process.env.ONE_TRADE_PER_SYMBOL, true),
  rejectUnknownBtcRegime: parseBool(process.env.REJECT_UNKNOWN_BTC_REGIME, true),
  rejectTrendConflict: parseBool(process.env.REJECT_TREND_CONFLICT, true),
  rejectRsiConflict: parseBool(process.env.REJECT_RSI_CONFLICT, true),
  rejectVolumeDeltaConflict: parseBool(process.env.REJECT_VOLUME_DELTA_CONFLICT, true),
  minTurnover24h: parseNumber(process.env.MIN_TURNOVER_24H, 0),
  maxSignalAgeMinutes: parseNumber(process.env.MAX_SIGNAL_AGE_MINUTES, 5),
  symbolSettleCoin: process.env.SYMBOL_SETTLE_COIN || 'USDT',
  publicBackendUrl: DEFAULT_BACKEND_URL,
  confirmLiveTrading: parseBool(process.env.CONFIRM_LIVE_TRADING, false),
  version: '3.3.0-safe-backend-dashboard'
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
  out.minScoreToTrade = Math.max(0, Math.min(100, parseNumber(out.minScoreToTrade, DEFAULTS.minScoreToTrade)));
  out.cooldownMinutes = Math.max(0, Math.min(1440, parseNumber(out.cooldownMinutes, DEFAULTS.cooldownMinutes)));
  out.pendingTimeoutMinutes = Math.max(5, Math.min(1440, parseNumber(out.pendingTimeoutMinutes, DEFAULTS.pendingTimeoutMinutes)));
  out.defaultRiskPct = Math.max(0.001, Math.min(0.10, parseNumber(out.defaultRiskPct, DEFAULTS.defaultRiskPct)));
  out.defaultRewardPct = Math.max(0.001, Math.min(0.25, parseNumber(out.defaultRewardPct, DEFAULTS.defaultRewardPct)));
  out.marketOrdersOnTestnet = !!out.marketOrdersOnTestnet;
  out.useSignalTpSlPercent = !!out.useSignalTpSlPercent;
  out.safeMode = !!out.safeMode;
  out.oneTradePerSymbol = out.oneTradePerSymbol !== false;
  out.rejectUnknownBtcRegime = out.rejectUnknownBtcRegime !== false;
  out.rejectTrendConflict = out.rejectTrendConflict !== false;
  out.rejectRsiConflict = out.rejectRsiConflict !== false;
  out.rejectVolumeDeltaConflict = out.rejectVolumeDeltaConflict !== false;
  out.minTurnover24h = Math.max(0, parseNumber(out.minTurnover24h, DEFAULTS.minTurnover24h));
  out.maxSignalAgeMinutes = Math.max(1, Math.min(120, parseNumber(out.maxSignalAgeMinutes, DEFAULTS.maxSignalAgeMinutes)));
  if (out.safeMode) {
    out.minScoreToTrade = Math.max(70, out.minScoreToTrade);
    out.maxOpenTrades = Math.min(out.maxOpenTrades, 3);
    out.leverage = Math.min(out.leverage, 1);
    out.maxTradeUsdt = Math.min(out.maxTradeUsdt, 5);
  }
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
