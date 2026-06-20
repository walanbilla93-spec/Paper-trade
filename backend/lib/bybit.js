'use strict';

const crypto = require('crypto');
const axios  = require('axios');
const { getSettings } = require('./config');

const LIVE_BASE    = 'https://api.bybit.com';
const TESTNET_BASE = 'https://api-testnet.bybit.com';

// fix49r: PUBLIC MARKET-DATA BASE — always the REAL (live) exchange, decoupled from trade mode.
// Root cause of the BTC-regime/RSI corruption: bybitPublicGet() routed through getBase(), which
// returns TESTNET_BASE whenever settings.testnet===true. In PAPER_REAL_PRICE mode config.js
// forces testnet=true, so regimeBrain + sentinelBrain + marketBrain were computing BTC regime,
// RSI, EMA-spread and breadth from TESTNET candles — a thin, detached order book — producing
// nonsense readings (e.g. real BTC 1h RSI 54 reported as 33; real ~65 reported as 5). The math
// was always correct; the INPUT data was the wrong venue. Market data must ALWAYS be real,
// regardless of whether orders are paper/testnet/live. Signed account/order calls (bybitGet/
// bybitPost) intentionally remain mode-gated via getBase() — they must hit the same venue the
// account lives on. Env-overridable for completeness; defaults to live and needs no Northflank change.
const PUBLIC_MARKET_BASE = process.env.BYBIT_PUBLIC_BASE || LIVE_BASE;

// fix49b: widened from 5000. 5s was too tight for Northflank<->Bybit latency
// spikes, causing intermittent 401 / retCode 10002 (timestamp expired).
// Bybit's own docs recommend up to 20000ms. Env-overridable.
const RECV_WINDOW = String(parseInt(process.env.BYBIT_RECV_WINDOW || '20000', 10) || 20000);

function getBase() {
  const s = getSettings();
  return s.testnet === false ? LIVE_BASE : TESTNET_BASE;
}

function getKey()    { return process.env.BYBIT_API_KEY    || ''; }
function getSecret() { return process.env.BYBIT_API_SECRET || ''; }
function keySet()    { return !!(getKey() && getSecret()); }

// ---- fix49b: clock-skew correction ---------------------------------------
// If the container clock drifts vs Bybit's server clock, every signed request
// can fail with 10002 even when latency is fine. We learn the offset from
// Bybit's public time endpoint and add it to every timestamp.
let _clockOffsetMs = 0;        // bybitServerTime - localTime
let _lastSyncAt    = 0;
let _lastTs        = 0;        // monotonic guard: timestamps never repeat/regress
const SKEW_RESYNC_MS = 5 * 60 * 1000; // resync every 5 min

async function syncClock(force = false) {
  const now = Date.now();
  if (!force && (now - _lastSyncAt) < SKEW_RESYNC_MS) return _clockOffsetMs;
  try {
    const t0 = Date.now();
    const resp = await axios.get(getBase() + '/v5/market/time', { timeout: 8000 });
    const t1 = Date.now();
    // Bybit returns timeNano (string ns) and time (sec). Prefer nano.
    const nano = resp?.data?.result?.timeNano;
    const sec  = resp?.data?.result?.timeSecond;
    let serverMs;
    if (nano) serverMs = Math.floor(Number(nano) / 1e6);
    else if (sec) serverMs = Number(sec) * 1000;
    else return _clockOffsetMs;
    // Estimate local time at the moment the server stamped it (half RTT).
    const localMid = t0 + (t1 - t0) / 2;
    _clockOffsetMs = Math.round(serverMs - localMid);
    _lastSyncAt = now;
  } catch (e) {
    // Non-fatal: keep last known offset.
  }
  return _clockOffsetMs;
}

function signedTimestamp() {
  let ts = Date.now() + _clockOffsetMs;
  if (ts <= _lastTs) ts = _lastTs + 1; // never repeat/regress within same ms
  _lastTs = ts;
  return ts.toString();
}

function sign(params, timestamp, recvWindow) {
  const key    = getKey();
  const secret = getSecret();
  const str    = timestamp + key + recvWindow + params;
  return crypto.createHmac('sha256', secret).update(str).digest('hex');
}

function buildHeaders(params, isBody = false) {
  const ts  = signedTimestamp();
  const rw  = RECV_WINDOW;
  const raw = isBody ? JSON.stringify(params) : params;
  const sig = sign(raw, ts, rw);
  return {
    'X-BAPI-API-KEY':     getKey(),
    'X-BAPI-SIGN':        sig,
    'X-BAPI-SIGN-TYPE':   '2',
    'X-BAPI-TIMESTAMP':   ts,
    'X-BAPI-RECV-WINDOW': rw,
    'Content-Type':       'application/json',
  };
}

function buildUrl(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return getBase() + path + (qs ? '?' + qs : '');
}

// fix49b: detect Bybit's timestamp-expiry failure across both transports.
// HTTP 401 (rare) and the far more common in-body retCode 10002.
function isTimestampError(err, data) {
  if (err && err.response && err.response.status === 401) return true;
  const rc = (data && data.retCode) || (err && err.response && err.response.data && err.response.data.retCode);
  return rc === 10002; // "request expired / timestamp out of recv_window"
}

async function bybitPublicGet(path, params = {}) {
  // fix49r: build the URL from PUBLIC_MARKET_BASE (always real exchange), NOT buildUrl()/getBase()
  // which is mode-gated. Public market data (kline/tickers/instruments) must never come from
  // testnet. Signed calls (bybitGet/bybitPost) still use buildUrl()/getBase() and are unaffected.
  const qs  = new URLSearchParams(params).toString();
  const url = PUBLIC_MARKET_BASE + path + (qs ? '?' + qs : '');
  const resp = await axios.get(url, { timeout: 10000 });
  return resp.data;
}

async function bybitGet(path, params = {}) {
  if (!keySet()) throw new Error('BYBIT_API_KEY/BYBIT_API_SECRET are not set');
  await syncClock(); // throttled; no-op if recently synced
  const qs  = new URLSearchParams(params).toString();
  const url = buildUrl(path, params);

  const attempt = async () => {
    const headers = buildHeaders(qs, false); // fresh timestamp each attempt
    return axios.get(url, { headers, timeout: 10000 });
  };

  try {
    const resp = await attempt();
    if (isTimestampError(null, resp.data)) {
      await syncClock(true);            // force resync, then retry once
      const r2 = await attempt();
      return r2.data;
    }
    return resp.data;
  } catch (err) {
    if (isTimestampError(err)) {
      await syncClock(true);
      const r2 = await attempt();       // one clean retry with fresh ts
      return r2.data;
    }
    throw err;
  }
}

async function bybitPost(path, body = {}) {
  if (!keySet()) throw new Error('BYBIT_API_KEY/BYBIT_API_SECRET are not set');
  await syncClock();
  const url = getBase() + path;

  const attempt = async () => {
    const headers = buildHeaders(body, true); // fresh timestamp each attempt
    return axios.post(url, body, { headers, timeout: 10000 });
  };

  try {
    const resp = await attempt();
    if (isTimestampError(null, resp.data)) {
      await syncClock(true);
      const r2 = await attempt();
      return r2.data;
    }
    return resp.data;
  } catch (err) {
    if (isTimestampError(err)) {
      await syncClock(true);
      const r2 = await attempt();
      return r2.data;
    }
    throw err;
  }
}

module.exports = { bybitGet, bybitPost, bybitPublicGet, getBase, keySet, syncClock };
