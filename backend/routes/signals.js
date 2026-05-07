// ============================================================
//  Signals routes
//    POST /api/signals/push  — browser pushes signal array
//    GET  /api/signals       — browser/scanner pulls signals
// ============================================================
'use strict';

const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const store   = require('../lib/store');

function getSignals() {
  return store.read('signals', []);
}

function saveSignals(sigs) {
  store.write('signals', sigs.slice(0, 100));
}

// ── POST /api/signals/push ────────────────────────────────────
router.post('/push', auth, (req, res) => {
  try {
    const incoming = req.body?.signals;
    if (!Array.isArray(incoming)) {
      return res.json({ ok: false, error: 'signals array required' });
    }

    const existing = getSignals();
    const map      = new Map();
    const TERMINAL = new Set(['WIN', 'LOSS', 'INVALID', 'EXPIRED']);

    for (const s of existing) {
      if (s.id) map.set(s.id, s);
    }

    for (const s of incoming) {
      if (!s.id) continue;
      const ex = map.get(s.id);
      if (!ex) {
        map.set(s.id, s);
      } else {
        // Terminal state always wins — can't un-close a signal
        const exTerminal  = TERMINAL.has(ex.status);
        const inTerminal  = TERMINAL.has(s.status);
        if (exTerminal && !inTerminal) continue; // keep closed version
        if ((s.updatedAt || 0) >= (ex.updatedAt || 0)) {
          map.set(s.id, s);
        }
      }
    }

    const merged = [...map.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 100);
    saveSignals(merged);

    res.json({ ok: true, total: merged.length });
  } catch (e) {
    console.error('[signals/push]', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── GET /api/signals ──────────────────────────────────────────
router.get('/', auth, (req, res) => {
  try {
    const sigs = getSignals();
    res.json(sigs); // array directly — matches frontend expectation
  } catch (e) {
    res.json([]);
  }
});

module.exports = router;
