# Master Plan

Snapshot iniciado em 2026-09-01 no SHA `da92e2fb1e7220890a1e9aef5555ec4649c80ea4`.

## Objetivo

Produzir evidência reproduzível de prontidão para lançamento SaaS multi-tenant, corrigindo falhas executáveis e classificando dependências externas como `BLOCKED`.

## Ordem de execução

1. Baseline Git e memória durável.
2. Suite pré-mudança: lint, typecheck, testes e build.
3. Inventário real: arquitetura, APIs, dados, integrações, roles e jornadas.
4. Threat model e auditorias P0: segredos/auth, tenant/RLS, webhooks, SSRF, diagnósticos e migrations.
5. Correções P0 com regressões focais e suite relacionada.
6. Jobs, concorrência, scraper, RBAC/features e agenda.
7. IA, RAG, memória, channels, campanhas, follow-up, automações e Calendar.
8. UX, performance, observabilidade, dependências, Docker, EasyPanel e backup/restore.
9. E2E, red team, regressão completa e release audit.
10. `RELEASE_READINESS.md` e `FINAL_REPORT.md`.

## Regras de evidência

- `PASS`: comando/teste executado com artefato ou saída verificável.
- `FAIL`: teste executado e critério não satisfeito.
- `BLOCKED`: dependência externa, credencial ou ambiente indisponível.
- `NOT_APPLICABLE`: não se aplica com evidência.
- Nunca promover suposição a `PASS`.
- Código executável prevalece sobre documentação histórica.
- Nenhum teste live sem flags de ambiente explícitas.
