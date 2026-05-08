'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function safeFileName(name) {
  return String(name || 'data').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function filePath(name) {
  const safe = safeFileName(name);
  return path.join(DATA_DIR, safe.endsWith('.json') ? safe : `${safe}.json`);
}

function read(name, fallback = null) {
  try {
    ensureDataDir();

    const p = filePath(name);
    if (!fs.existsSync(p)) return fallback;

    const raw = fs.readFileSync(p, 'utf8');
    if (!raw || !raw.trim()) return fallback;

    return JSON.parse(raw);
  } catch (err) {
    console.warn('[store] read failed:', name, err && err.message ? err.message : err);
    return fallback;
  }
}

function write(name, value) {
  try {
    ensureDataDir();

    const p = filePath(name);
    fs.writeFileSync(p, JSON.stringify(value, null, 2));
    return value;
  } catch (err) {
    console.error('[store] write failed:', name, err && err.message ? err.message : err);
    throw err;
  }
}

function append(name, row) {
  const current = read(name, []);

  const arr = Array.isArray(current) ? current : [];
  arr.push(row);

  write(name, arr);
  return arr;
}

function update(name, updater, fallback = {}) {
  const current = read(name, fallback);
  const next = typeof updater === 'function' ? updater(current) : updater;
  write(name, next);
  return next;
}

function remove(name) {
  try {
    ensureDataDir();

    const p = filePath(name);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }

    return true;
  } catch (err) {
    console.warn('[store] remove failed:', name, err && err.message ? err.message : err);
    return false;
  }
}

function exists(name) {
  try {
    ensureDataDir();
    return fs.existsSync(filePath(name));
  } catch (_err) {
    return false;
  }
}

function list() {
  try {
    ensureDataDir();

    return fs
      .readdirSync(DATA_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/i, ''));
  } catch (err) {
    console.warn('[store] list failed:', err && err.message ? err.message : err);
    return [];
  }
}

module.exports = {
  DATA_DIR,

  // Main API expected by your existing backend
  read,
  write,
  append,
  update,
  remove,
  exists,
  list,

  // Compatibility aliases for other patch/helper files
  readJson: read,
  writeJson: write,
  appendJson: append,
  deleteJson: remove,
  removeJson: remove,
  has: exists,
};
