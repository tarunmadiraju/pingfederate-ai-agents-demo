# syntax=docker/dockerfile:1
# Workforce Portal Dockerfile
# Express server behind PingAccess

FROM node:22-alpine

WORKDIR /app

# Install dependencies (BuildKit cache keeps ~/.npm across rebuilds)
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Copy server and tracing bootstrap
COPY server.js tracing.cjs ./
COPY lib/ ./lib/

# Copy static frontend into public/
COPY index.html graph.html ./public/
COPY landing.html ./public/
COPY js/ ./public/js/
COPY authenticator-app/ ./public/authenticator-app/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
