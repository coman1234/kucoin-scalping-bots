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

      // ── Signal engine (optimised 2025-05-24 via paramOptimizer — 90d history) ──
      // Best passing combo: OOS PF=1.33, OOS WR=49.6%, degradation=11.3%
      BOT7_MIN_SCORE: "3",        // was 2 — all 8 passing combos require 3/3 conditions
      BOT7_SL_ATR:    "1.25",     // was 1.5 — tighter stop
      BOT7_TP_ATR:    "1.5",      // was 2.0 — closer TP → faster exits, higher WR
      BOT7_RSI_BULL_LO: "45",     // was 55 — wider lower bound captures more momentum
      BOT7_RSI_BULL_HI: "72",     // was 80 — avoid overbought entries
      BOT7_RSI_BEAR_LO: "28",     // was 20 — avoid oversold entries
      BOT7_RSI_BEAR_HI: "45",     // unchanged

      // ── Risk ──────────────────────────────────────────────────────────────────
      BOT7_RISK_PCT:    "1.0",    // 1% equity per trade
      BOT7_DD_LIMIT:    "5.0",    // 5% daily drawdown circuit-breaker
      BOT7_MAX_TRADES:  "10",     // max trades per day
      BOT7_MAX_POS:     "3",      // max concurrent positions
    }
  }]
};
