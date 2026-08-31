# WhatsApp Multi-Tenant Scraper — Technical Architecture Document

**Document type:** Technical architecture & implementation overview (not a product requirements document)  
**Audience:** Client / technical stakeholders  
**Status:** Reflects the production architecture as implemented (AWS worker + Render backend + portal)  
**Last updated:** August 2026  

---

## 1. Executive summary

This system allows multiple portal users (clients) to **link their WhatsApp accounts** and **collect chat lists + messages** into a multi-tenant web application.

We **do not** open WhatsApp Web in Chrome, and we **do not** use browser extensions in production.

Instead, a dedicated **WhatsApp Worker** runs on **AWS EC2**. For each portal user, the worker opens a separate WhatsApp **multi-device session** using the open-source library **Baileys** (`@whiskeysockets/baileys`). That session behaves like a linked device (similar in concept to WhatsApp Desktop / WhatsApp Web), but it is a **server-side protocol client**, not a browser.

Scraped data is stored in **PostgreSQL** and exposed through a **Node.js / Express** backend on **Render**, with a React portal frontend.

---

## 2. High-level architecture

```
┌─────────────────────┐         ┌──────────────────────────────┐
│  Portal (React)     │  HTTPS  │  Backend API (Render)        │
│  - Login / JWT      │◄───────►│  - Auth, QR claim, chats     │
│  - QR screen        │ Socket  │  - Messages, monitor APIs    │
│  - Chat dashboard   │◄───────►│  - Socket.IO rooms           │
└─────────────────────┘         │  - PostgreSQL                │
                                └──────────────▲───────────────┘
                                               │ HTTPS (API key + user headers)
                                ┌──────────────┴───────────────┐
                                │  WhatsApp Worker (AWS EC2)   │
                                │  - Node.js + pm2             │
                                │  - SessionManager (Map)      │
                                │  - One Baileys socket / user │
                                │  - Auth files per user       │
                                └──────────────▲───────────────┘
                                               │ WhatsApp multi-device protocol
                                ┌──────────────┴───────────────┐
                                │  WhatsApp servers            │
                                │  (official WA infrastructure)│
                                └──────────────────────────────┘
```

### Component roles

| Component | Hosting | Responsibility |
|-----------|---------|----------------|
| Portal frontend | Client hosting / static app | Login, QR display, monitor chats, view scraped data |
| Backend API | Render (`scrapper-node-app.onrender.com`) | Auth, claims, persistence, realtime events |
| Database | Managed PostgreSQL | Users, chats, messages, link sessions, analysis tables |
| WhatsApp Worker | AWS EC2 | Open/maintain WhatsApp sessions, scrape, push data to backend |

---

## 3. Technology stack

### 3.1 WhatsApp Worker (AWS)

| Technology | Purpose |
|------------|---------|
| **Node.js 20+** | Runtime |
| **Express** | Small control API (`/health`, `/sessions/...`) |
| **@whiskeysockets/baileys** | WhatsApp multi-device WebSocket client (open sessions, QR, receive messages) |
| **qrcode** | Convert QR payload to data URL when needed |
| **pino** | Structured logging |
| **dotenv** | Environment configuration |
| **pm2** | Process manager (keepalive / restart on EC2) |
| **Filesystem auth state** | `useMultiFileAuthState` → `sessions/user_<id>/` |

**Recommended EC2 sizing (current guidance):**
- AMI: Ubuntu 22.04  
- Instance: `t3.medium` (2 vCPU / 4 GB) for a small number of concurrent clients  
- Disk: ~30 GB gp3 for OS + Node + session auth files  
- Process: single Node process hosting **many in-memory sessions**

### 3.2 Backend API (Render)

| Technology | Purpose |
|------------|---------|
| **Node.js + Express** | REST API |
| **PostgreSQL (`pg`)** | Primary datastore |
| **Socket.IO** | Realtime QR / connection / chat updates to portal |
| **JWT (`jsonwebtoken`)** | Portal authentication |
| **bcryptjs** | Password hashing |
| **cors / dotenv** | Cross-origin + config |

### 3.3 Portal frontend

