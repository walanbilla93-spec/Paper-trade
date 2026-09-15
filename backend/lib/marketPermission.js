'use strict';
const VERSION = 'BREADTH_FIRST_2.4.1';
// Missing/stale breadth remains fail-open. Live sentinel-blind placement protection
// is separate feed-health protection, not a BTC directional veto.
function resolve({sent, now = Date.now(), buyMin = 50, sellMax = 50, maxAgeMs = 1800000} = {}) {
  const at = Number(sent?.updatedAt), pct = sent?.vol?.bull_pct;
  const ageMs = Number.isFinite(at) && at > 0 ? now - at : null;
  const usable = Number(sent?.vol?.pair_count) > 0 && pct != null && Number.isFinite(Number(pct)) && Number(pct) >= 0 && Number(pct) <= 100 && ageMs != null && ageMs >= 0 && ageMs <= maxAgeMs;
  return {version:VERSION, source:'BREADTH', sourceAt:at || null, ageMs, pct:pct == null ? null : Number(pct), usable,
    staleBehavior:'FAIL_OPEN_NO_BTC_FALLBACK', reason:usable ? 'BREADTH_PERMISSION' : 'BREADTH_UNAVAILABLE_NO_GATE',
    allowedBuy:!usable || Number(pct) > buyMin, allowedSell:!usable || Number(pct) < sellMax,
    buyMinExclusive:buyMin, sellMaxExclusive:sellMax, maxAgeMs,
    btcRole:'DIAGNOSTIC_ONLY', scoreRegimeMultiplier:0.90};
}
function allows(p, side) { return side === 'BUY' ? p.allowedBuy : side === 'SELL' ? p.allowedSell : false; }
module.exports = {VERSION, resolve, allows};
