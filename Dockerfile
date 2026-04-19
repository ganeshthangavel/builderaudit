# Use the official Playwright image — has Chromium + all OS deps pre-installed
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json ./
RUN npm install --production

# Copy source
COPY src/ ./src/
COPY public/ ./public/
COPY audit.js ./

# Railway injects PORT automatically; default to 3000
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/server.js"]
