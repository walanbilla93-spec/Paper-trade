'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const v4 = require('../lib/v4Brain');

router.get('/', auth, async (req, res) => {
  try {
    const snap = req.query.refresh === '1' ? await v4.scanOnce() : v4.getSnapshot();
    res.json({
      ok: true,
      version: snap.version,
      ts: snap.ts,
      entries: snap.entries || [],
      summary: snap.summary || {},
      btcRegime: snap.btcRegime || {},
      source: 'backend-planner-v4'
    });
  } catch (e) {
    res.json({ ok: false, error: e.message, entries: [] });
  }
});

router.post('/refresh', auth, async (req, res) => {
  try {
    res.json(await v4.scanOnce());
  } catch (e) {
    res.json({ ok: false, error: e.message, entries: [] });
  }
});

module.exports = router;
