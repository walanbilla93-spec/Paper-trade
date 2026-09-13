'use strict';

// Recorder-only projection. Never feed this snapshot back into execution decisions.
const SCHEMA = 'PATCH-2.3';
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function executionProof(s) {
  const p = s.executionPosition;
  // A resting position owns its accepted intent. The signal can contain a newer
  // eligibility attempt; retain that separately rather than mislabel its ACK.
  const intent = (p && p.intent) || s.executionIntent;
  const pick = (obj, field, flat) => obj && obj[field] !== undefined
    ? obj[field] : (s[flat || field] ?? null);
  const events = [];
  const seen = new Set();
  for (const [origin, rows] of [['POSITION', p && p.executionEvents], ['SIGNAL', s.executionEvents]]) {
    for (const e of Array.isArray(rows) ? rows : []) {
      if (!e) continue;
      const item = { ...e, origin: e.origin || origin };
      const key = `${item.origin}:${e.eventId || JSON.stringify(e)}`;
      if (!seen.has(key)) { seen.add(key); events.push(item); }
    }
  }
  events.sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  const ack = events.find(e => e.type === 'ORDER_ACK');
  const fills = events.filter(e => e.type === 'FILL');
  const gaps = [];
  if (pick(intent, 'status', 'executionIntentStatus') !== 'ACCEPTED') gaps.push('ACCEPTED_INTENT_UNAVAILABLE');
  if (!ack) gaps.push('ORDER_ACK_EVENT_UNAVAILABLE');
  if (!fills.length) gaps.push('FILL_EVENT_UNAVAILABLE');
  if (fills.some(e => !e.execId)) gaps.push('FILL_EXEC_ID_UNAVAILABLE');
  const legacy = !!(s.legacyExecutionMigratedAt || events.some(e =>
    e.type === 'LEGACY_POSITION_MIGRATED' || e.liquidity === 'LEGACY_RECORDED' || e.orderId === 'legacy_migration'));
  return clone({
    ledgerObservabilitySchema: SCHEMA,
    executionEvidence: legacy ? 'LEGACY_SYNTHETIC' : gaps.length ? 'INCOMPLETE' : 'RECORDED',
    executionEvidenceGaps: gaps,
    executionIntent: intent || null,
    executionPosition: p || null,
    observedExecutionIntent: s.observedExecutionIntent || (p && s.executionIntent && p.intent &&
      s.executionIntent.intentId !== p.intent.intentId ? s.executionIntent : null),
    plannedEntry: pick(intent, 'plannedEntry') ?? s.entry,
    avgFillPrice: pick(p, 'avgFillPrice'),
    requestedQty: pick(intent, 'requestedQty'),
    filledQty: pick(p, 'filledQty'),
    // remainingQty is OPEN position quantity; unfilledQty is the outstanding order quantity.
    unfilledQty: pick(intent, 'requestedQty') != null && pick(p, 'filledQty') != null
      ? Math.max(0, Number(pick(intent, 'requestedQty')) - Number(pick(p, 'filledQty'))) : null,
    remainingQty: pick(p, 'remainingQty'),
    closedQty: pick(p, 'closedQty'),
    executionIntentId: pick(intent, 'intentId', 'executionIntentId'),
    executionIntentStatus: pick(intent, 'status', 'executionIntentStatus'),
    executionIntentAcceptedAt: pick(intent, 'acceptedAt', 'executionIntentAcceptedAt'),
    executionOrderId: (ack && ack.orderId) ?? s.executionOrderId ?? null,
    executionAcknowledgedAt: pick(p, 'acknowledgedAt', 'executionAcknowledgedAt'),
    executionOpenedAt: pick(p, 'openedAt', 'executionOpenedAt'),
    entryFees: pick(p, 'entryFees'), exitFees: pick(p, 'exitFees'),
    fundingCashflow: pick(p, 'funding', 'fundingCashflow'),
    executionStatus: pick(p, 'status', 'executionStatus'),
    executionBracketVersions: (p && p.bracketVersions) || s.executionBracketVersions || [],
    executionEvents: events,
    legacyExecutionMigratedAt: s.legacyExecutionMigratedAt ?? null,
    legacyExecutionBlocked: s.legacyExecutionBlocked || false,
    timingReason: s.timingReason || '', executionReason: s.executionReason || '',
  });
}

module.exports = { SCHEMA, clone, executionProof };
