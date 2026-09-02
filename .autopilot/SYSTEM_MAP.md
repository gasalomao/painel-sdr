# System Map

Status: `PASS` (2026-09-01). Contagens via `git ls-files`/`git grep`.

## Fluxo executável
Browser → `src/proxy.ts` (edge: JWT HS256, gate admin, gate de feature em páginas) → `src/app/api/**/route.ts` (Node) → `src/lib/*` → Supabase (Postgres/Storage/Realtime) → Evolution V2/GO, Meta Cloud, Gemini/OpenRouter/DeepSeek, Google Calendar.

Janelas públicas (sem cookie): `/api/webhooks/*`, `/api/auth/*`, `/api/whisper-status`, `/api/deepseek-chat/{import-bookmarklet,userscript.user.js,v1/*}`, `/login`, assets.

## Boot / timers (src/instrumentation.ts) — 5 timers no processo web
- Organizer: 5min (primeiro tick 20s), linhas 138-144.
- Automation: 60s (169-186).
- Campaign recovery: 90s (195-212).
- Follow-up: 2min (primeiro 15s, 214-247).
- Appointments: 60s (reminders; auto-promote a cada 5; Google sync a cada 3, 255-295).
- Guards `globalThis.*Ticking` são por processo — NÃO há liderança entre réplicas. Multi-réplica = envios duplicados.

## Inventário medido
- 105 arquivos de rota API; 156 handlers (GET 58, POST 69, PATCH 16, DELETE 12, OPTIONS 1).
- 16 páginas, 1 layout raiz, ~38 componentes; zero `loading.tsx`/`error.tsx`.
- 71 suites de teste (`src/lib/__tests__`), 18 com guards live (auto-skip sem env).
- 51 arquivos SQL em `migrations/`; `migrations/SETUP_COMPLETO.sql` é a fonte canônica; `scripts/build-setup-sql.mjs` procura o arquivo na raiz (errado) e reusa `src/lib/setup-sql.ts` silenciosamente — MIG-001 aberto.
- Redis/BullMQ: inexistentes (AGENTS.md desatualizado). Toda concorrência é in-process + claims no Postgres.

## Modelo de segurança real
- JWT próprio em cookie httpOnly (`sdr_session`), TTL 30d, claims estáticas.
- Revogação em `auth_sessions` checada SÓ em 4 rotas (`isSessionLive` fail-open).
- Isolamento multi-tenant é por código de aplicação (filtros `client_id`) — RLS desligado + GRANT anon em migrations (SEC-C1).
- Impersonação: JWT carrega `actorId`; `isAdmin` forçado falso durante impersonação (`tenant.ts:51`, `proxy.ts:123`). Ciclo de vida corrigido em FIX-001.

## Matriz de estado por processo
- **OK_PER_INSTANCE**: caches TTL (channel 30s, organizer 60s, tenant instance 60s, pricing, RAG 30s), whisper bin/model cache, login rate-limit (comportamento pior em multi-réplica, mas só enfraquece).
- **MUST_BE_SHARED (hoje in-process — quebra/duplica em ≥2 réplicas)**: session-lock, registries de envio manual/IA, automation in-flight/ticking, campaign runningTimers/consecutiveFailures, scraper singleton + SSE (SEC-H8), IMPORT_CODES (DeepSeek), whisper semaphore.
- **MUST_BE_PERSISTED (hoje em disco local)**: `.deepseek-chat/*`, `.gateway-proxy/*`, `.whisper` config — perdidos em rebuild; backup ausente.
- **MUST_BE_REMOVED a longo prazo**: timers de negócio dentro do processo web → worker único com lease em DB.
- **Claims atômicos já corretos**: campaigns (gate + claim), follow-up targets, appointments reminders, automations. Gaps: follow-up target travado em `processing` após crash; `reminders_sent` lost-update entre réplicas; contadores sent/failed read-modify-write.

## Riscos top (detalhe em SECURITY_FINDINGS.md)
P0: SEC-C1 (RLS/anon), SEC-C2 (corrigido), SEC-C3 (webhooks fail-open), SEC-H8 (scraper cross-tenant), timers duplicados.
P1: SEC-H4/H5/H6/H7/H9/H10, `/api/whisper-status` público, `provider_credentials` sem REVOKE no setup automático.
