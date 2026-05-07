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
      'maxTradeUsdt','leverage','maxOpenTrades','minScoreToTrade',
      'cooldownMinutes','pendingTimeoutMinutes','defaultRiskPct',
      'defaultRewardPct','useSignalTpSlPercent'
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
    cooldownMinutes: req.body.cooldownMinutes,
    pendingTimeoutMinutes: req.body.pendingTimeoutMinutes,
    defaultRiskPct: req.body.defaultRiskPct,
    defaultRewardPct: req.body.defaultRewardPct,
    useSignalTpSlPercent: req.body.useSignalTpSlPercent,
  };
  Object.keys(allowed).forEach(k => allowed[k] === undefined && delete allowed[k]);
  const next = saveSettings(allowed);
  addLog('SETTINGS', 'Bot settings updated', next);
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
