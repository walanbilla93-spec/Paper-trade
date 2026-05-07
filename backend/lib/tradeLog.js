'use strict';

const store = require('./store');

function addLog(type, message, details = {}) {
  const logs = store.read('trade-log', []);
  const row = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    iso: new Date().toISOString(),
    type,
    message,
    details,
  };
  logs.unshift(row);
  store.write('trade-log', logs.slice(0, 1000));
  console.log(`[trade-log] ${type}: ${message}`);
  return row;
}

function getLogs(limit = 200) {
  return store.read('trade-log', []).slice(0, Math.max(1, Math.min(1000, limit)));
}

module.exports = { addLog, getLogs };
