# WhatsApp Worker (Production & AWS Scaling Guide)

Multi-session WhatsApp worker that replaces Chrome extensions.  
Each client `userId` gets its own WhatsApp session on your AWS server.

---

## 1. What it does
1. Portal user calls `POST /api/qr/claim` with their `userId`
2. Worker auto-starts that user's WhatsApp session immediately
3. QR is posted to your Render backend → shown on portal
4. Client scans → worker marks linked + scrapes chats/messages
5. Contacts go to dashboard; monitored chats sync messages
6. Sessions persist in `./sessions/user_<id>/` (survive restarts)

---

## 2. Local Setup

```bash
cd ~/Downloads/whatsapp-worker
cp .env.example .env
# Edit .env — set WORKER_API_KEY and optional PROXY_URLS
npm install
npm start
```

Health check: `http://localhost:4100/health`

Manual start session:
```bash
curl -X POST http://localhost:4100/sessions/3/start \
  -H "x-api-key: YOUR_WORKER_API_KEY"
```

---

## 3. Resolving Message Duplication (Backend SQL Setup)

To guarantee that restarted workers or re-sent history batches never duplicate messages in your PostgreSQL / MySQL database, run this SQL migration on your backend database:

```sql
-- Ensure unique constraint per message key
ALTER TABLE messages 
ADD CONSTRAINT unique_user_chat_message_id UNIQUE (user_id, chat_id, message_id);
```

When storing messages in your backend route (`POST /api/scraped-chats/messages`), use `ON CONFLICT`:
```sql
INSERT INTO messages (user_id, chat_id, message_id, sender, message, timestamp)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (user_id, chat_id, message_id) DO NOTHING;
```

---

## 4. Preventing AWS IP Blocking (Proxy Configuration)

WhatsApp/Meta blocks or throttles Noise protocol handshakes from AWS EC2 IP blocks when multiple sessions connect from one IP.

Add SOCKS5 or HTTP proxies to `.env`:
```env
PROXY_URLS=http://user:pass@proxy-node-1.com:8080,socks5://user:pass@proxy-node-2.com:1080
```
The worker automatically round-robins available proxies per user session.

---

## 5. Architecture & Scaling Plan for 100 Users

Running 100 WhatsApp WebSockets inside a single Node process on one IP will cause memory exhaustion and IP bans.

### Cluster Architecture

```
                          ┌─────────────────────────┐
                          │   Render Backend API    │
                          └────────────┬────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
┌──────────────────┐         ┌──────────────────┐           ┌──────────────────┐
│ EC2 Worker Node 1│         │ EC2 Worker Node 2│    ...    │ EC2 Worker Node 4│
│ (25 Sessions)    │         │ (25 Sessions)    │           │ (25 Sessions)    │
│ Port 4100        │         │ Port 4100        │           │ Port 4100        │
└──────────────────┘         └──────────────────┘           └──────────────────┘
```

### Specifications:
* **Instances**: 4 × EC2 `t3.medium` (2 vCPU, 4 GB RAM)
* **Sessions Capacity**: ~25 WhatsApp sessions per instance
* **Storage**: 30 GB gp3 per instance
* **Proxy Allocation**: Assign distinct proxy subnets per node

---

## 6. AWS Deploy Steps (Single Node / Multi Node)

### 1) Create EC2 Instance
- AMI: **Ubuntu 22.04 LTS**
- Type: **t3.medium** (2 vCPU / 4 GB)
- Storage: **30 GB** gp3
- Security Group:
  - SSH `22` (restricted to your IP)
  - Custom TCP `4100` (internal or restricted)

### 2) Install Node 20 & PM2 on EC2

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm i -g pm2
```

### 3) Upload & Configure Code

```bash
cd ~/
git clone <your-repo-url> whatsapp-worker # or scp from local machine
cd whatsapp-worker
cp .env.example .env
nano .env
```

Set environment options in `.env`:
```env
BACKEND_API_URL=https://watsapp-web-backend.onrender.com
WORKER_PORT=4100
WORKER_API_KEY=your-secure-api-key
SESSIONS_DIR=./sessions
AUTO_START_FROM_CLAIMS=true
CLAIM_POLL_MS=5000
MAX_WAITING_STARTS=5
PROXY_URLS=socks5://proxy-user:proxy-pass@proxy-server:1080
```

### 4) Start Worker with PM2

```bash
npm install
mkdir -p sessions
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

---

## 7. Verification Checklist

- [ ] Worker health check responds: `curl http://127.0.0.1:4100/health`
- [ ] Backend database has `UNIQUE(user_id, chat_id, message_id)` constraint
- [ ] QR code appears within 2–5 seconds when user hits claim page
- [ ] Session reconnects automatically after EC2 reboot
- [ ] WhatsApp Web connection succeeds through configured proxies
