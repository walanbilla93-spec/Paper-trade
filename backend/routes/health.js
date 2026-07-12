'use strict';

const express = require('express');
const router  = express.Router();
const { getSettings } = require('../lib/config');
const { keySet } = require('../lib/bybit');
const { V4_VERSION, getLedgerReconcileStats, getBreadthChopState, detectLiveDivergences } = require('../lib/v4Brain'); // fix48u: live code version, not stale settings hardcode; fix53: breadth-chop state; fix57: live divergence detector
const sentinel = require('../lib/sentinelBrain'); // fix49s: price-snapshot freshness heartbeat
const unifiedBrain = require('../lib/unifiedBrain'); // fix62: expose V4_UNIFIED_BRAIN flag + live authority count on /health (was invisible before — could only be inferred from behavior)
const store = require('../lib/store'); // fixPERSIST: surface the DATA_DIR diagnostic (see below)

// fixPERSIST: store.startupDiagnostic() was written in fix49l and EXPORTED — but never called, by
// anything, ever. The one warning that would have revealed the recurring "ledger wiped on deploy"
// problem has therefore never printed in the system's life. It is the difference between:
//   usingEnv=true + writable=true + existingFiles>0  → real mounted volume, data survives restarts
//   existingFiles===0 right after a restart           → NOT persisting; the volume is not actually
//                                                       mounted at DATA_DIR and every deploy wipes.
// This matters far more in LIVE mode than paper: a wipe destroys the trades store, so the tradeId →
// position link is lost, liveStateAuthority cannot claim the real Bybit position, and a live
// position runs completely unmanaged (only the exchange-side SL still protects the account).
// Exposed on /health so it can be read from the phone instead of hunting through Northflank logs.
let _storageDiag = null;
try { _storageDiag = store.startupDiagnostic(); } catch (_e) {}

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
    // fixPERSIST: re-read file count live (not just the boot snapshot) so a wipe is visible the
    // moment it happens. persisting=false is a HARD BLOCKER for live trading — see note at top.
    storage: (() => {
      let liveFileCount = null;
      try { liveFileCount = require('fs').readdirSync(store.DATA_DIR).filter(f => !f.startsWith('.')).length; } catch (_e) {}
      return {
        dataDir: store.DATA_DIR,
        usingEnvVar: !!process.env.DATA_DIR,
        writable: _storageDiag ? _storageDiag.writable : null,
        filesAtBoot: _storageDiag ? _storageDiag.fileCount : null,
        filesNow: liveFileCount,
        persisting: !!(process.env.DATA_DIR && _storageDiag && _storageDiag.fileCount > 0),
      };
    })(),
  });
});

module.exports = router;
