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
# Defaults vazios — Easypanel preenche via Build Args.
ARG NEXT_PUBLIC_SUPABASE_URL=
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=
ARG NEXT_PUBLIC_APP_URL=
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

# Build arg: qual modelo whisper pré-baixar no container.
# Default: ggml-small.bin (465MB, bom PT). Para melhor qualidade: ggml-medium.bin (1.46GB).
# No Easypanel: setar como Build Arg E Environment Variable com o mesmo valor.
ARG WHISPER_MODEL=ggml-small.bin

# Chromium + libs de fonte/encoding pra Puppeteer (scraper Google Maps).
# tar + libc6-compat: o conector embutido (1 clique) extrai e roda o binário do
# CLIProxyAPI — tar garante a extração do .tar.gz e libc6-compat a execução.
# ffmpeg: conversão ogg→wav16k exigida pelo whisper.cpp (transcrição grátis).
# libc6-compat também roda o binário whisper-bin-ubuntu-x64 no Alpine.
# curl: usado pra pré-baixar o modelo whisper durante o build.
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont font-noto-emoji tar libc6-compat ffmpeg curl
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    WHISPER_MODEL=${WHISPER_MODEL}

# Copia apenas o que o standalone precisa pra rodar.
COPY --from=builder --chown=nextjs:nodejs /app/public           ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static     ./.next/static
# node_modules de produção (inclui pacotes externos não-bundleados pelo Next).
COPY --from=builder --chown=nextjs:nodejs /app/node_modules     ./node_modules

# Conector embutido (1 clique) grava aqui: binário do CLIProxyAPI, config,
# management.key e logins (auths/). Como o app roda como `nextjs` (não-root) e
# /app pertence ao root, sem este chown o mkdir falha com EACCES.
# Monte um VOLUME nesta pasta no Easypanel pra os logins sobreviverem a deploys.
RUN mkdir -p /app/.gateway-proxy && chown -R nextjs:nodejs /app/.gateway-proxy

# DeepSeek "modo conta" grava aqui: tokens (userToken capturado) + subscriptions
# (userscript Tampermonkey). Mesma razão do .gateway-proxy acima: sem permissão,
# o save falha com EACCES em runtime (app roda como nextjs, /app é do root).
# Foi o mesmo bug corrigido em 6433bb5 pro conector — agora aplicado pro DeepSeek.
# Monte um VOLUME aqui no Easypanel pra os tokens sobreviverem a deploys.
RUN mkdir -p /app/.deepseek-chat && chown -R nextjs:nodejs /app/.deepseek-chat

# Whisper.cpp (transcrição de áudio GRATUITA, sem API):
# 1) Baixa o binário whisper-cli (Linux x64, ~poucos MB) do release oficial v1.8.7
# 2) Baixa o modelo definido em WHISPER_MODEL (default ggml-small.bin, 465MB)
# Tudo durante o BUILD — o container sobe pronto, sem download em runtime.
# Se trocar WHISPER_MODEL, rebuild a imagem pra baixar o modelo novo.
# Modelo tamanho varia: base 148MB, small 465MB, medium 1.46GB.
# Monte um VOLUME opcional em /app/.whisper se quiser persistir entre deploys
# (mas se já vem na imagem, só precisa de volume se planeja trocar modelo sem rebuild).
RUN mkdir -p /app/.whisper/bin && \
    cd /app/.whisper && \
    curl -fsSL -o whisper-bin.tar.gz \
      "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.7/whisper-bin-ubuntu-x64.tar.gz" && \
    tar -xzf whisper-bin.tar.gz -C /app/.whisper/bin && \
    rm whisper-bin.tar.gz && \
    BIN=$(find /app/.whisper/bin -name "whisper-cli" -type f | head -1) && \
    if [ -n "$BIN" ]; then chmod 755 "$BIN"; echo "$BIN" > /app/.whisper/bin-path.txt; fi && \
    curl -fsSL -o "/app/.whisper/${WHISPER_MODEL}" \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL}" && \
    chown -R nextjs:nodejs /app/.whisper

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
