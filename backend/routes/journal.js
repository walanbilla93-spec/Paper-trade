// ============================================================
//  Journal routes
//    POST /api/journal/push  — browser pushes rows to server
//    GET  /api/journal       — browser pulls rows from server
// ============================================================
'use strict';

const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const store   = require('../lib/store');
const { dedupeJournal, journalStats } = require('../lib/journalUtils');

function v4Brain() {
  // Lazy require avoids circular startup issues.
  return require('../lib/v4Brain');
}

function getJournal() {
  return store.read('journal', []);
}

function saveJournal(rows) {
  const clean = dedupeJournal(rows).rows;
  store.write('journal', clean.slice(0, 1000));
}
function getArchive(){ return store.read('journal-archive', []); }
function saveArchive(rows){ store.write('journal-archive', rows.slice(0, 50)); }

// ── POST /api/journal/push ────────────────────────────────────
router.post('/push', auth, (req, res) => {
  try {
    const incoming = req.body?.rows;
    if (!Array.isArray(incoming)) {
      return res.json({ ok: false, error: 'rows array required' });
    }

    const before = getJournal();
    const mergedRaw = [...before, ...incoming];
    const { rows, duplicatesRemoved } = dedupeJournal(mergedRaw);
    saveJournal(rows);

    res.json({ ok: true, total: rows.length, unique: rows.length, rawIncoming: incoming.length, duplicatesRemoved, stats: journalStats(rows) });
  } catch (e) {
    console.error('[journal/push]', e.message);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/dedupe', auth, (req, res) => {
  try {
    const before = getJournal();
    const { rows, duplicatesRemoved } = dedupeJournal(before);
    saveJournal(rows);
    res.json({ ok: true, before: before.length, after: rows.length, duplicatesRemoved, stats: journalStats(rows) });
  } catch (e) { res.json({ ok:false, error:e.message }); }
});

router.get('/stats', auth, (req, res) => {
  try {
    const rows = getJournal();
    res.json({ ok:true, stats: journalStats(rows) });
  } catch (e) { res.json({ ok:false, error:e.message }); }
});

function archiveAndFresh(req, res) {
  try {
    const rows = getJournal();
    const stats = journalStats(rows);
    const v4 = v4Brain();
    const v4Snapshot = v4.getSnapshot ? v4.getSnapshot() : null;
    const v4Rows = v4.getLedger
      ? v4.getLedger()
      : (Array.isArray(v4Snapshot?.ledger) ? v4Snapshot.ledger : []);
    const v4Signals = v4.getSignals
      ? v4.getSignals()
      : (Array.isArray(v4Snapshot?.signals) ? v4Snapshot.signals : []);
    const v4Diagnostics = v4.getDiagnostics ? v4.getDiagnostics(5000) : store.read('v4_diagnostic_journal', []);
    const v4Rejections = store.read('v4_candidate_rejections', []);
    const v4Summary = v4.computeLedgerSummary
      ? v4.computeLedgerSummary(v4Rows)
      : (v4Snapshot?.summary || {});
    const archive = getArchive();
    const entry = {
      id: `archive_${Date.now()}`,
      createdAt: Date.now(),
      iso: new Date().toISOString(),
      stats,
      rows,
      v4Summary,
      v4Rows,
      v4Signals,
      v4Snapshot,
      v4Diagnostics,
      v4Rejections
    };
    archive.unshift(entry);
    saveArchive(archive);

    const shouldClear = req.body?.clear !== false;
    if (shouldClear) {
      saveJournal([]);
      if (v4Brain().freshJournal) v4Brain().freshJournal();
      store.write('v4_diagnostic_journal', []);
      if (typeof store.clearNdjson === 'function') store.clearNdjson('v4_diagnostic_journal');
      store.write('v4_candidate_rejections', []);
    }

    res.json({
      ok: true,
      archived: rows.length,
      v4Archived: v4Rows.length,
      v4DiagnosticsArchived: Array.isArray(v4Diagnostics) ? v4Diagnostics.length : 0,
      v4RejectionsArchived: Array.isArray(v4Rejections) ? v4Rejections.length : 0,
      archiveId: entry.id,
      cleared: shouldClear,
      stats,
      v4Summary
    });
  } catch (e) { res.json({ ok:false, error:e.message }); }
}

router.post('/archive', auth, archiveAndFresh);
router.post('/fresh', auth, archiveAndFresh);

router.get('/archive', auth, (req, res) => {
  try { res.json({ ok:true, archives:getArchive().map(a=>({ id:a.id, iso:a.iso, createdAt:a.createdAt, stats:a.stats })) }); }
  catch (e) { res.json({ ok:false, error:e.message, archives:[] }); }
});

router.delete('/', auth, (req, res) => {
  try { const rows=getJournal(); saveJournal([]); res.json({ ok:true, cleared:rows.length }); }
  catch (e) { res.json({ ok:false, error:e.message }); }
});

// ── GET /api/journal ──────────────────────────────────────────
router.get('/', auth, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || 500), 1000);
    const rows  = getJournal().slice(0, limit);
    res.json({ ok: true, rows, total: rows.length, stats: journalStats(getJournal()) });
  } catch (e) {
    res.json({ ok: false, error: e.message, rows: [] });
  }
});

module.exports = router;
