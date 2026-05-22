/**
 * Root PM2 ecosystem — manages all 5 processes in the bot7 trading stack:
 *   1. data-producer      — KuCoin WebSocket data daemon (→ /dev/shm/kucoin-data)
 *   2. kucoin-datalake    — Datalake + optimizer service   (port 3010)
 *   3. scalping-bot7      — Signal monitor dashboard       (port 3001)
 *   4. scalping-monitor7  — System overview / heatmap      (port 3100)
 *   5. scalping-day7      — Regime-aware day trader        (port 3002)
 *
 * Deploy: scp this file to /usr/local/bin/ on the server.
 * Start:  pm2 start /usr/local/bin/ecosystem.config.js
 * Update: pm2 reload ecosystem.config.js
 */

module.exports = {
  apps: [
    {
      name: "data-producer",
      cwd: "/usr/local/bin/data-producer",
      script: "dist/index.js",
      interpreter: "node",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: { NODE_ENV: "production" },
      error_file: "/var/log/pm2/data-producer-err.log",
      out_file: "/var/log/pm2/data-producer-out.log",
    },
    {
      name: "kucoin-datalake",
      cwd: "/usr/local/bin/kucoin-datalake",
      script: "dist/index.js",
      interpreter: "node",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: "3010",
        DATALAKE_ROOT: "/var/lib/kucoin-datalake",
      },
      error_file: "/var/log/pm2/kucoin-datalake-err.log",
      out_file: "/var/log/pm2/kucoin-datalake-out.log",
    },
    {
      name: "scalping-bot7",
      cwd: "/usr/local/bin/scalping-bot7",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3001",
      interpreter: "node",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        DATALAKE_URL: "http://localhost:3010",
      },
      error_file: "/var/log/pm2/scalping-bot7-err.log",
      out_file: "/var/log/pm2/scalping-bot7-out.log",
    },
    {
      name: "scalping-monitor7",
      cwd: "/usr/local/bin/scalping-monitor7",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3100",
      interpreter: "node",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        DATALAKE_URL: "http://localhost:3010",
      },
      error_file: "/var/log/pm2/scalping-monitor7-err.log",
      out_file: "/var/log/pm2/scalping-monitor7-out.log",
    },
    {
      name: "scalping-day7",
      cwd: "/usr/local/bin/scalping-day7",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3002",
      interpreter: "node",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        DATALAKE_URL: "http://localhost:3010",
      },
      error_file: "/var/log/pm2/scalping-day7-err.log",
      out_file: "/var/log/pm2/scalping-day7-out.log",
    },
  ],
};
