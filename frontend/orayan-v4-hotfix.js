/* ORAYAN v4.3 compatibility hotfix.
 * Safe to include, but the main v4.3 logic is now baked into index.html.
 * This file only exposes a fresh-journal helper and does not recalculate stats
 * from local browser TRADE_EVENTS anymore.
 */
(function(){
  if (window.__orayanV43CompatHotfix) return;
  window.__orayanV43CompatHotfix = true;

  async function backendUrl(){
    try {
      if (typeof getATBackendUrl === 'function') return getATBackendUrl();
      if (typeof getJournalBackendUrl === 'function') return getJournalBackendUrl();
      return (window.ST?.settings?.autoTradeBackendUrl || window.ST?.settings?.journalBackendUrl || '').replace(/\/+$/,'');
    } catch(e) { return ''; }
  }

  window.orayanStartFreshJournal = async function(){
    if (!confirm('Archive backend journal/snapshot and start a fresh session?')) return;
    const url = await backendUrl();
    try {
      if (url) {
        const headers = typeof buildBackendHeaders === 'function' ? buildBackendHeaders() : {'Content-Type':'application/json'};
        const resp = await fetch(url + '/api/journal/fresh', { method:'POST', headers, body: JSON.stringify({clear:true}), signal: AbortSignal.timeout(12000) });
        const data = await resp.json().catch(()=>({}));
        if (!resp.ok || data.ok === false) throw new Error(data.error || 'Backend fresh journal failed');
      }
      if (window.ST) { ST.journal = []; ST.signals = []; ST.v4Summary = null; }
      try { localStorage.setItem('orayan_journal', '[]'); } catch(e) {}
      try { localStorage.setItem('orayan_signals', '[]'); } catch(e) {}
      try { localStorage.setItem('orayan_trade_events', '[]'); } catch(e) {}
      if (typeof renderJournal === 'function') renderJournal();
      if (typeof renderSignals === 'function') renderSignals();
      alert('Fresh backend journal/session started.');
    } catch(err) {
      alert('Fresh journal failed: ' + err.message);
    }
  };
})();
