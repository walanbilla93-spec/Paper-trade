// ── Simple JSON file store ────────────────────────────────────
// Stores data in /app/data/*.json (Northflank persistent volume)
// Falls back to ./data/ for local dev
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  || (fs.existsSync('/app/data') ? '/app/data' : path.join(__dirname, '..', 'data'));

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(name) {
  return path.join(DATA_DIR, name + '.json');
}

function read(name, defaultVal) {
  try {
    const raw = fs.readFileSync(filePath(name), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return defaultVal;
  }
}

function write(name, data) {
  try {
    fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[store] write error:', name, e.message);
    return false;
  }
}

module.exports = { read, write, DATA_DIR };
