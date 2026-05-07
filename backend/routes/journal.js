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

router.post('/archive', auth, (req, res) => {
  try {
    const rows = getJournal();
    const stats = journalStats(rows);
    const archive = getArchive();
    const entry = { id:`archive_${Date.now()}`, createdAt:Date.now(), iso:new Date().toISOString(), stats, rows };
    archive.unshift(entry);
    saveArchive(archive);
    if (req.body?.clear !== false) saveJournal([]);
    res.json({ ok:true, archived: rows.length, archiveId: entry.id, cleared: req.body?.clear !== false, stats });
  } catch (e) { res.json({ ok:false, error:e.message }); }
});

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
