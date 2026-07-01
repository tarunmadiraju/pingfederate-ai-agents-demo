# syntax=docker/dockerfile:1
FROM node:20-alpine

# Create non-root user before COPY so --chown is available.
# node_modules is installed as root but world-readable (755/644) — no chown needed.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

COPY package*.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

COPY --chown=nodejs:nodejs src/ ./src/

USER nodejs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

CMD ["node", "src/index.js"]
