# AUDIT TECHNOLOGY EVIDENCE

## Status

- Fase: PHASE 0 — discovery concluída; validação profunda pendente.
- Método: inspeção estática do workspace e metadados Git.
- Regra: uma tecnologia só é considerada presente quando sustentada por manifest, configuração, import ou source.
- Escala: HIGH = múltiplas evidências diretas; MEDIUM = evidência parcial; LOW = indício ainda não confirmado.

## Tecnologias confirmadas

### Node.js e npm

**Evidências**

- `.node-version` define Node 20.
- `package.json:5-12` define scripts npm.
- `package-lock.json` existe e é lockfile npm v3.
- `.github/workflows/ci.yml:16-23` e `.github/workflows/ci.yml:38-45` usam Node 20 e `npm ci`.
- `Dockerfile:7-14` usa imagens Node 20.

**Confiança:** HIGH

**Skills permitidas:** backend-patterns, security-and-hardening, performance-optimization, error-handling, ci-cd-and-automation.

### TypeScript

**Evidências**

- `package.json:56` declara TypeScript.
- `tsconfig.json:2-24` configura compilação strict e noEmit.
- 259 arquivos `.ts` e 75 arquivos `.tsx` rastreados.

**Confiança:** HIGH

**Skills permitidas:** coding-standards, code-review-and-quality, frontend-patterns, backend-patterns.

### Next.js App Router

**Evidências**

- `package.json:32` declara Next.js 16.3.1.
- `next.config.ts:3-43` configura output standalone e pacotes server-side.
- `src/app/layout.tsx`, 17 arquivos `page.tsx` e 105 arquivos `route.ts` foram inventariados.
- `Dockerfile:77-80` copia o output standalone.

**Confiança:** HIGH

**Skills permitidas:** nextjs-turbopack, frontend-patterns, backend-patterns, react-performance, frontend-a11y.

### React

**Evidências**

- `package.json:37-39` declara React e React DOM 19.2.4.
- 75 arquivos `.tsx` e componentes em `src/components`.

**Confiança:** HIGH

**Skills permitidas:** react-patterns, react-testing, react-performance, frontend-ui-engineering, frontend-a11y.

### Tailwind CSS e shadcn/ui

**Evidências**

- `package.json:47,55` declara Tailwind CSS 4 e plugin PostCSS.
- `postcss.config.mjs` configura Tailwind.
- `components.json` configura shadcn/ui.
- `src/components/ui` contém 17 componentes.

**Confiança:** HIGH

**Skills permitidas:** ui-styling, accessibility, frontend-a11y. Skills de redesign permanecem fora do escopo salvo bug funcional.

### Supabase

**Evidências**

- `package.json:20` declara `@supabase/supabase-js`.
- `.env.example:7-10` documenta URL, anon key e service-role key.
- `src/lib/supabase.ts` e `src/lib/supabase_admin.ts` são clientes compartilhados.
- Migrations e código usam PostgREST, Storage e Realtime.

**Confiança:** HIGH

**Skills permitidas:** postgres-patterns, database-migrations, backend-patterns, security-and-hardening.

### PostgreSQL e pgvector

**Evidências**

- `README.md:49-50` descreve PostgreSQL/Supabase e RAG.
- `migrations/` contém 50 arquivos SQL.
- `migrations/SETUP_COMPLETO.sql` contém DDL PostgreSQL e extensões `pgcrypto` e `vector`.
- Funções e índices de RAG foram localizados no schema.

**Confiança:** HIGH

**Skills permitidas:** postgres-patterns, database-migrations, performance-optimization, security-and-hardening.

### Redis e BullMQ

**Evidências**

- `package.json:22,28` declara BullMQ e ioredis.
- `.env.example:21-25` documenta Redis.
- `src/lib/redis-queue.ts` e `src/workers/message-worker.ts` existem.

**Confiança:** HIGH para dependências e código; MEDIUM para funcionamento operacional do worker.

**Skills permitidas:** redis-patterns, backend-patterns, observability-and-instrumentation.

### Vitest

**Evidências**

- `package.json:11-12,57` declara comandos e Vitest.
- `vitest.config.ts:8-15` inclui `src/**/*.test.ts` em ambiente Node.
- `src/lib/__tests__` contém 69 arquivos `*.test.ts` e dois setups.

**Confiança:** HIGH

**Skills permitidas:** react-testing quando houver componentes React; ai-regression-testing para IA; test-driven-development; verification-loop.

### GitHub Actions

**Evidências**

- `.github/workflows/ci.yml:1-52` executa install, lint, test e build em push/PR para main.

**Confiança:** HIGH

**Skills permitidas:** ci-cd-and-automation, production-audit.

### Docker

**Evidências**

