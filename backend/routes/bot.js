'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { getSettings, saveSettings } = require('../lib/config');
const { keySet, getBase } = require('../lib/bybit');
const { executeSignal, buildExecutionPlan, activeTrades, getTrades } = require('../lib/executor');
const { getLastSnapshot, reconcileOnce } = require('../lib/reconciler');
const { getLogs, addLog } = require('../lib/tradeLog');

router.get('/status', auth, async (req, res) => {
  const settings = getSettings();
  const snapshot = getLastSnapshot();
  const trades = getTrades();
  res.json({
    ok: true,
    version: settings.version,
    settings,
    bybit: {
      keySet: keySet(),
      baseUrl: getBase(),
      testnet: settings.testnet !== false,
      wallet: snapshot.wallet || null,
      openOrders: snapshot.orders?.length || 0,
      openPositions: snapshot.positions?.length || 0,
      lastSync: snapshot.ts || 0,
      errors: snapshot.errors || [],
    },
    totals: {
      activeTrades: activeTrades(trades).length,
      allTrades: Object.keys(trades).length,
    },
  });
});

router.get('/live-trades', auth, async (req, res) => {
  const refresh = req.query.refresh === '1';
  const snapshot = refresh ? await reconcileOnce() : getLastSnapshot();
  res.json({ ok: true, ...snapshot });
});


router.get('/settings', auth, (req, res) => {
  res.json({
    ok: true,
    settings: getSettings(),
    editable: [
      'botMode','tradingEnabled','orderType','marketOrdersOnTestnet',
      'maxTradeUsdt','leverage','maxOpenTrades','minScoreToTrade','v4MinBuyScore','v4MinSellScore','v4AllowSells',
      'cooldownMinutes','pendingTimeoutMinutes','defaultRiskPct',
      'defaultRewardPct','useSignalTpSlPercent','safeMode','oneTradePerSymbol',
      'rejectUnknownBtcRegime','rejectTrendConflict','rejectRsiConflict',
      'rejectVolumeDeltaConflict','rejectMixedBtcRegime','rejectMildExtension','rejectMomentumConflict',
      'entryConfirmationRequired','rejectElliottConflict','elliottWaveFilterEnabled',
      'minSlDistancePct','v4MinRR','v4MinSellRR','v4MinNetTpUsdt','v4MinNetTpFeeMult','v4MinNetRR','v4MaxFrontendTpPct','v4DiagnosticJournal','v4MaxTpAtr','minEntryTimingScore','v4MinBuyEntryTimingScore','v4MinSellEntryTimingScore','v4EntryReactionBps','v4EntryWaitSeconds','v4EntryToleranceAtr','v4WaitingExpiryMinutes','v4SymbolLossCooldownMinutes','v4RiskWindowHours','v4MaxConsecutiveLosses','v4MaxSessionLossUsdt','btcRegimeMode','elliottWaveWeight','experimentPresetMode','minTurnover24h','maxSignalAgeMinutes'
    ],
    secretKeys: {
      bybitApiKey: keySet(),
      bybitApiSecret: keySet(),
      note: 'API keys are never returned to the frontend. Keep them in Northflank env variables.'
    }
  });
});

router.get('/logs', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
  res.json({ ok: true, logs: getLogs(limit) });
});

