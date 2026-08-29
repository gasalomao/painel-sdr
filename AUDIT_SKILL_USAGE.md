# AUDIT SKILL USAGE

## Política

Skills são selecionadas somente após evidência concreta. O resultado de uma skill é tratado como orientação; toda conclusão material exige validação independente no repositório ou por teste seguro.

## Matriz inicial

| Skill | Relevante? | Evidência | Área | Quando usar |
|---|---|---|---|---|
| codebase-onboarding | SIM, usada | Repositório desconhecido com múltiplas superfícies | mapa | Discovery e convenções |
| code-tour | PARCIAL, consultada | Há muitos entrypoints, mas não foi solicitado arquivo `.tour` | arquitetura | Usar apenas se uma CodeTour reutilizável for necessária |
| planning-and-task-breakdown | SIM, usada | Auditoria multi-pass e longa | gestão | Plano, checkpoints e critérios |
| production-audit | SIM, usada | Docker, CI, DB, workers e integrações reais | produção | Readiness e riscos operacionais |
| code-review-and-quality | SIM, usada | 262+ arquivos de produção | revisão | Passes por domínio e diff review |
| security-and-hardening | SIM, usada | Auth, multi-tenant, uploads, webhooks, IA | segurança | Threat boundaries e revisão defensiva |
| repo-scan | NÃO EXECUTADA | Skill local é bootstrap de ferramenta externa, não auditoria | descoberta | Somente com necessidade e aprovação para instalar ferramenta externa |
| gsd-map-codebase | NÃO | Mapeamento direto já produziu evidência suficiente | mapa | Somente se `.planning/codebase` trouxer benefício líquido |
| graphify / gsd-graphify | DEFERIDA | Dependências são extensas | arquitetura | Após mapa canônico, se ciclos/paths não forem resolvidos por busca estática |
| debugging-and-error-recovery | PLANEJADA | Achados ainda precisam reprodução | bugs | Para cada falha difícil e reproduzível |
| agent-introspection-debugging | SOB DEMANDA | Nenhum run de agente falhou | meta-debug | Apenas se uma investigação falhar de forma não explicada |
| doubt-driven-development | PLANEJADA | Segurança e dados exigem segunda hipótese | verificação | Revisão adversarial dos achados altos/críticos |
| verification-loop | PLANEJADA | Fixes exigirão baseline e regressão | verificação | Antes de declarar qualquer fix validado |
| delivery-gate | PLANEJADA | Auditoria terá fixes e checks | entrega | Gate final, sem auto-fix |
| agent-self-evaluation | PLANEJADA | Trabalho não trivial | self-review | Após grandes blocos e no encerramento |
| ai-regression-testing | PLANEJADA | Gemini/OpenRouter/DeepSeek/RAG confirmados | IA | Prompts, parsing, fallbacks e regressões |
| eval-harness | DEFERIDA | IA confirmada, mas rubricas ainda não mapeadas | IA | Quando fluxos críticos e datasets forem identificados |
| source-driven-development | SOB DEMANDA | Versões recentes e APIs externas | docs | Confirmar comportamento em docs oficiais antes de fix dependente de framework |
| context-engineering | SIM | 446 arquivos e múltiplas sessões possíveis | contexto | Usar `AUDIT_*` como memória operacional |
| context-budget | SOB DEMANDA | Escopo grande | contexto | Quando houver risco de contexto excessivo |
| iterative-retrieval | SIM | Revisão precisa ser por domínio/fluxo | contexto | Busca progressiva por evidência |
| strategic-compact | SOB DEMANDA | Auditoria longa | contexto | Em fronteiras de fase |
| incremental-implementation | PLANEJADA | Fixes podem tocar múltiplas camadas | implementação | Um bug/causa/teste por alteração |
| test-driven-development / tdd-workflow | PLANEJADA | Há Vitest e bugs candidatos | testes | Teste de regressão antes do fix quando seguro |
| ai-regression-testing | PLANEJADA | Há testes live e providers múltiplos | testes IA | Separar sandbox/live e verificar parsing/fallback |
| api-design / api-and-interface-design | PLANEJADA | 105 rotas REST | API | Contratos, status, validação e paginação |
| contract-first | PLANEJADA | UI/API/webhook/worker compartilham contratos | integração | Producer/consumer mismatches |
| backend-patterns | SIM | Next.js API Routes e lógica server-side | backend | Handlers, DB e integrações |
| nextjs-turbopack | SIM | Next.js 16.3.1 confirmado | build | Config/build/runtime |
| react-patterns | SIM | React 19 confirmado | frontend | Componentes e estado |
| react-testing | SIM | React + Vitest confirmados | frontend tests | Testes de componentes/hooks quando encontrados |
| react-performance | SIM | React confirmado e páginas grandes | performance | Apenas após evidência de render/bundle |
| frontend-patterns | SIM | App Router e UI confirmados | frontend | Fluxos e boundaries client/server |
| frontend-ui-engineering | PARCIAL | Há UI | UI | Bugs funcionais, sem redesign |
| frontend-a11y / accessibility | PLANEJADA | 17 páginas e componentes interativos | acessibilidade | Passagem específica de UI |
| browser-qa | BLOQUEADA POR ENQUANTO | App web existe, ambiente seguro não confirmado | E2E | Após servidor isolado e conta/test data seguros |
| browser-testing-with-devtools | BLOQUEADA POR ENQUANTO | MCP/runtime não confirmados | browser | Após ambiente isolado disponível |
| click-path-audit | PLANEJADA | UI com estados e ações complexas | fluxos | Após mapa de store/API e ambiente seguro |
| e2e-testing | PLANEJADA | Fluxos web críticos | E2E | Projetar; executar apenas isolado |
| postgres-patterns | SIM | PostgreSQL/Supabase/pgvector confirmados | banco | Schema, indexes, RLS e queries |
| database-migrations | SIM | 50 migrations e fontes divergentes | banco | Ordem, idempotência e rollback |
| redis-patterns | SIM | Redis/ioredis/BullMQ confirmados | filas | Locks, queue semantics e conexão |
| prisma-patterns | NÃO | Prisma não detectado | banco | Não usar sem evidência nova |
| mysql-patterns / clickhouse-io | NÃO | Bancos não detectados | banco | Não usar sem evidência nova |
| observability-and-instrumentation | PLANEJADA | Jobs, webhooks e providers | SRE | Logs, correlação, métricas e alertas |
| performance-optimization | PLANEJADA | Hotspots, scraping, DB e IA | performance | Após correctness/data passes |
| error-handling | PLANEJADA | 105 handlers e providers externos | confiabilidade | Trace de erro ponta a ponta |
| ci-cd-and-automation | PLANEJADA | GitHub Actions e Docker confirmados | CI | Typecheck, isolamento e release gates |
| deprecation-and-migration | SOB DEMANDA | DDL duplicado e integrações legadas | legado | Após confirmar runtime ativo |
| config-gc | PLANEJADA | ~50 env usages vs 18 no template | config | Env, defaults e configs órfãs |
| documentation-and-adrs / living-docs-governance | PLANEJADA | Docs divergem da estrutura | docs | Comparação docs/código/config |
| architecture-decision-records | NÃO AGORA | Auditoria ainda não decide arquitetura | docs | Apenas para decisões futuras aprovadas |
| code-simplification | NÃO AGORA | Sem refactor cosmético | qualidade | Somente onde simplificação reduz risco de fix |
| coding-standards | PLANEJADA | TS strict e convenções locais | qualidade | Revisão de legibilidade sem confundir estilo com bug |
| plankton-code-quality | NÃO | Implicaria hooks/auto-fix | tooling | Fora do read-only e sem necessidade concreta |
| security-auditor / gsd-secure-phase | PLANEJADA | Achados de auth/RLS/webhooks | segurança | Segunda revisão defensiva independente |
| council / council-multi-model | DEFERIDA | Nenhuma decisão arquitetural tomada | self-review | Para fixes high-risk ou ambíguos, com consentimento externo quando aplicável |
| gsd-code-review / gsd-debug / gsd-forensics | SOB DEMANDA | Auditoria já estruturada | investigação | Quando um achado exigir workflow persistente |
| gsd-add-tests / gsd-validate-phase / gsd-verify-work | PLANEJADA | Fixes futuros | verificação | Testes e validação pós-fix |
| gsd-audit-fix | NÃO AGORA | Não pode auto-fixar antes de Gates A–F | fixing | Somente após findings comprovados e escopo aprovado |
| 9router* | NÃO CONFIRMADA | Gateways de IA existem, integração 9Router não comprovada | IA | Não usar até evidência direta |
| ui/design/motion/brand skills | NÃO PARA REDESIGN | UI existe, mas redesign não foi solicitado | UI | Apenas bug funcional/acessibilidade específico |

