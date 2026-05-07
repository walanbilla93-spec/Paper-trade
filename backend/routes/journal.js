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

function getJournal() {
  return store.read('journal', []);
}

function saveJournal(rows) {
  store.write('journal', rows.slice(0, 1000));
}

// ── POST /api/journal/push ────────────────────────────────────
router.post('/push', auth, (req, res) => {
  try {
    const incoming = req.body?.rows;
    if (!Array.isArray(incoming)) {
      return res.json({ ok: false, error: 'rows array required' });
    }

    const existing = getJournal();
    const map      = new Map();

    // Load existing rows keyed by id
    for (const r of existing) {
      if (r.id) map.set(r.id, r);
    }

    let added = 0, updated = 0;
    for (const r of incoming) {
      if (!r.id) {
        // No id — generate one and add
        r.id = `j_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        map.set(r.id, r);
        added++;
      } else {
        const ex = map.get(r.id);
        if (!ex) {
          map.set(r.id, r);
          added++;
        } else {
          // Newer timestamp wins
          if ((r.updatedAt || r.ts || 0) >= (ex.updatedAt || ex.ts || 0)) {
            map.set(r.id, r);
            updated++;
          }
        }
      }
    }

    const merged = [...map.values()]
      .sort((a, b) => (b.createdAt || b.ts || 0) - (a.createdAt || a.ts || 0));
    saveJournal(merged);

    res.json({ ok: true, total: merged.length, added, updated });
  } catch (e) {
    console.error('[journal/push]', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── GET /api/journal ──────────────────────────────────────────
router.get('/', auth, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || 500), 1000);
    const rows  = getJournal().slice(0, limit);
    res.json({ ok: true, rows, total: rows.length });
  } catch (e) {
    res.json({ ok: false, error: e.message, rows: [] });
  }
});

module.exports = router;
