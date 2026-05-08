'use strict';

const assert = require('assert');
const {
  closeSignal,
  evaluateActiveOutcome,
  firstTerminalStats,
  mergeSignalPreservingTerminal,
} = require('../backend/lib/stateMachine');

(function testLossThenWinCannotFlip(){
  const sig = { id:'sig_ORCA_1', sym:'ORCAUSDT', side:'BUY', entry:1.5921, sl:1.5881, tp1:1.602, status:'ACTIVE' };
  let out = evaluateActiveOutcome(sig, 1.5880);
  assert.strictEqual(out.terminalState, 'LOSS');
  assert.strictEqual(closeSignal(sig, out.terminalState, 1.5880, out.reason, { at: 1000 }).changed, true);
  out = evaluateActiveOutcome(sig, 1.6030);
  assert.strictEqual(out, null);
  assert.strictEqual(closeSignal(sig, 'WIN', 1.6030, 'TP1 later', { at: 2000 }).changed, false);
  assert.strictEqual(sig.status, 'LOSS');
  assert.strictEqual(sig.terminalState, 'LOSS');
})();

(function testFirstTerminalStats(){
  const events = [
    { ts: 2000, signalId:'a', eventType:'STATE_WIN' },
    { ts: 1000, signalId:'a', eventType:'STATE_LOSS' },
    { ts: 3000, signalId:'b', eventType:'STATE_WIN' },
  ];
  const s = firstTerminalStats(events);
  assert.strictEqual(s.wins, 1);
  assert.strictEqual(s.losses, 1);
  assert.strictEqual(Math.round(s.hitRate), 50);
})();

(function testMergeProtectsTerminal(){
  const existing = { id:'x', status:'LOSS', terminalState:'LOSS', isClosed:true, terminalAt:1000 };
  const incoming = { id:'x', status:'WIN', terminalState:'WIN', terminalAt:2000 };
  const merged = mergeSignalPreservingTerminal(existing, incoming);
  assert.strictEqual(merged.status, 'LOSS');
  assert.strictEqual(merged.terminalState, 'LOSS');
})();

console.log('[OK] state machine terminal-lock tests passed');
