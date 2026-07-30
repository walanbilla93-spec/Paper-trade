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
  // ==========================================================================================
  // fixSLIM (07/22): THE FRONTEND↔BACKEND LINK WAS DROWNING, NOT DROPPING.
  // Measured from the user's own ledger export: 392 rows, average row 9,458 bytes — 87.6% of it
  // five fields the signals TABLE never renders (diagnostic 37%, planner 29%, diag 17%,
  // experimentSettingsSnapshot 4%, history 4%). /dashboard was ~2.9 MB serialized, polled every
  // 7s, into a Dialog mobile link observed at 6–142 KB/s, against a 12s frontend fetch timeout:
  // at 22 KB/s the transfer needs ~131s. Every slow-network moment = timeout = "SRV✗" = the
  // "fragile link". The link was fine; the payload was absurd.
  // Three layers, all backward-compatible (a plain GET /dashboard is byte-identical to before):
  //   ?slim=1 — strips those five fields from signals + ledger rows (~8x smaller before gzip).
  //             Heavy consumers (CSV export, journal card expand) fetch the FULL dashboard on
  //             demand instead — user action, not a 7s tax.
  //   ?h=<hash> — if it matches the current serialized slim body's hash, returns ~60 bytes
  //             ({unchanged:true}). Snapshot rebuilds every ~20s+ scan; polls run at 7s, so most
  //             polls collapse to nothing.
  //   caching — bodies serialize ONCE per snapshot rebuild (keyed by snap.ts), not per request;
  //             a 2.9MB JSON.stringify per poll was also meaningful CPU on the shared node.
  // gzip on top lives in server.js (fixGZIP).
  // ==========================================================================================
  const snap = v4.getSnapshot();
  if (String(req.query.slim || '') === '1') {
    const c = getDashCache(snap);
    if (req.query.h && String(req.query.h) === c.hash) {
      return res.json({ ok: true, unchanged: true, h: c.hash, ts: snap.ts, version: snap.version });
    }
    res.type('application/json');
    return res.send(c.slimJson);
  }
  res.json(snap);
});

// fixSLIM: per-snapshot serialization cache + hash. Rebuilt only when snap.ts moves.
const SLIM_STRIP = ['diagnostic', 'planner', 'diag', 'experimentSettingsSnapshot', 'history'];
let _dashCache = { forTs: null, slimJson: '', hash: '' };
function slimRow(r) {
  if (!r || typeof r !== 'object') return r;
  let out = null;
  for (const k of SLIM_STRIP) {
    if (k in r) { if (!out) { out = { ...r }; } delete out[k]; }
  }
  return out || r; // untouched rows are passed by reference — no copy cost
}
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h.toString(36);
}
function getDashCache(snap) {
  if (_dashCache.forTs === snap.ts && _dashCache.slimJson) return _dashCache;
  const slim = {
    ...snap,
    slim: true, // frontend marker: heavy fields absent by design, fetch full dashboard for exports
    signals: Array.isArray(snap.signals) ? snap.signals.map(slimRow) : snap.signals,
    ledger: Array.isArray(snap.ledger) ? snap.ledger.map(slimRow) : snap.ledger,
  };
  const slimJson0 = JSON.stringify(slim);
  const hash = fnv1a(slimJson0);
  // embed the hash so the client can echo it back on the next poll without a second field to track
  slim.h = hash;
  _dashCache = { forTs: snap.ts, slimJson: JSON.stringify(slim), hash };
  return _dashCache;
}

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

