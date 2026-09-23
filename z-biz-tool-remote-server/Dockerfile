# Multi-stage build for tiny production image.
# Final image: ~50MB (alpine + node 20 + ws only).

# ---- deps stage: install prod deps ----
FROM node:20-alpine AS deps
WORKDIR /app
# Install only production deps.
# 用 install 不用 ci：这个包没有 package-lock.json，`npm ci` 没有锁文件会直接报错退出。
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ---- runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app
# Run as non-root
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./
# 代码是平铺的（server.js / auth.js / storage.js / logger.js 就在包根），不是 src/ 布局：
# 原来这行 COPY src ./src 让构建在第一步就失败（"/src": not found），镜像从来没建出来过。
COPY --chown=app:app *.js ./
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
CMD ["node", "server.js"]
