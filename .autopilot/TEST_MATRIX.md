# Test Matrix

| Área | Teste | Tipo | Comando/artefato | Status |
|---|---|---|---|---|
| Baseline | Lint | Estático | `npm run lint`: 0 erros, 1.595 warnings | PASS |
| Baseline | TypeScript | Estático | `npx tsc --noEmit`: exit 0 | PASS |
| Baseline | Unit/integration | Vitest | `npm run test`: 676 passaram, 31 ignorados | PASS |
| Baseline | Production build | Build | `npm run build`: exit 0; 24 warnings de tracing | PASS |
| Regressão | Unit/integration após FIX-001/002/003 | Vitest | `npm run test`: 693 passaram, 31 ignorados | PASS |
| Regressão | Unit/integration após FIX-004/005 | Vitest | `npm run test`: 719 passaram, 30 ignorados; `npx tsc --noEmit`: exit 0; `npm run lint`: 0 erros; `npm run build`: PASS; `git diff --check`: limpo | PASS |
| Migrations | Fonte canônica/fail-fast/schema runtime/unicidade composta | Vitest/build | `build-setup-sql.test.ts`: 3 passaram; `npm run build`: exit 0 | PASS |
| Auth | Login/logout/revocation/impersonation | Unit/integration | 7 testes novos; E2E real pendente | PARTIAL |
| Tenant | Scraper/follow-up/campaign/organizer/intelligence com JID compartilhado | Unit/integration | `scraper-tenant-isolation`, `followup-worker`, `campaign-tenant-isolation`, `organizer-tenant-isolation`: passaram | PARTIAL (SQL/RLS live pendente) |
| Webhooks | Strict default/timing-safe | Unit/integration | 5 testes novos; replay/fuzz pendentes | PARTIAL |
| SSRF | IPs privados/redirect/stream limits | Unit | A criar | TODO |
| Jobs | Multi-worker/crash recovery | Integration | DB descartável | TODO |
| Agenda | Overlap/race | SQL/integration | DB descartável | TODO |
| Agent | Provider/tool/failover/idempotência | Unit/integration | Fakes | TODO |
| RAG | Tenant/agent/document isolation | Unit/integration | Fakes/DB | TODO |
| E2E | Roles/jornadas/security | Browser | Framework a confirmar | TODO |
| Docker | Image/health/startup | Container | Docker local se disponível | TODO |
| Backup | Backup/restore/smoke | Integration | DB descartável | TODO |

Teste não executado permanece `TODO` ou `BLOCKED`.
