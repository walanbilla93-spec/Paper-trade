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
    version: '4.6.8.19',
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

router.get('/rejections', auth, (req, res) => {
  const store = require('../lib/store');
  res.json({ ok: true, rows: store.read('v4_candidate_rejections', []) });
});


router.get('/diagnostics', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 5000);
  const rows = v4.getDiagnostics ? v4.getDiagnostics(limit) : [];
  res.json({ ok: true, source: 'v4_diagnostic_journal.ndjson', total: Array.isArray(rows) ? rows.length : 0, rows: Array.isArray(rows) ? rows.slice(0, limit) : [] });
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
  res.json(v4.clearSignals({ archive: req.body?.archive !== false, clearLedger: req.body?.clearLedger === true }));
});

router.post('/clear-ledger', auth, (req, res) => {
  res.json(v4.clearSignals({ archive: req.body?.archive !== false, clearLedger: true }));
});

router.post('/cancel-signal', auth, (req, res) => {
  res.json(v4.cancelSignal(req.body || {}));
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
    v4MinBuyScore: 60,
    v4MinSellScore: 86,
    v4AllowSells: false,
    cooldownMinutes: 60,
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
    v4MinRR: 1.6,
    v4MinSellRR: 1.7,
    v4MinNetTpUsdt: 0.25,
    v4MinNetTpFeeMult: 2.5,
    v4MinNetRR: 0.85,
    v4MaxFrontendTpPct: 4.5,
    v4DiagnosticJournal: true,
    v4MaxTpAtr: 2.4,
    v4RiskWindowHours: 6,
    v4MaxConsecutiveLosses: 5,
    v4MaxSessionLossUsdt: 5.0,
    experimentPresetMode: 'balanced',
    v4EntryToleranceAtr: 0.25,
    v4EntryReactionBps: 5,
    v4EntryWaitSeconds: 10,
    v4WaitingExpiryMinutes: 30,
    v4SymbolLossCooldownMinutes: 60,
  });
  res.json({ ok: true, settings });
});

// ── Overall PnL history (all-time, survives ledger clears) ─────────────────
// GET /api/v4/pnl
// Returns: { net, trades, history: [{date, pnl, wins, losses, trades}] }
router.get('/pnl', auth, (req, res) => {
  const allTime = v4.getAllTimePnl();
  const ledger = v4.getLedger();
  const currentSummary = v4.computeLedgerSummary(ledger);
  res.json({
    ok: true,
    source: 'v4_pnl_history',
    // All-time (persisted across session clears)
    allTime: {
      net: allTime.net,
      trades: allTime.trades,
      updatedAt: allTime.updatedAt,
    },
    // Current ledger session
    session: {
      net: currentSummary.netPnl,
      trades: currentSummary.completed,
      wins: currentSummary.wins,
      losses: currentSummary.losses,
      winRate: currentSummary.winRate,
      expectancy: currentSummary.expectancy,
      profitFactor: currentSummary.profitFactor,
      avgWin: currentSummary.avgWin,
      avgLoss: currentSummary.avgLoss,
      sideStats: currentSummary.sideStats,
    },
    // Daily breakdown (current ledger + historical merged)
    daily: allTime.history || [],
    // Current ledger daily (for chart)
    sessionDaily: currentSummary.dailyPnl || [],
  });
});

// ── Account balance snapshot ──────────────────────────────────────────────
// POST /api/v4/balance   body: { walletBalance, availableBalance, unrealisedPnl, equity }
// Frontend calls this after fetching Bybit wallet. Stored with timestamp for equity curve.
router.post('/balance', auth, (req, res) => {
  try {
    const snap = v4.recordBalanceSnapshot(req.body || {});
    res.json({ ok: true, snapshot: snap });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/v4/balance
// Returns balance history snapshots for equity curve display.
router.get('/balance', auth, (req, res) => {
  const history = v4.getBalanceHistory();
  const limit = Math.min(parseInt(req.query.limit || '168', 10) || 168, 720); // default 7d @ hourly
  res.json({
    ok: true,
    source: 'balance_history',
    latest: history.snapshots?.[0] || null,
    snapshots: (history.snapshots || []).slice(0, limit),
  });
});

module.exports = router;
