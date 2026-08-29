# AUDIT PROGRESS

## Estado global

- [x] PHASE 0 read-only iniciada.
- [x] Estado Git verificado: branch `main`, workspace inicialmente limpo.
- [x] Estrutura e classificação inicial inventariadas.
- [x] Manifests, lockfiles, configs, CI e Docker identificados.
- [x] Tecnologias identificadas com evidência.
- [x] Entrypoints, páginas, APIs, scripts, schedulers e worker identificados.
- [x] Testes, banco e integrações identificados.
- [x] Arquivos operacionais `AUDIT_*` criados.
- [ ] Baseline seguro executado.
- [ ] Todos os domínios revisados.
- [ ] Findings comprovados/reproduzidos.
- [ ] Fixes de baixo risco avaliados pelos Gates A–J.
- [ ] Segunda busca obrigatória concluída.
- [ ] Relatório final consolidado.

## Restrições ativas

- Não executar servidor: `src/instrumentation.ts` pode iniciar jobs mutáveis e envios.
- Não executar suite inteira ainda: testes live podem usar `.env.local`, DB, IA, navegador e rede.
- Não executar `npm run build` ainda: o prebuild pode escrever `src/lib/setup-sql.ts`.
- Não executar scripts em `scripts/` sem classificação individual.
- Não executar SQL, migrations, backfills ou recovery.
- Não executar browser E2E sem ambiente isolado e dados descartáveis.
- Não exibir valores de secrets.
- Não usar `--fix`, `--force`, `--write`, `--update` ou equivalentes.

## Plano detalhado

### Passagem 1 — Discovery e inventário

- [x] Estrutura top-level.
- [x] Contagem por área e extensão.
- [x] Classificação SOURCE/TEST/CONFIG/GENERATED/VENDOR/BUILD/UNKNOWN.
- [x] Manifests e tooling.
- [x] Docs e artefatos operacionais.
- [ ] Confirmar arquivos órfãos/dinâmicos com busca de referências.

**Critério de saída:** mapa estrutural e evidências tecnológicas persistidos.

### Passagem 2 — Arquitetura e dependências

- [ ] Traçar proxy/auth/tenant até handlers.
- [ ] Traçar UI até APIs e Supabase client-side.
- [ ] Traçar schedulers até workers e persistência.
- [ ] Traçar webhooks até efeitos.
- [ ] Traçar IA/RAG até providers e DB.
- [ ] Identificar ciclos, singletons globais e dependências invertidas.

**Critério de saída:** flows críticos documentados com path:line.

### Passagem 3 — Regras de negócio

- [ ] Auth, sessão, admin e impersonation.
- [ ] Isolamento multi-tenant.
- [ ] Chat, contatos e identidade JID.
- [ ] Campanhas e targets.
- [ ] Automação e follow-up.
- [ ] Appointments e calendário.
- [ ] Leads, organizer e prospecção.
- [ ] Agentes, IA, RAG e knowledge base.
- [ ] Configurações e credenciais.

**Critério de saída:** regras, invariantes, duplicações e testes existentes mapeados.

### Passagem 4 — Bug hunt

- [ ] Null/undefined/empty/defaults.
- [ ] Boolean logic e condições invertidas.
- [ ] Datas, timezone e limites.
- [ ] Paginação, filtros e ordenação.
- [ ] Silent failures e sucesso incorreto.
- [ ] Producer/consumer e schema/runtime mismatch.
- [ ] Procurar globalmente cada padrão confirmado.

### Passagem 5 — Dados e migrations

- [ ] Fonte canônica do schema.
- [ ] Ordem e idempotência das migrations.
- [ ] RLS/grants/policies no repo.
- [ ] Tenant constraints e unique keys.
- [ ] Foreign keys/cascades/nullability/defaults.
- [ ] Índices e queries críticas.
- [ ] Dados órfãos e compatibilidade de versões.
- [ ] Plano read-only para validar DB real.

