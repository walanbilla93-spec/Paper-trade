'use strict';

const express = require('express');
const router  = express.Router();
const { getSettings } = require('../lib/config');
const { keySet } = require('../lib/bybit');
const { V4_VERSION, getLedgerReconcileStats, getBreadthChopState } = require('../lib/v4Brain'); // fix48u: live code version, not stale settings hardcode; fix53: breadth-chop state
const sentinel = require('../lib/sentinelBrain'); // fix49s: price-snapshot freshness heartbeat

router.get('/', (req, res) => {
  const settings = getSettings();
  let ledgerReconcile = null, priceSnapshot = null, sentinelHealth = null, breadthChop = null;
  try { ledgerReconcile = getLedgerReconcileStats(); } catch (_e) {}
  try { priceSnapshot = sentinel.getPriceSnapshotStats(); } catch (_e) {}
  try { breadthChop = getBreadthChopState(); } catch (_e) {} // fix53: { range, hi, lo, threshold, chop, active }
  // fix49t: expose the sentinel's OWN age directly. This is the literal number that was stuck
  // at 73,718s while every other signal looked fine — it has to be on /health, not just inferred
  // from priceSnapshot/ledgerReconcile, since a stuck sentinel can freeze before either of those
  // sub-components would show anything obviously wrong.
  try {
    const s = sentinel.getSentinel();
    sentinelHealth = {
      updatedAt: s?.updatedAt || null,
      ageMs: s?.updatedAt ? (Date.now() - s.updatedAt) : null,
      regime: s?.market_regime || null,
    };
  } catch (_e) {}
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
    ledgerReconcile, // fix49s: { lastAt, totalReconciled } — zombie-sweep heartbeat
    priceSnapshot,   // fix49s: { lastUpdateAt, ageMs, updateCount, staleThresholdMs } — breadth-feed heartbeat
    sentinelHealth,  // fix49t: { updatedAt, ageMs, regime } — the exact value that froze for 20h
    breadthChop,     // fix53: { range, hi, lo, threshold, chop, active } — whipsaw circuit-breaker state
  });
});

module.exports = router;
