'use strict';

const { bybitPublicGet } = require('./bybit');
const { toNum } = require('./math');

const cache = new Map();
const TICKER_CACHE = new Map();
const TTL = 10 * 60 * 1000;
const TICKER_TTL = 3000;

function normalizeSymbol(input, settle = 'USDT') {
  const raw = String(input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) return '';
  if (raw.endsWith(settle)) return raw;
  return raw + settle;
}

async function getInstrumentInfo(symbol) {
  const sym = normalizeSymbol(symbol);
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.ts < TTL) return hit.info;

  const data = await bybitPublicGet('/v5/market/instruments-info', {
    category: 'linear',
    symbol: sym,
  });
  const raw = data.result?.list?.[0];
  if (!raw) throw new Error(`Bybit instrument not found: ${sym}`);

  const info = {
    symbol: sym,
    status: raw.status,
    baseCoin: raw.baseCoin,
    quoteCoin: raw.quoteCoin,
    settleCoin: raw.settleCoin,
    priceScale: parseInt(raw.priceScale || '4', 10) || 4,
    tickSize: raw.priceFilter?.tickSize || '0.0001',
    qtyStep: raw.lotSizeFilter?.qtyStep || '1',
    minOrderQty: toNum(raw.lotSizeFilter?.minOrderQty, 0),
    maxOrderQty: toNum(raw.lotSizeFilter?.maxOrderQty, 0),
    minNotionalValue: toNum(raw.lotSizeFilter?.minNotionalValue, 0),
    maxMktOrderQty: toNum(raw.lotSizeFilter?.maxMktOrderQty, 0),
  };
  cache.set(sym, { ts: Date.now(), info });
  return info;
}

async function getTicker(symbol) {
  const sym = normalizeSymbol(symbol);
  const hit = TICKER_CACHE.get(sym);
  if (hit && Date.now() - hit.ts < TICKER_TTL) return hit.ticker;

  const data = await bybitPublicGet('/v5/market/tickers', { category: 'linear', symbol: sym });
  const raw = data.result?.list?.[0];
  if (!raw) throw new Error(`Bybit ticker not found: ${sym}`);
  const ticker = {
    symbol: sym,
    lastPrice: toNum(raw.lastPrice, 0),
    markPrice: toNum(raw.markPrice, 0),
    indexPrice: toNum(raw.indexPrice, 0),
    bid1Price: toNum(raw.bid1Price, 0),
    ask1Price: toNum(raw.ask1Price, 0),
    raw,
  };
  TICKER_CACHE.set(sym, { ts: Date.now(), ticker });
  return ticker;
}

async function getBybitPrice(symbol) {
  const t = await getTicker(symbol);
  return t.markPrice || t.lastPrice || t.indexPrice || t.bid1Price || t.ask1Price || 0;
}

module.exports = { normalizeSymbol, getInstrumentInfo, getTicker, getBybitPrice };
