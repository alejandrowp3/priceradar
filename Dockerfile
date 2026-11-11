# syntax=docker/dockerfile:1
# PriceRadar P5 — Cloud-First Multi-Stage Container Image
# Fully reproducible remote cloud build for Railway, Render, and cloud container platforms.
# Zero local Docker installation required.

# -----------------------------------------------------------------------------
# Base Image: Node 24 with Playwright Chromium dependencies pre-installed
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install required system libraries for headless Chromium and corepack
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

WORKDIR /app

# -----------------------------------------------------------------------------
# Build Stage: Install dependencies, download Chromium, and compile packages & Next.js
# -----------------------------------------------------------------------------
FROM base AS builder

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/config/package.json ./packages/config/
COPY packages/domain/package.json ./packages/domain/
COPY packages/database/package.json ./packages/database/
COPY packages/providers/package.json ./packages/providers/
COPY packages/ui/package.json ./packages/ui/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/

RUN pnpm install --frozen-lockfile

# F7-04: Install Playwright Chromium in cloud container build
RUN npx playwright install chromium

COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

# Build workspace packages and Next.js production bundle
RUN pnpm build

# -----------------------------------------------------------------------------
# Production Runner Stage: Lightweight execution container
# -----------------------------------------------------------------------------
FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PRICERADAR_ENV=cloud
ENV PRICERADAR_SQLITE_PATH=/data/private-history.sqlite
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PORT=4178
ENV HOST=0.0.0.0

# Create persistent storage mount directory
RUN mkdir -p /data /ms-playwright

# Copy installed Chromium browser binaries (F7-04)
COPY --from=builder /ms-playwright /ms-playwright

# Copy compiled application code and workspace
COPY --from=builder /app /app

VOLUME ["/data"]

EXPOSE 4178

# Cloud entrypoint initializes CloudScheduler and Next.js Web Dashboard
CMD ["node", "--experimental-strip-types", "apps/worker/src/cloud-entrypoint.ts"]
