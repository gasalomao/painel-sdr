# Security Findings

Cada achado foi reconfirmado por leitura direta de código (path:line) em 2026-09-01.
Severidade: potencial real de impacto. Produção sem acesso direto = introspecção SQL/rotação marcadas BLOCKED.

## CRITICAL

### SEC-C1 — RLS desligado + GRANT ALL para anon em tabelas de tenant
- **Evidência**: `DISABLE ROW LEVEL SECURITY` + `GRANT ALL ... TO anon` em `migrations/001_multi_tenant.sql:143-148` (clients, auth_sessions), `fix_permissao_supa.sql:5-22` (agent_settings, agent_knowledge, agent_stages, channel_connections), `FIX_RLS.sql:7-19` (leads_extraidos, automations, logs), `criar_campaigns.sql:56-59`, `criar_followup.sql:62-82`, `criar_logs.sql:8-9`, `banco_dados_update.sql:61-77` (ai_token_usage, chat_buffers), `migration_ai_first_os.sql:151-165` (varredura em massa), `criar_ai_organizer.sql:51-53`, `006_rag_vector_kb.sql:112-113`.
- **Impacto**: a anon key (pública no bundle) lê/escreve todas as tabelas listadas — inclui `clients.password_hash`, `auth_sessions`, `channel_connections.provider_config` (tokens Evolution/Cloud), `agent_settings.options.google_tokens`.
- **Status**: `CONFIRMED` no SQL. Estado efetivo do banco de produção: `BLOCKED` (requer introspecção SQL — actions humanas no checklist `RELEASE_READINESS.md`). `HARDEN_RLS.sql` existe mas é manual e não cobre todas as tabelas.

### SEC-C2 — Sessão admin restaurável por qualquer usuário pós-logout (impersonação)
- **Evidência (pré-fix)**: `impersonate/route.ts` importava `revokeSession` sem chamar; `ADMIN_SESSION_COOKIE` guardava o JWT admin cru; `stop-impersonate` reinstalava sem validar assinatura/liveness/isAdmin; `logout` não limpava o cookie.
- **Correção aplicada**: `impersonate/route.ts` revoga a sessão admin e apaga o cookie; `stop-impersonate/route.ts` reescrito — valida JWT+liveness, exige `impersonating`, reemite token admin novo a partir de `actorId` com verificação `is_admin/is_active` fresca do DB; cookie legado sempre deletado; `logout` apaga o cookie.
- **Evidência**: `src/lib/__tests__/admin-impersonation.test.ts` — 7 testes PASS (inclui cenário de ataque com cookie legado).
- **Status**: `FIXED` (pending regression + deploy).

### SEC-C3 — Webhooks Evolution fail-open por padrão
- **Correção aplicada (FIX-003)**: strict por padrão (401 em mismatch/absent) com opt-out `webhook_strict=false`; comparação timing-safe (`webhook-security.ts`); log 1x `WEBHOOK_NO_SECRET`; HMAC Cloud inalterado + log `CLOUD_NO_APP_SECRET`.
- **Residual**: (a) instância sem `webhook_secret` segue forjável até provisionar — ação operacional; (b) `DEFAULT_CLIENT_ID` fallback segue ativo para instância desconhecida; (c) sem rate-limit por IP.
- **Status**: `MITIGATED` (código) — rollout documentado em ADR-002/RELEASE_READINESS.

## HIGH

