'use strict';

// ORAYAN Sentinel Routes — fix29
// GET  /api/sentinel          → current sentinel state
// POST /api/sentinel/refresh  → force immediate re-evaluation
// GET  /api/sentinel/history  → regime flip log (JSON)
// GET  /api/sentinel/history.csv → regime flip log (CSV download)

const router = require('express').Router();
const sentinel = require('../lib/sentinelBrain');

// Current sentinel state
router.get('/', (req, res) => {
  try {
    res.json({ ok: true, sentinel: sentinel.getSentinel() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Force refresh
router.post('/refresh', async (req, res) => {
  try {
    await sentinel.refresh();
    res.json({ ok: true, sentinel: sentinel.getSentinel() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// History JSON
router.get('/history', (req, res) => {
  try {
    res.json({ ok: true, history: sentinel.getHistory() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// History CSV download
router.get('/history.csv', (req, res) => {
  try {
    const csv = sentinel.getHistoryCSV();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="orayan_sentinel_history_${Date.now()}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
