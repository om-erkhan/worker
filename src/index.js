const express = require('express');
const cors = require('cors');
const pino = require('pino');

const config = require('./config');
const backend = require('./backendClient');
const sessions = require('./sessionManager');

const logger = pino({ level: config.logLevel });
const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (!config.workerApiKey || key !== config.workerApiKey) {
    return res.status(401).json({ error: true, message: 'Invalid worker API key' });
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({
    error: false,
    service: 'whatsapp-worker',
    sessions: sessions.list().length,
    backend: config.backendApiUrl
  });
});

app.get('/sessions', requireApiKey, (_req, res) => {
  res.json({ error: false, data: sessions.list() });
});

app.get('/sessions/:userId', requireApiKey, (req, res) => {
  const row = sessions.getPublic(Number(req.params.userId));
  if (!row) return res.status(404).json({ error: true, message: 'Session not found' });
  res.json({ error: false, data: row });
});

app.post('/sessions/:userId/start', requireApiKey, async (req, res) => {
  try {
    const data = await sessions.start(Number(req.params.userId));
    res.status(201).json({ error: false, data, message: 'Session starting' });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.post('/sessions/:userId/stop', requireApiKey, async (req, res) => {
  try {
    const logout = String(req.body?.logout || '') === 'true';
    const data = await sessions.stop(Number(req.params.userId), { logout });
    res.json({ error: false, data, message: 'Session stopped' });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.post('/sessions/:userId/fresh-qr', requireApiKey, async (req, res) => {
  try {
    const data = await sessions.forceFreshQr(Number(req.params.userId));
    res.status(201).json({ error: false, data, message: 'Fresh QR session started' });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

async function pollClaimsAndStart() {
  if (!config.autoStartFromClaims) return;
  try {
    const claims = await backend.getClaimSessions();
    const claimedIds = new Set();
    const now = Date.now();

    for (const claim of claims) {
      const userId = Number(claim.userId || claim.user_id);
      if (!userId) continue;
      // Default admin is not a WhatsApp client — never auto-start it
      if (userId === 1) continue;
      claimedIds.add(userId);

      if (claim.status !== 'waiting' && claim.status !== 'linked') continue;

      const existing = sessions.get(userId);

      // Permanent fix: never leave waiting users stuck in reconnecting/stale QR
      if (existing && sessions.needsFreshQr(userId)) {
        const wipeAuth = !(sessions.hasAuthCreds(userId) && claim.status === 'linked');
        logger.warn(
          {
            userId,
            status: existing.status,
            lastQrAt: existing.lastQrAt,
            statusSince: existing.statusSince,
            wipeAuth
          },
          'Stuck/stale QR session detected — forcing restart'
        );
        try {
          await sessions.forceFreshQr(userId, { wipeAuth });
        } catch (err) {
          logger.error({ userId, err: err.message }, 'forceFreshQr failed');
        }
        continue;
      }

      if (existing && ['starting', 'qr', 'connected', 'reconnecting'].includes(existing.status)) {
        continue;
      }

      // waiting => need QR
      // linked + valid creds => restore; linked + no/broken creds => fresh QR
      if (existing?.status === 'error') {
        const failedAt = existing.errorAt || 0;
        if (now - failedAt < 30000) continue;
        await sessions.stop(userId);
      }
      if (claim.status === 'linked' && !sessions.hasAuthCreds(userId)) {
        logger.info({ userId }, 'Linked claim has no auth — starting fresh QR session');
      }
      logger.info({ userId, status: claim.status }, 'Auto-starting session from claim');
      await sessions.start(userId);
    }

    // Stop non-claimed sessions. Keep multi-user same-WA: each linked claim stays alive.
    // Never tear down a healthy connected session — another portal user linking the
    // same phone must not steal / kill this user's live socket.
    for (const row of sessions.list()) {
      if (claimedIds.has(row.userId)) continue;
      if (row.status === 'connected' || row.status === 'qr' || row.status === 'reconnecting') {
        continue;
      }
      logger.info(
        { userId: row.userId, status: row.status },
        'Stopping session without active claim'
      );
      await sessions.stop(row.userId);
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Claim poll failed');
  }
}

async function main() {
  await sessions.restoreAll();

  app.listen(config.workerPort, () => {
    logger.info(
      { port: config.workerPort, backend: config.backendApiUrl },
      'WhatsApp worker listening'
    );
  });

  setInterval(pollClaimsAndStart, config.claimPollMs);
  pollClaimsAndStart();
}

main().catch((err) => {
  logger.error(err, 'Worker crashed');
  process.exit(1);
});
