'use strict';

const express = require('express');
const router  = express.Router();

// fixHEALTHBOOT (07/22): every lib was required at module top-level, so a partially-synced deploy
// (files copied in non-atomic order — observed live 07/22 01:05Z: "Cannot find module '../lib/v4Brain'"
// thrown FROM THIS FILE's require, process exit code 1, container crash-loop until the next full
// copy landed) killed the whole backend because the HEALTH route couldn't load. The health endpoint
// is precisely the thing that must survive a broken deploy to REPORT it. All lib requires are now
// individually guarded; a failed one degrades the response instead of crashing the process, and the
// error is surfaced in the payload so the phone shows WHAT is missing without Northflank log spelunking.
function tryRequire(p) {
  try { return { mod: require(p), error: null }; }
  catch (e) { return { mod: null, error: (e && e.message) || String(e) }; }
}
const _config       = tryRequire('../lib/config');
const _bybit        = tryRequire('../lib/bybit');
const _v4           = tryRequire('../lib/v4Brain');
const _sentinel     = tryRequire('../lib/sentinelBrain');
const _unifiedBrain = tryRequire('../lib/unifiedBrain');
const _store        = tryRequire('../lib/store');
const _bootErrors = [_config, _bybit, _v4, _sentinel, _unifiedBrain, _store]
  .filter(x => x.error).map(x => x.error);

const getSettings = (_config.mod && _config.mod.getSettings) || (() => ({}));
const keySet      = (_bybit.mod && _bybit.mod.keySet) || (() => false);
const v4          = _v4.mod;
const sentinel    = _sentinel.mod;
const unifiedBrain = _unifiedBrain.mod;
const store       = _store.mod;

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
try { _storageDiag = store && store.startupDiagnostic(); } catch (_e) {}

router.get('/', (req, res) => {
  const settings = getSettings();
  let ledgerReconcile = null, priceSnapshot = null, sentinelHealth = null, breadthChop = null;
  try { ledgerReconcile = v4 && v4.getLedgerReconcileStats(); } catch (_e) {}
  try { priceSnapshot = sentinel && sentinel.getPriceSnapshotStats(); } catch (_e) {}
  try { breadthChop = v4 && v4.getBreadthChopState(); } catch (_e) {} // fix53: { range, hi, lo, threshold, chop, active }
  let liveDivergence = null;
  try { liveDivergence = v4 && v4.detectLiveDivergences(); } catch (_e) {} // fix57: read-only Orayan-vs-Bybit mismatch telemetry
  // fix62: was invisible whether V4_UNIFIED_BRAIN was actually taking effect — only inferable from
  // signal behavior. Surface the flag plus a live count of signals currently under its authority
  // (BYBIT-authority = order-bearing, driven by the lifecycle core, snapshot cannot touch them) and
  // any FROZEN (ambiguous, alarmed, never-abandoned) — so "is it on AND doing something" is one look.
  let unifiedBrainStatus = { enabled: !!(unifiedBrain && unifiedBrain.flagEnabled()), bybitAuthorityCount: null, frozenCount: null };
  try {
    if (unifiedBrainStatus.enabled && v4) {
      const lc = require('../lib/lifecycle');
      const signals = v4.getSignals() || [];
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
    const s = sentinel && sentinel.getSentinel();
    sentinelHealth = {
      updatedAt: s?.updatedAt || null,
      ageMs: s?.updatedAt ? (Date.now() - s.updatedAt) : null,
      regime: s?.market_regime || null,
    };
  } catch (_e) {}
  res.json({
    ok: _bootErrors.length === 0,
    degraded: _bootErrors.length > 0 || undefined,       // fixHEALTHBOOT
    bootErrors: _bootErrors.length ? _bootErrors : undefined, // fixHEALTHBOOT: WHAT failed to load
    service: 'orayan-backend',
    version: v4 ? v4.V4_VERSION : 'UNAVAILABLE_MODULE_LOAD_FAILED', // fix48u; fixHEALTHBOOT fallback
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
      try { liveFileCount = store ? require('fs').readdirSync(store.DATA_DIR).filter(f => !f.startsWith('.')).length : null; } catch (_e) {}
      return {
        dataDir: store ? store.DATA_DIR : null,
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
