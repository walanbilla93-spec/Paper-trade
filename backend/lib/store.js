'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const SIGNALS_FILE = path.join(DATA_DIR, 'signals.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'journal.json');
const EVENTS_FILE = path.join(DATA_DIR, 'trade_events.json');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'signal_snapshot.json');

function ensureDir(dir = DATA_DIR) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error('[Orayan] Failed reading', file, err.message);
    return fallback;
  }
}

function writeJSON(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function loadStore() {
  ensureDir();
  return {
    signals: readJSON(SIGNALS_FILE, []),
    journal: readJSON(JOURNAL_FILE, []),
    tradeEvents: readJSON(EVENTS_FILE, []),
    snapshot: readJSON(SNAPSHOT_FILE, []),
  };
}

function saveStore(store, opts = {}) {
  ensureDir();
  const signalLimit = Number(process.env.SIGNAL_MAX_ROWS || opts.signalLimit || 1000);
  const journalLimit = Number(process.env.JOURNAL_MAX_ROWS || opts.journalLimit || 0); // 0 = no cap
  const eventLimit = Number(process.env.EVENT_MAX_ROWS || opts.eventLimit || 0); // 0 = no cap

  const signals = Array.isArray(store.signals) ? store.signals.slice(0, signalLimit || undefined) : [];
  const journal = Array.isArray(store.journal) ? (journalLimit > 0 ? store.journal.slice(0, journalLimit) : store.journal) : [];
  const events = Array.isArray(store.tradeEvents) ? (eventLimit > 0 ? store.tradeEvents.slice(0, eventLimit) : store.tradeEvents) : [];
  const snapshot = Array.isArray(store.snapshot) ? store.snapshot : [];

  writeJSON(SIGNALS_FILE, signals);
  writeJSON(JOURNAL_FILE, journal);
  writeJSON(EVENTS_FILE, events);
  writeJSON(SNAPSHOT_FILE, snapshot);
}

function archiveStore(clear = true) {
  ensureDir();
  ensureDir(ARCHIVE_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(ARCHIVE_DIR, stamp);
  ensureDir(target);
  const files = [
    [SIGNALS_FILE, 'signals.json'],
    [JOURNAL_FILE, 'journal.json'],
    [EVENTS_FILE, 'trade_events.json'],
    [SNAPSHOT_FILE, 'signal_snapshot.json'],
  ];
  let archived = 0;
  for (const [src, name] of files) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(target, name));
      archived += 1;
    }
  }
  if (clear) {
    writeJSON(JOURNAL_FILE, []);
    writeJSON(EVENTS_FILE, []);
    writeJSON(SNAPSHOT_FILE, []);
    // Keep signals by default only when ORAYAN_KEEP_SIGNALS_ON_FRESH=true.
    if (String(process.env.ORAYAN_KEEP_SIGNALS_ON_FRESH || 'false').toLowerCase() !== 'true') {
      writeJSON(SIGNALS_FILE, []);
    }
  }
  return { archivedFiles: archived, archivePath: target, archiveId: stamp };
}

function dedupeBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows || []) {
    const key = keyFn(row);
    if (!key) continue;
    const old = map.get(key);
    const oldTs = Number(old?.ts || old?.updatedAt || old?.terminalAt || 0);
    const newTs = Number(row?.ts || row?.updatedAt || row?.terminalAt || 0);
    if (!old || newTs >= oldTs) map.set(key, row);
  }
  return [...map.values()].sort((a, b) => Number(b.ts || b.updatedAt || 0) - Number(a.ts || a.updatedAt || 0));
}

module.exports = {
  DATA_DIR,
  SIGNALS_FILE,
  JOURNAL_FILE,
  EVENTS_FILE,
  SNAPSHOT_FILE,
  ensureDir,
  readJSON,
  writeJSON,
  loadStore,
  saveStore,
  archiveStore,
  dedupeBy,
};
