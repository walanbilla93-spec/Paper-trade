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

function lineFilePath(name) {
  const safe = safeFileName(name);
  return path.join(DATA_DIR, safe.endsWith('.ndjson') ? safe : `${safe}.ndjson`);
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

function appendNdjson(name, row) {
  try {
    ensureDataDir();
    const p = lineFilePath(name);
    fs.appendFileSync(p, JSON.stringify(row) + '\n');
    return true;
  } catch (err) {
    console.error('[store] appendNdjson failed:', name, err && err.message ? err.message : err);
    throw err;
  }
}

function readNdjsonTail(name, limit = 500) {
  try {
    ensureDataDir();
    const p = lineFilePath(name);
    if (!fs.existsSync(p)) return [];
    const max = Math.max(1, Math.min(parseInt(limit || 500, 10) || 500, 20000));
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw || !raw.trim()) return [];
    const lines = raw.trim().split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-max);
    const rows = [];
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      try { rows.push(JSON.parse(tail[i])); } catch (_e) {}
    }
    return rows;
  } catch (err) {
    console.warn('[store] readNdjsonTail failed:', name, err && err.message ? err.message : err);
    return [];
  }
}

function clearNdjson(name) {
  try {
    ensureDataDir();
    const p = lineFilePath(name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch (err) {
    console.warn('[store] clearNdjson failed:', name, err && err.message ? err.message : err);
    return false;
  }
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


function archiveStore(clear = false) {
  ensureDataDir();
  const now = Date.now();
  const archiveDir = path.join(DATA_DIR, 'archive', String(now));
  fs.mkdirSync(archiveDir, { recursive: true });
  const names = ['journal', 'v4_signals', 'v4_paper_ledger', 'v4_candidate_rejections', 'v4_diagnostic_journal', 'v4_snapshot'];
  const archived = [];
  for (const name of names) {
    const p = filePath(name);
    if (fs.existsSync(p)) {
      const dest = path.join(archiveDir, path.basename(p));
      fs.copyFileSync(p, dest);
      archived.push(name);
      if (clear) fs.unlinkSync(p);
    }
  }
  const ndjsonNames = ['v4_diagnostic_journal'];
  for (const name of ndjsonNames) {
    const p = lineFilePath(name);
    if (fs.existsSync(p)) {
      const dest = path.join(archiveDir, path.basename(p));
      fs.copyFileSync(p, dest);
      archived.push(`${name}.ndjson`);
      if (clear) fs.unlinkSync(p);
    }
  }
  return { archiveDir, archived, cleared: !!clear };
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
  archiveStore,
  appendNdjson,
  readNdjsonTail,
  clearNdjson,

  // Compatibility aliases for other patch/helper files
  readJson: read,
  writeJson: write,
  appendJson: append,
  deleteJson: remove,
  removeJson: remove,
  has: exists,
};