| Technology | Purpose |
|------------|---------|
| **React** | UI |
| **Socket.IO client** | Live QR and connection status |
| REST calls to backend | Claim QR, list chats, monitor, delete, etc. |

### 3.4 What we intentionally do **not** use in production

- Chrome / Chromium automation (Puppeteer/Playwright) for WhatsApp Web  
- Browser extensions reading the WhatsApp Web DOM  
- Selenium-style UI scraping  

Those approaches are fragile (UI changes break scrapers) and harder to scale. The current design uses **protocol-level linked-device sessions**.

---

## 4. How WhatsApp sessions are opened on AWS

### 4.1 One portal user = one worker session

The worker keeps an in-memory map:

```text
sessions: Map<userId, SessionState>
```

Each `SessionState` contains:
- its own Baileys socket (`makeWASocket`)
- auth directory `sessions/user_<userId>/`
- connection status (`starting` / `qr` / `connected` / `reconnecting` / `error`)
- monitored chat JIDs
- message cache / dedupe keys
- reconnect timers

**Important:** “Multiple WhatsApps open at once” means **multiple Baileys sockets inside one Node process**, not multiple Chrome tabs.

### 4.2 Session start flow (end-to-end)

1. Portal user logs in and opens the WhatsApp connect page.  
2. Frontend calls backend `POST /api/qr/claim` for that `userId`.  
3. Backend stores/updates a row in `whatsapp_link_sessions` (`waiting` or already `linked`).  
4. Worker polls backend claims (default every ~5 seconds).  
5. For each claimed `userId`, worker calls `sessions.start(userId)`.  
6. Worker boots a Baileys socket with that user’s auth folder.  
7. If no saved credentials exist, WhatsApp issues a **QR**.  
8. Worker posts QR to backend (`/api/qr/...`).  
9. Backend emits Socket.IO events to that user’s room (`user_<id>`).  
10. Portal shows QR; client scans with WhatsApp mobile app → **Linked Devices**.  
11. On success, worker marks session connected and notifies backend (`linked`).  
12. Auth credentials are saved under `sessions/user_<id>/` so reconnects survive worker restarts.

### 4.3 Persistence & restore

- On EC2 reboot / pm2 restart, worker runs `restoreAll()`.  
- Any folder `sessions/user_<id>/` that contains valid `creds.json` is restored.  
- Empty/broken auth folders are skipped or cleared to avoid reconnect storms.  
- Logout / invalid session clears auth and resets claim to `waiting` so a fresh QR can be issued.

### 4.4 Sticky WhatsApp binding (tenant safety)

Each portal user can be permanently bound to the first successfully linked WhatsApp number (`bound_whatsapp_jid` / `bound_whatsapp_phone`).

If the same portal user later tries to link a **different** WhatsApp number, backend can reject with `409 WHATSAPP_BIND_MISMATCH`, and the worker logs out / clears that wrong session.

This prevents accidental (or intentional) switching of a tenant’s linked number after onboarding.

---

## 5. How scraping works (without extensions)

Scraping is **event-driven** from Baileys WhatsApp events, then filtered and stored.

### 5.1 Chat list sync

When a session connects, WhatsApp sends chat metadata via events such as:
- `messaging-history.set`
- `chats.upsert` / `chats.update`

Worker normalizes each chat to `{ id: jid, name }` and posts contacts/chats to the backend for that `userId`.

Result: portal can show the user’s chat list.

### 5.2 Monitored-chat filter (important product rule)

The worker does **not** continuously dump every message from every chat into long-term scraping storage by default.

It periodically fetches monitored chats from backend:

`GET /api/scraped-chats/monitored?userId=...`

Only JIDs in that monitored set have messages posted as scraped content.

### 5.3 Historical scrape (when a chat is newly monitored)

For each newly monitored chat, worker runs a history sync:
1. Flush any already-cached messages for that chat.  
2. Use Baileys `fetchMessageHistory(...)` to page backwards (batches of ~50).  
3. Incoming history batches arrive on `messaging-history.set`.  
4. Worker posts text messages to backend until configured limit (default ~500) or no more pages.