| ID | Achado | Evidência | Status |
|---|---|---|---|
| SEC-H4 | KB poisoning cross-tenant | FIXED (FIX-002): create exige agente do tenant; update reindexa agent_id real; reads filtram client_id; 5 testes | FIXED |
| SEC-H5 | Revogação de sessão só é checada em poucas rotas; `isSessionLive` fail-open por design | `auth.ts:168-206` | PARTIAL (FIX-006): impersonate/stop-impersonate migrados para `isSessionLiveStrict` em 2026-09-01; session/change-password seguem fail-open por decisão de continuidade |
| SEC-H6 | Segredo único: `AUTH_SECRET \|\| SUPABASE_SERVICE_ROLE_KEY` assina JWT, internal-auth, OAuth state e DeepSeek bearer | `auth-edge.ts:37`, `internal-auth.ts:19`, `proxy.ts:79`, `google/url:17`, `callback/google:10` | CONFIRMED |
| SEC-H7 | Tools de calendário sem escopo por contato: cancela/lista qualquer evento | `agent/process/route.ts` (cancel) | PARTIAL (FIX-007): cancel só recai em appointment do tenant + contato da conversa (bloqueio de cross-contact/tenant); list continua lendo a agenda do próprio agente (design) |
| SEC-H8 | Scraper singleton cross-tenant: `forceRestart` de A mata run de B; SSE global sem filtro por tenant | `scraper-engine.ts`, `automation-worker.ts`, `scraper/route.ts` | FIXED (FIX-004): estado por (clientId, automationId), owner_required fail-closed, SSE 60s strict; revisão independente 0 HIGH/CRITICAL |
| SEC-H9 | RAG ILIKE fallback e `chat_history_summaries` sem filtro `client_id`; caches por `remoteJid`/`instance_name` globais | `rag.ts`; `history-summary.ts`; `lead-intelligence.ts:1558`; `channel.ts` | PARTIAL (FIX-004/008): `getCachedIntelligence(remoteJid, clientId)` e `history-summary` cache por `clientId:remoteJid` FIXED; RAG fallback já filtra tenant (FIX-002); `chat_history_summaries` e demais caches de `channel.ts` (chaveados por instance_name globalmente único) seguem sob revisão |
| SEC-H10 | Campanha/follow-up/automação usam instância sem checar ownership do tenant | `campaign-worker.ts`, `followup-worker.ts`, rotas start/pause | FIXED (FIX-004): campanhas carregam/exigem client_id; reads/writes tenant-scoped; follow-up history/target/lead por tenant; organizer history/run por tenant; testes com JID compartilhado |

## MEDIUM

| ID | Achado | Evidência |
|---|---|---|
| SEC-M8 | Feature gates só em páginas; APIs ignoram; default-allow | `proxy.ts:119-137` |
| SEC-M9 | `/api/admin/*` depende 100% do proxy, sem auth in-handler | `admin/clients/*/route.ts` |
| SEC-M11 | OAuth `state` HMAC sem consumo de nonce | `google/url`, `callback/google` |
| SEC-M12 | `serviceRole` aceito via querystring em `setup-db` | `setup-db/route.ts:83` |
| SEC-M13 | Rate limit de login in-memory + `x-forwarded-for` spoofável | `login/route.ts:12-53` |
| SEC-M14 | Upload 100MB em memória, bucket público, ext por nome | `upload-media/route.ts:7-50` |
| SEC-M15 | `safe-url` sem DNS/redirect re-validation | `safe-url.ts:5-8` |
| SEC-M16 | Sem CSP/HSTS/X-Frame-Options | `next.config.ts` |
| SEC-M17 | Mutations globais por `message_id`/`remote_jid` sem `client_id` (webhooks, contacts, avatars) | `whatsapp/route.ts:1307-1309`; `whatsapp-cloud/route.ts:187-230,343-381`; `evolution-go` contacts |
| SEC-M18 | Realtime sem filtro `client_id` | `use-realtime.ts:39-45` |

## LOW / positivos
- PBKDF2 100k (abaixo do OWASP 600k); JWT sem iss/aud; TTL 30d sem idle timeout; output de custom tool sem cap.
- `xlsx@0.18.5` com advisory crítico — uso export-only; trocar depois.
- Positivos: `jose` pinned HS256; timing-safe compare; sessions como hash; proxy exclui `/api/admin` do bypass interno; HMAC timing-safe no whatsapp-cloud GET; ownership correto em campaigns/[id], followup/[id], appointments/[id], organizer/history.

## Correções aplicadas nesta iteração
| ID | Fix | Teste |
|---|---|---|
| SEC-C2 | impersonate revoga + stop-impersonate reemite + logout limpa | `admin-impersonation.test.ts` (7 testes) |
| SEC-H4 | KB ownership + filtros client_id (create/update/read/RAG) | `knowledge-save-isolation.test.ts` (5 testes) |
| SEC-C3 | webhooks strict default + timing-safe + logs 1x | `webhook-security.test.ts` (5 testes) |
