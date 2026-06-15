# syntax=docker/dockerfile:1.6
# =============================================================================
#  Painel SDR — Dockerfile multi-stage otimizado para Easypanel
#  - Stage 1 (deps):    instala TODAS as deps (incluindo dev) p/ build
#  - Stage 2 (builder): roda `next build` em modo standalone
#  - Stage 3 (runner):  imagem final mínima com Chromium + standalone server.js
# =============================================================================

# ===== STAGE 1: Dependencies =============================================
FROM node:20-alpine AS deps
WORKDIR /app
# libc6-compat ajuda algumas libs nativas (sharp etc.) a rodarem no alpine.
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
# `npm ci` é determinístico (usa o lockfile).
# BuildKit cache acelera rebuilds quando não mexeu nos deps.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ===== STAGE 2: Builder ==================================================
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# ----- Build args (variáveis NEXT_PUBLIC_* viram código no JS do cliente) -----
# Easypanel injeta estes valores via "Build Args" se você setar lá.
# Se NÃO setar, caem nos defaults abaixo (que apontam pra produção).
ARG NEXT_PUBLIC_SUPABASE_URL=https://sistema-supabase.ridnii.easypanel.host
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE
ARG NEXT_PUBLIC_APP_URL=https://sistema-sdr.ridnii.easypanel.host
ARG SUPABASE_SERVICE_ROLE_KEY=

ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=4096

# scripts/build-setup-sql.mjs roda dentro do `npm run build` e gera o setup-sql.ts.
# 4 GB de heap pro Node — o type-checker do Next 16 (Turbopack) consome ~2 GB
# por worker e o default de 1.4 GB derruba o build com OOM.
RUN npm run build

# Remove devDependencies do node_modules pra deixar a imagem final mais magra.
# Mantém produção + os pacotes externos (puppeteer-core etc.) que o
# next.config.ts marca como serverExternalPackages.
RUN npm prune --omit=dev

# ===== STAGE 3: Runner ===================================================
FROM node:20-alpine AS runner
WORKDIR /app

# Chromium + libs de fonte/encoding pra Puppeteer (scraper Google Maps).
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont font-noto-emoji
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Copia apenas o que o standalone precisa pra rodar.
COPY --from=builder --chown=nextjs:nodejs /app/public           ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static     ./.next/static
# node_modules de produção (inclui pacotes externos não-bundleados pelo Next).
COPY --from=builder --chown=nextjs:nodejs /app/node_modules     ./node_modules

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