### 5.4 Live scrape (ongoing)

On `messages.upsert`:
1. Cache message.  
2. Ignore non-monitored chats.  
3. Deduplicate by WhatsApp message key.  
4. Extract text content + `fromMe` (outgoing vs incoming).  
5. POST to backend in chunks (`postMessages`).

### 5.5 What is extracted today

Typically text-bearing content:
- plain text  
- captions on media  
- related extended text fields  

Non-text media-only messages may be skipped by current extractors.

Each stored message includes roughly:
- `chat_jid`
- `sender`
- `timestamp`
- `message`
- `from_me`
- `user_id` (tenant)

---

## 6. Data model (conceptual)

Primary multi-tenant tables:

| Table | Purpose |
|-------|---------|
| `users` | Portal accounts; optional sticky WA bind fields |
| `whatsapp_link_sessions` | Claim/link state per user (`waiting` / `linked`) |
| `whatsapp_chats` | Chat list per user (`jid`, name, `is_monitored`) |
| `whatsapp_messages` | Scraped messages per user |
| `normalized_messages` / related AI tables | Downstream analysis (optional) |

Isolation principle: **every chat/message row is scoped by `user_id`**.

Additional APIs include monitor toggles and delete endpoints for selected messages/chats.

---

## 7. How the WhatsApp Worker works today (detailed)

### 7.1 Process model

- One Node process (`whatsapp-worker`) managed by pm2.  
- Internal HTTP server (default port `4100`) for health/control.  
- Protected by `WORKER_API_KEY` (`x-api-key`).  
- Outbound calls to Render backend with user scoping headers.

### 7.2 Claim polling loop

Every few seconds worker:
1. Reads active claims from backend.  
2. Starts sessions for claimed users (`waiting` or `linked`).  
3. Skips admin/`userId=1` as a WhatsApp client by policy.  
4. Stops sessions that no longer have claims (with safeguards for healthy connected sessions during transient claim gaps).

### 7.3 Connection lifecycle per user

```text
start(userId)
  → boot Baileys socket
  → QR? post QR to backend
  → open? mark linked, sync chats, refresh monitored set
  → close? reconnect with backoff OR clear auth if logged out
```

### 7.4 Why this scales better than extensions

| Extension model | Worker model |
|-----------------|--------------|
| Browser + WhatsApp Web UI | Protocol client |
| DOM selectors break often | Event APIs (`messages.upsert`, history fetch) |
| Hard to run many profiles headlessly | Many sockets in one process |
| Laptop-bound | Centralized on AWS |

---

## 8. Scaling to ~1,000 WhatsApp sessions — IP / ban risk (critical)

### 8.1 Direct answer

**Yes — putting ~1,000 WhatsApp linked sessions on a single AWS public IP is high risk and can trigger WhatsApp anti-abuse systems.**

WhatsApp does not need a special “scraper detector” unique to our code. From their side, they already see:

- many independent multi-device connections  
- coming from the **same IP / same cloud ASN (Amazon)**  
- often with similar client fingerprints (Baileys / linked-device patterns)  
- potentially abnormal volume of history sync / connection churn  

That pattern is commonly associated with spam, bulk automation, or account farming. WhatsApp can respond with:

- connection failures before/during QR  
- sudden disconnects  
- “logged out” / device removed  
- temporary or longer blocks on numbers or IP ranges  

So: **same-server, same-IP mass linking is a real ban/closure risk for client WhatsApp accounts.** This is one of the most important operational risks in the architecture.

### 8.2 What WhatsApp can observe

Even without us “notifying” them explicitly, each session is a normal connection to WhatsApp servers. At scale they can correlate:

| Signal | Risk if thousands share one EC2 IP |
|--------|------------------------------------|
| Source IP / ASN | Very high (datacenter IP concentration) |
| Concurrent linked devices from one IP | Very high |
| Repeated QR / reconnect storms | High |
| Aggressive history fetch patterns | Medium–high |
| Unofficial client fingerprints | Medium–high (Baileys is not an official WhatsApp Business API) |

### 8.3 Practical guidance