router.post('/settings', auth, (req, res) => {
  const allowed = {
    botMode: req.body.botMode,
    tradingEnabled: req.body.tradingEnabled,
    orderType: req.body.orderType,
    marketOrdersOnTestnet: req.body.marketOrdersOnTestnet,
    maxTradeUsdt: req.body.maxTradeUsdt,
    leverage: req.body.leverage,
    maxOpenTrades: req.body.maxOpenTrades,
    minScoreToTrade: req.body.minScoreToTrade,
    v4MinBuyScore: req.body.v4MinBuyScore,
    v4MinSellScore: req.body.v4MinSellScore,
    v4AllowSells: req.body.v4AllowSells,
    cooldownMinutes: req.body.cooldownMinutes,
    pendingTimeoutMinutes: req.body.pendingTimeoutMinutes,
    defaultRiskPct: req.body.defaultRiskPct,
    defaultRewardPct: req.body.defaultRewardPct,
    useSignalTpSlPercent: req.body.useSignalTpSlPercent,
    safeMode: req.body.safeMode,
    oneTradePerSymbol: req.body.oneTradePerSymbol,
    rejectUnknownBtcRegime: req.body.rejectUnknownBtcRegime,
    rejectTrendConflict: req.body.rejectTrendConflict,
    rejectRsiConflict: req.body.rejectRsiConflict,
    rejectVolumeDeltaConflict: req.body.rejectVolumeDeltaConflict,
    rejectMixedBtcRegime: req.body.rejectMixedBtcRegime,
    rejectMildExtension: req.body.rejectMildExtension,
    rejectMomentumConflict: req.body.rejectMomentumConflict,
    entryConfirmationRequired: req.body.entryConfirmationRequired,
    rejectElliottConflict: req.body.rejectElliottConflict,
    elliottWaveFilterEnabled: req.body.elliottWaveFilterEnabled,
    minSlDistancePct: req.body.minSlDistancePct,
    v4MinRR: req.body.v4MinRR,
    v4MinSellRR: req.body.v4MinSellRR,
    v4MinNetTpUsdt: req.body.v4MinNetTpUsdt,
    v4MinNetTpFeeMult: req.body.v4MinNetTpFeeMult,
    v4MinNetRR: req.body.v4MinNetRR,
    v4MaxFrontendTpPct: req.body.v4MaxFrontendTpPct,
    v4DiagnosticJournal: req.body.v4DiagnosticJournal,
    v4MaxTpAtr: req.body.v4MaxTpAtr,
    minEntryTimingScore: req.body.minEntryTimingScore,
    v4MinBuyEntryTimingScore: req.body.v4MinBuyEntryTimingScore,
    v4MinSellEntryTimingScore: req.body.v4MinSellEntryTimingScore,
    v4EntryReactionBps: req.body.v4EntryReactionBps,
    v4EntryWaitSeconds: req.body.v4EntryWaitSeconds,
    v4EntryToleranceAtr: req.body.v4EntryToleranceAtr,
    v4WaitingExpiryMinutes: req.body.v4WaitingExpiryMinutes,
    v4SymbolLossCooldownMinutes: req.body.v4SymbolLossCooldownMinutes,
    v4RiskWindowHours: req.body.v4RiskWindowHours,
    v4MaxConsecutiveLosses: req.body.v4MaxConsecutiveLosses,
    v4MaxSessionLossUsdt: req.body.v4MaxSessionLossUsdt,
    btcRegimeMode: req.body.btcRegimeMode,
    elliottWaveWeight: req.body.elliottWaveWeight,
    experimentPresetMode: req.body.experimentPresetMode,
    minTurnover24h: req.body.minTurnover24h,
    maxSignalAgeMinutes: req.body.maxSignalAgeMinutes,
    // fix24b: AI proxy keys — stored server-side, used by /api/ai/analyze
    geminiApiKey:     req.body.geminiApiKey     || undefined,
    openrouterApiKey: req.body.openrouterApiKey || undefined,
    groqApiKey:       req.body.groqApiKey       || undefined,
    openaiApiKey:     req.body.openaiApiKey     || undefined,
    aiProvider:       req.body.aiProvider       || undefined,
  };
  Object.keys(allowed).forEach(k => allowed[k] === undefined && delete allowed[k]);
  const next = saveSettings(allowed);
  addLog('SETTINGS', 'Bot settings updated', next);
  res.json({ ok: true, settings: next });
});


router.post('/safe-mode', auth, (req, res) => {
  const next = saveSettings({
    botMode: 'PAPER_REAL_PRICE',
    tradingEnabled: false,
    safeMode: true,
    maxTradeUsdt: 10,
    leverage: 5,
    maxOpenTrades: 10,
    v4MinRR: 1.6,
    v4MinSellRR: 1.7,
    v4MinNetTpUsdt: 0.25,
    v4MinNetTpFeeMult: 2.5,
    v4MinNetRR: 0.85,
    v4MaxFrontendTpPct: 4.5,
    v4DiagnosticJournal: true,
    v4MaxTpAtr: 2.4,
    minScoreToTrade: 70,
    v4MinBuyScore: 70,
    v4MinSellScore: 70,
    v4AllowSells: false,
    minEntryTimingScore: 85,
    v4MinBuyEntryTimingScore: 85,
    v4MinSellEntryTimingScore: 92,
    experimentPresetMode: 'balanced',
    cooldownMinutes: 30,
    orderType: 'Market',
    marketOrdersOnTestnet: true,
    oneTradePerSymbol: true,
    rejectUnknownBtcRegime: false,
    rejectTrendConflict: true,
    rejectRsiConflict: true,
    rejectVolumeDeltaConflict: true,
    rejectMixedBtcRegime: true,
    rejectMildExtension: true,
    rejectMomentumConflict: true,
    entryConfirmationRequired: true,
    rejectElliottConflict: true,
    elliottWaveFilterEnabled: true,
    minSlDistancePct: 0.25,
    v4RiskWindowHours: 6,
    v4MaxConsecutiveLosses: 5,
    v4MaxSessionLossUsdt: 5.0,
    maxSignalAgeMinutes: 5,
  });
  addLog('SAFE_MODE', 'Safe Paper Mode preset applied', next);
  res.json({ ok: true, settings: next });
});

router.post('/start', auth, (req, res) => {
  const next = saveSettings({ tradingEnabled: true });
  addLog('BOT_ON', 'Backend auto-trader enabled');
  res.json({ ok: true, settings: next });
});

router.post('/stop', auth, (req, res) => {
  const next = saveSettings({ tradingEnabled: false });
  addLog('BOT_OFF', 'Backend auto-trader disabled');
  res.json({ ok: true, settings: next });
});

router.post('/plan', auth, async (req, res) => {
  try {
    const plan = await buildExecutionPlan(req.body.signal || req.body, { forceMarket: req.body.forceMarket });
    res.json({ ok: true, plan });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/execute-signal', auth, async (req, res) => {
  try {
    const signal = req.body.signal || req.body;
    const result = await executeSignal(signal, { source: 'backend-api', force: req.body.force === true, forceMarket: req.body.forceMarket === true });
    await reconcileOnce().catch(() => null);
    res.json(result);
  } catch (e) {
    addLog('ERROR', `execute-signal failed: ${e.message}`, { body: req.body });
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