### Passagem 6 — Concorrência e idempotência

- [ ] Timers in-process em múltiplas réplicas.
- [ ] Claims atômicos de campaign/automation/follow-up/appointment.
- [ ] Webhook replay e eventos fora de ordem.
- [ ] Double click/retry de APIs mutáveis.
- [ ] BullMQ retries/deduplication.
- [ ] Lost updates e locks.

### Passagem 7 — Error handling e observabilidade

- [ ] Catches vazios/silenciosos.
- [ ] Status HTTP e contratos de erro.
- [ ] Timeouts, retry e circuit breaking.
- [ ] Contexto, correlation IDs e logs.
- [ ] PII/secrets em logs.
- [ ] Diagnóstico de incidentes críticos.

### Passagem 8 — Performance

- [ ] N+1 e overfetching.
- [ ] Listas sem paginação.
- [ ] Hot loops e serialização.
- [ ] Render/client bundle de páginas grandes.
- [ ] Scraper CPU/memória/processos.
- [ ] IA tokens/custos/fallbacks.
- [ ] Cache correctness antes de otimização.

### Passagem 9 — Segurança defensiva

- [ ] Authn/authz por rota sensível.
- [ ] Tenant ownership por query e referência.
- [ ] Webhook assinatura e fail-closed.
- [ ] SSRF e redirects.
- [ ] Upload MIME/tamanho/path/bucket.
- [ ] XSS/HTML output.
- [ ] CSRF/cookies/security headers.
- [ ] Secrets no working tree e histórico, sempre mascarados.
- [ ] Provider credentials e encryption/access.
- [ ] Prompt injection, output validation e RAG isolation.

### Passagem 10 — Testes

- [ ] Classificar todas as 69 suites por unit/integration/live.
- [ ] Identificar side effects por suite.
- [ ] Identificar skip/only/weak assertions/mocks.
- [ ] Selecionar subset seguramente offline.
- [ ] Executar baseline offline focado.
- [ ] Executar lint e typecheck read-only.
- [ ] Decidir se build pode ser executado sem mutação; usar diff antes/depois.
- [ ] Mapear gaps por fluxo.

### Passagem 11 — Código morto e qualidade

- [ ] Imports/exports sem referência.
- [ ] Rotas e workers não iniciados.
- [ ] Feature flags e config órfãs.
- [ ] TODO/FIXME/HACK/XXX/TEMP/LEGACY/WORKAROUND.
- [ ] `@ts-ignore`, eslint-disable, skip e only.
- [ ] Complexidade e arquivos gigantes, sem confundir com bug.

### Passagem 12 — Configuração e dependências

- [ ] Env usados versus `.env.example`.
- [ ] Fail-fast de env obrigatórios.
- [ ] Config global versus tenant.
- [ ] Dependências unused/duplicadas.
- [ ] Audit de advisories sem auto-fix.
- [ ] Engines/runtime compatibility.
- [ ] Lockfile e CI reproduzível.

### Passagem 13 — Documentação versus realidade

- [ ] Arquitetura.
- [ ] Endpoints.
- [ ] Banco e migrations.
- [ ] Workers.
- [ ] Deploy/restore.
- [ ] Variáveis de ambiente.

### Passagem 14 — UI, acessibilidade e E2E

- [ ] Componentes e formulários por inspeção.
- [ ] Loading/empty/error/permission states.
- [ ] Labels, teclado, foco e semântica.
- [ ] Ambiente browser seguro definido.
- [ ] Fluxos críticos executados sem efeitos reais, se possível.

### Passagem 15 — Cross-component inconsistencies

- [ ] UI/API contract.
- [ ] API/schema.
- [ ] Worker/schema.
- [ ] Webhook/channel/tenant.
- [ ] Docs/runtime.
- [ ] Build/container/dependency engines.

### Passagem 16 — Segunda opinião

