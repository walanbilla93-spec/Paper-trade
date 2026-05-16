'use strict';

const express = require('express');
const cors = require('cors');
const { getSettings } = require('./lib/config');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '4mb' }));

app.use('/health', require('./routes/health'));
app.use('/bot', require('./routes/bot'));
app.use('/bybit', require('./routes/bybit'));
app.use('/api/journal', require('./routes/journal'));
app.use('/api/signals', require('./routes/signals'));
app.use('/api/leaderboard', require('./routes/leaderboard'));
app.use('/api/trades', require('./routes/trades'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/v4', require('./routes/v4'));

// Backward compatibility for older frontend settings text.
app.get('/journal', (req, res) => res.redirect(307, '/api/journal'));
app.post('/journal', (req, res) => res.redirect(307, '/api/journal/push'));

// Bybit reconciliation can still run for the Trades tab, but v4 paper signals do not need Bybit.
require('./lib/reconciler').start(15000);

// v4 source of truth. Do NOT start the legacy scanner/marketBrain here.
require('./lib/v4Brain').start();

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const s = getSettings();
  console.log(`[Orayan] Backend v4.6.8.24b running on port ${PORT}`);
  console.log(`[Orayan] Mode: ${s.botMode} | Trading: ${s.tradingEnabled ? 'ENABLED' : 'disabled'} | AI proxy: /api/ai/analyze`);
});
