'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { bybitGet, bybitPost, keySet } = require('../lib/bybit');
const { getSettings } = require('../lib/config');
const { normalizeSymbol, getInstrumentInfo, getTicker } = require('../lib/instruments');
const { executeSignal, setTradingStopSafe } = require('../lib/executor');
const { reconcileOnce, getLastSnapshot } = require('../lib/reconciler');
const { addLog } = require('../lib/tradeLog');

function asNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

router.get('/wallet', auth, async (req, res) => {
  try {
    const data = await bybitGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' });
    if (data.retCode !== 0) return res.json({ ok: false, error: data.retMsg });
    const coins = data.result?.list?.[0]?.coin || [];
    const usdt = coins.find(c => c.coin === 'USDT') || {};
    res.json({
      ok: true,
      keySet: keySet(),
      mode: getSettings().botMode,
      availableBalance: asNum(usdt.availableToWithdraw || usdt.availableToBorrow || usdt.walletBalance),
      walletBalance: asNum(usdt.walletBalance),
      equity: asNum(usdt.equity),
      coins,
    });
  } catch (e) {
    console.error('[bybit/wallet]', e.message);
    res.json({ ok: false, error: e.message });
  }
});

router.get('/ticker', auth, async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol || req.query.sym);
    const ticker = await getTicker(symbol);
    res.json({ ok: true, ticker });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.get('/instrument', auth, async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol || req.query.sym);
    const instrument = await getInstrumentInfo(symbol);
    res.json({ ok: true, instrument });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/leverage', auth, async (req, res) => {
  const symbol = normalizeSymbol(req.body.symbol);
  const leverage = req.body.leverage;
  if (!symbol || !leverage) return res.json({ ok: false, error: 'symbol and leverage required' });
  try {
    const data = await bybitPost('/v5/position/set-leverage', {
      category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage),
    });
    const ok = data.retCode === 0 || data.retCode === 110043;
    res.json({ ok, retCode: data.retCode, retMsg: data.retMsg });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/trading-stop', auth, async (req, res) => {
  try {
    const result = await setTradingStopSafe({ symbol: normalizeSymbol(req.body.symbol), tp1: req.body.tpPrice || req.body.tp1, sl: req.body.slPrice || req.body.sl });
    res.json(result);
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/order', auth, async (req, res) => {
  try {
    // Backward compatible endpoint. Prefer /bot/execute-signal.
    const signal = {
      id: req.body.signalId || `manual_${Date.now()}`,
      sym: normalizeSymbol(req.body.symbol),
      side: String(req.body.side || '').toLowerCase() === 'sell' ? 'SELL' : 'BUY',
      entry: req.body.price || req.body.entry,
      sl: req.body.slPrice || req.body.sl,
      tp1: req.body.tpPrice || req.body.tp1,
      score: req.body.score || 100,
      margin: req.body.margin,
      leverage: req.body.leverage,
    };
    const result = await executeSignal(signal, { force: req.body.force === true, forceMarket: req.body.orderType === 'Market' });
    res.json(result);
  } catch (e) {
    addLog('ERROR', `manual order failed: ${e.message}`, { body: req.body });
    res.json({ ok: false, error: e.message });
  }
});

router.get('/orders', auth, async (req, res) => {
  try {
    const params = { category: 'linear', settleCoin: 'USDT', limit: '50' };
    if (req.query.symbol) params.symbol = normalizeSymbol(req.query.symbol);
    const data = await bybitGet('/v5/order/realtime', params);
    if (data.retCode !== 0) return res.json({ ok: false, error: data.retMsg, orders: [] });
    const orders = (data.result?.list || []).map(o => ({
      orderId: o.orderId, orderLinkId: o.orderLinkId, symbol: o.symbol, side: o.side,
      price: asNum(o.price), avgPrice: asNum(o.avgPrice), qty: asNum(o.qty), leavesQty: asNum(o.leavesQty),
      cumExecQty: asNum(o.cumExecQty), orderType: o.orderType, status: o.orderStatus,
      rejectReason: o.rejectReason || '', cancelType: o.cancelType || '', createdAt: o.createdTime, updatedAt: o.updatedTime,
      takeProfit: asNum(o.takeProfit), stopLoss: asNum(o.stopLoss),
    }));
    res.json({ ok: true, orders });
  } catch (e) { res.json({ ok: false, error: e.message, orders: [] }); }
});

router.get('/positions', auth, async (req, res) => {
  try {
    const params = { category: 'linear', settleCoin: 'USDT', limit: '50' };
    if (req.query.symbol) params.symbol = normalizeSymbol(req.query.symbol);
    const data = await bybitGet('/v5/position/list', params);
    if (data.retCode !== 0) return res.json({ ok: false, error: data.retMsg, positions: [] });
    const positions = (data.result?.list || []).filter(p => asNum(p.size) > 0).map(p => ({
      symbol: p.symbol, side: p.side, size: asNum(p.size), entryPrice: asNum(p.avgPrice),
      unrealisedPnl: asNum(p.unrealisedPnl), leverage: asNum(p.leverage), markPrice: asNum(p.markPrice),
      liqPrice: asNum(p.liqPrice), takeProfit: asNum(p.takeProfit), stopLoss: asNum(p.stopLoss),
    }));
    res.json({ ok: true, positions });
  } catch (e) { res.json({ ok: false, error: e.message, positions: [] }); }
});

router.get('/order-history', auth, async (req, res) => {
  try {
    const params = { category: 'linear', settleCoin: 'USDT', limit: String(Math.min(parseInt(req.query.limit || '50', 10) || 50, 50)) };
    if (req.query.symbol) params.symbol = normalizeSymbol(req.query.symbol);
    const data = await bybitGet('/v5/order/history', params);
    res.json({ ok: data.retCode === 0, error: data.retMsg, orders: data.result?.list || [] });
  } catch (e) { res.json({ ok: false, error: e.message, orders: [] }); }
});

router.get('/executions', auth, async (req, res) => {
  try {
    const params = { category: 'linear', limit: String(Math.min(parseInt(req.query.limit || '50', 10) || 50, 100)) };
    if (req.query.symbol) params.symbol = normalizeSymbol(req.query.symbol);
    const data = await bybitGet('/v5/execution/list', params);
    res.json({ ok: data.retCode === 0, error: data.retMsg, executions: data.result?.list || [] });
  } catch (e) { res.json({ ok: false, error: e.message, executions: [] }); }
});

router.get('/closed-pnl', auth, async (req, res) => {
  try {
    const params = { category: 'linear', limit: String(Math.min(parseInt(req.query.limit || '50', 10) || 50, 50)) };
    if (req.query.symbol) params.symbol = normalizeSymbol(req.query.symbol);
    const data = await bybitGet('/v5/position/closed-pnl', params);
    res.json({ ok: data.retCode === 0, error: data.retMsg, closedPnl: data.result?.list || [] });
  } catch (e) { res.json({ ok: false, error: e.message, closedPnl: [] }); }
});

router.get('/live-state', auth, async (req, res) => {
  try {
    const state = req.query.refresh === '1' ? await reconcileOnce() : getLastSnapshot();
    res.json({ ok: true, ...state });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.delete('/order', auth, async (req, res) => {
  const symbol = normalizeSymbol(req.body.symbol);
  const { orderId } = req.body;
  if (!symbol || !orderId) return res.json({ ok: false, error: 'symbol and orderId required' });
  try {
    const data = await bybitPost('/v5/order/cancel', { category: 'linear', symbol, orderId });
    res.json({ ok: data.retCode === 0, retCode: data.retCode, retMsg: data.retMsg });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

module.exports = router;
