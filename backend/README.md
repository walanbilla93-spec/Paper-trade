# Orayan Hunter Backend v2

This backend turns Orayan from a browser-only signal dashboard into a safer cloud trading backend.

## What v2 fixes

- Backend Bybit live sync every 15 seconds.
- Separate signal status from Bybit order/position status.
- Pending orders are not deleted just because there is no position yet.
- Testnet orders use Bybit testnet prices, not real/Binance prices.
- Testnet execution defaults to market orders so orders fill for testing.
- Backend stores Bybit order IDs, orderLinkIds, position status, fills, PnL, TP/SL, and errors.
- Frontend can display a separate Bybit trade book pulled directly from the backend/Bybit.

## Northflank

Backend service:

```text
Root directory: backend
Dockerfile path: backend/Dockerfile
Protocol: HTTP
Port: 3000
```

Environment variables:

```env
BYBIT_API_KEY=...
BYBIT_API_SECRET=...
BOT_MODE=TESTNET_BYBIT_PRICE
BYBIT_TESTNET=true
AUTO_TRADE_ENABLED=false
MAX_TRADE_USDT=10
LEVERAGE=3
MAX_OPEN_TRADES=10
MIN_SCORE_TO_TRADE=55
MARKET_ORDERS_ON_TESTNET=true
```

Turn `AUTO_TRADE_ENABLED=true` only when you are ready for testnet auto orders.

## Important endpoints

```text
GET  /health
GET  /bot/status
POST /bot/start
POST /bot/stop
POST /bot/settings
POST /bot/execute-signal
GET  /bot/live-trades?refresh=1
GET  /bybit/live-state?refresh=1
GET  /bybit/orders
GET  /bybit/positions
GET  /bybit/order-history
GET  /bybit/executions
GET  /bybit/closed-pnl
```

## Safety

`LIVE_REAL_BYBIT` is locked unless `ALLOW_LIVE_TRADING=true` is set. Do not set that until testnet is fully verified.
