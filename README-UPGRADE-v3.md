# ORAYAN v3 - Frontend Editable Backend Bot Settings

This build adds a frontend Bot Settings panel that saves non-secret bot controls directly to the backend.

## What changed

- Added `GET /bot/settings`
- Added frontend panel: Backend Bot Settings
- Frontend can save:
  - `BOT_MODE`
  - `tradingEnabled`
  - `MAX_TRADE_USDT`
  - `LEVERAGE`
  - `MAX_OPEN_TRADES`
  - `MIN_SCORE_TO_TRADE`
  - `COOLDOWN_MINUTES`
  - `PENDING_TIMEOUT_MINUTES`
  - `ORDER_TYPE`
  - `MARKET_ORDERS_ON_TESTNET`
- Bybit API keys are not saved from frontend. Keep them only in Northflank backend env variables.
- LIVE mode is blocked unless `CONFIRM_LIVE_TRADING=true` is set on the backend host.

## Recommended safe settings now

Use these in the frontend Bot Settings panel:

```text
BOT_MODE=PAPER_REAL_PRICE
TRADING ENABLED=OFF
MAX_TRADE_USDT=10
LEVERAGE=3
MAX_OPEN_TRADES=10
MIN_SCORE_TO_TRADE=55
ORDER_TYPE=Market
MARKET ORDERS ON TESTNET=ON
```

## Required Northflank backend env secrets

```env
BYBIT_API_KEY=your_key
BYBIT_API_SECRET=your_secret
BYBIT_TESTNET=true
CONFIRM_LIVE_TRADING=false
```

Do not put API keys in frontend.
