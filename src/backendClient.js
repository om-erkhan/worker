const config = require('./config');

async function request(method, route, { userId, body, timeoutMs = 15000 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (userId != null) {
    headers['x-user-id'] = String(userId);
    // Worker owns the userId — do not remap via portal "active claim"
    headers['x-force-user-id'] = '1';
    headers['x-wa-worker'] = '1';
  }

  const res = await fetch(`${config.backendApiUrl}${route}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });

  let json = null;
  try {
    json = await res.json();
  } catch (_) {}

  if (!res.ok) {
    const msg = json?.message || `${res.status} ${res.statusText}`;
    const err = new Error(`Backend ${method} ${route} failed: ${msg}`);
    err.status = res.status;
    err.body = json?.data || json;
    err.code = json?.data?.code || json?.code;
    throw err;
  }
  return json;
}

module.exports = {
  postQr(userId, url) {
    return request('POST', '/api/qr', {
      userId,
      timeoutMs: 60000,
      body: { url, source: 'whatsapp-worker', pageUrl: 'worker', userId, user_id: userId }
    });
  },

  postQrStatus(userId, message = 'WhatsApp linked / QR disappeared', whatsappJid = null) {
    return request('POST', '/api/qr/status', {
      userId,
      timeoutMs: 30000,
      body: {
        status: 'disappeared',
        message,
        userId,
        user_id: userId,
        whatsappJid: whatsappJid || undefined,
        whatsapp_jid: whatsappJid || undefined
      }
    });
  },

  postContacts(userId, contacts) {
    return request('POST', '/api/scraped-chats/contacts', {
      userId,
      timeoutMs: 20000,
      body: { userId, contacts }
    });
  },

  postMessages(userId, { chatId, chatName, messages }) {
    return request('POST', '/api/scraped-chats/messages', {
      userId,
      timeoutMs: 25000,
      body: { userId, chatId, jid: chatId, chatName, name: chatName, messages }
    });
  },

  async getMonitored(userId) {
    const json = await request('GET', `/api/scraped-chats/monitored?userId=${userId}`, {
      userId,
      timeoutMs: 12000
    });
    return Array.isArray(json?.data) ? json.data : [];
  },

  async getClaimSessions() {
    try {
      const json = await request('GET', '/api/qr/sessions?worker=1', { timeoutMs: 20000 });
      return Array.isArray(json?.data) ? json.data : [];
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
  },

  resetClaimToWaiting(userId) {
    return request('POST', '/api/qr/reset-waiting', {
      userId,
      body: { userId, user_id: userId }
    });
  },

  pauseScraping(userId) {
    return request('POST', '/api/scraped-chats/pause-scraping', {
      userId,
      body: { userId, user_id: userId }
    });
  }
};
