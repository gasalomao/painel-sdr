# AUDIT TEST MATRIX

## Política de execução

Nenhuma suite será executada antes de sua classificação. O setup global lê arquivos de ambiente locais; testes live podem acessar DB, IA, navegador, filesystem e APIs externas.

## Inventário

- Runner: Vitest 2.1.9.
- Config: `vitest.config.ts`.
- Include: `src/**/*.test.ts`.
- Ambiente: Node.
- Suites: 69 arquivos `*.test.ts`.
- Setup: `src/lib/__tests__/setup.ts` e `setupEnv.ts`.
- Coverage: não configurada.
- Browser E2E: framework não encontrado.

## Classes

| Classe | Critério | Execução atual |
|---|---|---|
| UNIT-OFFLINE | mocks completos; sem env real, rede, DB, subprocesso ou filesystem mutável | PODE após inspeção |
| INTEGRATION-LOCAL | filesystem/temp ou módulo real, sem serviço externo | PODE em temp após inspeção |
| LIVE-OPT-IN | usa serviço externo apenas com guard explícito | NÃO por padrão |
| LIVE-UNGUARDED | pode usar env real/DB/rede sem guard inequívoco | BLOQUEADA |
| UNKNOWN | side effects ainda não classificados | BLOQUEADA |

## Suites live identificadas inicialmente

- `live-audit-router.test.ts`
- `live-e2e-automacao.test.ts`
- `live-e2e-fluxo-completo.test.ts`
- `live-e2e-prospeccao.test.ts`
- `live-openrouter-audio.test.ts`
- `live-openrouter-free-probe.test.ts`
- `live-openrouter-free-probe2.test.ts`
- `live-openrouter-full-matrix.test.ts`
- `live-probe-free-models.test.ts`
- `petshop-live-validate.test.ts`
- `reviews-ai.e2e.test.ts`
- `test_agent_process.test.ts`
- `test_find_session.test.ts`
- `test_webhook_process.test.ts`
- `campaign-pregen.live.test.ts`
- `scraper-restart-race.live.test.ts`

A lista é heurística até inspeção das 69 suites.

## Baseline seguro proposto

| Check | Comando | Mutação esperada | Estado |
|---|---|---|---|
| Typecheck | `npx tsc --noEmit --incremental false` | nenhuma | PENDENTE |
| Lint | `npm run lint` | nenhuma sem `--fix` | PENDENTE |
| Unit subset | `npx vitest run <arquivos explícitos>` | nenhuma após inspeção | PENDENTE |
| Suite completa | `npm test` | risco externo atual | BLOQUEADA |
| Build | `npm run build` | pode escrever setup-sql | BLOQUEADA até sandbox/diff |
| Dependency audit | `npm audit --json` ou análise dedicada | nenhuma; rede de registry | PENDENTE |

## Matriz por fluxo

| Fluxo | Unit | Integration | E2E | Edge cases prioritários | Estado |
|---|---|---|---|---|---|
| Auth/login | existente a mapear | DB live possível | ausente | senha inválida, rate limit, inactive, revoked | PENDENTE |
| Proxy/internal secret | a localizar/criar | não necessário | opcional | ausente, vazio, incorreto, correto/allowlist | GAP PROVÁVEL |
| Tenant ownership | parcial | DB policies não validadas | ausente | recurso de tenant B | GAP |
| Admin | a mapear | DB | ausente | não-admin, anônimo, auto-delete | GAP |
| Evolution webhooks | existente a mapear | live opt-in | ausente | assinatura, replay, unknown instance | PENDENTE |
| Cloud webhook | a mapear | live | ausente | signature missing, tenant, duplicate | GAP |
| Chat/send | parcial | live provider | ausente | double click, provider timeout | PENDENTE |
| Campaign | várias suites | live AI/DB | ausente | claim concorrente, retry | PENDENTE |
| Automation/follow-up | várias suites | live DB/provider | ausente | resposta simultânea, two replicas | PENDENTE |
| Appointment/calendar | parcial | Google live | ausente | timezone, conflict, token expiry | PENDENTE |
| IA combos/providers | várias suites | live providers | ausente | malformed output, timeout, fallback | PENDENTE |
| RAG | a mapear | vector DB | ausente | tenant isolation, empty KB | GAP |
| Scraper | suites live | Puppeteer | UI ausente | restart, stop, tenant, SSRF | BLOQUEADO |
| Build SQL | a localizar/criar | temp sandbox | não aplicável | missing source, deterministic output | GAP |
| BullMQ | a localizar | Redis local | não aplicável | retry, duplicate, no Redis | GAP |

## Edge case checklist transversal

- [ ] zero/negativo/mínimo/máximo.
- [ ] vazio/null/undefined.
- [ ] Unicode/caracteres especiais/string enorme.
- [ ] duplicado/replay/double click.
- [ ] duas operações simultâneas.
- [ ] tenant/recurso inexistente ou alheio.
- [ ] timeout/perda de conexão/resposta parcial.
- [ ] cache antigo.
- [ ] virada de dia/mês/ano/timezone.
- [ ] eventos fora de ordem.
- [ ] processo morre após efeito externo e antes do commit local.

## Critério para habilitar suite completa

- [ ] Toda suite classificada.
- [ ] `*.live.test.ts` excluída por padrão ou guardada antes de imports/side effects.
- [ ] Env de teste não carrega credenciais reais por padrão.
- [ ] DB de teste é isolado e descartável.
- [ ] Providers reais permanecem opt-in explícito.
- [ ] Puppeteer/live browser permanece opt-in.