- [ ] Revisor de código independente.
- [ ] Revisor de segurança independente.
- [ ] Revisor de testes independente.
- [ ] Resolver divergências com evidência.

### Passagem 17 — Segunda busca obrigatória

- [ ] Arquivos pouco revisados.
- [ ] Fluxos não executados.
- [ ] Hipóteses abertas.
- [ ] Falhas parciais.
- [ ] Operações não idempotentes.
- [ ] Regras duplicadas.
- [ ] Código que funciona apenas por acidente.

## Baseline planejado

Executar somente após classificar side effects:

1. `npx tsc --noEmit --incremental false` — esperado read-only; confirmar que não grava cache.
2. `npm run lint` — sem `--fix`.
3. Subset Vitest comprovadamente offline por arquivos explícitos.
4. `npm test` apenas após excluir risco de suites live não protegidas.
5. `npm run build` apenas com checkpoint Git e sabendo que `sql:build` pode escrever arquivo.
6. Dependency audit read-only, sem fix, após baseline.

## Gate obrigatório por finding corrigível

- [ ] GATE A: causa raiz confirmada.
- [ ] GATE B: reprodução ou evidência forte.
- [ ] GATE C: baseline relevante registrado.
- [ ] GATE D: menor escopo definido.
- [ ] GATE E: risco classificado.
- [ ] GATE F: rollback definido.
- [ ] GATE G: menor implementação possível.
- [ ] GATE H: teste pós-fix.
- [ ] GATE I: regressão relacionada.
- [ ] GATE J: revisão integral do diff.

## Checkpoints

### Checkpoint A — Discovery

- [x] Workspace preservado.
- [x] Nenhuma integração executada.
- [x] Stack comprovada.
- [x] Mapa inicial persistido.

### Checkpoint B — Baseline

- [ ] Testes offline identificados.
- [ ] Lint registrado.
- [ ] Typecheck registrado.
- [ ] Build classificado/executado com diff zero ou desfeito apenas para artefato próprio.

### Checkpoint C — Findings

- [ ] Cada crítico/alto tem evidência independente.
- [ ] Hipóteses não aparecem como confirmadas.
- [ ] Reprodução segura documentada.
- [ ] Padrões semelhantes pesquisados globalmente.

### Checkpoint D — Fixes

- [ ] Apenas fixes low-risk automáticos.
- [ ] High-risk marcado `REQUIRES HIGH-RISK CHANGE`.
- [ ] Teste de regressão por bug relevante.
- [ ] Diff mínimo.

### Checkpoint E — Encerramento

- [ ] Todas as caixas relevantes revisadas.
- [ ] Áreas não validadas explícitas.
- [ ] Diffs revisados.
- [ ] Riscos residuais explícitos.
- [ ] Relatório final gerado.

## Baseline de verificacao (2026-08-28)
- npm test: 646 passed / 1 skipped / 0 failed (52 arquivos; 17 suites live fora do default via vitest.config.ts exclude)
- npm run lint: 0 errors / 1611 warnings (politica any documentada em eslint.config.mjs)
- npx tsc --noEmit: LIMPO (erros anteriores eram artefatos stale .next/dev/types, removidos; next.config ignoreBuildErrors mascara um codebase atualmente type-clean)

## Correcoes aplicadas (Gates: diff minimo, reversivel, testes/lint/tsc verdes)
1. vitest.config.ts � exclude de 17 suites live do default run (aplicada por subagente, revisada e mantida)
2. eslint.config.mjs � ignores: public/** (vendor minificado), scripts/recover-sdr-chats.js (CJS one-off)
3. conversation-list.tsx � reset imgError via ajuste no render (React 19 set-state-in-effect)
4. prospeccao-sites/page.tsx � CountdownCard: Date.now() fora do render (purity), tick via rAF+interval, caso vazio derivado no render
5. ajustes-tab.tsx � reset de chosen/orderLoaded no render (padr�o React 19), effect s� de fetch
