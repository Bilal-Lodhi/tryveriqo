# ─────────────────────────────────────────────────────────────────────────────
# tryveriqo API + MCP tool server — multi-stage production image
#
# Stage 1 compiles both TypeScript workspaces.
# Stage 2 is a slim, non-root runtime that starts the HTTP MCP transport and
# the API together via a dumb-init supervised entrypoint.
# ─────────────────────────────────────────────────────────────────────────────

# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 1 — BUILD
# ═══════════════════════════════════════════════════════════════════════════════
FROM node:22-alpine AS builder

WORKDIR /app

# Workspace manifests first so the dependency layer caches independently of src.
COPY package.json package-lock.json ./
COPY packages/mcp-mongodb/package.json ./packages/mcp-mongodb/
COPY apps/api/package.json ./apps/api/
COPY packages/mcp-mongodb/tsconfig.json ./packages/mcp-mongodb/
COPY apps/api/tsconfig.json ./apps/api/
COPY tsconfig.json ./

RUN npm ci --ignore-scripts

COPY packages/mcp-mongodb/src ./packages/mcp-mongodb/src
COPY apps/api/src ./apps/api/src

RUN npm run build

# Fail the build rather than ship a half-compiled image.
RUN test -f packages/mcp-mongodb/dist/index.js
RUN test -f packages/mcp-mongodb/dist/http-server.js
RUN test -f apps/api/dist/index.js

# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 2 — RUNTIME
# ═══════════════════════════════════════════════════════════════════════════════
FROM node:22-alpine AS runtime

RUN apk add --no-cache dumb-init curl \
    && rm -rf /var/cache/apk/*

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app
RUN chown -R appuser:appgroup /app

COPY --from=builder --chown=appuser:appgroup /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=appuser:appgroup /app/packages/mcp-mongodb/package.json ./packages/mcp-mongodb/
COPY --from=builder --chown=appuser:appgroup /app/apps/api/package.json ./apps/api/

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder --chown=appuser:appgroup /app/packages/mcp-mongodb/dist ./packages/mcp-mongodb/dist
COPY --from=builder --chown=appuser:appgroup /app/apps/api/dist ./apps/api/dist

COPY --chown=appuser:appgroup scripts/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER appuser

ENV NODE_ENV=production
ENV ENVIRONMENT=production
ENV PORT=8080
ENV MCP_PORT=3001

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -sf "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["/bin/sh", "./entrypoint.sh"]
