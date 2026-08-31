# WhatsApp Worker (Production)

Multi-session WhatsApp worker that replaces Chrome extensions.  
Each client `userId` gets its own WhatsApp session on your AWS server.

## What it does
1. Portal user calls `POST /api/qr/claim` with their `userId`
2. Worker auto-starts that user's WhatsApp session
3. QR is posted to your Render backend → shown on portal
4. Client scans → worker marks linked + scrapes chats/messages
5. Contacts go to dashboard; monitored chats sync messages
6. Sessions persist in `./sessions/user_<id>/` (survive restarts)

## Local setup

```bash
cd ~/Downloads/whatsapp-worker
cp .env.example .env
# edit .env — set WORKER_API_KEY to a long random string
npm install
npm start
```

Health check: `http://localhost:4100/health`

Manual start session:

```bash
curl -X POST http://localhost:4100/sessions/3/start \
  -H "x-api-key: YOUR_WORKER_API_KEY"
```

## Frontend requirement (important)

When client opens the WhatsApp QR page after login:

```js
await fetch("https://scrapper-node-app.onrender.com/api/qr/claim", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "x-user-id": String(user.id)
  },
  body: JSON.stringify({ userId: user.id })
});

socket.emit("join_user_room", { userId: user.id });
// listen: new_qr, qr_disappeared
```

Worker will auto-detect the claim and start that session.

---

## AWS deploy steps (EC2)

### 1) Create EC2
- AMI: **Ubuntu 22.04**
- Type: **t3.medium** (2 vCPU / 4 GB) for ~4 clients
- Storage: **30 GB** gp3
- Security group:
  - SSH `22` from your IP only
  - Custom TCP `4100` from your IP (or private only if using tunnel)

### 2) SSH in

```bash
ssh -i your-key.pem ubuntu@YOUR_EC2_PUBLIC_IP
```

### 3) Install Node 20 + pm2

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm i -g pm2
node -v
```

### 4) Upload worker code

From your Mac:

```bash
scp -i your-key.pem -r ~/Downloads/whatsapp-worker ubuntu@YOUR_EC2_PUBLIC_IP:~/
```

Or clone from git if you push this folder to GitHub.

### 5) Configure env on server

```bash
cd ~/whatsapp-worker
cp .env.example .env
nano .env
```

Set at least:

```env
BACKEND_API_URL=https://scrapper-node-app.onrender.com
WORKER_PORT=4100
WORKER_API_KEY=put-a-long-random-secret-here
SESSIONS_DIR=./sessions
AUTO_START_FROM_CLAIMS=true
```

### 6) Install + start with pm2

```bash
cd ~/whatsapp-worker
npm install
mkdir -p sessions
pm2 start ecosystem.config.js
pm2 save
pm2 startup
# run the command pm2 prints
pm2 status
pm2 logs whatsapp-worker
```

### 7) Test

```bash
curl http://127.0.0.1:4100/health
curl -H "x-api-key: YOUR_WORKER_API_KEY" http://127.0.0.1:4100/sessions
```

Then from portal: login as client → claim → QR should appear → scan on phone.

### 8) (Optional) Docker instead of pm2

```bash
cd ~/whatsapp-worker
docker build -t whatsapp-worker .
docker run -d --name whatsapp-worker \
  --restart unless-stopped \
  -p 4100:4100 \
  -v $(pwd)/sessions:/app/sessions \
  --env-file .env \
  whatsapp-worker
```

---

## After deploy checklist
- [ ] Push latest backend to Render (claim + multi-session APIs)
- [ ] Frontend calls `/api/qr/claim` on QR page
- [ ] Worker running on EC2 (`pm2 status` online)
- [ ] Test 2 clients separately (different userIds)
- [ ] Reboot EC2 once and confirm sessions restore

## Stop using in production
- Laptop WhatsApp Web
- QR2API Chrome extension
- WhatsApp Scraper Chrome extension
