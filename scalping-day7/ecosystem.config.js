module.exports = {
  apps: [{
    name: "scalping-day7",
    script: "node_modules/.bin/next",
    args: "start -p 3002",
    cwd: "/usr/local/bin/scalping-day7",
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: "production",
      PORT: "3002",
      KUCOIN_HISTORY_DIR: "/usr/local/bin/scalping-bot6/data/history",

      // ── Signal engine (optimised 2026-05-24 via paramOptimizer — 730d/2y history) ──
      // Best passing combo: OOS PF=1.36, WR=50.4%, 44/384 combos passed
      BOT7_MIN_SCORE: "3",        // was 2 — all passing combos require 3/3 conditions
      BOT7_SL_ATR:    "1.5",      // confirmed — 2y run agrees with original default
      BOT7_TP_ATR:    "2.0",      // confirmed — 2y run agrees with original default
      BOT7_RSI_BULL_LO: "45",     // was 55 — wider lower bound captures more momentum
      BOT7_RSI_BULL_HI: "68",     // was 80 — avoid overbought (2y optimal: 68)
      BOT7_RSI_BEAR_LO: "32",     // was 20 — avoid oversold (2y optimal: 32)
      BOT7_RSI_BEAR_HI: "45",     // unchanged

      // ── Risk ──────────────────────────────────────────────────────────────────
      BOT7_RISK_PCT:    "1.0",    // 1% equity per trade
      BOT7_DD_LIMIT:    "5.0",    // 5% daily drawdown circuit-breaker
      BOT7_MAX_TRADES:  "10",     // max trades per day
      BOT7_MAX_POS:     "3",      // max concurrent positions
    }
  }]
};
