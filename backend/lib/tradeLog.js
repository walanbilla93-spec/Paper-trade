'use strict';

const store = require('./store');

// fixSHADOWLOG: the general trade-log store is capped at 1000 rows and shared with every noisy
// tag (EUPH_GUARD, BOTTOM_GUARD fire dozens of times per scan) — shadow entries (BREADTH_FIGHT_SHADOW,
// FADE_SHADOW) were getting evicted within an hour or two of a busy tape. These two tags ALSO get
// appended to a dedicated, larger ndjson store (shadow_signals, 8000-line cap, same pattern as
// bybit_ledger) so they survive long enough to actually export and score. Nothing else changes —
// same addLog signature, same console output, same 1000-row trade-log behavior for every other tag.
const SHADOW_LOG_TYPES = new Set(['BREADTH_FIGHT_SHADOW', 'FADE_SHADOW']);

function addLog(type, message, details = {}) {
  const logs = store.read('trade-log', []);
  const row = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    iso: new Date().toISOString(),
    type,
    message,
    details,
  };
  logs.unshift(row);
  store.write('trade-log', logs.slice(0, 1000));
  if (SHADOW_LOG_TYPES.has(type)) {
    try { store.appendNdjson('shadow_signals', row); } catch (_e) { /* never block the primary log on shadow persistence */ }
  }
  console.log(`[trade-log] ${type}: ${message}`);
  return row;
}

function getLogs(limit = 200) {
  return store.read('trade-log', []).slice(0, Math.max(1, Math.min(1000, limit)));
}

module.exports = { addLog, getLogs };
