'use strict';

const express = require('express');
const router  = express.Router();
const { getSettings } = require('../lib/config');
const { keySet } = require('../lib/bybit');
const { V4_VERSION, getLedgerReconcileStats, getBreadthChopState, detectLiveDivergences } = require('../lib/v4Brain'); // fix48u: live code version, not stale settings hardcode; fix53: breadth-chop state; fix57: live divergence detector
const sentinel = require('../lib/sentinelBrain'); // fix49s: price-snapshot freshness heartbeat
const unifiedBrain = require('../lib/unifiedBrain'); // fix62: expose V4_UNIFIED_BRAIN flag + live authority count on /health (was invisible before — could only be inferred from behavior)

router.get('/', (req, res) => {
  const settings = getSettings();
  let ledgerReconcile = null, priceSnapshot = null, sentinelHealth = null, breadthChop = null;
  try { ledgerReconcile = getLedgerReconcileStats(); } catch (_e) {}
  try { priceSnapshot = sentinel.getPriceSnapshotStats(); } catch (_e) {}
  try { breadthChop = getBreadthChopState(); } catch (_e) {} // fix53: { range, hi, lo, threshold, chop, active }
  let liveDivergence = null;
  try { liveDivergence = detectLiveDivergences(); } catch (_e) {} // fix57: read-only Orayan-vs-Bybit mismatch telemetry
  // fix62: was invisible whether V4_UNIFIED_BRAIN was actually taking effect — only inferable from
  // signal behavior. Surface the flag plus a live count of signals currently under its authority
  // (BYBIT-authority = order-bearing, driven by the lifecycle core, snapshot cannot touch them) and
  // any FROZEN (ambiguous, alarmed, never-abandoned) — so "is it on AND doing something" is one look.
  let unifiedBrainStatus = { enabled: unifiedBrain.flagEnabled(), bybitAuthorityCount: null, frozenCount: null };
  try {
    if (unifiedBrainStatus.enabled) {
      const { getSignals } = require('../lib/v4Brain');
      const lc = require('../lib/lifecycle');
      const store = require('../lib/store');
      const signals = getSignals() || [];
      let bybitAuthority = 0, frozen = 0;
      for (const s of signals) {
        if (lc.authorityOf(s) === 'BYBIT') bybitAuthority++;
        if (s && s.paperState === lc.STATES.FROZEN) frozen++;
      }
      unifiedBrainStatus.bybitAuthorityCount = bybitAuthority;
      unifiedBrainStatus.frozenCount = frozen;
    }
  } catch (_e) {}
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
    liveDivergence,  // fix57: { mode, checked, divergences[] } — read-only Orayan-vs-Bybit mismatches
    unifiedBrain: unifiedBrainStatus, // fix62: { enabled, bybitAuthorityCount, frozenCount } — V4_UNIFIED_BRAIN visibility
  });
});

module.exports = router;
