'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const v4 = require('../lib/v4Brain');
const { getSettings, saveSettings } = require('../lib/config');

router.get('/status', auth, (req, res) => {
  const snap = v4.getSnapshot();
  res.json({
    ok: true,
    version: '4.2.0-ledger-stats',
    running: true,
    ts: snap.ts,
    lastError: snap.lastError || '',
    summary: snap.summary,
    btcRegime: snap.btcRegime,
    settings: getSettings()
  });
});

router.get('/dashboard', auth, (req, res) => {
  const snap = v4.getSnapshot();
  res.json(snap);
});

router.get('/signals', auth, (req, res) => {
  res.json(v4.getSignals());
});

router.get('/stats', auth, (req, res) => {
  const ledger = v4.getLedger();
  res.json({ ok: true, source: 'v4_paper_ledger', summary: v4.computeLedgerSummary(ledger), visible: v4.computeSummary(v4.getSignals()) });
});

router.get('/ledger', auth, (req, res) => {
  const ledger = v4.getLedger();
  res.json({ ok: true, source: 'v4_paper_ledger', total: ledger.length, summary: v4.computeLedgerSummary(ledger), rows: ledger });
});

router.get('/journal', auth, (req, res) => {
  const ledger = v4.getLedger();
  res.json({ ok: true, source: 'v4_paper_ledger', total: ledger.length, summary: v4.computeLedgerSummary(ledger), rows: ledger });
});

router.get('/leaderboard', auth, (req, res) => {
  const snap = v4.getSnapshot();
  res.json({
    ok: true,
    version: snap.version,
    ts: snap.ts,
    entries: snap.entries || [],
    summary: snap.summary || {},
    btcRegime: snap.btcRegime || {}
  });
});

router.post('/scan', auth, async (req, res) => {
  const snap = await v4.scanOnce();
  res.json(snap);
});

router.post('/clear', auth, (req, res) => {
  res.json(v4.clearSignals({ archive: req.body?.archive !== false }));
});

router.post('/safe-mode', auth, (req, res) => {
  const settings = saveSettings({
    botMode: 'PAPER_REAL_PRICE',
    tradingEnabled: false,
    safeMode: true,
    maxTradeUsdt: 10,
    leverage: 1,
    maxOpenTrades: 3,
    minScoreToTrade: 70,
    cooldownMinutes: 30,
    oneTradePerSymbol: true,
    rejectUnknownBtcRegime: false,
    rejectTrendConflict: true,
    rejectRsiConflict: true,
    rejectVolumeDeltaConflict: true,
  });
  res.json({ ok: true, settings });
});

module.exports = router;
