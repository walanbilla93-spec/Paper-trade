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


const ACTIVE_TRADE_STATES = new Set(['PENDING', 'NEW', 'SUBMITTED', 'ORDER_SUBMITTED', 'ORDER_PENDING_FILL', 'PARTIALLY_FILLED', 'FILLED', 'OPEN', 'POSITION_OPEN', 'PAPER_ACTIVE']);
const TERMINAL_TRADE_STATES = new Set(['CLOSED', 'CANCELLED', 'REJECTED', 'DEACTIVATED', 'FILLED_NO_POSITION', 'ORDER_CANCELLED', 'ORDER_REJECTED', 'POSITION_CLOSED']);

function isActiveTrade(trade) {
  const state = String(trade?.status || trade?.paperState || trade?.signalStatus || '').toUpperCase();
  if (TERMINAL_TRADE_STATES.has(state)) return false;
  return ACTIVE_TRADE_STATES.has(state) || state.includes('ACTIVE') || state.includes('OPEN') || state.includes('PENDING');
}

function archiveTradesIfNeeded(trades, label = 'manual-clear') {
  const count = Object.keys(trades || {}).length;
  if (!count) return null;
  const archiveName = `trades_archive_${Date.now()}`;
  store.write(archiveName, { at: Date.now(), label, count, trades });
  return archiveName;
}

function resolveTradeKey(trades, id) {
  const needle = String(id || '');
  if (!needle) return '';
  if (trades[needle]) return needle;
  return Object.keys(trades).find((key) => {
    const t = trades[key] || {};
    return String(t.id || '') === needle || String(t.signalId || '') === needle || String(t.orderId || '') === needle || String(t.orderLinkId || '') === needle;
  }) || '';
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


// ── POST /api/trades/clear ─────────────────────────────────────────
// Clears the backend paper/auto-trade store used by the Trades tab.
// This does not touch real Bybit open positions; it only clears bot-tracked rows.
router.post('/clear', auth, (req, res) => {
  try {
    const trades = getTrades();
    const archive = req.body?.archive !== false ? archiveTradesIfNeeded(trades, 'clear-backend-paper-trades') : null;
    saveTrades({});
    res.json({ ok: true, cleared: Object.keys(trades).length, archive });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── POST /api/trades/cancel-open ───────────────────────────────────
// Marks open/pending backend paper trades as cancelled, or deletes them when delete=true.
router.post('/cancel-open', auth, (req, res) => {
  try {
    const trades = getTrades();
    const del = req.body?.delete === true;
    let cancelled = 0;
    for (const [id, trade] of Object.entries(trades)) {
      if (!isActiveTrade(trade)) continue;
      cancelled += 1;
      if (del) {
        delete trades[id];
      } else {
        trades[id] = {
          ...trade,
          status: 'CANCELLED',
          paperState: 'CANCELLED',
          signalStatus: 'CANCELLED',
          positionStatus: trade.positionStatus === 'OPEN' ? trade.positionStatus : 'NONE',
          orderStatus: trade.orderStatus || 'CANCELLED',
          cancelledAt: Date.now(),
          updatedAt: Date.now(),
          cancelReason: req.body?.reason || 'USER_CANCELLED_BACKEND_PAPER_TRADES',
        };
      }
    }
    saveTrades(trades);
    res.json({ ok: true, cancelled, deleted: del });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── POST /api/trades/cancel-one ────────────────────────────────────
router.post('/cancel-one', auth, (req, res) => {
  try {
    const trades = getTrades();
    const key = resolveTradeKey(trades, req.body?.id || req.body?.tradeId || req.body?.signalId || req.body?.orderId);
    if (!key) return res.json({ ok: false, error: 'trade not found' });
    const del = req.body?.delete === true;
    const trade = trades[key];
    if (del) {
      delete trades[key];
    } else {
      trades[key] = {
        ...trade,
        status: 'CANCELLED',
        paperState: 'CANCELLED',
        signalStatus: 'CANCELLED',
        positionStatus: trade.positionStatus === 'OPEN' ? trade.positionStatus : 'NONE',
        orderStatus: trade.orderStatus || 'CANCELLED',
        cancelledAt: Date.now(),
        updatedAt: Date.now(),
        cancelReason: req.body?.reason || 'USER_CANCELLED_BACKEND_PAPER_TRADE',
      };
    }
    saveTrades(trades);
    res.json({ ok: true, id: key, deleted: del, trade: trades[key] || null });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
