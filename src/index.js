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

let claimPollRunning = false;

async function pollClaimsAndStart() {
  if (!config.autoStartFromClaims) return;
  if (claimPollRunning) return;
  claimPollRunning = true;
  try {
    const claims = await backend.getClaimSessions();
    const claimedIds = new Set();
    const now = Date.now();
    const activeClaimsMap = new Map();
    for (const c of claims) {
      const uId = Number(c.userId || c.user_id);
      if (uId) activeClaimsMap.set(uId, c);
    }

    // 1) Stop idle un-scanned QR only. Never tear down a linked WhatsApp scrape session.
    for (const s of sessions.list()) {
      if (s.connectedAt || s.status === 'connected') continue;
      if (sessions.hasAuthCreds(s.userId)) continue;
      if (s.status === 'qr' || s.status === 'reconnecting' || s.status === 'starting') {
        const claim = activeClaimsMap.get(s.userId);
        const claimUpdatedAt = claim?.updated_at ? Date.parse(claim.updated_at) : 0;
        const claimIsStale = !claim || (claim.status === 'waiting' && claimUpdatedAt && (now - claimUpdatedAt > config.claimRecentMs));
        const qrIsIdle = s.lastQrAt && (now - Date.parse(s.lastQrAt) > 3 * 60 * 1000);

        if (claimIsStale || (qrIsIdle && claim?.status === 'waiting')) {
          logger.info(
            { userId: s.userId, status: s.status, claimStale: claimIsStale, qrIdle: qrIsIdle },
            'Stopping idle/stale un-scanned QR session to free up worker slot'
          );
          await sessions.stop(s.userId);
        }
      }
    }

    const qrBusy = sessions
      .list()
      .filter((s) => ['starting', 'qr', 'reconnecting'].includes(s.status) && !s.connectedAt)
      .length;
    let waitingStarts = qrBusy;

    // Prefer users who actually opened the portal recently (updated_at).
    const sorted = [...claims].sort(
      (a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0)
    );

    for (const claim of sorted) {
      const userId = Number(claim.userId || claim.user_id);
      if (!userId) continue;
      // Default admin is not a WhatsApp client — never auto-start it
      if (userId === 1) continue;
      claimedIds.add(userId);

      if (claim.status !== 'waiting' && claim.status !== 'linked') continue;

      const existing = sessions.get(userId);

      // Permanent fix: never leave waiting users stuck in reconnecting/stale QR
      if (existing && sessions.needsFreshQr(userId)) {
        // Linked-device creds must never be wiped — that looks like an automatic logout.
        const wipeAuth = !sessions.hasAuthCreds(userId);
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

      // Don't spin up QR for every stale waiting row in DB (was starting 50+ at once).
      if (claim.status === 'waiting') {
        const updatedAt = Date.parse(claim.updated_at || 0);
        if (!updatedAt || now - updatedAt > config.claimRecentMs) {
          continue;
        }
        if (waitingStarts >= config.maxWaitingStarts) {
          continue;
        }
        waitingStarts += 1;
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

    // Portal logout: stop QR sockets only. Keep scrape sessions (connected or with creds).
    for (const row of sessions.list()) {
      if (claimedIds.has(row.userId)) continue;
      if (row.status === 'connected' || row.connectedAt || sessions.hasAuthCreds(row.userId)) {
        continue;
      }
      logger.info(
        { userId: row.userId, status: row.status },
        'Stopping QR session without active claim (scrape left running)'
      );
      await sessions.stop(row.userId);
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Claim poll failed');
  } finally {
    claimPollRunning = false;
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
