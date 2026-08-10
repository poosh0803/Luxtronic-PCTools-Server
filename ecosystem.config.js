/**
 * PM2 process definition for the Luxtronic PCTools server.
 *
 *   pm2 start ecosystem.config.js --env production
 *
 * Deploy target: 192.168.68.255:7777 (PROJECT_PLAN.md section 5), updated via the same
 * lan-portal-deploy pattern as the other Luxtronic services on that box (git pull + pm2 restart) --
 * nothing here does that itself, this file only describes how PM2 should run the process once it's
 * pulled.
 *
 * exec_mode is deliberately "fork", not "cluster", and instances is 1: src/lib/testRunCache.js and
 * src/ws/hub.js are in-memory, per-process state (the telemetry cache and the /ws/live pub/sub
 * fan-out). Running more than one instance would split that state across processes with no shared
 * backing store, and a dashboard tab could subscribe to an instance that never sees the telemetry
 * another instance is receiving. If this ever needs to scale beyond one process, that in-memory
 * state has to move to something shared (e.g. Postgres LISTEN/NOTIFY or Redis) first.
 *
 * Secrets (DATABASE_URL) are NOT set here -- they stay in .env on the server (see README.md "Local
 * setup"), loaded by the app itself via dotenv. This file only carries non-secret operational
 * config (PORT, NODE_ENV) that's fine to have in git. Keep PORT here in sync with .env's PORT if
 * you ever change one -- PM2's env always wins over .env when PM2 is what starts the process.
 */
module.exports = {
  apps: [
    {
      name: 'luxtronic-pctools-server',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 7777,
      },
      env_development: {
        NODE_ENV: 'development',
        watch: true,
      },
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