## Skills específicas descartadas por falta de tecnologia

| Grupo | Skills | Decisão |
|---|---|---|
| Java/JVM | java-coding-standards, jpa-patterns, springboot-patterns, springboot-tdd, springboot-verification, quarkus-patterns, quarkus-tdd, quarkus-verification | NÃO RELEVANTES |
| Kotlin/Android | kotlin-patterns, kotlin-testing, kotlin-coroutines-flows, kotlin-exposed-patterns, kotlin-ktor-patterns, android-clean-architecture, compose-multiplatform-patterns | NÃO RELEVANTES |
| Python | python-patterns, python-testing, django-patterns, django-tdd, django-verification, django-celery, fastapi-patterns | NÃO RELEVANTES |
| PHP/Laravel | laravel-patterns, laravel-plugin-discovery, laravel-tdd, laravel-verification | NÃO RELEVANTES |
| .NET | dotnet-patterns, csharp-testing, fsharp-testing | NÃO RELEVANTES |
| Go | golang-patterns, golang-testing | NÃO RELEVANTES ao código local |
| Rust | rust-patterns, rust-testing | NÃO RELEVANTES |
| C++ | cpp-coding-standards, cpp-testing | NÃO RELEVANTES; binários externos não tornam o repo C++ |
| Perl | perl-patterns, perl-testing | NÃO RELEVANTES |
| Mobile | react-native-patterns, dart-flutter-patterns, flutter-dart-code-review | NÃO RELEVANTES |
| Frontends ausentes | angular-developer, vue-patterns, nuxt4-patterns, vite-patterns, ui-to-vue | NÃO RELEVANTES |
| Backend ausente | nestjs-patterns, mcp-server-patterns | NÃO RELEVANTES |
| Runtime ausente | bun-runtime | NÃO RELEVANTE |