- `Dockerfile:1-103` define build multi-stage e runtime standalone.
- `.dockerignore` existe.

**Confiança:** HIGH

**Skills permitidas:** production-audit, performance-optimization, security-and-hardening.

### Autenticação JWT customizada

**Evidências**

- `package.json:30` declara `jose`.
- `src/lib/auth-edge.ts`, `src/lib/auth.ts`, `src/lib/internal-auth.ts`, `src/lib/tenant.ts` e `src/proxy.ts` implementam sessão, JWT, segredo interno e tenant.

**Confiança:** HIGH

**Skills permitidas:** security-and-hardening, error-handling, contract-first.

### WhatsApp: Evolution API, Evolution GO e Cloud API

**Evidências**

- `.env.example:12-19` documenta Evolution V2 e GO.
- `src/lib/evolution.ts`, `src/lib/providers/evolution-v2.ts`, `src/lib/providers/evolution-go.ts` e `src/lib/whatsapp-cloud.ts` existem.
- Rotas em `src/app/api/webhooks` e `src/app/api/whatsapp` processam canais.

**Confiança:** HIGH

**Skills permitidas:** backend-patterns, api-design, contract-first, security-and-hardening, observability-and-instrumentation.

### IA: Gemini, OpenRouter, DeepSeek e gateways compatíveis

**Evidências**

- `package.json:19` declara SDK Gemini.
- `src/lib/ai-provider.ts`, `src/lib/ai-combos.ts`, `src/lib/gemini-call.ts`, `src/lib/openrouter-model-discovery.ts`, `src/lib/deepseek-chat-client.ts` e `src/lib/gateway-proxy-manager.ts` existem.
- Há rotas `api/ai-*`, `api/deepseek-chat`, `api/gateway-proxy` e testes live de providers.

**Confiança:** HIGH

**Skills permitidas:** ai-regression-testing, eval-harness, gsd-ai-integration-phase quando for necessário formalizar contratos de IA, observability-and-instrumentation, error-handling.

### RAG e embeddings

**Evidências**

- `src/lib/rag.ts` implementa retrieval.
- Migrations usam `vector` e estruturas de knowledge chunks.
- Há testes e configurações de embedding model.

**Confiança:** HIGH

**Skills permitidas:** ai-regression-testing, postgres-patterns, security-and-hardening.

### Google Calendar e OAuth

**Evidências**

- `package.json:27` declara `googleapis`.
- `src/lib/google-calendar.ts`, `src/lib/google-calendar-sync.ts` e rotas OAuth existem.

**Confiança:** HIGH

**Skills permitidas:** api-and-interface-design, security-and-hardening, error-handling, observability-and-instrumentation.

### Puppeteer/Chromium

**Evidências**

- `package.json:34-36` declara Puppeteer Core, Extra e Stealth.
- `next.config.ts:24-28` os marca como server external packages.
- `Dockerfile:41-64` instala Chromium e bibliotecas.
- `src/lib/scraper-engine.ts` implementa o scraper.

**Confiança:** HIGH

**Skills permitidas:** browser-qa apenas para UI segura; performance-optimization; security-and-hardening.

### Whisper.cpp e FFmpeg

**Evidências**

- `Dockerfile:41-64` instala FFmpeg.
- `Dockerfile:85-98` baixa binário e modelo Whisper.
- Rotas e scripts de transcrição foram inventariados.

**Confiança:** HIGH

**Skills permitidas:** production-audit, security-and-hardening, performance-optimization.

## Tecnologias não confirmadas

As seguintes tecnologias não possuem manifest/config/source correspondente no inventário inicial e suas skills não serão usadas sem nova evidência:

- Angular, Vue, Nuxt, Vite como bundler principal.
- Java, Spring Boot, Quarkus, Kotlin, Android/Compose.
- Python, Django, FastAPI.
- PHP/Laravel.
- .NET/F#/C#.
- Go como código deste repositório; Evolution GO é serviço externo.
- Rust, C++, Perl.
- Flutter, React Native.
- Prisma, MySQL/MariaDB, ClickHouse.
- Kubernetes, Helm, Terraform, Docker Compose.
- Playwright, Cypress, Jest, Storybook.
- 9Router: existem gateways de IA, mas nenhuma evidência direta de integração com 9Router foi confirmada.

## Inconsistências a validar

- `next.config.ts:23` ignora erros TypeScript no build.
- O Node 20 declarado pode divergir do engine de `puppeteer-core` resolvido; validar no lockfile e por typecheck/runtime isolado.
- A ordem canônica das 50 migrations não está inequívoca.
- O estado real de RLS, grants, policies, buckets e migrations aplicadas não pode ser inferido apenas do repositório.
- A presença de BullMQ não comprova producer, startup ou worker operacional.
