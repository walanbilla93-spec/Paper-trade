'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const v4 = require('../lib/v4Brain');
const store = require('../lib/store'); // fix58: bybit-ledger ndjson export
const { getSettings, saveSettings } = require('../lib/config');

router.get('/status', auth, (req, res) => {
  const snap = v4.getSnapshot();
  res.json({
    ok: true,
    version: v4.V4_VERSION || snap.version || '4.6.8.30', // fix48u: live code version (was hardcoded 4.6.8.30)
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

// fix44a: GET /rejections removed — skip alert system disabled

// fix75: GET /alerts — persistent alert feed DERIVED from the ledger at read time. Deliberately NOT a
// second write-path store: every alert-worthy transition already lands in the ledger (single source of
// truth, NVMe-persisted), so deriving the feed on read means (a) alerts survive any device/localStorage
// wipe — the "alerts disappear" bug was ST.alerts living only in per-device localStorage — and (b) a
// missed write is structurally impossible; there is nothing to keep in sync. Same title strings and
// event-key scheme as the frontend's pushLedgerEventAlerts so client-side dedupe (a.key) works across
// both sources without merge logic. Terminal rows only + live actives; 'Candidate rejected' stays
// session-ephemeral by design (it comes from rejectedPreview, not the ledger — rejected candidates
// are never born, so there is nothing durable to derive them from).
router.get('/alerts', auth, (req, res) => {
  const hours = Math.max(1, Math.min(168, parseInt(req.query.hours || '48', 10) || 48));
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '200', 10) || 200));
  const cutoff = Date.now() - hours * 3600 * 1000;
  const FINAL_WIN = new Set(['TP_HIT']);
  const FINAL_LOSS = new Set(['SL_HIT']);
  const FINAL_INV = new Set(['INVALIDATED', 'EXPIRED', 'REJECTED', 'STALE_CANCELLED']);
  const out = [];
  for (const r of v4.getLedger()) {
    if (!r) continue;
    const st = String(r.paperState || r.status || '');
    const at = Number(r.closedAt || r.updatedAt || r.createdAt || 0);
    if (!at || at < cutoff) continue;
    const sym = String(r.sym || r.symbol || '').replace('USDT', '');
    const side = r.side || '';
    const score = Math.round(Number(r.score || r.setupScore || 0));
    const rr = Number(r.rr || r.rr1 || 0).toFixed(2);
    const reason = String(r.stateReason || r.lossReason || '').slice(0, 160);
    const id = r.id || r.key || `${sym}|${side}|${r.entry}`;
    if (FINAL_WIN.has(st)) out.push({ title: '🎯 TP hit උනා', message: `${sym} ${side} · score ${score} · RR ${rr} · ${reason}`, time: at, important: true, key: `ledger_tp_${id}_${st}` });
    else if (FINAL_LOSS.has(st)) out.push({ title: '❌ SL hit', message: `${sym} ${side} · score ${score} · RR ${rr} · ${reason}`, time: at, important: true, key: `ledger_sl_${id}_${st}` });
    else if (FINAL_INV.has(st)) out.push({ title: '⚠️ Signal invalidated', message: `${sym} ${side} · score ${score} · ${reason}`, time: at, important: false, key: `ledger_inv_${id}_${st}` });
    else if (st === 'PAPER_ACTIVE') out.push({ title: '🔵 Trade live වෙලා', message: `${sym} ${side} PAPER_ACTIVE · score ${score} · RR ${rr}`, time: at, important: true, key: `ledger_active_${id}_${st}` });
  }
  out.sort((a, b) => b.time - a.time);
  res.json({ ok: true, source: 'v4_paper_ledger_derived', hours, total: out.length, alerts: out.slice(0, limit) });
});


router.get('/diagnostics', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 5000);
  const rows = v4.getDiagnostics ? v4.getDiagnostics(limit) : [];
  res.json({ ok: true, source: 'v4_diagnostic_journal.ndjson', total: Array.isArray(rows) ? rows.length : 0, rows: Array.isArray(rows) ? rows.slice(0, limit) : [] });
});

