'use strict';

function roundKeyNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  // 8 dp keeps tiny coins unique enough but removes floating noise.
  return n.toFixed(8).replace(/0+$/,'').replace(/\.$/,'');
}

function bucketTs(row, windowMs = 10 * 60 * 1000) {
  const t = Number(row.createdAt || row.ts || Date.parse(row.time || row.date || '') || 0);
  if (!Number.isFinite(t) || t <= 0) return '';
  return String(Math.floor(t / windowMs));
}

function journalKey(row) {
  const coin = String(row.coin || row.symbol || row.sym || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
  const side = String(row.side || '').toUpperCase();
  const entry = roundKeyNum(row.entry);
  const sl = roundKeyNum(row.sl || row.stopLoss || row.stop_loss);
  const tp = roundKeyNum(row.tp1 || row.tp || row.takeProfit || row.take_profit);
  const b = bucketTs(row);
  return [coin, side, entry, sl, tp, b].join('|');
}

function normalizeResult(v) {
  const r = String(v || '').toUpperCase();
  if (r.includes('WIN') || r.includes('TP')) return 'WIN';
  if (r.includes('LOSS') || r.includes('SL')) return 'LOSS';
  if (r.includes('PART')) return 'PARTIAL';
  if (r.includes('OPEN') || r.includes('ACTIVE')) return 'OPEN';
  return r || 'UNKNOWN';
}

function resultRank(r) {
  const x = normalizeResult(r);
  if (x === 'WIN' || x === 'LOSS') return 5;
  if (x === 'PARTIAL') return 4;
  if (x === 'OPEN') return 3;
  return 1;
}

function mergeRows(a, b) {
  const ar = resultRank(a.result), br = resultRank(b.result);
  const newer = Number(b.updatedAt || b.createdAt || b.ts || 0) >= Number(a.updatedAt || a.createdAt || a.ts || 0);
  const base = br > ar || (br === ar && newer) ? { ...a, ...b } : { ...b, ...a };
  const duplicateIds = [];
  [a, b].forEach(r => {
    if (Array.isArray(r.duplicateIds)) duplicateIds.push(...r.duplicateIds);
    if (r.id) duplicateIds.push(r.id);
  });
  base.duplicateIds = [...new Set(duplicateIds)].slice(0, 30);
  base.dedupeKey = journalKey(base);
  base.duplicateCount = Math.max(1, base.duplicateIds.length);
  return base;
}

function dedupeJournal(rows = []) {
  const map = new Map();
  let duplicatesRemoved = 0;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = { ...raw };
    row.result = normalizeResult(row.result);
    const key = journalKey(row) || row.id || Math.random().toString(36).slice(2);
    row.dedupeKey = key;
    if (map.has(key)) {
      map.set(key, mergeRows(map.get(key), row));
      duplicatesRemoved++;
    } else {
      row.duplicateCount = row.duplicateCount || 1;
      row.duplicateIds = row.duplicateIds || (row.id ? [row.id] : []);
      map.set(key, row);
    }
  }
  const uniqueRows = [...map.values()].sort((a,b) => Number(b.createdAt || b.updatedAt || b.ts || 0) - Number(a.createdAt || a.updatedAt || a.ts || 0));
  return { rows: uniqueRows, duplicatesRemoved };
}

function journalStats(rawRows = []) {
  const deduped = dedupeJournal(rawRows);
  const rows = deduped.rows;
  const wins = rows.filter(r => normalizeResult(r.result) === 'WIN').length;
  const losses = rows.filter(r => normalizeResult(r.result) === 'LOSS').length;
  const partial = rows.filter(r => normalizeResult(r.result) === 'PARTIAL').length;
  const open = rows.filter(r => normalizeResult(r.result) === 'OPEN').length;
  const completed = wins + losses;
  const winRate = completed ? Math.round((wins / completed) * 100) : null;
  const rawWins = rawRows.filter(r => normalizeResult(r.result) === 'WIN').length;
  const rawLosses = rawRows.filter(r => normalizeResult(r.result) === 'LOSS').length;
  const rawCompleted = rawWins + rawLosses;
  const rawWinRate = rawCompleted ? Math.round((rawWins / rawCompleted) * 100) : null;
  return {
    rawRows: rawRows.length,
    uniqueRows: rows.length,
    duplicatesRemoved: deduped.duplicatesRemoved,
    wins, losses, partial, open, completed, winRate,
    rawWins, rawLosses, rawWinRate,
  };
}

module.exports = { journalKey, dedupeJournal, journalStats, normalizeResult };
