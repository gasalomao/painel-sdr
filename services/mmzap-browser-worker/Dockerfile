FROM mcr.microsoft.com/playwright:v1.50.0-noble

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV PORT=3099
ENV DATA_DIR=/data
ENV DEFAULT_EXTENSION_DIR=/opt/mmzap-extension
ENV MAX_CONCURRENT_BROWSERS=2
ENV MAX_RSS_MB=550

RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb unzip curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Instala explicitamente o Chromium empacotado do Playwright (suporta --load-extension sem bloqueio do Chrome 137+)
RUN npx playwright install chromium

COPY src ./src
COPY README-EASYPANEL.md ./

RUN mkdir -p /data/profiles /data/extensions/mmzap /opt/mmzap-extension \
  && node src/install-default-mmzap.mjs

EXPOSE 3099

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3099/health || exit 1

CMD ["sh", "-c", "xvfb-run --auto-servernum --server-args='-screen 0 1024x720x16' node src/server.mjs"]
