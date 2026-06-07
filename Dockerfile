# Lightweight Node 20 base — no browser binaries needed.
# Crawling is delegated to ScrapFly via HTTP, so the server only needs Node.
FROM node:20-bookworm-slim

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/
COPY public/ ./public/

# Railway injects PORT automatically; default to 3000
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/server.js"]