## Inventário completo disponível por família

### 9Router

9router, 9router-chat, 9router-embeddings, 9router-image, 9router-stt, 9router-tts, 9router-web-fetch, 9router-web-search.

### Auditoria, qualidade, contexto e engenharia

accessibility, agent-introspection-debugging, agent-self-evaluation, agent-sort, ai-regression-testing, api-and-interface-design, api-design, architecture-decision-records, backend-patterns, browser-qa, browser-testing-with-devtools, ci-cd-and-automation, click-path-audit, code-review-and-quality, code-simplification, code-tour, codebase-onboarding, codehealth-mcp, coding-standards, config-gc, configure-ecc, context-budget, context-engineering, contract-first, council, council-multi-model, debugging-and-error-recovery, delivery-gate, deprecation-and-migration, documentation-and-adrs, doubt-driven-development, e2e-testing, error-handling, eval-harness, git-workflow, git-workflow-and-versioning, graphify, growth-log, idea-refine, incremental-implementation, inherit-legacy-style, intent-driven-development, interview-me, iterative-retrieval, living-docs-governance, loop-design-check, observability-and-instrumentation, performance-optimization, plan-canvas, plankton-code-quality, planning-and-task-breakdown, product-lens, production-audit, repo-scan, rules-distill, santa-method, security-and-hardening, shipping-and-launch, skill-scout, skill-stocktake, source-driven-development, spec-driven-development, strategic-compact, tdd-workflow, test-driven-development, unified-memory, using-agent-skills, verification-loop.

### Frontend, UI e design

awesome-design-md, banner-design, brand, design, design-system, frontend-a11y, frontend-design-direction, frontend-patterns, frontend-slides, frontend-ui-engineering, make-interfaces-feel-better, motion-advanced, motion-foundations, motion-patterns, motion-ui, react-patterns, react-performance, react-testing, slides, ui-styling, ui-ux-pro-max.

