require('dotenv').config();
const path = require('path');

module.exports = {
  backendApiUrl: (process.env.BACKEND_API_URL || 'https://scrapper-node-app.onrender.com').replace(/\/$/, ''),
  workerPort: parseInt(process.env.WORKER_PORT || '4100', 10),
  workerApiKey: process.env.WORKER_API_KEY || 'change-me-to-a-long-random-secret',
  sessionsDir: path.resolve(process.env.SESSIONS_DIR || './sessions'),
  autoStartFromClaims: String(process.env.AUTO_START_FROM_CLAIMS || 'true') === 'true',
  claimPollMs: parseInt(process.env.CLAIM_POLL_MS || '5000', 10),
  monitoredPollMs: parseInt(process.env.MONITORED_POLL_MS || '15000', 10),
  historyLimit: parseInt(process.env.HISTORY_LIMIT || '500', 10),
  // QR codes die quickly; if last QR is older than this while not linked, force refresh
  staleQrMs: parseInt(process.env.STALE_QR_MS || '90000', 10),
  // Never-connected reconnect loops stuck longer than this → hard reset
  stuckReconnectMs: parseInt(process.env.STUCK_RECONNECT_MS || '60000', 10),
  logLevel: process.env.LOG_LEVEL || 'info'
};
