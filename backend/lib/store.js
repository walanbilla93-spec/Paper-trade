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
    // fix39/C-4: atomic write — write to .tmp then rename to prevent corruption on crash/OOM
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, p);
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

// fix49l: overwrite an ndjson file with a filtered/trimmed set of rows (atomic). Used by the
// breadth-history retention trim. `rows` is written oldest→newest in file order.
function rewriteNdjson(name, rows) {
  try {
    ensureDataDir();
    const p = lineFilePath(name);
    const tmp = p + '.tmp';
    const body = (Array.isArray(rows) ? rows : []).map(r => JSON.stringify(r)).join('\n');
    fs.writeFileSync(tmp, body ? body + '\n' : '');
    fs.renameSync(tmp, p);
    return true;
  } catch (err) {
    console.warn('[store] rewriteNdjson failed:', name, err && err.message ? err.message : err);
    return false;
  }
}

// fix49l: DATA_DIR startup diagnostic. The deploy-wipe happens when DATA_DIR is NOT set and the
// code falls back to the in-container default (path.join(__dirname,'..','data')), which resets on
// every rebuild. This prints, at boot, the resolved path, whether it's writable, how many files
// already exist (a persistent volume keeps files across deploys; an ephemeral dir starts at ~0),
// and an explicit warning if the in-container fallback is in use. Fix = set Northflank env DATA_DIR
// to the mounted volume path.
function startupDiagnostic() {
  try {
    ensureDataDir();
    const usingEnv = !!process.env.DATA_DIR;
    let fileCount = 0, writable = false;
    try { fileCount = fs.readdirSync(DATA_DIR).filter(f => !f.startsWith('.')).length; } catch (_e) {}
    try { const t = path.join(DATA_DIR, '.write_test'); fs.writeFileSync(t, '1'); fs.unlinkSync(t); writable = true; } catch (_e) {}
    const tag = usingEnv ? 'persistent (DATA_DIR env set)' : 'EPHEMERAL FALLBACK — WILL WIPE ON DEPLOY (set DATA_DIR env to the mounted volume!)';
    console.log(`[store] DATA_DIR=${DATA_DIR} | ${tag} | writable=${writable} | existingFiles=${fileCount}`);
    return { dataDir: DATA_DIR, usingEnv, writable, fileCount };
  } catch (err) {
    console.warn('[store] startupDiagnostic failed:', err && err.message ? err.message : err);
    return null;
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
  rewriteNdjson,
  startupDiagnostic,
  clearNdjson,

  // Compatibility aliases for other patch/helper files
  readJson: read,
  writeJson: write,
  appendJson: append,
  deleteJson: remove,
  removeJson: remove,
  has: exists,
};
