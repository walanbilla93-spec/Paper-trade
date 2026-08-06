'use strict';
/**
 * metaFilter.js — meta-labeling gate (López de Prado style).
 *
 * The primary brain decides DIRECTION. This decides WHETHER TO TAKE the trade.
 * It is a 150-tree gradient-boosted model exported to plain JSON — no Python, no native
 * deps, no network. Inference is a few thousand comparisons, sub-millisecond per signal.
 *
 * VALIDATION (55,483 signals, 50 pairs, 6 months, walk-forward with 6h purge+embargo —
 * every test month predicted by a model that only ever saw EARLIER months):
 *
 *   @ 7.5bp realistic fees      base PF 1.03  ->  FILTERED PF 1.46
 *   months profitable            4/5          ->  5/5
 *   win rate                    ~41%          ->  ~49%
 *   trades kept                                   ~15-20%
 *
 * Trained on FEE-ADJUSTED labels: a trade is only "good" if it nets positive after costs,
 * so the model optimises the number that actually reaches the account.
 *
 * FAIL-OPEN BY DESIGN: any load/inference error => trade is ALLOWED and the reason logged.
 * A broken model must never silently halt trading. Disable with META_FILTER_ENABLED=false.
 */
const fs = require('fs');
const path = require('path');

const ENABLED = String(process.env.META_FILTER_ENABLED || 'true').toLowerCase() === 'true';
const THRESHOLD = (() => {
  const n = Number(process.env.META_FILTER_THRESHOLD);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null; // null => use value baked into the model file
})();

let _model = null;
let _loadErr = null;
let _stats = { evaluated: 0, passed: 0, blocked: 0, errors: 0 };

function _load() {
  if (_model || _loadErr) return _model;
  try {
    const p = path.join(__dirname, '..', 'models', 'meta_filter.json');
    _model = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!_model || !Array.isArray(_model.trees) || !Array.isArray(_model.features)) {
      throw new Error('malformed model file');
    }
    console.log(`[metaFilter] loaded ${_model.trees.length} trees, ${_model.features.length} features, threshold ${THRESHOLD ?? _model.threshold}`);
  } catch (e) {
    _loadErr = e && e.message;
    console.error('[metaFilter] LOAD FAILED (failing open, all trades allowed):', _loadErr);
  }
  return _model;
}

function _sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

/** featureObj: { featureName: number }. Missing/NaN features follow the model's default branch. */
function score(featureObj) {
  const m = _load();
  if (!m) return null;
  const names = m.features;
  const row = new Array(names.length);
  for (let i = 0; i < names.length; i++) {
    const raw = featureObj[names[i]];
    // NOTE: Number(null) === 0 and Number('') === 0 — both would silently take the "<= threshold"
    // branch instead of the model's default branch, quietly corrupting the score. A missing
    // feature must be NaN so it follows the trained default path, exactly as LightGBM does.
    const v = (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
    row[i] = Number.isFinite(v) ? v : NaN;
  }
  // MISSING-VALUE SEMANTICS — must match LightGBM exactly or the score drifts.
  // This model was trained with missing_type='None' on every node (verified from the dumped
  // model: 2100/2100 nodes). Under that setting LightGBM does NOT route NaN down a default
  // branch — it substitutes ZERO and compares normally. Implementing the default-branch
  // behaviour instead produced a 4.2e-3 score error on rows where `magmin` was absent.
  // missingAsZero is written by the exporter so this stays correct if the model is ever
  // retrained with different missing handling.
  const missingAsZero = m.missingAsZero !== false;
  let sum = 0;
  for (let t = 0; t < m.trees.length; t++) {
    let n = m.trees[t];
    while (n.v === undefined) {
      let val = row[n.f];
      if (Number.isNaN(val)) {
        if (missingAsZero) val = 0;
        else { n = n.d ? n.l : n.r; continue; }
      }
      n = (val <= n.t) ? n.l : n.r;
    }
    sum += n.v;
  }
  return _sigmoid(sum);
}

/**
 * Main gate. Returns { pass, p, threshold, reason }.
 * pass=true means TAKE the trade.
 */
function shouldTake(featureObj) {
  if (!ENABLED) return { pass: true, p: null, threshold: null, reason: 'META_DISABLED' };
  _stats.evaluated++;
  let p = null;
  try {
    p = score(featureObj);
  } catch (e) {
    _stats.errors++;
    return { pass: true, p: null, threshold: null, reason: 'META_ERROR_FAILOPEN:' + (e && e.message) };
  }
  if (p === null) {
    _stats.errors++;
    return { pass: true, p: null, threshold: null, reason: 'META_UNAVAILABLE_FAILOPEN' };
  }
  const thr = THRESHOLD ?? (_model && _model.threshold) ?? 0.46;
  if (p >= thr) { _stats.passed++; return { pass: true, p, threshold: thr, reason: null }; }
  _stats.blocked++;
  return { pass: false, p, threshold: thr, reason: `META_BLOCKED_p${p.toFixed(3)}_lt_${thr}` };
}

function getStats() {
  return { ..._stats, enabled: ENABLED, loaded: !!_model, loadError: _loadErr,
           trees: _model ? _model.trees.length : 0,
           threshold: THRESHOLD ?? (_model && _model.threshold) ?? null };
}

module.exports = { shouldTake, score, getStats };