| Concurrent sessions on **one** public IP | Expected risk |
|------------------------------------------|---------------|
| Few (pilot / small team) | Manageable, still not zero (cloud IP risk exists) |
| Tens | Elevated; monitor disconnects carefully |
| Hundreds–1000 on one IP | **Not recommended** — ban/closure risk becomes likely |

### 8.4 Required direction if the product must support ~1,000 clients

To reduce correlation risk, architecture must evolve beyond “one EC2 IP for everyone”:

1. **IP isolation**
   - Prefer **residential / mobile proxy** or dedicated egress IP **per session or small session groups**
   - Avoid funneling all sockets out one AWS elastic IP
2. **Horizontal workers**
   - Multiple worker nodes across regions/providers
   - Shard users across workers (`userId` ranges / assignment table)
3. **Rate limiting & soft start**
   - Stagger QR starts, history sync, reconnects
   - Cap concurrent history pagination
4. **Health / ban detection**
   - Auto-pause users showing repeated auth failures
   - Alert ops before mass reconnect loops amplify risk
5. **Official API path (long-term compliance)**
   - For enterprise-grade legality/stability, evaluate **WhatsApp Cloud API / BSP** where use-case fits
   - Baileys-based linked-device automation is powerful but is **not** an officially supported WhatsApp business channel and carries ToS / enforcement risk

### 8.5 Honest product statement for client

> The current worker successfully supports multi-user WhatsApp linking and scraping on AWS for a controlled number of concurrent sessions.  
> Scaling to ~1,000 simultaneous WhatsApp connections from a **single AWS IP** is **not safe** from an anti-abuse perspective.  
> A production scale-out plan must include **egress IP isolation (proxies / multiple exit nodes)** and **sharded workers**, otherwise client numbers can be disconnected or restricted by WhatsApp.

---

## 9. Security posture & known gaps / vulnerabilities

This section is intentionally candid for client transparency and remediation planning.

### 9.1 Architectural / platform risks

| Item | Severity | Notes |
|------|----------|-------|
| Unofficial WhatsApp client (Baileys) | High (business/compliance) | Not WhatsApp-official; ToS and enforcement risk |
| Session auth files on disk | High | `creds.json` = account link secrets; disk compromise = session theft |
| Cloud IP reputation | High at scale | AWS IPs are more scrutinized than residential |
| Single worker host | Medium–High | Compromise of one box affects many linked sessions |

### 9.2 Application security gaps observed / residual risks

| Item | Severity | Detail / recommendation |
|------|----------|-------------------------|
| Worker control plane exposure | High if public | Port `4100` must not be open to the world; restrict SG to admin IP/VPN; keep strong `WORKER_API_KEY` |
| Default/weak secrets | High if unchanged | Ensure strong `WORKER_API_KEY`, `JWT_SECRET`, DB credentials in all envs |
| Tenant spoofing via headers | Medium–High | Backend historically accepted `x-user-id` / force headers for worker flows; must ensure untrusted clients cannot impersonate other tenants |
| Multi-tenant isolation bugs | High impact | Any missed `user_id` filter in queries = cross-tenant data leak |
| Socket room joining | Medium | Ensure users can only join their own `user_<id>` room |
| Auth credential backup | Medium | Session folders may be copied in AMI snapshots/backups without encryption controls |
| No hardware-backed secret store | Medium | Prefer KMS/Secrets Manager + encrypted volume for session store at scale |
| Delete/monitor APIs authorization | Medium | Must always enforce authenticated user scope server-side (never trust body `userId` alone) |
| Logging of message content | Low–Medium | Logs may contain PII; define retention + redaction |
| Dependency risk | Medium | Baileys/ecosystem changes can break linking overnight |

### 9.3 Data protection considerations

- Scraped chats are private communications; treat as sensitive personal data.  
- Define retention, export, and deletion policies (delete APIs exist for selected chats/messages).  
- Restrict who (admin vs client) can view which tenant data.  
- Encrypt in transit (HTTPS) everywhere; plan encryption at rest for DB + session volumes.

### 9.4 Recommended security hardening roadmap