// fix49q: expose the breadth time-series (was logged to breadth_history.ndjson by fix49l but never
// reachable via API — every /breadth* URL 404'd). Read-only. Returns newest-first samples + the
// current computed slope (rising/falling/flat). Lets the breadth trajectory be fetched and analysed
// externally — the data needed to test "BUY losses while breadth declining" and to validate the
// conflict-breadth-lead experiment.
router.get('/breadth-history', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '1000', 10) || 1000, 10000);
  const out = v4.getBreadthHistory ? v4.getBreadthHistory(limit) : { rows: [], slope: null };
  const rows = Array.isArray(out.rows) ? out.rows : [];
  res.json({ ok: true, source: 'breadth_history.ndjson', total: rows.length, slope: out.slope || null, rows });
});

// fix58: expose the Bybit event ledger (bybit_ledger.ndjson) — fills/opens/closes/cancels/rejects
// with real net P&L, fees, slippage. Download alongside the trade ledger + breadth log for
// cost-aware analysis. Optional ?event=EXECUTION|STATUS_CHANGE filter. Read-only.
router.get('/bybit-ledger', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '2000', 10) || 2000, 20000);
  let rows = [];
  try { rows = store.readNdjsonTail('bybit_ledger', limit) || []; } catch (_e) {}
  const ev = req.query.event ? String(req.query.event).toUpperCase() : null;
  if (ev) rows = rows.filter(r => String(r.event || '').toUpperCase() === ev);
  res.json({ ok: true, source: 'bybit_ledger.ndjson', total: rows.length, rows });
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
    minScoreToTrade: 70, // fix30: fix28 data-proven floor — 40-69=25%WR(-11U), 70+=57%WR(+7U)
    v4MinBuyScore: 70,
    v4MinSellScore: 70,
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
    v4MaxTpAtr: 8.0, // fix25b: was 2.4, killed all signals
    v4RiskWindowHours: 6,
    v4MaxConsecutiveLosses: 5,
    v4MaxSessionLossUsdt: 5.0,
    experimentPresetMode: 'research', // fix-preset: Research is the only standard
    v4EntryToleranceAtr: 0.25,
    v4EntryReactionBps: 5,
    v4EntryWaitSeconds: 90, // fix33-obs2: was 10 — must be > scan interval (20s)
    minEntryTimingScore: 0, // fix25b: entry timing disabled
    v4MinBuyEntryTimingScore: 0,
    v4MinSellEntryTimingScore: 0,
    v4WaitingExpiryMinutes: 30,
    v4SymbolLossCooldownMinutes: 60,
  });
  res.json({ ok: true, settings });
});

// ── Overall PnL history (all-time, survives ledger clears) ─────────────────
// GET /api/v4/pnl
// fix52: all-time net + all-time win rate + last-7 LK days now come from the PERMANENT accumulator
// (pnl_permanent), which counts each resolved trade exactly once and never decrements. This is what
// removes the "win rate fell from 58% to 56% with no loss" drift: the figure no longer depends on
// which rows are currently inside the capped ledger window. `session` still reflects the live ledger.
router.get('/pnl', auth, (req, res) => {
  const perm = v4.getPermanentSummary(7);
  const ledger = v4.getLedger();
  const currentSummary = v4.computeLedgerSummary(ledger);
  res.json({
    ok: true,
    source: 'v4_pnl_permanent',
    // All-time, decay-proof. winRate/sideStats added so the UI can show a stable overall figure.
    allTime: {
      net: perm.net,
      trades: perm.completed,
      wins: perm.wins,
      losses: perm.losses,
      winRate: perm.winRate,
      sideStats: perm.sideStats,
      startedAt: perm.startedAt,
    },
    // Current ledger session (live window — fine to churn).
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
    // Daily breakdown — permanent, last 7 LK days (stable; not recomputed from the window).
    daily: perm.days,
    // Current ledger daily (kept for any chart that wants the live-session view).
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

// POST /api/v4/retry-rejections — manual replay of soft-gate rejections from frontend button
router.post('/retry-rejections', auth, async (req, res) => {
  try {
    const result = await v4.manualRetryRejections({
      maxAgeMinutes: Number(req.body?.maxAgeMinutes) || 240,
      minScore: Number(req.body?.minScore) || 60,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
