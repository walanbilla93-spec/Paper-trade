'use strict';

const { firstTerminalStats, firstTerminalBySignal, signalId, getTerminalState } = require('./stateMachine');

function n(value) {
  const x = Number(value);
  return Number.isFinite(x) ? x : 0;
}

function signalEventsFromSignals(signals = []) {
  return signals
    .filter(s => ['WIN', 'LOSS'].includes(getTerminalState(s)))
    .map(s => ({
      ts: s.terminalAt || s.closedAt || s.updatedAt || s.createdAt || 0,
      signalId: signalId(s),
      symbol: s.sym || s.symbol || '',
      side: s.side || '',
      entry: s.entry,
      sl: s.sl,
      tp1: s.tp1,
      price: s.terminalPrice || s.price,
      eventType: getTerminalState(s) === 'WIN' ? 'STATE_WIN' : 'STATE_LOSS',
      terminalState: getTerminalState(s),
      reason: s.terminalReason || s.stateReason || '',
    }));
}

function buildStats(signals = [], events = []) {
  const eventRows = [...(events || []), ...signalEventsFromSignals(signals || [])];
  const stats = firstTerminalStats(eventRows);
  const first = firstTerminalBySignal(eventRows);
  const uniqueSignalIds = new Set((signals || []).map(signalId).filter(Boolean));
  for (const id of first.keys()) uniqueSignalIds.add(id);

  const open = (signals || []).filter(s => {
    const id = signalId(s);
    if (first.has(id)) return false;
    const status = String(s.status || s.state || '').toUpperCase();
    return ['DETECTED', 'ARMED', 'ACTIVE', 'PARTIAL', 'OPEN', 'PENDING'].includes(status);
  }).length;

  return {
    totalSignals: uniqueSignalIds.size,
    tracked: uniqueSignalIds.size,
    open,
    wins: stats.wins,
    losses: stats.losses,
    closed: stats.closed,
    hitRate: stats.hitRate,
    hitRatePct: stats.closed ? `${Math.round(stats.hitRate)}%` : '0%',
  };
}

function snapshotRows(signals = [], events = []) {
  const first = firstTerminalBySignal([...(events || []), ...signalEventsFromSignals(signals || [])]);
  const map = new Map();
  for (const s of signals || []) {
    map.set(signalId(s), { ...s });
  }
  for (const [id, ev] of first.entries()) {
    const s = map.get(id) || {};
    map.set(id, {
      ...s,
      signalId: id,
      sym: s.sym || ev.symbol || ev.sym || '',
      side: s.side || ev.side || '',
      entry: s.entry ?? ev.entry,
      sl: s.sl ?? ev.sl,
      tp1: s.tp1 ?? ev.tp1,
      terminalState: ev.terminalState,
      terminalAt: ev.ts || ev.terminalAt || ev.closedAt || '',
      terminalPrice: ev.price || ev.terminalPrice || '',
      terminalReason: ev.reason || ev.note || '',
      status: ev.terminalState,
      isClosed: true,
    });
  }
  return [...map.values()].sort((a, b) => n(b.createdAt || b.terminalAt || b.updatedAt) - n(a.createdAt || a.terminalAt || a.updatedAt));
}

module.exports = { buildStats, snapshotRows, signalEventsFromSignals };
