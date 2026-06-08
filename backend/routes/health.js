'use strict';

const express = require('express');
const router  = express.Router();
const { getSettings } = require('../lib/config');
const { keySet } = require('../lib/bybit');
const { V4_VERSION } = require('../lib/v4Brain'); // fix48u: live code version, not stale settings hardcode

router.get('/', (req, res) => {
  const settings = getSettings();
  res.json({
    ok: true,
    service: 'orayan-backend',
    version: V4_VERSION, // fix48u: was settings.version (frozen 4.6.8.47) — now the deployed code version
    settingsVersion: settings.version || null, // kept for reference/debugging
    time: new Date().toISOString(),
    mode: settings.botMode,
    testnet: settings.testnet !== false,
    tradingEnabled: settings.tradingEnabled,
    keySet: keySet(),
  });
});

module.exports = router;
