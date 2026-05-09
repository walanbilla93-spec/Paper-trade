'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const v4 = require('../lib/v4Brain');
const { getSettings, saveSettings } = require('../lib/config');


function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function rowsToSnapshotCsv(rows) {
  const cols = [
    'id','sym','side','score','rr','entry','sl','tp1','result','paperState','status',
    'openedAt','createdAt','closedAt','exitPx','realizedPnl','netTpUSDT','netSlUSDT','stateReason','source'
  ];
  const lines = [cols.join(',')];
  for (const r of rows || []) {
    lines.push(cols.map(c => csvEscape(c === 'source' ? (r.source || r.planner?.source || '') : r[c])).join(','));
  }
  return lines.join('\n');
}

router.get('/status', auth, (req, res) => {
  const snap = v4.getSnapshot();
  res.json({
    ok: true,
    version: '4.6.6-stability-confirmation',
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
    maxOpenTrades: 10,
    minScoreToTrade: 84,
    cooldownMinutes: 30,
    oneTradePerSymbol: true,
    rejectUnknownBtcRegime: false,
    rejectTrendConflict: true,
    rejectRsiConflict: true,
    rejectVolumeDeltaConflict: true,
  });
  res.json({ ok: true, settings });
});


router.get('/export/snapshot.csv', auth, (req, res) => {
  const snap = v4.getSnapshot();
  const rows = Array.isArray(snap.signals) ? snap.signals : [];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orayan_v4_signal_snapshot_${new Date().toISOString().slice(0,10)}_${Date.now()}.csv"`);
  res.send(rowsToSnapshotCsv(rows));
});

router.get('/export/ledger.csv', auth, (req, res) => {
  const rows = v4.getLedger();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orayan_v4_ledger_${new Date().toISOString().slice(0,10)}_${Date.now()}.csv"`);
  res.send(rowsToSnapshotCsv(rows));
});

router.get('/candidates', auth, (req, res) => {
  const snap = v4.getSnapshot();
  res.json({ ok: true, rows: (snap.entries || []).filter(e => e && !e.rejected).slice(0, 100) });
});

router.get('/rejections', auth, (req, res) => {
  const snap = v4.getSnapshot();
  res.json({ ok: true, rows: (snap.entries || []).filter(e => e && e.rejected).slice(0, 100) });
});

router.post('/fresh', auth, (req, res) => {
  res.json(v4.clearSignals({ archive: true, clearLedger: true }));
});

module.exports = router;
