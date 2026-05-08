/*
ORAYAN v4 terminal-lock patch for your existing backend/server.js

Use this file as a transplant guide if your current backend already contains the
scanner/Bybit engine and you do not want to replace the whole server.js.

Main fixes:
1. First terminal state wins forever.
2. A later recovery after SL cannot change LOSS to WIN.
3. EXPIRED only applies before ACTIVE.
4. Stats count one first WIN/LOSS per signalId, not duplicate event rows.
5. Fresh journal endpoint archives old data before clearing.
*/

// 1) Add near the existing helpers.
const ORAYAN_TERMINAL_STATES = new Set(['WIN', 'LOSS', 'INVALID', 'EXPIRED']);
const ORAYAN_COUNTED_TERMINALS = new Set(['WIN', 'LOSS']);

function orayanSignalId(s) {
  return String(s?.signalId || s?.id || [s?.sym || s?.symbol || '', s?.side || '', s?.entry || ''].join('|'));
}

function orayanTerminalState(s) {
  const vals = [s?.terminalState, s?.status, s?.state];
  for (const v of vals) {
    const st = String(v || '').toUpperCase();
    if (ORAYAN_TERMINAL_STATES.has(st)) return st;
  }
  return null;
}

function orayanIsClosed(s) {
  return Boolean(s?.isClosed || s?.terminalState || s?.closedAt || orayanTerminalState(s));
}

function orayanCloseSignal(s, terminalState, px, reason, extra = {}) {
  const state = String(terminalState || '').toUpperCase();
  if (!ORAYAN_TERMINAL_STATES.has(state)) return false;

  const existing = orayanTerminalState(s);
  if (existing) {
    // First terminal state wins. This is the ORCAUSDT fix.
    s.status = existing;
    s.state = existing;
    s.terminalState = existing;
    s.isClosed = true;
    return false;
  }

  const now = extra.now || Date.now();
  s.status = state;
  s.state = state;
  s.terminalState = state;
  s.terminalAt = now;
  s.closedAt = now;
  s.updatedAt = now;
  s.terminalPrice = px;
  s.terminalReason = reason || state;
  s.isClosed = true;
  s.firstTerminalEventId = s.firstTerminalEventId || `${orayanSignalId(s)}:${state}:${now}`;

  pushHistory(s, state, reason || state);
  logEvent(s, `STATE_${state}`, px, reason || state, extra.eventExtra || {});
  return true;
}

function orayanEvaluateActiveOutcome(s, px) {
  const winAt = String(process.env.ORAYAN_SIGNAL_WIN_AT || 'TP1').toUpperCase();
  const target = winAt === 'TP2' && s.tp2 != null ? Number(s.tp2) : Number(s.tp1);
  const sl = Number(s.sl);
  const price = Number(px);
  if (!Number.isFinite(price) || !Number.isFinite(sl) || !Number.isFinite(target)) return null;

  const side = String(s.side || '').toUpperCase();
  const slHit = side === 'BUY' ? price <= sl : side === 'SELL' ? price >= sl : false;
  const tpHit = side === 'BUY' ? price >= target : side === 'SELL' ? price <= target : false;
  if (!slHit && !tpHit) return null;

  // If a gap crosses both in one polling tick, use conservative loss unless changed by env.
  if (slHit && tpHit) {
    return String(process.env.ORAYAN_SAME_TICK_POLICY || 'LOSS').toUpperCase() === 'WIN'
      ? { state: 'WIN', reason: `${winAt} hit same tick as SL` }
      : { state: 'LOSS', reason: 'SL hit same tick as target - conservative first-hit rule' };
  }
  if (slHit) return { state: 'LOSS', reason: 'SL hit' };
  return { state: 'WIN', reason: `${winAt} hit` };
}

function orayanFirstTerminalStats(events) {
  const first = new Map();
  const sorted = [...(events || [])].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  for (const ev of sorted) {
    const et = String(ev.eventType || '').toUpperCase();
    const state = et === 'STATE_WIN' ? 'WIN' : et === 'STATE_LOSS' ? 'LOSS' : null;
    if (!state) continue;
    const id = orayanSignalId(ev);
    if (!id || first.has(id)) continue;
    first.set(id, { ...ev, terminalState: state });
  }
  const rows = [...first.values()];
  const wins = rows.filter(r => r.terminalState === 'WIN').length;
  const losses = rows.filter(r => r.terminalState === 'LOSS').length;
  return { wins, losses, closed: wins + losses, hitRate: wins + losses ? wins / (wins + losses) * 100 : 0 };
}

