'use strict';

const express = require('express');
const router  = express.Router();
const { getSettings } = require('../lib/config');
const { keySet } = require('../lib/bybit');

router.get('/', (req, res) => {
  const settings = getSettings();
  res.json({
    ok: true,
    service: 'orayan-backend',
    version: settings.version,
    time: new Date().toISOString(),
    mode: settings.botMode,
    testnet: settings.testnet !== false,
    tradingEnabled: settings.tradingEnabled,
    keySet: keySet(),
  });
});

module.exports = router;