### Tecnologias específicas

android-clean-architecture, angular-developer, bun-runtime, clickhouse-io, compose-multiplatform-patterns, cpp-coding-standards, cpp-testing, csharp-testing, dart-flutter-patterns, database-migrations, django-celery, django-patterns, django-tdd, django-verification, dotnet-patterns, fastapi-patterns, flutter-dart-code-review, fsharp-testing, generating-python-installer, golang-patterns, golang-testing, java-coding-standards, jpa-patterns, kotlin-coroutines-flows, kotlin-exposed-patterns, kotlin-ktor-patterns, kotlin-patterns, kotlin-testing, laravel-patterns, laravel-plugin-discovery, laravel-tdd, laravel-verification, mcp-server-patterns, mysql-patterns, nestjs-patterns, nextjs-turbopack, nuxt4-patterns, perl-patterns, perl-testing, postgres-patterns, prisma-patterns, python-patterns, python-testing, quarkus-patterns, quarkus-tdd, quarkus-verification, react-native-patterns, redis-patterns, rust-patterns, rust-testing, springboot-patterns, springboot-tdd, springboot-verification, tinystruct-patterns, vite-patterns, vue-patterns, windows-desktop-e2e.

### GSD

gsd-add-tests, gsd-ai-integration-phase, gsd-audit-fix, gsd-audit-milestone, gsd-audit-uat, gsd-autonomous, gsd-capture, gsd-cleanup, gsd-code-review, gsd-complete-milestone, gsd-config, gsd-debug, gsd-discuss-phase, gsd-docs-update, gsd-eval-review, gsd-execute-phase, gsd-explore, gsd-extract-learnings, gsd-fast, gsd-forensics, gsd-graphify, gsd-health, gsd-help, gsd-import, gsd-inbox, gsd-ingest-docs, gsd-manager, gsd-map-codebase, gsd-milestone-summary, gsd-mvp-phase, gsd-new-milestone, gsd-new-project, gsd-ns-context, gsd-ns-ideate, gsd-ns-manage, gsd-ns-project, gsd-ns-review, gsd-ns-workflow, gsd-pause-work, gsd-phase, gsd-plan-phase, gsd-plan-review-convergence, gsd-pr-branch, gsd-profile-user, gsd-progress, gsd-quick, gsd-resume-work, gsd-review, gsd-review-backlog, gsd-secure-phase, gsd-settings, gsd-ship, gsd-sketch, gsd-spec-phase, gsd-spike, gsd-stats, gsd-surface, gsd-thread, gsd-ui-phase, gsd-ui-review, gsd-ultraplan-phase, gsd-undo, gsd-update, gsd-validate-phase, gsd-verify-work, gsd-workspace, gsd-workstreams.

### Outros utilitários instalados

agent-sort, banner-design, ck, config-gc, continuous-learning, continuous-learning-v2, customize-opencode, dev-team, dmux-workflows, ecc-guide, ecc-recipes, frontend-slides, hookify-rules, plan-canvas, slides.

## Log de uso

| Skill | Motivo | Área | Resultado | Evidência gerada |
|---|---|---|---|---|
| codebase-onboarding | Reconhecimento estruturado | mapa | Confirmou stack, entrypoints e convenções | `AUDIT_SYSTEM_MAP.md`, `AUDIT_TECHNOLOGY_EVIDENCE.md` |
| code-tour | Avaliar artefato de navegação | arquitetura | `.tour` não é necessário nesta fase | decisão registrada |
| planning-and-task-breakdown | Organizar auditoria multi-pass | gestão | Checkpoints e gates definidos | `AUDIT_PROGRESS.md` |
| production-audit | Identificar release surfaces | produção | Priorizou auth, dados, jobs, migrations e env | `AUDIT_RISK_REGISTER.md` |
| code-review-and-quality | Definir eixos de revisão | qualidade | Correctness, arquitetura, segurança e performance separados | plano de passes |
| security-and-hardening | Mapear trust boundaries | segurança | Auth, tenant, webhooks, uploads, SSRF e IA priorizados | mapa e findings preliminares |
