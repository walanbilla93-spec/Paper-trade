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
    version: '4.6.4-senior-candidate-gate',
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



router.get('/rejections', auth, (req, res) => {
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '100', 10)));
  const rows = v4.getCandidateRejections ? v4.getCandidateRejections().slice(0, limit) : [];
  res.json({ ok: true, total: rows.length, rows });
});

router.get('/candidates', auth, (req, res) => {
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '100', 10)));
  const rows = v4.getCandidateRejections ? v4.getCandidateRejections().slice(0, limit) : [];
  res.json({ ok: true, rejected: rows.length, recentRejected: rows });
});

router.post('/candidate', auth, (req, res) => {
  try {
    const result = v4.ingestCandidate(req.body || {});
    res.status(result.ok ? 200 : 202).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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
    leverage: 5,
    maxOpenTrades: 10,
    minScoreToTrade: 84,
    cooldownMinutes: 30,
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
    minSlDistancePct: 0.60,
    v4MinRR: 2.0,
    v4MinSellRR: 2.0,
  });
  res.json({ ok: true, settings });
});

module.exports = router;