1. Private networking between worker and backend (VPN / Tailscale / private ingress).  
2. Rotate and vault all secrets.  
3. Encrypt EC2 disks; restrict IAM; no public worker ports.  
4. Strict tenant authorization middleware on every read/write route.  
5. Audit logging for claim/link/monitor/delete actions.  
6. Proxy-per-session (or per small cohort) before large-scale rollout.  
7. Penetration test focused on tenant isolation and worker API.

---

## 10. Operational characteristics

### 10.1 Current operating model

- Worker always-on (pm2)  
- Backend always-on (Render)  
- Sessions restored from disk after restart  
- Monitored list refreshed on an interval  
- Reconnect with exponential/backoff style delays on disconnect  

### 10.2 Approximate infrastructure cost (ballpark)

For a small deployment (not 1,000 sessions):

| Item | Monthly ballpark |
|------|------------------|
| EC2 `t3.medium` + disk + light transfer | ~$35–45 |
| Render backend | ~$0–25 |
| Managed Postgres (small) | ~$0–15 |
| **Typical small total** | **~$40–80** |

At 1,000 sessions, cost is dominated not only by CPU/RAM, but by **proxy/IP isolation strategy** (often larger than the EC2 bill).

### 10.3 Capacity note

A single `t3.medium` is suitable for a **small** concurrent session count.  
1,000 concurrent Baileys sockets generally requires **multiple larger workers**, careful memory planning, and IP sharding — not one small instance.

---

## 11. End-to-end user journey (as implemented)

1. Client logs into portal.  
2. Portal claims QR session for that user.  
3. Worker starts Baileys session for that user on AWS.  
4. QR appears in portal; client scans on phone.  
5. WhatsApp marks device linked; worker persists credentials.  
6. Chat list appears in portal.  
7. Client selects chats to monitor.  
8. Worker syncs history + continues live message ingestion.  
9. Messages appear in portal DB views / dashboards.  
10. Client can delete selected messages/chats via delete API.  

---

## 12. Key libraries & protocols (reference)

### Worker
- `@whiskeysockets/baileys` — WhatsApp multi-device protocol client  
- `useMultiFileAuthState` — persist Signal/WhatsApp auth keys to disk  
- `makeWASocket` — open one socket per tenant  
- Events used: `connection.update`, `creds.update`, `messaging-history.set`, `chats.upsert`, `chats.update`, `messages.upsert`  
- History API: `fetchMessageHistory`

### Backend
- Express routes for QR claim/status, scraped chats/messages, monitor, delete  
- Socket.IO rooms `user_<id>` for realtime UX  
- PostgreSQL uniqueness constraints for chats/messages per user  

---

## 13. Conclusions

1. **How we open WhatsApp on AWS:** one Baileys linked-device session per portal user inside a Node worker on EC2, with per-user auth folders and claim-driven auto-start.  
2. **How we scrape:** protocol events + monitored-chat filter + history pagination + live upserts; **no Chrome extensions** in production.  
3. **Tech stack:** Node.js, Baileys, Express, PostgreSQL, Socket.IO, React, pm2, AWS EC2, Render.  
4. **Scale warning:** ~1,000 WhatsApps on **one AWS IP** is **likely to attract WhatsApp anti-abuse actions**; client numbers can be disconnected/restricted. Scale-out requires **IP isolation + sharded workers**.  
5. **Security:** functional multi-tenant architecture exists, but production hardening (secrets, private networking, encrypted session storage, strict tenant auth, proxy strategy) should be treated as mandatory before large-scale commercial rollout.

---

## 14. Appendix — glossary

| Term | Meaning |
|------|---------|
| **JID** | WhatsApp identifier for a chat/user (e.g. `number@s.whatsapp.net`, group `@g.us`) |
| **Baileys** | Open-source WhatsApp multi-device client library |
| **Claim** | Backend reservation that a portal `userId` should have an active worker session |
| **Monitored chat** | Chat selected by client for message scraping |
| **Linked device** | Phone-authorized companion session (worker acts as one) |
| **Sticky bind** | Portal user permanently associated with first linked WhatsApp number |

---

*This document describes the implemented technical system and known risks for planning, client communication, and scale/security roadmap decisions.*
