# Release Readiness

Veredicto atual: `NOT_READY` — correções P0 parciais concluídas; gates críticos ainda estão `TODO`/`BLOCKED`.

| AREA | STATUS | EVIDENCE | COMMAND | ARTIFACT | REMAINING RISK |
|---|---|---|---|---|---|
| Auth | PARTIAL | Impersonação revoga e reemite sessão; 7 testes | `npm run test` | `SECURITY_FINDINGS.md` | E2E e segredos independentes pendentes |
| Tenant isolation | PARTIAL | KB, scraper, automations, follow-up, organizer, campaign e lead-intelligence filtram/gravam `client_id`; unicidade composta `(client_id, remoteJid)`; revisão independente 0 HIGH/CRITICAL; 719 testes | `npm run test` | `TENANT_ISOLATION_MATRIX.md` | RLS implantado, timers multi-réplica e fluxos live não provados |
| RLS | BLOCKED | Sem introspecção implantada | — | `MIGRATION_AUDIT.md` | Estado real desconhecido |
| Webhooks | PARTIAL | Secret per-instance strict quando configurado; comparação timing-safe; 5 testes | `npm run test` | `SECURITY_FINDINGS.md` | Instâncias sem secret, replay e lookup fail-open |
| SSRF | TODO | — | — | — | Download externo |
| Jobs | TODO | — | — | — | Duplicação multi-réplica |
| Campaigns | PARTIAL | Opt-out, templates, pregen, merge e status escopados por client_id; inserts com tenant; `campaign-tenant-isolation.test.ts` | `npm run test` | `SECURITY_FINDINGS.md` | Locks multi-réplica pendentes |
| Followup | PARTIAL | Campaign/target/histórico/leads/contatos por tenant; claim atômico; enrollment valida ownership; 46 testes | `npm run test` | `SECURITY_FINDINGS.md` | Concorrência multi-réplica pendente |
| Automations | TODO | — | — | — | Máquina de estados |
| Agent | TODO | — | — | — | Tools/failover |
| RAG | TODO | — | — | — | Isolamento |
| OpenRouter | BLOCKED | Sem autorização live | — | `OPENROUTER_MATRIX.md` | Live não testado |
| Evolution | BLOCKED | Sem target live autorizado | — | `LIVE_TEST_MATRIX.md` | Live não testado |
| Calendar | BLOCKED | Sem staging OAuth | — | `LIVE_TEST_MATRIX.md` | Live não testado |
| Scraper | PARTIAL | Singleton fail-closed por (clientId, automationId); SSE 60s com auth strict; restart/stop/clear por owner; 10 testes | `npm run test` | `SECURITY_FINDINGS.md` | Coordenação multi-réplica pendente; webhook SSRF aberto (SEC adjacente) |
| UX | TODO | — | — | `UX_AUDIT.md` | Não auditado |
| E2E | TODO | — | — | `TEST_MATRIX.md` | Jornadas não provadas |
| Performance | TODO | — | — | `PERFORMANCE_BASELINE.md` | Baseline ausente |
| Build | PASS | Exit 0 após geração canônica; 24 warnings preexistentes de tracing | `npm run build` | `MIGRATION_AUDIT.md` | Warnings de tracing permanecem |
| Model discovery | PASS | Discovery OpenRouter/Gemini via `supabaseAdmin` após REVOKE HARDEN_RLS; 2 testes de regressão; suite 719 PASS | `npx vitest run src/lib/__tests__/model-discovery-admin-client.test.ts` | `TASK_LEDGER.md` (FIX-005) | Exige `SUPABASE_SERVICE_ROLE_KEY` no ambiente |
| Docker | TODO | — | — | — | Container não testado |
| EasyPanel | BLOCKED | SHA ativo não comprovado | — | `DEPLOYMENT_EASYPANEL.md` | Revisão ativa desconhecida |
| Backup | TODO | — | — | `BACKUP_RESTORE.md` | Plano incompleto |
| Restore | BLOCKED | Não executado | — | `BACKUP_RESTORE.md` | Recuperação não provada |
| Observability | TODO | — | — | `OBSERVABILITY.md` | Lacunas desconhecidas |
| Dependencies | TODO | — | — | `DEPENDENCY_AUDIT.md` | Não auditadas |
| Migrations | PARTIAL | Fonte canônica, fail-fast, unicidade composta e upgrade idempotente (preflight nulos/duplicatas, NOT NULL) provados por 3 testes + build | `npx vitest run src/lib/__tests__/build-setup-sql.test.ts` | `MIGRATION_AUDIT.md` | Execução da 015 em produção, zero-to-schema e RLS implantado não provados |
