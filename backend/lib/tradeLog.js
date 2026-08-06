'use strict';

const store = require('./store');

// fixSHADOWLOG: the general trade-log store is capped at 1000 rows and shared with every noisy
// tag (EUPH_GUARD, BOTTOM_GUARD fire dozens of times per scan) — shadow entries (BREADTH_FIGHT_SHADOW,
// FADE_SHADOW) were getting evicted within an hour or two of a busy tape. These two tags ALSO get
// appended to a dedicated, larger ndjson store (shadow_signals, 8000-line cap, same pattern as
// bybit_ledger) so they survive long enough to actually export and score. Nothing else changes —
// same addLog signature, same console output, same 1000-row trade-log behavior for every other tag.
const SHADOW_LOG_TYPES = new Set(['BREADTH_FIGHT_SHADOW', 'FADE_SHADOW']);

// fixPHASELOG (07/30, real evidence): user's Phase 0/1 trade-log rows (PHASE0_TRACE, PHASE1_SHADOW)
// were confirmed EVICTED from every export (ledger, bybit_ledger, shadow_signals) — the 1972
// BREADTH_FIGHT_SHADOW rows in one session alone blow past the shared 1000-row trade-log cap long
// before anyone can read the phase rows. Same fix as SHADOW_LOG_TYPES: a dedicated durable ndjson
// store (phase_trace, 8000-line cap) so these survive long enough to actually answer "why didn't
// this reach Bybit" instead of silently vanishing.
// hotfix37: SCORE_BAND_PASS (fixBAND admission stamp) and ARM_CANCEL (fixARM knife cancel) are
// durable from day one — applying the hotfix30 lesson up front rather than re-learning eviction
// the hard way when a busy tag floods the shared 1000-row trade-log.
const PHASE_LOG_TYPES = new Set(['PHASE0_TRACE', 'PHASE1_SHADOW', 'RSI_GATE_PASS', 'SCORE_BAND_PASS', 'ARM_CANCEL', 'PCT_BAND_SHADOW', 'PARTIAL_LOCK']); // hotfix41: fixPARTIALLOCK breakeven-lock event, durable from day one

// ── fixLOGCACHE: THE SECOND OOM — same disease as hotfix38, never applied here ────────────
// hotfix38 (fixLEDGERCACHE) diagnosed and fixed this EXACT pattern for the ledger: a fully
// synchronous store.read (fs.readFileSync + JSON.parse) followed by store.write
// (JSON.stringify + fs.writeFileSync) on every single call, blocking Node's one event loop.
// It was never applied to the general trade-log — and addLog() is called far more often than
// the ledger ever was. BOTTOM_GUARD / CONTRARIAN_FLIP / BREADTH_FIGHT_SHADOW fire once per
// SYMBOL per scan tick (your own log shows dozens of distinct symbols within a few seconds),
// so a single scan cycle across ~530 pairs can call addLog() 50-150+ times, EACH doing a full
// disk read+parse of up to 1000 rows, an unshift, then a full stringify+write of 1000 rows
// back to disk. That is the actual reason the process kept dying after the kline-cache fix:
// the kline cache leak was real and is fixed, but this was a second, independent source of
// sustained memory churn and event-loop blocking large enough to hit the same 512MB ceiling
// on its own.
//
// Fix: identical pattern to fixLEDGERCACHE — an in-memory cache, written to disk periodically
// instead of on every call. Logs are pure observability (not trade state), so losing the last
// few seconds of them on a hard crash is an acceptable and correct tradeoff for stability.
// getLogs() now also reads the cache instead of hitting disk on every UI poll.
//
// Reversible: LOG_CACHE_ENABLED=false restores the exact original per-call disk round trip.
const LOG_CACHE_ENABLED = String(process.env.LOG_CACHE_ENABLED || 'true').toLowerCase() === 'true';
const LOG_FLUSH_EVERY_N = Math.max(1, parseInt(process.env.LOG_FLUSH_EVERY_N || '20', 10));
const LOG_FLUSH_MS = Math.max(500, parseInt(process.env.LOG_FLUSH_MS || '3000', 10));

let _logCache = null;      // in-memory array, lazily loaded once per process lifetime
let _dirtyCount = 0;
let _lastFlushAt = 0;

function _loadLogCache() {
  if (_logCache === null) _logCache = store.read('trade-log', []);
  return _logCache;
}

function _flushLogCache(force = false) {
  if (_logCache === null) return;
  const due = force || _dirtyCount >= LOG_FLUSH_EVERY_N || (Date.now() - _lastFlushAt) >= LOG_FLUSH_MS;
  if (!due) return;
  try {
    store.write('trade-log', _logCache);
    _dirtyCount = 0;
    _lastFlushAt = Date.now();
  } catch (e) {
    console.error('[tradeLog] flush failed:', e && e.message);
  }
}

// Best-effort: catch a graceful shutdown (SIGTERM from a redeploy, not an OOM-kill — nothing
// can catch that) so a normal restart doesn't lose the last few seconds of buffered logs.
let _exitHookInstalled = false;
function _installExitHook() {
  if (_exitHookInstalled || !LOG_CACHE_ENABLED) return;
  _exitHookInstalled = true;
  const flush = () => { try { _flushLogCache(true); } catch (_e) {} };
  process.on('SIGTERM', flush);
  process.on('SIGINT', flush);
  process.on('beforeExit', flush);
}

function addLog(type, message, details = {}) {
  const row = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    iso: new Date().toISOString(),
    type,
    message,
    details,
  };

  if (LOG_CACHE_ENABLED) {
    _installExitHook();
    const logs = _loadLogCache();
    logs.unshift(row);
    if (logs.length > 1000) logs.length = 1000;   // in-place cap, no new array allocation
    _dirtyCount++;
    _flushLogCache(false);
  } else {
    // fixLOGCACHE reverted: exact original per-call disk round trip
    const logs = store.read('trade-log', []);
    logs.unshift(row);
    store.write('trade-log', logs.slice(0, 1000));
  }

  if (SHADOW_LOG_TYPES.has(type)) {
    try { store.appendNdjson('shadow_signals', row); } catch (_e) { /* never block the primary log on shadow persistence */ }
  }
  if (PHASE_LOG_TYPES.has(type)) {
    try { store.appendNdjson('phase_trace', row); } catch (_e) { /* never block the primary log on phase persistence */ }
  }
  console.log(`[trade-log] ${type}: ${message}`);
  return row;
}

function getLogs(limit = 200) {
  const logs = LOG_CACHE_ENABLED ? _loadLogCache() : store.read('trade-log', []);
  return logs.slice(0, Math.max(1, Math.min(1000, limit)));
}

// fixPROOF: existing at all proves fixLOGCACHE loaded; also genuinely useful for the
// heap-pressure log line to report cache size alongside the kline/ledger caches.
function getLogCacheStats() { return { cached: _logCache ? _logCache.length : 0, dirty: _dirtyCount, enabled: LOG_CACHE_ENABLED }; }

module.exports = { addLog, getLogs, getLogCacheStats };
