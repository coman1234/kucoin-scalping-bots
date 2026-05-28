module.exports = {
  apps: [{
    name: "scalping-day7",
    script: "node_modules/.bin/next",
    args: "start -p 3002",
    cwd: "/usr/local/bin/scalping-day7",
    interpreter: "/root/.nvm/versions/node/v24.15.0/bin/node",  // explicit NVM node — avoids system Node v12
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: "production",
      PORT: "3002",
      KUCOIN_HISTORY_DIR: "/usr/local/bin/scalping-bot6/data/history",

      // ── Signal engine (2y history OOS PF=1.36, WR=50.4%) ─────────────────────
      BOT7_MIN_SCORE:    "2",    // 2/3 conditions required (3 causes 0 trades in sideways mkts)
      BOT7_SL_ATR:       "1.5",  // confirmed by 2y optimiser
      BOT7_TP_ATR:       "2.5",  // was 2.0 → wider TP needed to overcome 0.2% round-trip fees
                                  // Fee-breakeven ATR: 2.5×TP/1.5×SL = R:R 1.67
                                  //   → profitable when ATR > 0.28% of price (vs 1.49% with TP=2.0)
      BOT7_RSI_BULL_LO:  "45",   // was 55 — wider lower bound
      BOT7_RSI_BULL_HI:  "68",   // was 80 — avoid overbought entries
      BOT7_RSI_BEAR_LO:  "32",   // was 20 — avoid oversold entries
      BOT7_RSI_BEAR_HI:  "45",   // unchanged

      // ── Volatility quality gate (NEW) ─────────────────────────────────────────
      // Only trade when ATR ≥ 0.5% of current price.
      // Rationale: with TP=2.5×ATR and SL=1.5×ATR at ATR=0.5%:
      //   win:  +1.25% − 0.2% fee = +1.05% net
      //   loss: −0.75% − 0.2% fee = −0.95% net
      //   at WR=46%: 0.46×1.05 − 0.54×0.95 = 0.483 − 0.513 = −0.03% (barely negative)
      //   at WR=50%: 0.5×1.05 − 0.5×0.95 = +0.05% per trade — profitable
      // Filters out coins like BNB (ATR=0.2%), APT (ATR=0.2%) in low-vol conditions.
      BOT7_MIN_ATR_PCT:  "0.5",  // % of price — filters low-volatility setups

      // ── Risk ──────────────────────────────────────────────────────────────────
      BOT7_RISK_PCT:     "2.0",  // was 1.0% → 2.0% per trade for larger positions
                                  // with $1000 sim equity: risk $20/trade
                                  // max position (20% cap) = $200/trade
      BOT7_DD_LIMIT:     "5.0",  // 5% daily drawdown circuit-breaker ($50 on $1000)
      BOT7_MAX_TRADES:   "8",    // was 10 → quality over quantity
      BOT7_MAX_POS:      "3",    // max 3 concurrent positions = $600 deployed max
      BOT7_MAX_NOTL:     "25",   // was 20% → 25% per position ($250 max on $1000)
      BOT7_MAX_HOLD_MIN: "90",   // was 60 → 90 min to give wider TP more time to hit
    }
  }]
};
