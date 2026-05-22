# Deployment Guide — Unified Trading Ecosystem

## Architecture

```
Server (192.168.1.30)
│
├── data-producer   (:background)  →  /dev/shm/kucoin-data/
│     Fetches KuCoin every 2-10s, writes candles/tickers/orderbooks atomically
│
├── scalping-bot6   (:3001)  Bot A — signal monitor + manual backtest
├── scalping-monitor6 (:3100)  Bot B — multi-pair live monitor
└── scalping-day6   (:3002)  Bot C — autonomous ATR/BB day-trader (DRY RUN default)
```

---

## One-time server setup

```bash
# SSH in
ssh root@192.168.1.30

# Load nvm (ALWAYS required for Next.js 15 builds)
source ~/.nvm/nvm.sh
nvm use 24       # or whatever version is installed

# Create app directories
mkdir -p /usr/local/bin/{data-producer,scalping-bot6,scalping-monitor6,scalping-day6}
mkdir -p /var/log/pm2
mkdir -p /dev/shm/kucoin-data/{candles,ticker,orderbook}

# Set KuCoin credentials (real values) in server environment
# Add to /etc/environment or ~/.bashrc:
export KUCOIN_API_KEY="your-key"
export KUCOIN_API_SECRET="your-secret"
export KUCOIN_PASSPHRASE="your-passphrase"
```

---

## First deployment

From your Windows machine (run each block in PowerShell):

### 1. Copy all project sources to server

```powershell
$base = "C:\Users\JuhaHäkämies\OneDrive - Valoo Oy\data\Claude_files\corpdev"
$srv  = "root@192.168.1.30"

# data-producer
scp -r "$base\data-producer\src"        "${srv}:/usr/local/bin/data-producer/"
scp    "$base\data-producer\package.json" "${srv}:/usr/local/bin/data-producer/"
scp    "$base\data-producer\tsconfig.json" "${srv}:/usr/local/bin/data-producer/"

# Bot A
scp -r "$base\scalping-bot6\lib"         "${srv}:/usr/local/bin/scalping-bot6/"
scp -r "$base\scalping-bot6\app"         "${srv}:/usr/local/bin/scalping-bot6/"
scp -r "$base\scalping-bot6\components"  "${srv}:/usr/local/bin/scalping-bot6/"

# Bot B
scp -r "$base\scalping-monitor6\lib"       "${srv}:/usr/local/bin/scalping-monitor6/"
scp -r "$base\scalping-monitor6\app"       "${srv}:/usr/local/bin/scalping-monitor6/"
scp -r "$base\scalping-monitor6\components" "${srv}:/usr/local/bin/scalping-monitor6/"

# Bot C
scp -r "$base\scalping-day6\lib"         "${srv}:/usr/local/bin/scalping-day6/"
scp -r "$base\scalping-day6\app"         "${srv}:/usr/local/bin/scalping-day6/"
scp -r "$base\scalping-day6\components"  "${srv}:/usr/local/bin/scalping-day6/"
scp    "$base\scalping-day6\package.json"   "${srv}:/usr/local/bin/scalping-day6/"
scp    "$base\scalping-day6\tsconfig.json"  "${srv}:/usr/local/bin/scalping-day6/"
scp    "$base\scalping-day6\next.config.ts" "${srv}:/usr/local/bin/scalping-day6/"
scp    "$base\scalping-day6\tailwind.config.ts" "${srv}:/usr/local/bin/scalping-day6/"
scp    "$base\scalping-day6\postcss.config.js"  "${srv}:/usr/local/bin/scalping-day6/"

# Root ecosystem config
scp "$base\ecosystem.config.js" "${srv}:/usr/local/bin/"
```

### 2. Install deps + build on server

```bash
source ~/.nvm/nvm.sh

# data-producer
cd /usr/local/bin/data-producer
npm install
npm run build        # tsc → dist/

# Bot A
cd /usr/local/bin/scalping-bot6
npm install
npm run build

# Bot B
cd /usr/local/bin/scalping-monitor6
npm install
npm run build

# Bot C
cd /usr/local/bin/scalping-day6
npm install
npm run build
```

### 3. Start all processes with PM2

```bash
cd /usr/local/bin
pm2 start ecosystem.config.js
pm2 save               # persist across reboots
pm2 startup            # install pm2 as systemd service (run the printed command)
```

---

## Verify

```bash
pm2 list
pm2 logs data-producer --lines 20
pm2 logs scalping-day6 --lines 20
```

Expected:
- `data-producer` logs: `[producer] Ticker loop started`, cycle counts incrementing
- `/dev/shm/kucoin-data/` has `candles/`, `ticker/all.json`, `orderbook/` files
- Bot C dashboard at http://192.168.1.30:3002 — shows "Producer: ALIVE"

---

## Subsequent deploys (single bot)

```powershell
# Example: redeploy Bot C after code changes
$base = "C:\Users\JuhaHäkämies\OneDrive - Valoo Oy\data\Claude_files\corpdev"
scp -r "$base\scalping-day6\lib" "$base\scalping-day6\app" root@192.168.1.30:/usr/local/bin/scalping-day6/
ssh root@192.168.1.30 "source ~/.nvm/nvm.sh && cd /usr/local/bin/scalping-day6 && npm run build && pm2 restart scalping-day6"
```

---

## Environment variables reference

| Variable | Default | Description |
|---|---|---|
| `KUCOIN_API_KEY` | — | KuCoin API key (required for live trading) |
| `KUCOIN_API_SECRET` | — | KuCoin API secret |
| `KUCOIN_PASSPHRASE` | — | KuCoin API passphrase |
| `BOT6_DRY_RUN` | `"true"` | Paper-trade mode — no real orders. **Set to `"false"` to go live.** |
| `BOT6_RISK_PCT` | `"1.0"` | % of equity risked per trade |
| `BOT6_DD_LIMIT` | `"5.0"` | Daily drawdown % → circuit breaker |
| `BOT6_MAX_POS` | `"3"` | Max simultaneous open positions |
| `BOT6_MAX_NOTL` | `"20.0"` | Max notional size as % of equity |
| `BOT6_MIN_TRADE` | `"10.0"` | Min trade size USDT |
| `BOT6_SL_ATR` | `"1.5"` | Stop-loss = entry ± ATR × this |
| `BOT6_TP1_ATR` | `"2.0"` | TP1 = entry ± ATR × this |
| `BOT6_TP2_ATR` | `"4.0"` | TP2 = entry ± ATR × this |
| `BOT6_PAIRS` | TOP-20 | Comma-separated override, e.g. `"BTC-USDT,ETH-USDT"` |

---

## Going live

1. Verify dry-run mode works for ≥ 24h — confirm signals, sizing, circuit breaker
2. Set `BOT6_DRY_RUN=false` in `ecosystem.config.js`
3. `pm2 reload ecosystem.config.js` (graceful restart, no downtime)
4. Watch logs: `pm2 logs scalping-day6 --lines 100`
5. Monitor dashboard at http://192.168.1.30:3002

---

## Ports

| Service | Port | URL |
|---|---|---|
| Bot A (scalping-bot6) | 3001 | http://192.168.1.30:3001 |
| Bot B (scalping-monitor6) | 3100 | http://192.168.1.30:3100 |
| Bot C (scalping-day6) | 3002 | http://192.168.1.30:3002 |
