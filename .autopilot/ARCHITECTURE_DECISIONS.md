# Architecture Decisions

## ADR-000 — Preservar, endurecer, testar, medir, otimizar

- Data: 2026-09-01
- Status: Accepted
- Decisão: evitar reescrita ampla; aplicar o menor diff que feche risco comprovado e deixe teste reproduzível.
- Razão: sistema existente possui ampla funcionalidade e integrações; reescrita elevaria risco de regressão.

## ADR-001 — Impersonação sem cookie de restauração confiável

- Data: 2026-09-01 · Status: implemented (FIX-001)
- Contexto: `ADMIN_SESSION_COOKIE` guardava o JWT admin cru de 30d e `stop-impersonate` o reinstalava sem validação → qualquer sessão posterior no navegador virava admin.
- Decisão: impersonate REVOGA a sessão admin; stop-impersonate reemite token novo a partir do `actorId` da sessão impersonada validada (JWT+liveness+`is_admin`/`is_active` frescos); cookie legado sempre deletado (também no logout).
- Consequência: se o admin for demovido/desativado durante impersonação, retorno vira 401→login (correto).

## ADR-002 — Webhook secret strict por padrão (BREAKING)

- Data: 2026-09-01 · Status: implemented (FIX-003)
- Contexto: validação Evolution era fail-open; payload forjado injetava mensagens do "cliente" e disparava tools do agente.
- Decisão: se a instância tem `provider_config.webhook_secret`, header errado/ausente → 401. Opt-out explícito: `provider_config.webhook_strict=false`. Instância SEM secret segue aceitando com log `WEBHOOK_NO_SECRET` (1x/processo) até provisionar. Comparação timing-safe (`src/lib/webhook-security.ts`). Cloud HMAC inalterado (já strict com secret; novo log 1x `CLOUD_NO_APP_SECRET`).
- Risco de deploy (ação humana): instâncias cujo webhook Evolution foi registrado FORA do fluxo do painel (sem header) passam a 401 até clicar "Registrar Webhook" ou setar `webhook_strict=false`.

## ADR-003 — Escopo de tenant em conhecimento (KB)

- Data: 2026-09-01 · Status: implemented (FIX-002)
- Create exige agente do próprio tenant (ou legado `client_id` NULL); update reindexa com `agent_id` REAL da row; leituras (lista de títulos + fallback ILIKE em `process/route.ts` e `rag.ts`) filtram `client_id = caller OR NULL`. NULLs legados permanecem compartilhados de propósito; backfill/strict virão com MIG-001.

## ADRs pendentes

- Segredos e validação central de ambiente (SEC-H6).
- Estratégia de RLS/grants e acesso browser/server (SEC-C1).
- Idempotência de webhooks e efeitos externos.
- Jobs duráveis e processo worker (timers fora do process web).
- Agenda concorrente.
- Health/readiness.

Decisões dependentes de produtos externos exigem fonte oficial atual registrada.