// fixPHASE2: real opportunity-cost check on EXPIRED signals (excludes non-crypto/TradFi symbols).
// Manual trigger only — fetches historical klines per expired signal, not part of the scan loop.
router.get('/expired-analysis', auth, async (req, res) => {
  try {
    const result = await v4.analyzeExpiredOpportunityCost();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// fixREVERSAL: real backtest of "would reversing every trade have done better" — mirrors SL/TP
// around each real closed trade's actual entry price and walks real forward candles. Manual trigger
// only, same pattern as expired-analysis.
router.get('/reversal-analysis', auth, async (req, res) => {
  try {
    const result = await v4.analyzeReversalHypothesis();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

// fixSHADOWLOG: export routes for every shadow module in Orayan, so they can be pulled directly
// instead of scraping the Northflank log UI. Two kinds, matching how each is captured:
//   /shadow-signals — BREADTH_FIGHT_SHADOW + FADE_SHADOW, live-logged regardless of admission,
//                     read from the dedicated shadow_signals.ndjson (not evicted by log-store churn).
//   /shadow-diag    — rangeTrapShadow / deadHourShadow / rsiLegChaseShadow / flipShadowAtBirth,
//                     which only exist on ADMITTED signals' diag object — scanned from the signals
//                     store at read time (no separate capture needed, they're already there).
// Both support ?format=csv for a direct download; default is json. Read-only, changes nothing.
function toCsv(rows, fields) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [fields.join(',')];
  for (const r of rows) lines.push(fields.map(f => esc(r[f])).join(','));
  return lines.join('\n');
}

// fixTRUTHPERM: instant Bybit-Truth stats from the permanent accumulator — no 1500-row fetch,
// no client-side re-derivation. Replaces the old bybit-ledger?limit=1500 + client rank/dedupe path
// for the panel's 4 headline stats. Read-only, folds any newly-closed trades on each call (cheap —
// only unseen ids do real work).
router.get('/bybit-truth-summary', auth, (req, res) => {
  try {
    const summary = v4.getBybitTruthSummary();
    res.json({ ok: true, source: 'bybit_truth_permanent', ...summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'bybit-truth-summary failed' });
  }
});

router.get('/shadow-signals', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '2000', 10) || 2000, 8000);
  let rows = [];
  try { rows = store.readNdjsonTail('shadow_signals', limit) || []; } catch (_e) {}
  const type = req.query.type ? String(req.query.type).toUpperCase() : null; // BREADTH_FIGHT_SHADOW | FADE_SHADOW
  if (type) rows = rows.filter(r => String(r.type || '').toUpperCase() === type);
  if (String(req.query.format || '').toLowerCase() === 'csv') {
    const csv = toCsv(rows, ['iso', 'type', 'message']);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="shadow-signals-${Date.now()}.csv"`);
    return res.send(csv);
  }
  res.json({ ok: true, source: 'shadow_signals.ndjson', total: rows.length, rows });
});

// fixPHASELOG: export for PHASE0_TRACE (why did/didn't a signal reach a live-entry attempt) and
// PHASE1_SHADOW (unified-decision-engine vs actual outcome) — same durable-store pattern as
// /shadow-signals above. CSV flattens `details` into columns (unlike /shadow-signals's 3-column
// CSV) since the whole point of these two rows is the structured fields, not just the message text.
router.get('/phase-trace', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '2000', 10) || 2000, 8000);
  let rows = [];
  try { rows = store.readNdjsonTail('phase_trace', limit) || []; } catch (_e) {}
  const type = req.query.type ? String(req.query.type).toUpperCase() : null; // PHASE0_TRACE | PHASE1_SHADOW
  if (type) rows = rows.filter(r => String(r.type || '').toUpperCase() === type);
  if (String(req.query.format || '').toLowerCase() === 'csv') {
    const flat = rows.map(r => ({ iso: r.iso, type: r.type, message: r.message, ...(r.details || {}) }));
    const fields = ['iso', 'type', 'message', 'symbol', 'side', 'hadFirstTouch', 'missedMove',
      'knifeCheck', 'maxOpenTrades', 'sentinelBlind', 'outcome',
      'unifiedWouldPlace', 'unifiedReason', 'actuallyLive', 'agree'];
    const csv = toCsv(flat, fields);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="phase-trace-${Date.now()}.csv"`);
    return res.send(csv);
  }
  res.json({ ok: true, source: 'phase_trace.ndjson', total: rows.length, rows });
});

router.get('/shadow-diag', auth, (req, res) => {
  const DIAG_SHADOW_FIELDS = ['rangeTrapShadow', 'deadHourShadow', 'rsiLegChaseShadow', 'flipShadowAtBirth'];
  let signals = [];
  try { signals = store.read('signals', []) || []; } catch (_e) {}
  const rows = [];
  for (const s of signals) {
    const diag = s && s.diag;
    if (!diag) continue;
    for (const f of DIAG_SHADOW_FIELDS) {
      if (diag[f] != null) {
        rows.push({ symbol: s.symbol || s.sym || null, side: s.side || null, field: f, value: diag[f], signalId: s.id || null, capturedAt: diag.capturedAt || null });
      }
    }
  }
  if (String(req.query.format || '').toLowerCase() === 'csv') {
    const csv = toCsv(rows, ['symbol', 'side', 'field', 'value', 'signalId', 'capturedAt']);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="shadow-diag-${Date.now()}.csv"`);
    return res.send(csv);
  }
  res.json({ ok: true, source: 'signals[].diag', total: rows.length, rows });
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

// fixAGREEBLOCK (hotfix 17): symbols auto-blocked after Bybit's "sign the agreement" rejection.
// GET lists them (with the exact retMsg, so it's clear which product needs signing); POST clears
// one after the user has signed the pending agreement on Bybit's site/app, so it's picked up again
// on the next scan without waiting for the block's own 7-day safety expiry.
router.get('/agreement-blocks', auth, (req, res) => {
  const { getAgreementBlocks } = require('../lib/executor');
  res.json({ ok: true, blocks: getAgreementBlocks ? getAgreementBlocks() : {} });
});
router.post('/agreement-blocks/clear', auth, (req, res) => {
  const { clearAgreementBlock } = require('../lib/executor');
  const symbol = String(req.body?.symbol || '').toUpperCase();
  if (!symbol) return res.json({ ok: false, error: 'symbol required' });
  clearAgreementBlock(symbol);
  res.json({ ok: true, symbol, cleared: true });
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
