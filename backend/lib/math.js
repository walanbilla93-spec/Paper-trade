'use strict';

function toNum(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function decimalsFromStep(step) {
  const s = String(step || '1');
  if (s.includes('e-')) return parseInt(s.split('e-')[1], 10) || 0;
  const dot = s.indexOf('.');
  if (dot === -1) return 0;
  return s.slice(dot + 1).replace(/0+$/, '').length;
}

function floorToStep(value, step) {
  const n = toNum(value, 0);
  const st = toNum(step, 1);
  if (!st || st <= 0) return n;
  const d = decimalsFromStep(step);
  return Number((Math.floor((n + 1e-12) / st) * st).toFixed(d));
}

function roundToStep(value, step) {
  const n = toNum(value, 0);
  const st = toNum(step, 1);
  if (!st || st <= 0) return n;
  const d = decimalsFromStep(step);
  return Number((Math.round(n / st) * st).toFixed(d));
}

function ceilToStep(value, step) {
  const n = toNum(value, 0);
  const st = toNum(step, 1);
  if (!st || st <= 0) return n;
  const d = decimalsFromStep(step);
  return Number((Math.ceil((n - 1e-12) / st) * st).toFixed(d));
}

function pctDistance(a, b) {
  const x = Math.abs(toNum(a) - toNum(b));
  const base = Math.abs(toNum(a));
  return base > 0 ? x / base : 0;
}

function nowIso() { return new Date().toISOString(); }

module.exports = { toNum, decimalsFromStep, floorToStep, roundToStep, ceilToStep, pctDistance, nowIso };
