# Multi-stage Dockerfile for apps/api on Cloud Run.
#
# Build context MUST be the monorepo root (`docker build -f apps/api/Dockerfile .`)
# because pnpm workspaces need access to the root pnpm-workspace.yaml +
# all package.json files to resolve dependencies.
#
# Stages:
#   1. builder — full pnpm install + tsc build of apps/api + packages/shared-types
#   2. runtime — slim Node, only the compiled dist + production deps, non-root user
#
# Final image ~250 MB.

# ─── Builder ─────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /repo

# pnpm via corepack — pinned via packageManager in package.json.
RUN corepack enable

# Copy workspace manifest + lockfile first so dependency resolution can
# be cached when only source files change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/api/package.json apps/api/

# Frozen install — fails if lockfile is out of date (CI safety).
RUN pnpm install --frozen-lockfile

# Copy source for the two packages we actually build.
COPY packages/shared-types packages/shared-types
COPY apps/api apps/api

# Build shared-types first (api depends on it), then api.
RUN pnpm --filter @reviewarena/shared-types build \
 && pnpm --filter @reviewarena/api build

# ─── Runtime ─────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

WORKDIR /repo

# Same pnpm setup so we can prune dev deps in this stage.
RUN corepack enable

# Copy workspace manifest + lockfile + compiled output + node_modules
# from the builder. We re-run `pnpm install --prod` to drop devDeps and
# shrink the image, then copy in the dist directories.
COPY --from=builder /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=builder /repo/packages/shared-types/package.json packages/shared-types/
COPY --from=builder /repo/apps/api/package.json apps/api/

RUN pnpm install --frozen-lockfile --prod \
 && pnpm store prune

# Bring in the compiled JavaScript + Drizzle migration SQL files.
COPY --from=builder /repo/packages/shared-types/dist packages/shared-types/dist
COPY --from=builder /repo/apps/api/dist apps/api/dist
COPY --from=builder /repo/apps/api/drizzle apps/api/drizzle
COPY --from=builder /repo/apps/api/drizzle.config.ts apps/api/

# Non-root user — drops blast radius if the container is ever compromised.
# Cloud Run honours USER directives in containers.
RUN useradd --create-home --uid 10001 reviewarena
USER reviewarena

# Cloud Run injects $PORT (default 8080); Express reads it via config.ts → API_PORT.
ENV NODE_ENV=production
ENV API_PORT=8080
EXPOSE 8080

WORKDIR /repo/apps/api
CMD ["node", "dist/server.js"]
