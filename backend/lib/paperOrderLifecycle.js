'use strict';
const parity = require('./executionParity');
const MAX_PRICE_AGE_MS = 30000;
function quote(m, now) {
  const price = Number(m?.lastPrice), at = Number(m?.sourceAt), receivedAt = Number(m?.receivedAt);
  const valid = price > 0 && Number.isFinite(at) && at > 0 && Number.isFinite(receivedAt) && receivedAt >= at && receivedAt <= now && at <= now && now-at <= MAX_PRICE_AGE_MS;
  return {price, at, receivedAt, valid, kind:'LAST', source:m?.priceSource || 'UNKNOWN'};
}
function working(p) { return p?.intent?.status === 'ACCEPTED' && !['CLOSED','CANCELLED'].includes(p.status) && p.cancelState !== 'ACKNOWLEDGED' && p.intent.requestedQty-p.filledQty>1e-12; }
function tick(p, m, now, feeRate) {
  const lateCancelled = p?.cancelState==='ACKNOWLEDGED' && p.status!=='CLOSED' && p.intent.requestedQty-p.filledQty>1e-12 && p.cancelAcknowledgedAt!=null && Number(m?.sourceAt)<p.cancelAcknowledgedAt;
  if (!working(p) && !lateCancelled) return {filled:false, reason:'NO_WORKING_ORDER'};
  p.intent=Object.freeze({...p.intent});
  const q = quote(m,now);
  if (!q.valid) return {filled:false, reason:'STALE_OR_MISSING_PRICE'};
  if (p.acknowledgedAt == null || q.at <= p.acknowledgedAt || now <= p.acknowledgedAt) return {filled:false, reason:'SAME_TICK_OR_PRE_ACK_PRICE'};
  if (q.at <= (p.lastEntrySourceAt || 0)) return {filled:false, reason:'DUPLICATE_OR_OUT_OF_ORDER_PRICE'};
  p.lastEntrySourceAt = q.at;
  const i = p.intent;
  if (!(i.side === 'BUY' ? q.price <= i.plannedEntry : q.price >= i.plannedEntry)) return {filled:false, reason:'NO_RETRACE'};
  // Invalid bracket geometry cannot be silently treated as an entry.
  if (!parity.geometry(i.side,q.price,i.sl,i.tp).ok) return {filled:false, reason:'FILL_GEOMETRY_INVALID'};
  const remaining = i.requestedQty-p.filledQty;
  const qty = m.availableQty == null ? remaining : Math.min(remaining, Math.max(0,Number(m.availableQty) || 0));
  if (!(qty>0)) return {filled:false,reason:'NO_AVAILABLE_QTY'};
  parity.applyFill(p,{at:q.at,price:q.price,qty,fee:feeRate*qty*q.price,liquidity:'SIMULATED_LIMIT',execId:`paper_${i.intentId}_${q.at}`});
  return {filled:true, quote:q};
}
function cancel(p, at, reason) {
  if (!working(p)) return;
  parity.requestCancel(p,at);
  // Local simulated cancellation is effective here, with an explicit ACK event.
  parity.acknowledgeCancel(p,at);
  parity.appendEvent(p,'PAPER_CANCEL_EFFECTIVE',at,{reason});
}
module.exports={MAX_PRICE_AGE_MS,quote,working,tick,cancel};
