'use strict';
const { clone } = require('./ledgerObservability');

// Separate from executionPosition: these records must never drive paper fills,
// eligibility, sizing, stops, or the live state machine.
function orderAcknowledged(trade, request, response, requestedAt) {
  return {
    source:'BYBIT', coverage:'ENTRY_ORDER_OBSERVATIONS_ONLY',
    intent:{signalId:trade.signalId, intentId:trade.orderLinkId, requestedAt, request:clone(request)},
    acknowledgement:{at:trade.placedAt, orderId:trade.orderId, response:clone(response.result)},
    executions:[], orderObservations:[],
    limitations:['Exit/funding executions require the separate Bybit event ledger; no symbol-only attribution.'],
  };
}

function observe(trade, snapshot) {
  if (!trade.orderId) return false;
  const before=JSON.stringify(trade.liveExecutionEvidence || null);
  const evidence=trade.liveExecutionEvidence || {
    source:'BYBIT', coverage:'ENTRY_ORDER_OBSERVATIONS_ONLY', intent:null, acknowledgement:null,
    executions:[], orderObservations:[],
    limitations:['Historical placement ACK unavailable.', 'Exit/funding executions require the separate Bybit event ledger; no symbol-only attribution.'],
  };
  const matches=e=>e && (e.orderId===trade.orderId || (trade.orderLinkId && e.orderLinkId===trade.orderLinkId));
  const executions=new Map((evidence.executions || []).map(e=>[e.execId,e]));
  for(const e of (snapshot.executions || []).filter(matches)) {
    const raw=e.raw || e, execId=e.execId || raw.execId;
    if (!execId) continue;
    executions.set(execId,clone({execId,orderId:e.orderId,orderLinkId:e.orderLinkId,
      type:raw.execType || 'UNKNOWN',side:e.side,price:e.execPrice,qty:e.execQty,fee:e.execFee,
      at:e.execTime,isMaker:raw.isMaker ?? null,closedSize:raw.closedSize ?? null}));
  }
  evidence.executions=[...executions.values()].sort((a,b)=>a.at-b.at);
  const orders=new Map((evidence.orderObservations || []).map(e=>[JSON.stringify(e),e]));
  for(const o of [...(snapshot.orders || []),...(snapshot.orderHistory || [])].filter(matches)) {
    const row=clone({orderId:o.orderId,status:o.orderStatus,qty:o.qty,cumExecQty:o.cumExecQty,
      leavesQty:o.leavesQty,avgPrice:o.avgPrice,stopLoss:o.stopLoss,takeProfit:o.takeProfit,
      rejectReason:o.rejectReason,cancelType:o.cancelType,createdTime:o.createdTime,updatedTime:o.updatedTime});
    orders.set(JSON.stringify(row),row);
  }
  evidence.orderObservations=[...orders.values()];
  if (!trade.liveExecutionEvidence && !evidence.executions.length && !evidence.orderObservations.length) return false;
  trade.liveExecutionEvidence=evidence;
  return JSON.stringify(evidence)!==before;
}
module.exports={orderAcknowledged,observe};
