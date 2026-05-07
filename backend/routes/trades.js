// ============================================================
//  Trades routes — AT.openTrades persistence
//    POST /api/trades/push  — browser pushes AT.openTrades object
//    GET  /api/trades       — browser/scanner pulls AT.openTrades
// ============================================================
'use strict';

const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const store   = require('../lib/store');

function getTrades() {
  return store.read('trades', {});
}

function saveTrades(trades) {
  store.write('trades', trades);
}

// ── POST /api/trades/push ─────────────────────────────────────
router.post('/push', auth, (req, res) => {
  try {
    const incoming = req.body?.trades;
    if (!incoming || typeof incoming !== 'object') {
      return res.json({ ok: false, error: 'trades object required' });
    }

    const existing = getTrades();
    const CLOSED   = new Set(['CLOSED', 'CANCELLED']);

    for (const [id, trade] of Object.entries(incoming)) {
      const ex = existing[id];
      if (!ex) {
        existing[id] = trade;
      } else {
        // Closed state is terminal — keep it
        if (CLOSED.has(ex.status) && !CLOSED.has(trade.status)) continue;
        // Newer placedAt or OPEN status wins
        if ((trade.placedAt || 0) >= (ex.placedAt || 0)) {
          existing[id] = { ...ex, ...trade };
        }
      }
    }

    // Purge very old closed trades (>7 days) to keep file small
    const week = 7 * 24 * 60 * 60 * 1000;
    const now  = Date.now();
    for (const [id, trade] of Object.entries(existing)) {
      if (CLOSED.has(trade.status) && trade.closedAt && (now - trade.closedAt) > week) {
        delete existing[id];
      }
    }

    saveTrades(existing);
    res.json({ ok: true, total: Object.keys(existing).length });
  } catch (e) {
    console.error('[trades/push]', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── GET /api/trades ───────────────────────────────────────────
router.get('/', auth, (req, res) => {
  try {
    const trades = getTrades();
    res.json({ ok: true, trades });
  } catch (e) {
    res.json({ ok: false, error: e.message, trades: {} });
  }
});

module.exports = router;
