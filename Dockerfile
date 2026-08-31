FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY .env.example ./

RUN mkdir -p /app/sessions

ENV NODE_ENV=production
ENV SESSIONS_DIR=/app/sessions
EXPOSE 4100

CMD ["node", "src/index.js"]
