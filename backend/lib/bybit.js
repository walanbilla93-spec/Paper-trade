'use strict';

const crypto = require('crypto');
const axios  = require('axios');
const { getSettings } = require('./config');

const LIVE_BASE    = 'https://api.bybit.com';
const TESTNET_BASE = 'https://api-testnet.bybit.com';

function getBase() {
  const s = getSettings();
  return s.testnet === false ? LIVE_BASE : TESTNET_BASE;
}

function getKey()    { return process.env.BYBIT_API_KEY    || ''; }
function getSecret() { return process.env.BYBIT_API_SECRET || ''; }
function keySet()    { return !!(getKey() && getSecret()); }

function sign(params, timestamp, recvWindow = 5000) {
  const key    = getKey();
  const secret = getSecret();
  const str    = timestamp + key + recvWindow + params;
  return crypto.createHmac('sha256', secret).update(str).digest('hex');
}

function buildHeaders(params, isBody = false) {
  const ts  = Date.now().toString();
  const rw  = '5000';
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

async function bybitPublicGet(path, params = {}) {
  const url = buildUrl(path, params);
  const resp = await axios.get(url, { timeout: 10000 });
  return resp.data;
}

async function bybitGet(path, params = {}) {
  if (!keySet()) throw new Error('BYBIT_API_KEY/BYBIT_API_SECRET are not set');
  const qs = new URLSearchParams(params).toString();
  const headers = buildHeaders(qs, false);
  const url = buildUrl(path, params);
  const resp = await axios.get(url, { headers, timeout: 10000 });
  return resp.data;
}

async function bybitPost(path, body = {}) {
  if (!keySet()) throw new Error('BYBIT_API_KEY/BYBIT_API_SECRET are not set');
  const headers = buildHeaders(body, true);
  const url = getBase() + path;
  const resp = await axios.post(url, body, { headers, timeout: 10000 });
  return resp.data;
}

module.exports = { bybitGet, bybitPost, bybitPublicGet, getBase, keySet };
