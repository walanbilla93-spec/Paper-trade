const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const v4 = require('../lib/v4Brain');
const store = require('../lib/store');

// v4 change: frontend/browser-pushed signals are no longer the source of truth.
// We keep a compatibility push endpoint, but v4 paper stats use only backend-planner signals.
router.post('/push', auth, (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.signals) ? req.body.signals : [];
    store.write('legacy_browser_signals', {
      at: Date.now(),
      total: incoming.length,
      note: 'Ignored by v4.1 backend paper engine. Backend planner is source of truth.',
      sample: incoming.slice(0, 5)
    });
    res.json({ ok: true, ignored: incoming.length, sourceOfTruth: 'backend-planner-v4.2' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.get('/', auth, (req, res) => {
  res.json(v4.getSignals());
});

router.post('/clear', auth, (req, res) => {
  res.json(v4.clearSignals({ archive: req.body?.archive !== false }));
});

module.exports = router;
