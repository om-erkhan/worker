const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  jidNormalizedUser,
  Browsers
} = require('@whiskeysockets/baileys');

const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const config = require('./config');
const backend = require('./backendClient');
const { isCommonJunkMessage } = require('./messageFilter');

const logger = pino({ level: config.logLevel });
const HISTORY_BATCH = 50;
const HISTORY_MAX_ROUNDS = Math.ceil((config.historyLimit || 500) / HISTORY_BATCH);

function getProxyAgentForUser(userId) {
  if (!config.proxyUrls || !config.proxyUrls.length) return undefined;
  const index = Math.abs(Number(userId || 0)) % config.proxyUrls.length;
  const proxyUrl = config.proxyUrls[index];
  if (!proxyUrl) return undefined;
  try {
    if (proxyUrl.startsWith('socks')) {
      return new SocksProxyAgent(proxyUrl);
    }
    return new HttpsProxyAgent(proxyUrl);
  } catch (err) {
    logger.error({ userId, proxyUrl, err: err.message }, 'Failed creating proxy agent');
    return undefined;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toCUs(jid) {
  if (!jid) return '';
  const normalized = jidNormalizedUser(jid) || jid;
  return String(normalized);
}

/** Prefer classic WhatsApp JIDs over privacy @lid ids when both are present. */
function preferClassicJid(...jids) {
  const cleaned = jids.map(toCUs).filter(Boolean);
  if (!cleaned.length) return '';
  const classic = cleaned.find(
    (j) => j.endsWith('@g.us') || j.endsWith('@s.whatsapp.net') || j.endsWith('@c.us')
  );
  return classic || cleaned[0];
}

/** Chat JID for a Baileys message (handles LID ↔ classic addressing). */
function resolveMessageChatJid(msg) {
  const key = msg?.key || {};
  return preferClassicJid(key.remoteJid, key.remoteJidAlt, msg.remoteJid);
}

function rememberJidAlias(state, a, b) {
  if (!state || !a || !b || a === b) return;
  state.jidAliases = state.jidAliases || new Map();
  state.jidAliases.set(a, b);
  state.jidAliases.set(b, a);
}

function isPhoneLikeName(str) {
  const cleaned = String(str || '').trim();
  if (!cleaned) return true;
  const digits = cleaned.replace(/\D/g, '');
  const compact = cleaned.replace(/\s/g, '');
  if (digits.length >= 10 && digits.length <= 20) {
    const nonDigit = compact.replace(/\d/g, '').replace(/[+()-]/g, '');
    if (nonDigit.length <= 2) return true;
  }
  if (/^92\d{10}$/.test(digits) || /^03\d{9}$/.test(digits)) return true;
  return false;
}

function rememberChatName(state, jid, name) {
  if (!state || !jid || !name) return;
  const n = String(name).trim();
  if (!n || isPhoneLikeName(n)) return;
  state.nameByJid = state.nameByJid || new Map();
  state.nameByJid.set(jid, n);
}

function chatNameFrom(sock, jid, fallbackName, state = null) {
  if (fallbackName && !isPhoneLikeName(fallbackName)) return fallbackName;

  const cached = state?.nameByJid?.get(jid);
  if (cached && !isPhoneLikeName(cached)) return cached;

  try {
    const meta = sock?.contacts?.[jid] || sock?.store?.contacts?.[jid];
    const fromContact = meta?.name || meta?.notify || meta?.verifiedName;
    if (fromContact && !isPhoneLikeName(fromContact)) return fromContact;

    const chat = sock?.store?.chats?.get?.(jid);
    const fromChat = chat?.name || chat?.subject;
    if (fromChat && !isPhoneLikeName(fromChat)) return fromChat;
  } catch (_) {}

  return null;
}

function resolveChatDisplayName(state, sock, jid, hints = {}) {
  return (
    chatNameFrom(sock, jid, hints.name || hints.subject || hints.fallbackName, state) ||
    null
  );
}

function extractText(msg) {
  if (!msg?.message || msg.message.protocolMessage) return '';
  return (
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    msg.message.videoMessage?.caption ||
    msg.message.documentMessage?.caption ||
    msg.message.buttonsMessage?.contentText ||
    msg.message.listMessage?.description ||
    ''
  );
}

class SessionManager {
  constructor() {
    ensureDir(config.sessionsDir);
    /** @type {Map<number, any>} */
    this.sessions = new Map();
  }

  list() {
    return Array.from(this.sessions.entries()).map(([userId, s]) => ({
      userId,
      status: s.status,
      lastQrAt: s.lastQrAt || null,
      connectedAt: s.connectedAt || null,
      statusSince: s.statusSince || null,
      monitoredCount: s.monitoredJids?.size || 0,
      historySynced: s.historySyncedJids?.size || 0,
      error: s.error || null
    }));
  }

  get(userId) {
    return this.sessions.get(Number(userId)) || null;
  }

  _setStatus(state, status) {
    if (!state) return;
    if (state.status !== status) {
      state.status = status;
      state.statusSince = Date.now();
    } else if (!state.statusSince) {
      state.statusSince = Date.now();
    }
  }

  /**
   * True when a never-linked / waiting session is stuck and will not show a usable QR
   * (stale QR, endless reconnect, or orphaned reconnect without timer).
   */
  needsFreshQr(userId) {
    const s = this.sessions.get(Number(userId));
    if (!s) return false;
    if (s.connectedAt || s.status === 'connected') return false;
    if (s.startingLock) return false;

    const now = Date.now();
    const lastQrMs = s.lastQrAt ? Date.parse(s.lastQrAt) : 0;
    const since = s.statusSince || lastQrMs || 0;
    const staleQr = config.staleQrMs || 90000;
    const stuckReconnect = config.stuckReconnectMs || 60000;
    const hasCreds = this.hasAuthCreds(userId);

    // Linked-device restore path: do not wipe auth on short reconnects
    if (hasCreds) {
      if (s.status === 'reconnecting') {
        if (!s.reconnectTimer && !s.sock) return true; // orphaned
        if (since && now - since > stuckReconnect * 3) return true; // hung restore
      }
      if (s.status === 'error') {
        const failedAt = s.errorAt || since || 0;
        return !failedAt || now - failedAt >= 30000;
      }
      return false;
    }

    if (s.status === 'reconnecting') {
      if (!lastQrMs) return true;
      if (now - lastQrMs > staleQr) return true;
      if (since && now - since > stuckReconnect) return true;
      if (!s.reconnectTimer && !s.sock) return true;
      return false;
    }

    if (s.status === 'qr') {
      if (!lastQrMs || now - lastQrMs > staleQr) return true;
      return false;
    }

    if (s.status === 'error' || s.status === 'disconnected') {
      const failedAt = s.errorAt || since || 0;
      return !failedAt || now - failedAt >= 30000;
    }

    return false;
  }

  /**
   * Hard reset for waiting users: stop socket, wipe auth, start clean QR.
   * For linked users with creds, prefer restartWithoutWipe().
   */
  async forceFreshQr(userId, { wipeAuth = true } = {}) {
    const id = Number(userId);
    if (!id) throw new Error('userId is required');
    logger.warn({ userId: id, wipeAuth }, 'Forcing session restart for QR/reconnect');
    await this.stop(id, { logout: false });
    if (wipeAuth) {
      this.clearAuth(id);
      // Show QR on the portal. Do not pause scraping.
      await this._markPortalNeedsQr(id);
    }
    return this.start(id);
  }

  async start(userId) {
    const id = Number(userId);
    if (!id) throw new Error('userId is required');

    const existing = this.sessions.get(id);
    if (existing && ['starting', 'qr', 'connected', 'reconnecting'].includes(existing.status)) {
      return this.getPublic(id);
    }
    // Guard overlapping start() calls (poll interval can overlap)
    if (existing?.startingLock) {
      return this.getPublic(id);
    }

    const authDir = path.join(config.sessionsDir, `user_${id}`);
    ensureDir(authDir);

    const state = {
      userId: id,
      status: 'starting',
      statusSince: Date.now(),
      startingLock: true,
      sock: null,
      authDir,
      lastQrAt: null,
      connectedAt: null,
      monitoredJids: new Set(),
      monitoredMeta: new Map(), // jid -> { name }
      nameByJid: new Map(), // jid -> display name (groups + contacts)
      seenMsgKeys: new Set(),
      historySyncedJids: new Set(),
      historySyncing: new Set(),
      msgCache: new Map(), // jid -> WAMessage[]
      historyWaiters: new Set(),
      jidAliases: new Map(),
      lastMessageAtByJid: null, // jid -> last saved message ms (loaded once after connect)
      error: null,
      errorAt: null,
      stopping: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      bootGeneration: 0
    };
    this.sessions.set(id, state);

    try {
      await this._bootSocket(state);
      state.startingLock = false;
    } catch (err) {
      state.startingLock = false;
      state.status = 'error';
      state.error = err.message;
      state.errorAt = Date.now();
      logger.error({ userId: id, err }, 'Failed to start session');
      throw err;
    }

    return this.getPublic(id);
  }

  getPublic(userId) {
    const s = this.sessions.get(Number(userId));
    if (!s) return null;
    return {
      userId: s.userId,
      status: s.status,
      lastQrAt: s.lastQrAt,
      connectedAt: s.connectedAt,
      statusSince: s.statusSince || null,
      monitoredCount: s.monitoredJids.size,
      historySynced: s.historySyncedJids.size,
      error: s.error
    };
  }

  async stop(userId, { logout = false } = {}) {
    const id = Number(userId);
    const state = this.sessions.get(id);
    if (!state) return { userId: id, status: 'stopped' };

    state.stopping = true;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    try {
      // Never pause scraping on logout. Portal/QR stop must not freeze last_scraped_at.
      if (logout && state.sock?.logout) await state.sock.logout();
      else if (state.sock?.end) state.sock.end(undefined);
    } catch (_) {}

    if (state.monitoredTimer) clearInterval(state.monitoredTimer);
    this.sessions.delete(id);
    return { userId: id, status: 'stopped' };
  }

  hasAuthCreds(userId) {
    const authDir = path.join(config.sessionsDir, `user_${Number(userId)}`);
    try {
      return fs.existsSync(path.join(authDir, 'creds.json'));
    } catch (_) {
      return false;
    }
  }

  /**
   * Portal "connected" comes from claim status=linked, not the live socket.
   * When there is no WhatsApp session, put the claim back to waiting so the
   * UI shows QR instead of a stale connected state. Never pause scraping.
   */
  async _markPortalNeedsQr(userId) {
    const id = Number(userId);
    if (!id) return;
    try {
      await backend.resetClaimToWaiting(id);
      logger.info({ userId: id }, 'Portal claim set to waiting — not actually connected');
    } catch (err) {
      logger.warn({ userId: id, err: err.message }, 'Failed setting claim to waiting');
    }
  }

  clearAuth(userId) {
    const authDir = path.join(config.sessionsDir, `user_${Number(userId)}`);
    try {
      if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
      }
    } catch (err) {
      logger.warn({ userId, err: err.message }, 'Failed clearing auth dir');
    }
  }

  async restoreAll() {
    const entries = fs.readdirSync(config.sessionsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const m = ent.name.match(/^user_(\d+)$/);
      if (!m) continue;
      const userId = parseInt(m[1], 10);
      // Skip empty folders — they only create reconnect storms with no QR
      if (!this.hasAuthCreds(userId)) {
        logger.info({ userId }, 'Skipping empty session folder (no creds.json)');
        continue;
      }
      logger.info({ userId }, 'Restoring saved WhatsApp session');
      try {
        await this.start(userId);
      } catch (err) {
        logger.error({ userId, err: err.message }, 'Restore failed');
      }
    }
  }

  _cacheMessages(state, messages) {
    for (const msg of messages || []) {
      const key = msg?.key || {};
      if (!key.id) continue;
      const jids = [
        resolveMessageChatJid(msg),
        toCUs(key.remoteJid),
        toCUs(key.remoteJidAlt)
      ].filter(Boolean);
      const unique = [...new Set(jids)];
      if (unique.length >= 2) rememberJidAlias(state, unique[0], unique[1]);
      for (const jid of unique) {
        if (!state.msgCache.has(jid)) state.msgCache.set(jid, []);
        const arr = state.msgCache.get(jid);
        if (arr.some((m) => m.key?.id === key.id)) continue;
        arr.push(msg);
        const catchingUp = state.historySyncing && state.historySyncing.size > 0;
        const limit = (config.historyLimit || 500) + 100;
        if (!catchingUp && arr.length > limit) {
          arr.sort(
            (a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0)
          );
          state.msgCache.set(jid, arr.slice(-limit));
        }
      }
    }
  }

  _cachedList(state, jid) {
    const ids = new Set([jid, this._resolveMonitoredJid(state, jid), state.jidAliases?.get(jid)].filter(Boolean));
    const bare = String(jid || '').split('@')[0];
    for (const [k] of state.msgCache || []) {
      if (String(k).split('@')[0] === bare) ids.add(k);
    }
    const byId = new Map();
    for (const id of ids) {
      for (const msg of state.msgCache.get(id) || []) {
        const mid = msg?.key?.id;
        if (mid && !byId.has(mid)) byId.set(mid, msg);
      }
    }
    return [...byId.values()];
  }

  _oldestCached(state, jid) {
    const arr = this._cachedList(state, jid);
    if (!arr.length) return null;
    return arr.reduce((oldest, msg) => {
      if (!oldest) return msg;
      return Number(msg.messageTimestamp || 0) < Number(oldest.messageTimestamp || 0)
        ? msg
        : oldest;
    }, null);
  }

  _notifyHistoryWaiters(state) {
    for (const resolve of state.historyWaiters) {
      try {
        resolve();
      } catch (_) {}
    }
    state.historyWaiters.clear();
  }

  waitForHistoryBatch(state, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.historyWaiters.delete(wrapped);
        resolve(false);
      }, timeoutMs);
      const wrapped = () => {
        clearTimeout(timer);
        resolve(true);
      };
      state.historyWaiters.add(wrapped);
    });
  }

  async _bootSocket(state) {
    const authDir = state.authDir || path.join(config.sessionsDir, `user_${state.userId}`);
    state.authDir = authDir;
    ensureDir(authDir);

    // Kill previous socket so we never stack multiple WA connections
    const prev = state.sock;
    state.sock = null;
    if (prev) {
      try {
        prev.ev.removeAllListeners('connection.update');
        prev.ev.removeAllListeners('creds.update');
        // Prefer ws close without Boom("Connection Terminated") noise when possible
        if (prev.ws?.close) prev.ws.close();
        else prev.end(undefined);
      } catch (_) {}
      await sleep(300);
    }

    const bootGeneration = (state.bootGeneration || 0) + 1;
    state.bootGeneration = bootGeneration;

    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    // Unique device name per portal user so the same phone can link
    // multiple portal accounts as separate WhatsApp "Linked devices".
    // Identical names (e.g. all "Chrome") cause WA to replace the previous device.
    const deviceName = `PortalUser${state.userId}`;
    const agent = getProxyAgentForUser(state.userId);
    if (agent) {
      logger.info({ userId: state.userId }, 'Using proxy for WhatsApp session');
    }

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu(deviceName),
      syncFullHistory: true,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: 'silent' }))
      },
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
      ...(agent ? { agent, fetchAgent: agent } : {}),
      getMessage: async (key) => {
        const jid = toCUs(key.remoteJid);
        const arr = state.msgCache.get(jid) || [];
        const found = arr.find((m) => m.key?.id === key.id);
        return found?.message || undefined;
      }
    });

    state.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      // Ignore events from an older socket after reconnect
      if (state.bootGeneration !== bootGeneration || state.sock !== sock) return;

      const { connection, lastDisconnect, qr } = update;
      if (qr || connection) {
        logger.info(
          {
            userId: state.userId,
            connection: connection || null,
            hasQr: !!qr,
            code: lastDisconnect?.error?.output?.statusCode || null
          },
          'connection.update'
        );
      }

      if (qr) {
        this._setStatus(state, 'qr');
        state.reconnectAttempts = 0;
        state.lastQrAt = new Date().toISOString();
        // Only flip portal off "connected" when there is no saved WhatsApp session.
        // Restores with creds.json must not look like a logout while reconnecting.
        if (!this.hasAuthCreds(state.userId) && !state.portalWaitingForQr) {
          state.portalWaitingForQr = true;
          await this._markPortalNeedsQr(state.userId);
        }
        try {
          await backend.postQr(state.userId, qr);
          state.lastQrDataUrl = await QRCode.toDataURL(qr);
          logger.info({ userId: state.userId }, 'QR posted to backend');
        } catch (err) {
          logger.error({ userId: state.userId, err: err.message }, 'Failed posting QR');
        }
      }

      if (connection === 'open') {
        this._setStatus(state, 'connected');
        state.reconnectAttempts = 0;
        state.connectedAt = new Date().toISOString();
        state.portalWaitingForQr = false;
        state.error = null;
        const waJid = toCUs(sock.user?.id || sock.user?.lid || '');
        state.waJid = waJid || null;

        // Same WhatsApp number may already be linked on other portal users — keep all.
        const peers = [];
        for (const [otherId, other] of this.sessions.entries()) {
          if (otherId === state.userId) continue;
          if (!other?.waJid || !waJid) continue;
          const a = String(other.waJid).split('@')[0].split(':')[0];
          const b = String(waJid).split('@')[0].split(':')[0];
          if (a && b && (a === b || a.endsWith(b) || b.endsWith(a))) {
            peers.push(otherId);
          }
        }
        logger.info(
          { userId: state.userId, waJid: state.waJid, sameWaPeers: peers },
          'WhatsApp connected (multi-user same number allowed)'
        );

        try {
          const statusRes = await backend.postQrStatus(
            state.userId,
            'WhatsApp linked / QR disappeared',
            state.waJid
          );
          const postedFor = Number(
            statusRes?.data?.userId || statusRes?.data?.user_id || state.userId
          );
          if (postedFor && postedFor !== state.userId) {
            logger.error(
              { userId: state.userId, postedFor, waJid: state.waJid },
              'Backend attributed link to a different userId — refusing to continue as wrong tenant'
            );
          }
        } catch (err) {
          // Permanently bound to another number — drop this wrong session only
          if (err.status === 409 || err.body?.code === 'WHATSAPP_BIND_MISMATCH') {
            logger.warn(
              { userId: state.userId, waJid: state.waJid, body: err.body },
              'WhatsApp number not allowed for this portal user — logging out'
            );
            try {
              await sock.logout();
            } catch (_) {}
            this.clearAuth(state.userId);
            try {
              await backend.resetClaimToWaiting(state.userId);
            } catch (_) {}
            state.status = 'error';
            state.error = 'WHATSAPP_BIND_MISMATCH';
            this.sessions.delete(state.userId);
            return;
          }
          logger.error({ userId: state.userId, err: err.message }, 'Failed posting QR status');
        }
        // Scrape first — name sync can wait (used to block monitor start for minutes).
        try {
          await this._refreshMonitored(state);
        } catch (err) {
          logger.error(
            { userId: state.userId, err: err.message },
            'Failed refreshing monitored chats on connect — will retry on poll'
          );
        }
        this._syncChats(state).catch(() => {});
        this._syncGroupNames(state).catch(() => {});
        if (state.monitoredTimer) clearInterval(state.monitoredTimer);
        state.monitoredTimer = setInterval(() => {
          this._refreshMonitored(state).catch((err) => {
            logger.warn(
              { userId: state.userId, err: err.message },
              'Monitored chat poll failed'
            );
          });
        }, config.monitoredPollMs);
      }

      if (connection === 'close') {
        const err = lastDisconnect?.error;
        const code = err?.output?.statusCode;
        const errMsg = err?.message || String(err || '');
        const loggedOut = code === DisconnectReason.loggedOut;
        const isActive = this.sessions.get(state.userId) === state;

        if (state.monitoredTimer) {
          clearInterval(state.monitoredTimer);
          state.monitoredTimer = null;
        }

        logger.warn(
          { userId: state.userId, code, errMsg, attempts: state.reconnectAttempts, stopping: state.stopping, isActive },
          'WhatsApp disconnected'
        );

        // stop()/restart already replaced this socket — never wipe the new session
        if (state.stopping || !isActive) {
          return;
        }

        const shouldReconnect = !loggedOut;
        if (!shouldReconnect) {
          logger.warn(
            { userId: state.userId, code },
            'WhatsApp logged out on the phone — new QR needed; scrape cursor left running'
          );
          this.clearAuth(state.userId);
          await this._markPortalNeedsQr(state.userId);
          this._setStatus(state, 'disconnected');
          this.sessions.delete(state.userId);
          return;
        }

        state.reconnectAttempts = (state.reconnectAttempts || 0) + 1;

        // 408 is also connectionLost — do not treat it as "never linked" if creds exist
        const hasCreds = this.hasAuthCreds(state.userId);
        const neverLinked = !state.connectedAt && !hasCreds;
        const qrExpired =
          code === 408 ||
          /QR refs attempts ended/i.test(errMsg) ||
          code === DisconnectReason.timedOut;

        if (neverLinked && (qrExpired || state.reconnectAttempts >= 2)) {
          logger.warn(
            { userId: state.userId, code, attempts: state.reconnectAttempts },
            'Never-linked session disconnect — clearing half-auth for fresh QR'
          );
          this.clearAuth(state.userId);
          await this._markPortalNeedsQr(state.userId);
          ensureDir(authDir);
          state.reconnectAttempts = 0;
        }

        // After repeated closes with no QR/creds, wipe auth and cool down
        if (state.reconnectAttempts >= 5 && !this.hasAuthCreds(state.userId)) {
          logger.error(
            { userId: state.userId, attempts: state.reconnectAttempts },
            'No QR/creds after repeated disconnects — pausing session (check AWS IP / WhatsApp block)'
          );
          this._setStatus(state, 'error');
          state.error = 'WhatsApp connection failed before QR. Often blocked datacenter IP.';
          state.errorAt = Date.now();
          try {
            sock.ev.removeAllListeners();
            sock.end(undefined);
          } catch (_) {}
          return;
        }

        // Bad / half-written session: clear and retry for a fresh QR
        if (
          state.reconnectAttempts >= 3 &&
          (code === DisconnectReason.badSession ||
            code === DisconnectReason.connectionClosed ||
            code === DisconnectReason.multideviceMismatch)
        ) {
          if (!state.connectedAt && !hasCreds) {
            logger.warn({ userId: state.userId }, 'Clearing broken auth for fresh QR');
            this.clearAuth(state.userId);
            ensureDir(authDir);
          }
        }

        // Fast retry for QR refresh; slower only after a prior successful link
        const delay = neverLinked
          ? Math.min(5000, 1000 + state.reconnectAttempts * 500)
          : Math.min(30000, 2000 * state.reconnectAttempts);
        this._setStatus(state, 'reconnecting');
        if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(() => {
          state.reconnectTimer = null;
          if (!state.stopping && this.sessions.get(state.userId) === state) {
            this._bootSocket(state).catch((bootErr) => {
              this._setStatus(state, 'error');
              state.error = bootErr.message;
              state.errorAt = Date.now();
            });
          }
        }, delay);
      }
    });

    // Initial + on-demand history batches land here
    sock.ev.on('messaging-history.set', async (payload) => {
      try {
        const { chats, messages } = payload || {};
        if (Array.isArray(chats) && chats.length) {
          await this._uploadChats(state, chats);
        }
        if (Array.isArray(messages) && messages.length) {
          this._cacheMessages(state, messages);
          // Post any monitored history immediately
          await this._handleMessages(state, messages, { isHistory: true });
          logger.info(
            { userId: state.userId, count: messages.length },
            'History batch received'
          );
        }
        this._notifyHistoryWaiters(state);
      } catch (err) {
        logger.error({ userId: state.userId, err: err.message }, 'messaging-history.set failed');
        this._notifyHistoryWaiters(state);
      }
    });

    sock.ev.on('chats.upsert', async (chats) => {
      try {
        await this._uploadChats(state, chats);
      } catch (err) {
        logger.error({ userId: state.userId, err: err.message }, 'chats.upsert upload failed');
      }
    });

    sock.ev.on('chats.update', async (chats) => {
      try {
        await this._uploadChats(state, chats);
      } catch (_) {}
    });

    sock.ev.on('contacts.upsert', async (contacts) => {
      try {
        await this._uploadContacts(state, contacts);
      } catch (err) {
        logger.warn({ userId: state.userId, err: err.message }, 'contacts.upsert failed');
      }
    });

    sock.ev.on('contacts.update', async (contacts) => {
      try {
        await this._uploadContacts(state, contacts);
      } catch (_) {}
    });

    sock.ev.on('groups.upsert', async (groups) => {
      try {
        await this._uploadGroups(state, groups);
      } catch (err) {
        logger.warn({ userId: state.userId, err: err.message }, 'groups.upsert failed');
      }
    });

    sock.ev.on('groups.update', async (groups) => {
      try {
        await this._uploadGroups(state, groups);
      } catch (_) {}
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (!messages?.length) return;
      try {
        this._cacheMessages(state, messages);
        this._notifyHistoryWaiters(state);
        await this._handleMessages(state, messages, { type });
      } catch (err) {
        logger.error({ userId: state.userId, err: err.message }, 'messages.upsert failed');
      }
    });
  }

  async _uploadChats(state, chats) {
    const contacts = [];
    for (const chat of chats || []) {
      const jid = toCUs(chat.id || chat.jid);
      if (!jid || isJidBroadcast(jid) || jid.endsWith('@newsletter')) continue;
      const name = resolveChatDisplayName(state, state.sock, jid, {
        name: chat.name,
        subject: chat.subject
      });
      if (name) rememberChatName(state, jid, name);
      contacts.push({
        id: jid,
        name: name || chat.name || chat.subject || jid.split('@')[0],
        avatar: null
      });
    }
    if (!contacts.length) return;
    // Don't block the WA event loop on chatroom name sync
    backend.postContacts(state.userId, contacts)
      .then(() => {
        logger.info({ userId: state.userId, count: contacts.length }, 'Uploaded chatrooms');
      })
      .catch((err) => {
        logger.warn({ userId: state.userId, err: err.message }, 'Uploaded chatrooms failed');
      });
  }

  async _uploadContacts(state, contactsIn) {
    const contacts = [];
    for (const c of contactsIn || []) {
      const jid = toCUs(c.id || c.jid);
      const name = c.name || c.notify || c.verifiedName;
      if (!jid || !name || isPhoneLikeName(name)) continue;
      rememberChatName(state, jid, name);
      contacts.push({ id: jid, name, avatar: null });
    }
    if (!contacts.length) return;
    await backend.postContacts(state.userId, contacts);
    logger.info({ userId: state.userId, count: contacts.length }, 'Uploaded contact names');
  }

  async _uploadGroups(state, groups) {
    const contacts = [];
    for (const g of groups || []) {
      const jid = toCUs(g.id || g.jid);
      const name = g.subject || g.name;
      if (!jid || !name || isPhoneLikeName(name)) continue;
      rememberChatName(state, jid, name);
      contacts.push({ id: jid, name, avatar: null });
    }
    if (!contacts.length) return;
    await backend.postContacts(state.userId, contacts);
    logger.info({ userId: state.userId, count: contacts.length }, 'Uploaded group names');
  }

  async _syncGroupNames(state) {
    if (!state.sock?.groupFetchAllParticipating) return;
    try {
      const groups = await state.sock.groupFetchAllParticipating();
      const list = Object.entries(groups || {}).map(([jid, meta]) => ({
        id: jid,
        jid,
        subject: meta?.subject,
        name: meta?.subject
      }));
      if (list.length) await this._uploadGroups(state, list);
      logger.info({ userId: state.userId, count: list.length }, 'Synced group names from WhatsApp');
    } catch (err) {
      logger.warn({ userId: state.userId, err: err.message }, 'groupFetchAllParticipating failed');
    }
  }

  async _syncChats(state) {
    try {
      const storeChats = state.sock?.store?.chats?.all?.() || [];
      if (storeChats.length) await this._uploadChats(state, storeChats);
    } catch (_) {}
  }

  async _refreshMonitored(state) {
    const monitored = await backend.getMonitored(state.userId);
    const next = new Set();
    state.monitoredMeta = state.monitoredMeta || new Map();

    if (!state.lastMessageAtByJid) {
      try {
        const raw = await backend.getLastMessageTimes(state.userId);
        state.lastMessageAtByJid = new Map();
        for (const [jid, ts] of raw.entries()) {
          const id = toCUs(jid);
          if (!id || !ts) continue;
          const prev = state.lastMessageAtByJid.get(id) || 0;
          if (ts > prev) state.lastMessageAtByJid.set(id, ts);
        }
        logger.info(
          { userId: state.userId, chats: state.lastMessageAtByJid.size },
          'Loaded last scraped message times for reconnect cursor'
        );
      } catch (err) {
        state.lastMessageAtByJid = new Map();
        logger.warn(
          { userId: state.userId, err: err.message },
          'Failed loading last scraped message times — new chats will use connect time'
        );
      }
    }

    for (const c of monitored || []) {
      const jid = toCUs(c.jid || c.id);
      if (!jid) continue;
      next.add(jid);
      const monitoredAtMs = c.monitored_at
        ? Date.parse(c.monitored_at)
        : c.created_at
          ? Date.parse(c.created_at)
          : null;
      const prev = state.monitoredMeta.get(jid);
      const fromDb = state.lastMessageAtByJid.get(jid) || state.lastMessageAtByJid.get(c.jid || '') || null;
      const lastMessageAtMs = prev?.lastMessageAtMs || fromDb || null;
      state.monitoredMeta.set(jid, {
        name: c.name || chatNameFrom(state.sock, jid, null, state),
        monitoredAtMs: Number.isFinite(monitoredAtMs) ? monitoredAtMs : Date.now(),
        lastMessageAtMs: Number.isFinite(lastMessageAtMs) ? lastMessageAtMs : null
      });
    }

    // Newly connected: catch up history after last saved message (fills outage gaps)
    const newlyMonitored = [];
    for (const jid of next) {
      if (!state.monitoredJids.has(jid) || !state.historySyncedJids.has(jid)) {
        if (!state.historySyncedJids.has(jid) && !state.historySyncing.has(jid)) {
          newlyMonitored.push(jid);
        }
      }
    }

    state.monitoredJids = next;
    logger.info(
      { userId: state.userId, count: next.size, forwardOnly: newlyMonitored.length },
      'Monitored chats refreshed'
    );

    for (const jid of newlyMonitored) {
      const chatName = state.monitoredMeta.get(jid)?.name;
      this._syncCatchUpHistory(state, jid, chatName).catch((err) => {
        logger.warn(
          { userId: state.userId, jid, err: err.message },
          'Catch-up history failed'
        );
      });
    }
  }

  /**
   * After connect/reconnect: page WhatsApp history backwards until the last
   * saved message (or connect time for new users). Posts only messages after that.
   */
  async _syncCatchUpHistory(state, jid, chatName) {
    if (!state.sock || state.historySyncing.has(jid) || state.historySyncedJids.has(jid)) return;
    state.historySyncing.add(jid);

    const meta = this._getMonitoredMeta(state, jid);
    const floorSec = this._scrapeFloorSec(state, meta);
    const maxRounds = Math.max(HISTORY_MAX_ROUNDS, 40);

    logger.info(
      { userId: state.userId, jid, chatName, floorSec },
      'Starting catch-up history from last scraped / connect time'
    );

    try {
      // Wait until WhatsApp has sent some messages for this chat (history or live).
      let oldest = this._oldestCached(state, jid);
      for (let i = 0; i < 20 && !oldest?.key?.id; i++) {
        await this.waitForHistoryBatch(state, 3000);
        oldest = this._oldestCached(state, jid);
      }

      const cached = this._cachedList(state, jid);
      if (cached.length) {
        await this._handleMessages(state, cached);
      }

      oldest = this._oldestCached(state, jid);
      if (!oldest?.key?.id) {
        logger.warn(
          { userId: state.userId, jid },
          'No seed message yet for catch-up — will retry on next monitor poll'
        );
        return;
      }

      for (let round = 0; round < maxRounds; round++) {
        oldest = this._oldestCached(state, jid);
        if (!oldest?.key?.id) break;
        const oldestSec = Number(oldest.messageTimestamp || 0);
        if (floorSec && oldestSec && oldestSec <= floorSec) {
          logger.info(
            { userId: state.userId, jid, oldestSec, floorSec, round },
            'Catch-up reached last scraped / connect time'
          );
          break;
        }

        const beforeCount = this._cachedList(state, jid).length;
        try {
          await state.sock.fetchMessageHistory(HISTORY_BATCH, oldest.key, oldestSec);
        } catch (err) {
          logger.warn(
            { userId: state.userId, jid, err: err.message, round },
            'fetchMessageHistory error'
          );
          return;
        }

        const gotBatch = await this.waitForHistoryBatch(state, 15000);
        const afterCount = this._cachedList(state, jid).length;
        const gained = afterCount - beforeCount;
        logger.info(
          { userId: state.userId, jid, round, gained, total: afterCount, gotBatch, oldestSec },
          'Catch-up history page fetched'
        );
        if (gained) {
          await this._handleMessages(state, this._cachedList(state, jid));
          await sleep(800);
          continue;
        }
        if (!gotBatch) {
          logger.warn(
            { userId: state.userId, jid, round },
            'Catch-up page timed out — will retry'
          );
          return;
        }
        break;
      }

      const finalCached = this._cachedList(state, jid);
      if (finalCached.length) {
        await this._handleMessages(state, finalCached);
      }

      oldest = this._oldestCached(state, jid);
      const oldestSec = Number(oldest?.messageTimestamp || 0);
      if (floorSec && oldestSec && oldestSec > floorSec) {
        logger.warn(
          { userId: state.userId, jid, oldestSec, floorSec },
          'Catch-up stopped before reaching last scraped time — will retry'
        );
        return;
      }

      state.historySyncedJids.add(jid);
      logger.info(
        { userId: state.userId, jid, chatName, totalCached: this._cachedList(state, jid).length },
        'Catch-up history complete'
      );
    } finally {
      state.historySyncing.delete(jid);
    }
  }

  /**
   * Pull older messages for a newly monitored chat and post them to backend.
   */
  async _syncFullHistory(state, jid, chatName) {
    return this._syncCatchUpHistory(state, jid, chatName);
  }

  _isMonitored(state, jid) {
    if (!jid) return false;
    if (state.monitoredJids.has(jid)) return true;
    const alias = state.jidAliases?.get(jid);
    if (alias && state.monitoredJids.has(alias)) return true;
    const bare = String(jid).split('@')[0];
    for (const m of state.monitoredJids) {
      if (String(m).split('@')[0] === bare) return true;
    }
    if (alias) {
      const aliasBare = String(alias).split('@')[0];
      for (const m of state.monitoredJids) {
        if (String(m).split('@')[0] === aliasBare) return true;
      }
    }
    return false;
  }

  _resolveMonitoredJid(state, jid) {
    if (!jid) return null;
    if (state.monitoredJids.has(jid)) return jid;
    const alias = state.jidAliases?.get(jid);
    if (alias && state.monitoredJids.has(alias)) return alias;
    const bare = String(jid).split('@')[0];
    for (const m of state.monitoredJids) {
      if (String(m).split('@')[0] === bare) return m;
    }
    if (alias) {
      const aliasBare = String(alias).split('@')[0];
      for (const m of state.monitoredJids) {
        if (String(m).split('@')[0] === aliasBare) return m;
      }
    }
    return null;
  }

  _getMonitoredMeta(state, jid) {
    const resolved = this._resolveMonitoredJid(state, jid) || jid;
    if (state.monitoredMeta?.has(resolved)) return state.monitoredMeta.get(resolved);
    if (state.monitoredMeta?.has(jid)) return state.monitoredMeta.get(jid);
    const bare = String(resolved || jid).split('@')[0];
    for (const [m, meta] of state.monitoredMeta || []) {
      if (String(m).split('@')[0] === bare) return meta;
    }
    return null;
  }

  /**
   * Returning user / reconnect: scrape strictly after the last saved message time.
   * New user / chat with no saved messages: scrape from WhatsApp connect time.
   */
  _scrapeFloorSec(state, meta) {
    const lastMs = meta?.lastMessageAtMs;
    if (lastMs) return Math.floor(lastMs / 1000);
    const connectedMs = state?.connectedAt ? Date.parse(state.connectedAt) : Date.now();
    return Number.isFinite(connectedMs) ? Math.floor(connectedMs / 1000) : Math.floor(Date.now() / 1000);
  }

  async _handleMessages(state, messages) {
    const byChat = new Map();
    const monitoredContacts = [];

    for (const msg of messages) {
      if (!msg?.message || msg.message.protocolMessage) continue;

      const key = msg.key || {};
      if (key.remoteJid && key.remoteJidAlt) {
        rememberJidAlias(state, toCUs(key.remoteJid), toCUs(key.remoteJidAlt));
      }

      const remoteJid = resolveMessageChatJid(msg);
      if (!remoteJid || isJidBroadcast(remoteJid) || remoteJid === 'status@broadcast') continue;

      // Hot path: ignore non-monitored chats entirely (no backend round-trips).
      if (!this._isMonitored(state, remoteJid)) continue;

      const monitoredJid = this._resolveMonitoredJid(state, remoteJid) || remoteJid;
      const epochSec = Number(msg.messageTimestamp || 0);
      const chatMeta = this._getMonitoredMeta(state, monitoredJid);
      const floorSec = this._scrapeFloorSec(state, chatMeta);
      if (floorSec != null && epochSec && epochSec <= floorSec) continue;

      const msgKey = key.id || `${monitoredJid}_${msg.messageTimestamp}`;
      if (state.seenMsgKeys.has(msgKey)) continue;
      state.seenMsgKeys.add(msgKey);
      if (state.seenMsgKeys.size > 8000) {
        state.seenMsgKeys = new Set(Array.from(state.seenMsgKeys).slice(-4000));
      }

      const text = extractText(msg);
      if (!String(text).trim()) continue;
      // Don't scrape common fillers (ok/hi/thanks/emoji-only/system notices)
      if (isCommonJunkMessage(text)) continue;

      // WhatsApp UI: right-side bubbles = mine, left-side = other person.
      // Baileys exposes this as msg.key.fromMe (true = out / right, false = in / left).
      const fromMe = key.fromMe === true;
      const epochSecFinal = epochSec || Math.floor(Date.now() / 1000);
      const ts = msg.messageTimestamp
        ? new Date(epochSecFinal * 1000).toISOString()
        : new Date().toISOString();

      const displayName = chatNameFrom(
        state.sock,
        monitoredJid,
        state.monitoredMeta?.get(monitoredJid)?.name,
        state
      );
      const sender = fromMe
        ? 'Me'
        : msg.pushName || displayName || monitoredJid.split('@')[0];

      if (displayName && !isPhoneLikeName(displayName)) {
        monitoredContacts.push({ id: monitoredJid, name: displayName, avatar: null });
      }

      if (!byChat.has(monitoredJid)) byChat.set(monitoredJid, []);
      byChat.get(monitoredJid).push({
        messageId: String(msgKey),
        keyId: String(msgKey),
        sender,
        timestamp: String(ts),
        message: String(text).trim(),
        fromMe,
        from_me: fromMe,
        messageEpoch: epochSecFinal
      });
    }

    // Post messages first — contacts must not block scraping.
    for (const [chatId, msgs] of byChat.entries()) {
      for (let i = 0; i < msgs.length; i += 100) {
        const slice = msgs.slice(i, i + 100);
        await backend.postMessages(state.userId, {
          chatId,
          chatName: chatNameFrom(state.sock, chatId, state.monitoredMeta?.get(chatId)?.name, state),
          messages: slice
        });
      }
      const meta = this._getMonitoredMeta(state, chatId);
      if (meta && msgs.length) {
        const maxEpoch = Math.max(...msgs.map((m) => Number(m.messageEpoch || 0)));
        if (maxEpoch > 0) {
          const ms = maxEpoch * 1000;
          meta.lastMessageAtMs = meta.lastMessageAtMs ? Math.max(meta.lastMessageAtMs, ms) : ms;
          if (state.lastMessageAtByJid) state.lastMessageAtByJid.set(chatId, meta.lastMessageAtMs);
        }
      }
      logger.info(
        { userId: state.userId, chatId, count: msgs.length },
        'Posted monitored messages'
      );
    }

    if (monitoredContacts.length) {
      const unique = [];
      const seen = new Set();
      for (const c of monitoredContacts) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        unique.push(c);
      }
      backend.postContacts(state.userId, unique).catch((err) => {
        logger.warn(
          { userId: state.userId, err: err.message },
          'Background contact upload failed'
        );
      });
    }
  }
}

module.exports = new SessionManager();