// 2) Replace your updateOutcomes() body with this pattern.
function updateOutcomes() {
  const now = Date.now();
  let changed = false;

  for (const s of signals) {
    if (orayanIsClosed(s)) {
      const terminal = orayanTerminalState(s);
      if (terminal && s.status !== terminal) { s.status = terminal; changed = true; }
      continue;
    }

    const coin = coins[s.sym];
    if (!coin?.price) continue;
    const px = Number(coin.price);

    if (s.status === 'DETECTED') {
      const prox = Math.max(Math.abs(s.entry) * 0.003, 1e-10);
      if (Math.abs(px - s.entry) <= prox) {
        s.status = 'ARMED'; s.updatedAt = now;
        pushHistory(s, 'ARMED', 'Entry zone');
        logEvent(s, 'STATE_ARMED', px, 'Entry zone');
        changed = true;
      }
    }

    if (s.status === 'ARMED') {
      const prox = Math.max(Math.abs(s.entry) * 0.003, 1e-10);
      if (Math.abs(px - s.entry) <= prox) {
        s.status = 'ACTIVE'; s.entryHit = true; s.activatedAt = now; s.updatedAt = now;
        pushHistory(s, 'ACTIVE', 'Entry confirmed');
        logEvent(s, 'STATE_ACTIVE', px, 'Entry confirmed');
        changed = true;
      }
    }

    // EXPIRED/INVALID can only happen before active entry confirmation.
    if (['DETECTED', 'ARMED'].includes(s.status)) {
      const broken = (s.side === 'BUY' && px < s.sl) || (s.side === 'SELL' && px > s.sl);
      if (broken) {
        changed = orayanCloseSignal(s, 'INVALID', px, 'Structure break', { now }) || changed;
        continue;
      }
      if ((now - (s.createdAt || now)) > Number(process.env.SIGNAL_EXPIRY_MS || 1800000)) {
        changed = orayanCloseSignal(s, 'EXPIRED', px, 'Expired before activation', { now }) || changed;
        continue;
      }
    }

    if (['ACTIVE', 'PARTIAL'].includes(s.status)) {
      const outcome = orayanEvaluateActiveOutcome(s, px);
      if (outcome) {
        const extra = outcome.state === 'LOSS'
          ? { lossContext: JSON.stringify(buildLossContext(s, coin, px, now)) }
          : {};
        changed = orayanCloseSignal(s, outcome.state, px, outcome.reason, { now, eventExtra: extra }) || changed;
        continue;
      }
    }
  }

  if (changed) persistAll();
}

// 3) Replace /api/stats with unique first-terminal stats.
app.get('/api/stats', (req, res) => {
  const stats = orayanFirstTerminalStats(tradeEvents);
  const open = signals.filter(s => !orayanIsClosed(s) && ['DETECTED', 'ARMED', 'ACTIVE', 'PARTIAL'].includes(String(s.status || '').toUpperCase())).length;
  res.json({ ...stats, open, totalSignals: new Set(signals.map(orayanSignalId)).size, hitRate: stats.hitRate.toFixed(1) });
});

// 4) Add fresh journal endpoints. Keep both route names because older frontend builds
// may call /api/journal/fresh while the hotfix button calls /api/journal/archive.
function orayanArchiveAndFreshJournal(req, res) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(DATA_DIR, 'archive', stamp);
  fs.mkdirSync(archiveDir, { recursive: true });

  const filesToArchive = [
    [SIGNALS_FILE, 'signals.json'],
    [JOURNAL_FILE, 'journal.json'],
    [EVENTS_FILE, 'trade_events.json'],
    [typeof SNAPSHOT_FILE !== 'undefined' ? SNAPSHOT_FILE : null, 'signal_snapshot.json'],
  ];
  for (const [file, name] of filesToArchive) {
    try { if (file && fs.existsSync(file)) fs.copyFileSync(file, path.join(archiveDir, name)); } catch (e) {}
  }

  if (String(process.env.ORAYAN_KEEP_SIGNALS_ON_FRESH || 'false').toLowerCase() !== 'true') {
    signals = [];
  }
  journal = [];
  tradeEvents = [];
  if (typeof signalSnapshot !== 'undefined') signalSnapshot = [];
  persistAll();
  res.json({ ok: true, archived: true, archiveId: stamp, archiveDir, message: 'Fresh journal started.' });
}

app.post('/api/journal/archive', orayanArchiveAndFreshJournal);
app.post('/api/journal/fresh', orayanArchiveAndFreshJournal);
