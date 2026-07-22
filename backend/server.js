'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '4mb' }));

// fixGZIP (07/22): the dashboard JSON is extremely repetitive (per-row planner/diagnostic objects
// share structure), so gzip yields ~8-12x. Combined with fixSLIM in routes/v4.js this takes the 7s
// poll from ~2.9 MB to a few KB on the user's 6-142 KB/s mobile link — the actual root cause of
// "SRV goes red / connection is fragile". Guarded require, bootguard-style: if the compression
// package is missing (partial deploy, npm install failure) we serve uncompressed instead of dying.
try {
  app.use(require('compression')({ threshold: 1024 }));
} catch (e) {
  console.warn('[boot] compression unavailable — serving uncompressed:', (e && e.message) || e);
}

// ============================================================================================
// fixBOOTGUARD (07/22): NO SINGLE FILE MAY CRASH-LOOP THE BACKEND.
// Twice in one day a require() at this file's top level killed the whole process on boot:
//   01:05Z  routes/health.js threw MODULE_NOT_FOUND '../lib/v4Brain'   → exit 1, crash-loop
//   03:54Z  server.js threw MODULE_NOT_FOUND './routes/health'          → exit 1, crash-loop
// Both times the container restarted, hit the same missing file, and died again — forever, with
// NO endpoint answering, so the only diagnosis channel was scrolling raw Northflank logs on a
// phone. That is the worst possible failure mode for a system holding live orders on an exchange:
// the reconciler (which cancels stale orders and books real P&L) never starts either.
// A missing or broken ROUTE file must degrade that one URL, not the process. Each route is now
// mounted through mountRoute(): on failure it mounts a stub that answers 503 with the real error,
// records it in BOOT_ERRORS, and the server still listens. Same for the three background engines —
// if v4Brain fails to load, the process stays up so /health can TELL you that, instead of dying
// silently. GET /health and GET /boot both report BOOT_ERRORS, so a broken deploy is one URL away
// from being understood.
// NOTE: this is a safety net, not a licence to deploy broken files — a degraded backend does NOT
// trade. Check /boot after every deploy.
const BOOT_ERRORS = [];

function mountRoute(path, modulePath) {
  try {
    app.use(path, require(modulePath));
  } catch (e) {
    const msg = `${modulePath} failed to load: ${(e && e.message) || e}`;
    BOOT_ERRORS.push(msg);
    console.error(`[boot] ROUTE DEGRADED — ${msg}`);
    app.use(path, (req, res) => res.status(503).json({
      ok: false, degraded: true, route: path, module: modulePath,
      error: (e && e.message) || String(e),
      hint: 'This route file is missing or threw on load. Check the deployed file tree.',
    }));
  }
}

function startEngine(label, modulePath, starter) {
  try {
    starter(require(modulePath));
    return true;
  } catch (e) {
    const msg = `${label} (${modulePath}) failed to start: ${(e && e.message) || e}`;
    BOOT_ERRORS.push(msg);
    console.error(`[boot] ENGINE DOWN — ${msg}`);
    return false;
  }
}

mountRoute('/health', './routes/health');
mountRoute('/bot', './routes/bot');
mountRoute('/bybit', './routes/bybit');
mountRoute('/api/journal', './routes/journal');
mountRoute('/api/signals', './routes/signals');
mountRoute('/api/leaderboard', './routes/leaderboard');
mountRoute('/api/trades', './routes/trades');
mountRoute('/api/ai', './routes/ai');
mountRoute('/api/sentinel', './routes/sentinel');
mountRoute('/api/v4', './routes/v4');

// Bybit reconciliation can still run for the Trades tab, but v4 paper signals do not need Bybit.
// v4 source of truth. Do NOT start the legacy scanner/marketBrain here.
// Market Sentinel — self-aware regime engine (fix29). Runs every 5 min independently.
const ENGINES = {
  reconciler: startEngine('reconciler', './lib/reconciler', m => m.start(15000)),
  v4Brain:    startEngine('v4Brain', './lib/v4Brain', m => m.start()),
  sentinel:   startEngine('sentinelBrain', './lib/sentinelBrain', m => m.start(5 * 60 * 1000)),
};

// fixBOOTGUARD: dependency-free boot report. Answers even when EVERY route and engine is broken —
// it closes over BOOT_ERRORS and requires nothing. This is the endpoint to hit after a deploy.
app.get('/boot', (req, res) => {
  let files = null;
  try {
    const fs = require('fs'), path = require('path');
    files = {
      root: fs.readdirSync(__dirname).filter(f => !f.startsWith('.')),
      routes: fs.existsSync(path.join(__dirname, 'routes')) ? fs.readdirSync(path.join(__dirname, 'routes')) : 'MISSING',
      lib: fs.existsSync(path.join(__dirname, 'lib')) ? fs.readdirSync(path.join(__dirname, 'lib')) : 'MISSING',
    };
  } catch (e) { files = { error: (e && e.message) || String(e) }; }
  res.json({
    ok: BOOT_ERRORS.length === 0,
    degraded: BOOT_ERRORS.length > 0,
    bootErrors: BOOT_ERRORS,
    engines: ENGINES,
    dirname: __dirname,
    files, // the deployed file tree as the container actually sees it — settles "did my upload land"
    time: new Date().toISOString(),
  });
});

// Backward compatibility for older frontend settings text.
app.get('/journal', (req, res) => res.redirect(307, '/api/journal'));
app.post('/journal', (req, res) => res.redirect(307, '/api/journal/push'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  let mode = 'unknown', trading = 'unknown', version = 'unknown';
  // fixBOOTGUARD: config/v4Brain are read defensively — a broken one must not stop the listener
  // from reporting. Also replaces the hardcoded "v4.6.8.30" banner, which had drifted from the
  // real deployed version and made log-reading actively misleading.
  try { const s = require('./lib/config').getSettings(); mode = s.botMode; trading = s.tradingEnabled ? 'ENABLED' : 'disabled'; } catch (_e) {}
  try { version = require('./lib/v4Brain').V4_VERSION; } catch (_e) {}
  console.log(`[Orayan] Backend ${version} running on port ${PORT}`);
  console.log(`[Orayan] Mode: ${mode} | Trading: ${trading} | AI proxy: /api/ai/analyze`);
  if (BOOT_ERRORS.length) {
    console.error(`[Orayan] *** DEGRADED BOOT — ${BOOT_ERRORS.length} component(s) failed. GET /boot for detail. NOT SAFE TO TRADE. ***`);
    for (const e of BOOT_ERRORS) console.error(`[Orayan]   - ${e}`);
  }
});
