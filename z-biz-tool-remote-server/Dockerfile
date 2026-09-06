# Multi-stage build for tiny production image.
# Final image: ~50MB (alpine + node 20 + ws only).

# ---- deps stage: install prod deps ----
FROM node:20-alpine AS deps
WORKDIR /app
# Install only production deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app
# Run as non-root
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./
COPY --chown=app:app src ./src
USER app

# Generate default token if user doesn't supply one (warning at runtime)
ENV HOST=0.0.0.0 \
    PORT=8080 \
    LOG_LEVEL=info \
    NODE_ENV=production

# Tiny healthcheck against /healthz (200 OK, JSON {"ok":true})
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz | grep -q '"ok":true' || exit 1

EXPOSE 8080

# Use tini for proper signal forwarding (SIGTERM → graceful shutdown)
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
