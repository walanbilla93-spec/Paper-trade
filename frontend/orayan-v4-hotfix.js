/* ORAYAN v4 frontend hotfix: first-terminal stats + fresh journal button. */
(function(){
  if (window.__orayanV4TerminalLockHotfix) return;
  window.__orayanV4TerminalLockHotfix = true;

  const TERMINAL = new Set(['WIN','LOSS','INVALID','EXPIRED']);
  const COUNTED = new Set(['WIN','LOSS']);

  function n(x){ const v = Number(x); return Number.isFinite(v) ? v : 0; }
  function sid(s){ return String(s?.signalId || s?.id || `${s?.sym || s?.symbol || ''}|${s?.side || ''}|${s?.entry || ''}`); }
  function terminalState(s){
    const vals = [s?.terminalState, s?.status, s?.state];
    for (const v of vals) { const st = String(v || '').toUpperCase(); if (TERMINAL.has(st)) return st; }
    return null;
  }

  function localEvents(){
    const out = [];
    try { if (Array.isArray(window.TRADE_EVENTS)) out.push(...window.TRADE_EVENTS); } catch(e) {}
    try {
      const raw = localStorage.getItem('orayan_trade_events');
      if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) out.push(...arr); }
    } catch(e) {}
    try {
      const sigs = window.ST && Array.isArray(ST.signals) ? ST.signals : [];
      sigs.forEach(s => {
        const st = terminalState(s);
        if (COUNTED.has(st)) {
          out.push({
            ts: s.terminalAt || s.closedAt || s.updatedAt || s.createdAt || 0,
            signalId: sid(s),
            symbol: s.sym || s.symbol || '',
            side: s.side || '',
            eventType: st === 'WIN' ? 'STATE_WIN' : 'STATE_LOSS',
            terminalState: st,
            price: s.terminalPrice || s.price,
          });
        }
      });
    } catch(e) {}
    return out;
  }

  function firstTerminalStats(){
    const first = new Map();
    localEvents().sort((a,b)=>n(a.ts || a.terminalAt || a.updatedAt) - n(b.ts || b.terminalAt || b.updatedAt)).forEach(ev => {
      const et = String(ev.eventType || '').toUpperCase();
      const st = et === 'STATE_WIN' ? 'WIN' : et === 'STATE_LOSS' ? 'LOSS' : String(ev.terminalState || ev.status || ev.state || '').toUpperCase();
      if (!COUNTED.has(st)) return;
      const id = sid(ev);
      if (!id || first.has(id)) return;
      first.set(id, { ...ev, terminalState: st });
    });
    const rows = [...first.values()];
    const wins = rows.filter(r => r.terminalState === 'WIN').length;
    const losses = rows.filter(r => r.terminalState === 'LOSS').length;
    const closed = wins + losses;
    const open = (window.ST && Array.isArray(ST.signals) ? ST.signals : []).filter(s => !first.has(sid(s)) && ['DETECTED','ARMED','ACTIVE','PARTIAL','OPEN','PENDING'].includes(String(s.status || '').toUpperCase())).length;
    return { wins, losses, closed, open, hitRate: closed ? wins / closed * 100 : 0, firstRows: rows };
  }

  function preserveLocalTerminals(){
    if (!window.ST || !Array.isArray(ST.signals)) return;
    const first = new Map();
    localEvents().sort((a,b)=>n(a.ts || a.terminalAt || a.updatedAt) - n(b.ts || b.terminalAt || b.updatedAt)).forEach(ev => {
      const et = String(ev.eventType || '').toUpperCase();
      const st = et === 'STATE_WIN' ? 'WIN' : et === 'STATE_LOSS' ? 'LOSS' : String(ev.terminalState || ev.status || ev.state || '').toUpperCase();
      if (!TERMINAL.has(st)) return;
      const id = sid(ev);
      if (!id || first.has(id)) return;
      first.set(id, { state: st, ev });
    });
    ST.signals.forEach(s => {
      const hit = first.get(sid(s));
      if (!hit) return;
      s.status = hit.state;
      s.state = hit.state;
      s.terminalState = hit.state;
      s.isClosed = true;
      s.terminalAt = s.terminalAt || hit.ev.ts || hit.ev.terminalAt || hit.ev.updatedAt;
      s.terminalPrice = s.terminalPrice || hit.ev.price;
    });
  }

  async function getBackendUrl(){
    try {
      if (typeof getATBackendUrl === 'function') return getATBackendUrl();
      if (typeof getJournalBackendUrl === 'function') return getJournalBackendUrl();
      return (ST?.settings?.autoTradeBackendUrl || ST?.settings?.journalBackendUrl || '').replace(/\/$/, '');
    } catch(e) { return ''; }
  }

  window.orayanStartFreshJournal = async function(){
    const ok = confirm('Archive old backend journal/events and start a fresh journal? A backend archive backup will remain.');
    if (!ok) return;
    const url = await getBackendUrl();
    try {
      if (url) {
        const headers = typeof buildBackendHeaders === 'function' ? buildBackendHeaders() : {'Content-Type':'application/json'};
        const resp = await fetch(url + '/api/journal/archive', { method:'POST', headers, body:'{}', signal: AbortSignal.timeout(12000) });
        const data = await resp.json().catch(()=>({}));
        if (!resp.ok || data.ok === false) throw new Error(data.error || data.message || 'Backend archive failed');
      }
      if (window.ST) {
        ST.journal = [];
        ST.signals = [];
      }
      try { localStorage.setItem('orayan_journal', '[]'); } catch(e) {}
      try { localStorage.setItem('orayan_signals', '[]'); } catch(e) {}
      try { localStorage.setItem('orayan_trade_events', '[]'); } catch(e) {}
      if (typeof renderJournal === 'function') renderJournal();
      if (typeof renderSignals === 'function') renderSignals();
      alert('Fresh journal started. Old backend data was archived if backend was reachable.');
    } catch(err) {
      alert('Fresh journal failed: ' + err.message);
    }
  };

  function updateSignalStatCards(){
    preserveLocalTerminals();
    const st = firstTerminalStats();
    const ids = {
      sigWins: st.wins,
      sigLosses: st.losses,
      sigWinRate: st.closed ? Math.round(st.hitRate) + '%' : '0%',
    };
    Object.entries(ids).forEach(([id, value]) => { const el = document.getElementById(id); if (el) el.textContent = value; });
    const chip = document.getElementById('signalSummaryChip');
    if (chip) chip.textContent = `${st.open + st.closed} unique • ${st.open} open • ${st.wins}W/${st.losses}L • first-hit locked`;
  }

  const oldRenderSignals = window.renderSignals;
  if (typeof oldRenderSignals === 'function') {
    window.renderSignals = function(){
      const r = oldRenderSignals.apply(this, arguments);
      setTimeout(updateSignalStatCards, 0);
      return r;
    };
  }

  function addFreshButton(){
    if (document.getElementById('orayanFreshJournalBtn')) return;
    const host = document.querySelector('#tab-settings') || document.querySelector('.settings-panel') || document.body;
    const btn = document.createElement('button');
    btn.id = 'orayanFreshJournalBtn';
    btn.textContent = 'Archive + Fresh Journal';
    btn.onclick = window.orayanStartFreshJournal;
    btn.style.cssText = 'margin:8px;padding:8px 10px;border:1px solid #00d4ff;border-radius:6px;background:#0d1117;color:#00d4ff;font-family:Share Tech Mono,monospace;font-size:11px;cursor:pointer;';
    host.appendChild(btn);
  }

  document.addEventListener('DOMContentLoaded', () => { setTimeout(addFreshButton, 800); setTimeout(updateSignalStatCards, 1200); });
  window.addEventListener('load', () => { setTimeout(addFreshButton, 800); setTimeout(updateSignalStatCards, 1200); });
  setInterval(updateSignalStatCards, 5000);
})();
