# Orayan v2 Upgrade Package

Upload this package to GitHub, keeping the same folder names:

```text
backend/
frontend/
```

## Backend Northflank service

```text
Root directory: backend
Dockerfile path: backend/Dockerfile
Port: 3000
Protocol: HTTP
Publicly expose port: ON
```

Required backend environment variables:

```env
BYBIT_API_KEY=your_testnet_key
BYBIT_API_SECRET=your_testnet_secret
BOT_MODE=TESTNET_BYBIT_PRICE
BYBIT_TESTNET=true
AUTO_TRADE_ENABLED=false
MAX_TRADE_USDT=10
LEVERAGE=3
MAX_OPEN_TRADES=10
MIN_SCORE_TO_TRADE=55
MARKET_ORDERS_ON_TESTNET=true
```

When you are ready for testnet auto-orders, change:

```env
AUTO_TRADE_ENABLED=true
```

or use the app Settings toggle, which now calls the backend `/bot/start` and `/bot/stop` endpoints.

## Frontend Northflank service

```text
Root directory: frontend
Dockerfile path: frontend/Dockerfile
Port: 80
Protocol: HTTP
Publicly expose port: ON
```

The frontend now contains a Bybit direct trade book at the bottom of the Signals tab. It pulls:

- open positions
- pending/open orders
- Orayan backend trades
- recent closed PnL
- wallet balance

from the backend/Bybit sync.

## What changed

- Backend owns order execution.
- Backend uses Bybit testnet prices in testnet mode.
- Testnet uses market orders by default to avoid pending orders from real-price/testnet-price mismatch.
- Pending orders are not removed just because no position exists.
- Signal status and Bybit order/position status are displayed separately.
- A Bybit direct trade book was added to the Signals tab footer.

## Safety

Live trading is still locked unless you intentionally set:

```env
BOT_MODE=LIVE_REAL_BYBIT
BYBIT_TESTNET=false
ALLOW_LIVE_TRADING=true
```

Do not set those until testnet is fully verified.
