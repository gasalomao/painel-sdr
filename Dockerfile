# syntax=docker/dockerfile:1.6
# =============================================================================
#  Painel SDR — Dockerfile multi-stage otimizado para Debian Bookworm
# =============================================================================

# ===== STAGE 1: Dependencies =============================================
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ===== STAGE 2: Builder ==================================================
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_SUPABASE_URL=
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=
ARG NEXT_PUBLIC_APP_URL=

ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=4096

RUN npm run build
RUN npm prune --omit=dev

# ===== STAGE 3: Runner ===================================================
FROM node:22-bookworm-slim AS runner
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
    postgresql-client \
    ca-certificates \
    fonts-freefont-otf \
    fonts-noto-color-emoji \
    procps \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 -g nodejs --create-home nextjs \
    && mkdir -p /home/nextjs/.config/chromium && chown -R nextjs:nodejs /home/nextjs

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    ROUTER_BASE_URL=http://9router:20128/v1 \
    ROUTER_API_KEY=sk-9router \
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

# OpenCode CLI + Impeccable (geração autônoma de sites com todas as 253 skills):
RUN npm install -g @opencode/cli && \
    mkdir -p /home/nextjs/.config/opencode /root/.config/opencode /app/.opencode

# Copia todo o ecossistema de skills e configurações do OpenCode
COPY --chown=nextjs:nodejs .opencode /home/nextjs/.config/opencode
COPY --chown=nextjs:nodejs .opencode /app/.opencode
COPY .opencode /root/.config/opencode

# O 9Router dentro do container NÃO está em 127.0.0.1 (roda como serviço separado
# no EasyPanel). Troca as credenciais fixas por variáveis de ambiente.
RUN for d in /home/nextjs/.config/opencode /app/.opencode /root/.config/opencode; do \
        if [ -f "$d/opencode.json" ]; then \
            sed -i \
                -e 's|http://127\.0\.0\.1:20128/v1|{env:ROUTER_BASE_URL}|g' \
                -e 's|"apiKey": *"sk-9router"|"apiKey": "{env:ROUTER_API_KEY}"|g' \
                "$d/opencode.json"; \
        fi; \
    done

# Permissões de execução para scripts e binário nativo Linux x64 da Impeccable
RUN chmod +x /home/nextjs/.config/opencode/skills/impeccable/scripts/impeccable \
    /home/nextjs/.config/opencode/skills/impeccable/scripts/bin/linux-x64/impeccable \
    /app/.opencode/skills/impeccable/scripts/impeccable \
    /app/.opencode/skills/impeccable/scripts/bin/linux-x64/impeccable \
    /root/.config/opencode/skills/impeccable/scripts/impeccable \
    /root/.config/opencode/skills/impeccable/scripts/bin/linux-x64/impeccable 2>/dev/null || true && \
    chown -R nextjs:nodejs /home/nextjs /app/.opencode

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
