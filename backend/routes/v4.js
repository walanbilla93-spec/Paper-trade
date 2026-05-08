'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const v4 = require('../lib/v4Brain');
const { getSettings, saveSettings } = require('../lib/config');

function csvEscape(value) {
  if (value === undefined || value === null) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return '"' + s.replace(/"/g, '""') + '"';
}

const SNAPSHOT_HEADERS = [
  'signalId','key','symbol','side','result','paperState','status','score','rr',
  'entry','sl','tp1','terminalState','terminalAt','terminalTime','terminalPrice',
  'createdAt','createdTime','updatedAt','closedAt','openedAt','realizedPnl',
  'netTpUSDT','netSlUSDT','grossTpUSDT','grossSlUSDT','lossReason','stateReason',
  'rejectionReason','trend5','trend15','trend1h','btcRegime','risks','reasons'
];

function rowForCsv(r) {
  return {
    signalId: r.signalId || r.id || '',
    key: r.key || '',
    symbol: r.symbol || r.sym || '',
    side: r.side || '',
    result: r.result || '',
    paperState: r.paperState || '',
    status: r.status || '',
    score: r.score ?? '',
    rr: r.rr ?? '',
    entry: r.entry ?? '',
    sl: r.sl ?? '',
    tp1: r.tp1 ?? '',
    terminalState: r.terminalState || '',
    terminalAt: r.terminalAt || '',
    terminalTime: r.terminalAt ? new Date(Number(r.terminalAt)).toLocaleString() : '',
    terminalPrice: r.terminalPrice ?? '',
    createdAt: r.createdAt || '',
    createdTime: r.createdAt ? new Date(Number(r.createdAt)).toLocaleString() : '',
    updatedAt: r.updatedAt || '',
    closedAt: r.closedAt || '',
    openedAt: r.openedAt || '',
    realizedPnl: r.realizedPnl ?? '',
    netTpUSDT: r.netTpUSDT ?? '',
    netSlUSDT: r.netSlUSDT ?? '',
    grossTpUSDT: r.grossTpUSDT ?? r.tp1ProfitUSDT ?? '',
    grossSlUSDT: r.grossSlUSDT ?? r.slLossUSDT ?? '',
    lossReason: r.lossReason || '',
    stateReason: r.stateReason || '',
    rejectionReason: r.rejectionReason || '',
    trend5: r.planner?.scoring?.trend5 || r.trend5 || '',
    trend15: r.planner?.scoring?.trend15 || r.trend15 || '',
    trend1h: r.planner?.scoring?.trend1h || r.trend1h || '',
    btcRegime: r.planner?.btcRegime || r.btcRegime || '',
    risks: Array.isArray(r.risks) ? r.risks.join('|') : (r.risks || ''),
    reasons: Array.isArray(r.reasons) ? r.reasons.join('|') : (r.reasons || '')
  };
}

function snapshotCsv(rows) {
  const body = rows.map(r => {
    const row = rowForCsv(r);
    return SNAPSHOT_HEADERS.map(h => csvEscape(row[h])).join(',');
  });
  return [SNAPSHOT_HEADERS.join(','), ...body].join('\n');
}

function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

router.get('/status', auth, (req, res) => {
  const snap = v4.getSnapshot();
  res.json({
    ok: true,
    version: getSettings().version,
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

router.get('/snapshot', auth, (req, res) => {
  const rows = v4.getSignalSnapshot();
  res.json({ ok: true, source: 'v4_signal_snapshot', total: rows.length, summary: v4.computeLedgerSummary(rows), rows });
});

router.get('/stats', auth, (req, res) => {
  const rows = v4.getSignalSnapshot();
  res.json({ ok: true, source: 'v4_signal_snapshot', summary: v4.computeLedgerSummary(rows), visible: v4.computeSummary(v4.getSignals()) });
});

router.get('/ledger', auth, (req, res) => {
  const rows = v4.getSignalSnapshot();
  res.json({ ok: true, source: 'v4_signal_snapshot', total: rows.length, summary: v4.computeLedgerSummary(rows), rows });
});

router.get('/journal', auth, (req, res) => {
  const rows = v4.getSignalSnapshot();
  res.json({ ok: true, source: 'v4_signal_snapshot', total: rows.length, summary: v4.computeLedgerSummary(rows), rows });
});

router.get('/export/snapshot.csv', auth, (req, res) => {
  const rows = v4.getSignalSnapshot();
  sendCsv(res, `orayan_v4_signal_snapshot_${new Date().toISOString().slice(0,10)}_${Date.now()}.csv`, snapshotCsv(rows));
});

router.get('/export/ledger.csv', auth, (req, res) => {
  const rows = v4.getSignalSnapshot();
  sendCsv(res, `orayan_v4_trade_log_${new Date().toISOString().slice(0,10)}_${Date.now()}.csv`, snapshotCsv(rows));
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
  res.json(v4.clearSignals({ archive: req.body?.archive !== false, clearLedger: req.body?.clearLedger === true, fresh: req.body?.fresh === true }));
});

router.post('/fresh', auth, (req, res) => {
  res.json(v4.freshJournal());
});

router.post('/safe-mode', auth, (req, res) => {
  const settings = saveSettings({
    botMode: 'PAPER_REAL_PRICE',
    tradingEnabled: false,
    safeMode: true,
    maxTradeUsdt: 10,
    leverage: 5,
    maxOpenTrades: 10,
    minScoreToTrade: 70,
    cooldownMinutes: 30,
    pendingTimeoutMinutes: 360,
    orderType: 'Market',
    marketOrdersOnTestnet: true,
    oneTradePerSymbol: true,
    rejectUnknownBtcRegime: true,
    rejectTrendConflict: true,
    rejectRsiConflict: true,
    rejectVolumeDeltaConflict: true,
    maxSignalAgeMinutes: 5,
  });
  res.json({ ok: true, settings });
});

module.exports = router;
