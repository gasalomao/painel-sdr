# syntax=docker/dockerfile:1.6
# =============================================================================
#  Painel SDR — Dockerfile multi-stage otimizado para Debian Bookworm
# =============================================================================

# ===== STAGE 1: Dependencies =============================================
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ===== STAGE 2: Builder ==================================================
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

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

RUN npm run build
RUN npm prune --omit=dev

# ===== STAGE 3: Runner ===================================================
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ARG WHISPER_MODEL=ggml-small.bin

# Instala Chromium + dependências de fonte/render + ffmpeg + curl + tar no Debian
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    libnss3 \
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
    libasound2 \
    ffmpeg \
    curl \
    tar \
    ca-certificates \
    fonts-freefont-otf \
    fonts-noto-color-emoji \
    procps \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 -g nodejs nextjs

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    WHISPER_MODEL=${WHISPER_MODEL}

COPY --from=builder --chown=nextjs:nodejs /app/public           ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static     ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/node_modules     ./node_modules

RUN mkdir -p /app/.gateway-proxy && chown -R nextjs:nodejs /app/.gateway-proxy
RUN mkdir -p /app/.deepseek-chat && chown -R nextjs:nodejs /app/.deepseek-chat

# Whisper.cpp (transcrição de áudio GRATUITA, sem API):
# Baixa o binário oficial do Ubuntu/Debian (glibc nativo, roda direto no Debian slim)
# Baixa o modelo direto do HuggingFace durante o build.
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
