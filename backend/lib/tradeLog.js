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
const PHASE_LOG_TYPES = new Set(['PHASE0_TRACE', 'PHASE1_SHADOW', 'RSI_GATE_PASS']);

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
  if (PHASE_LOG_TYPES.has(type)) {
    try { store.appendNdjson('phase_trace', row); } catch (_e) { /* never block the primary log on phase persistence */ }
  }
  console.log(`[trade-log] ${type}: ${message}`);
  return row;
}

function getLogs(limit = 200) {
  return store.read('trade-log', []).slice(0, Math.max(1, Math.min(1000, limit)));
}

module.exports = { addLog, getLogs };
