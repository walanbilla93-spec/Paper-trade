'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const marketBrain = require('../lib/marketBrain');

router.get('/', auth, async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const snap = refresh ? await marketBrain.scanOnce() : marketBrain.getSnapshot();
    res.json(snap);
  } catch (e) {
    res.json({ ok: false, error: e.message, entries: [] });
  }
});

router.post('/refresh', auth, async (req, res) => {
  try {
    const snap = await marketBrain.scanOnce();
    res.json(snap);
  } catch (e) {
    res.json({ ok: false, error: e.message, entries: [] });
  }
});

module.exports = router;
