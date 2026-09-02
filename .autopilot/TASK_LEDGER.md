# Task Ledger

| ID | Etapa | Status | Evidência / próximo passo |
|---|---|---|---|
| BASE-001 | Registrar branch, SHA e alterações pré-existentes | PASS | `git status`, `git rev-parse HEAD`, 2026-09-01 |
| BASE-002 | Criar memória durável `.autopilot` | PASS | 24 artefatos iniciais criados em 2026-09-01 |
| TEST-001 | Suite pré-mudança: lint | PASS | `npm run lint`: 0 erros, 1.595 warnings existentes |
| TEST-002 | Suite pré-mudança: typecheck | PASS | `npx tsc --noEmit`: exit 0 |
| TEST-003 | Suite pré-mudança: unit/integration | PASS | `npm run test`: 53 arquivos/676 testes passaram; 18 arquivos/31 testes ignorados |
| TEST-004 | Suite pré-mudança: build | PASS | `npm run build`: exit 0; 24 warnings preexistentes de tracing |
| MAP-001 | Inventário completo de código executável | PASS | 8 agentes paralelos + reconciliação: 105 rotas API/156 handlers (58G/69P/16PATCH/12DEL/1OPT), 16 páginas, 71 suites, 51 SQL. Ver SYSTEM_MAP/SECURITY_FINDINGS |
| SEC-001 | Threat model e findings P0 | PASS | 3 CRITICAL + 7 HIGH confirmados com path:line; M10 refutado (tenant.ts:51) |
| FIX-001 | P0: ciclo de sessão/impersonação (SEC-C2) | PASS | impersonate revoga, stop-impersonate reemite via actorId, logout limpa cookie; 7 testes novos; suite 683 PASS; tsc 0; eslint 0 erro |
| FIX-002 | P0: KB cross-tenant (SEC-H4) | PASS | create valida dono do agente; update reindexa agent_id real; leituras (process/rag) filtram client_id; 5 testes; suite 688 PASS |
| FIX-003 | P0: webhooks strict default (SEC-C3) | PASS | whatsapp + evolution-go strict c/ opt-out `webhook_strict=false`; timing-safe; logs 1x; cloud log NO_APP_SECRET; helper + 5 testes; suite 693 PASS; tsc 0 |
| FIX-004 | P0: isolamento scraper + consumidores JID (SEC-H8/H10) | PASS | scraper fail-closed por (clientId, automationId); follow-up, organizer e campaign filtram/gravam client_id; getCachedIntelligence e findOrCreateContactSession tenant-aware; revisão independente: 0 HIGH/CRITICAL; suite 719 PASS; lint 0 erro; tsc 0; build PASS; diff --check limpo |
| FIX-005 | Seletores de modelos vazios pós-HARDEN_RLS | PASS | openrouter/gemini-model-discovery liam `ai_organizer_config` via client anon bloqueado por REVOKE; migrados para `supabaseAdmin`; regressão em `model-discovery-admin-client.test.ts` (2 testes) |
| AUTH-001 | Segredos independentes e auth fail-closed | TODO | Mapear fallbacks e testes |
| TENANT-001 | Matriz de isolamento multi-tenant | TODO | Código, SQL, RLS, RPC, Storage e Realtime |
| WEBHOOK-001 | Hardening e idempotência de webhooks | TODO | Evolution e WhatsApp Cloud |
| SSRF-001 | Download seguro e resource limits | TODO | Refatorar com testes adversariais |
| DIAG-001 | Health endpoints e diagnósticos protegidos | TODO | `/api/health/live`, `/ready`, Whisper |
| MIG-001 | Setup SQL e auditoria de migrations | PARTIAL | Gerador usa `migrations/SETUP_COMPLETO.sql`, falha sem fonte e preserva saída; drift `openrouter_keys`/`ai_combos` reconciliado; unicidade composta `(client_id, remoteJid)` em `015_leads_remotejid_multi_tenant.sql` + upgrade idempotente no canônico (preflight nulos/duplicatas, SET NOT NULL, índice recriado); 3 testes + build PASS. Banco vazio, execução da migration e RLS implantado pendentes |
| JOB-001 | Jobs duráveis e concorrência | TODO | Decisão após inventário e pesquisa oficial |
| PROD-001 | Subsystems e jornadas críticas | TODO | Agent, RAG, channels, campanhas, agenda e scraper |
| OPS-001 | Deploy, observabilidade e backup/restore | TODO | Provas locais e blockers externos |
| RELEASE-001 | Red team e regressão final | TODO | Executar após correções |
| RELEASE-002 | Veredicto final | TODO | Apenas após matriz completa |
