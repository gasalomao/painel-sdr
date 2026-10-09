## Checkpoint de continuidade — 08/10/2026

**Estado atual canônico:** início de `docs/SITE_STUDIO_HANDOFF.md`,seção **RETOMADA AUTOMÁTICA**. Usuário pediu salvar tudo para retomar com “quero continuar de onde parou”. Retomar diretamente,sem pedir que reconte a conversa. Os registros antigos abaixo são históricos,não substituem esse checkpoint.

- **Concluído no recorte:** preview candidato/last-good,retenção durante falhas iniciais,promoção sem remontar iframe,canal com origem/source/UUID/versão,Error Boundary recuperável,preparação/incomplete/timeout seguros,viewport estável,JSON/CSS/SVG,diagnóstico JSX `class`/`for`,criação/retomada em memória e preservação de parcial gratuita.
- **Última evidência coletada:** `bw5shjvdc` exit0,**1607 testes passaram,31 skipped,91 arquivos passaram**,33.77s;coverage lib/sites **84% linhas/statements,85.19% branches,89.13% funções**;diffcheck aprovado. `brsqa6ysj`:47 tools,tsc/lint aprovados após SVG camelCase. Browser anterior18 jornadas×2=**36 aprovadas**,sem retries. Cobertura não inclui componentes/página/API/provider compartilhado;não implica cada arquivo≥80%.
- **Ponto exato de parada:** `scripts/site-editor.browser.ts` recém-criado com2 testes preliminares,**NÃO executado/tipado/lintado/revisado**. Ainda excluído do testMatch e sem fixture Editor/aliases Next. Próximo integrar a página real ao harness sintético,sem copiar lógica polling,e corrigir teste dirty para provar fetch/resposta tardia real. Botão “Atualizar estado” sozinho pode apenas consultar deployments. Architect falhou API,sem plano entregue;nenhuma tarefa conhecida pendente.
- **Live:** edição de fontes Cohere gratuita aprovada;criação completa NÃO aprovada. Parcial NVIDIA em `test-results/site-creation-nemotron.json.partial.json` tem `class` em TSX e telefone inventado;NÃO reparada/typechecked/buildada/renderizada/QA aprovada. Não ampliar quota nem repetir criação cegamente;usar parcial para recuperação controlada.
- **Ainda falta:** browser Editor polling/canônico/dirty/stale/revisão/terminal/cancelamento;assets privados/renovação URLs;QA reprovado com binários/histórico;snapshots/lease;revisões finais;vulnerabilidades;criação live completa e validação do projeto existente. Projeto real bloqueado por link `/sites/<projectId>` e tenant autenticado,sem descobrir tenants ou recriar o site.
- **Limites:** E2B0/3;sem commit/publicação/migration remota/provisionamento/restart worker;sem fonte gerada no host. Diferenças locais preservadas. Sem servidor conhecido deixado intencionalmente rodando. Build anterior ao novo teste Editor;não declarar produto inteiro pronto.

## Histórico — 07/10/2026: confiabilidade e preview incremental

**Passagem de trabalho completa:** `docs/SITE_STUDIO_HANDOFF.md` (pedido, arquivos modificados nesta sessão, decisões, autorizações, falhas, pendências e próximo comando). `AGENTS.md` aponta para esse arquivo para outras IAs encontrarem o estado sem esta conversa. Atualizar o handoff em cada incremento.

Plano aprovado em `~/.claude/plans/modular-brewing-pudding.md`. Usuário autorizou até **3 execuções E2B no total**, Nemotron gratuito e diagnóstico no projeto Casa do Agricultor existente; falta receber o link `/sites/<projectId>`. Sem autorização para modelos pagos, publicação, provisionamento ou migration remota.

### Retomada verificada após compactação

- Baseline corrigida: assets fixture precisa executar patch real; redesign não preserva identidade explicitamente substituída; QA counters null rejeitados; fixtures SQL incluem017; attempts externos do provider ignorados e ledger local preservado.
- Guarda de inspeções repetidas (aviso3/parada6 por argumentos+workspace), prosa final somente após gates e estado estruturado de retomada (etapa, paths, diagnóstico, próxima ação). Checkpoint precede telemetria para evitar perder patch confirmado. Testes RED/GREEN de cada defeito; últimos focados agent/worker168 passam, TypeScript aprovado.
- Suíte completa passou antes do último ajuste de ordem de persistência; números exatos nos logs de teste e no handoff. Build de produção passou antes do estado estruturado e mudanças do preview; reexecutar ao finalizar.
- Lint do código `src scripts sandbox`:0 erros,1633 avisos. `npm run lint` raiz falhou ao percorrer worktrees/copias vendor; não mexer nessas cópias sem autorização. `git diff --check` encontrou blank line preexistente ui-helpers.ts318, removida; revalidar.
- Revisões TypeScript (ledger), code-reviewer (loop e persistência) concluídas sem achados após correção. Revisão ampla segurança ainda pendente por falhas de API dos agentes. Sem cobertura instalada, sem navegador/live;0/3 E2B.
- Preview parcial: erro renderizado via textContent; provider não remonta por tamanho/revisão em patches; indicador compara conteúdo inclusive mesma-length. Testes asset-preview28 e tsc passam; HMR no browser ainda não validado. Runtime continua CRA adaptado; endpoint/polling de checkpoint e last-valid-preview pendentes.
- Próximo incremento: endpoint de rascunho tenant-scoped, atualização incremental e proteção do editor manual; manter gates honestos. Criação live/Nemotron aguardam fixture e escopo real, não realizados.

### Última verificação deste incremento

- **1511 testes passaram,31 skipped**,88 arquivos passaram; PGlite incluído. TypeScript aprovado, build de produção aprovado (24 avisos de tracing preexistentes), lint focado0 erros e diffcheck aprovado.
- Endpoint de rascunho implementado na rota files com `run_id`, no-store/ETag, tenant/projeto/revisão e run exato. Página atualiza somente preview no polling e mantém edição manual/revisão canônica intactas. Races identificadas por revisão React corrigidas, sem navegador ainda.
- Troca textual única de nó JSX inteiro pode executar sem IA, preservando patch/checkpoint/build/QA; casos ambíguos seguem modelo. Imports locais ausentes identificados em memória. Fixture75KB com erro linha1046 corrigida por patch sem alterar demais bytes.
- **Teste live Nemotron falhou**: catálogo confirmou preço0/tools;5 chamadas de chat na tentativa efetiva,4 respostas com ferramentas, última falha. Nenhuma evidência final de edição/criação, renderização ou QA visual. Sem fallback pago, E2B/publicação/projeto real alterado.0/3 E2B usados. As2 tentativas anteriores pararam antes chat por incompatibilidade de prompt/budget do script, corrigida.
- Pendentes: browser/HMR/last-valid-preview, runtime async errors, cobertura≥80% (provider ausente), criação Casa do Agricultor e recuperação real com escopo autenticado. Não entregar como “perfeito” ou completamente validado. Mudanças só passam a valer no worker após reinício controlado; nenhum processo foi reiniciado nesta sessão.

### Incremento — 08/10/2026: diagnóstico QA privado e falha de infraestrutura

- Relatório diagnóstico QA agora acompanha checkpoint confirmado, com hash do candidato, classificação/estágio/logs/revisão visual e limites explícitos. Preservado antes de telemetria e na retomada por outro modelo; rejeita corrupção/campos binários. Sem associar QA do candidato à revisão válida, sem migration.
- Infraestrutura/timeout/cancelamento não provocam correções inúteis de fonte nem novas chamadas IA. Revisão válida permanece intacta. Relatório completo com screenshots/artefatos no histórico de builds ainda pendente.
- **1556 testes passaram,31skipped**,89 arquivos passam; TypeScript/diffcheck/build finais aprovados,24 avisos tracing preexistentes. Lint final0erros3warnings preexistentes. Segurança curta concluída sem defeito confirmado após corrigir perda do QA visual intermediário (RED/GREEN); TypeScript apontou listas esparsas/assinatura/readonly, corrigidos (RED/GREEN),reavaliação falhou por API/watchdog. Duas revisões gerais falharam por API/watchdog,sem aprovação geral. Cobertura percentual e browser continuam não executados.
- Sem live adicional,E2B0/3,sem projeto real alterado,publicação,migration remota,commit ou worker reiniciado. Detalhes e arquivos no handoff.

### Incremento — 08/10/2026: erros assíncronos no preview

- Bootstrap isolado captura `window.error`, `unhandledrejection` e falhas síncronas; banner único com texto limitado fora da raiz React. Cleanup HMR remove listeners/banner/nós HTML próprios, preservando estilos Sandpack. Sem novo canal de mensagens ou dependência.
- Regressões RED/GREEN via VM somente do bootstrap confiável,sem executar fontes geradas:async,promessas,conversões hostis,texto2000,limpeza e head sem acúmulo. Suíte atual **1560 passaram,31skipped**,89 arquivos passam; TypeScript/lint focado/diffcheck/build finais aprovados (lint0erros0warnings,build24warnings tracing preexistentes).
- Code-reviewer/segurança aprovaram recorte; React reviewer identificou head duplicado,corrigido e reavaliado. Não equivale a browser:React19 reportError/HMR real,último preview válido,Vite e cobertura percentual continuam pendentes. Sem live/E2B/commit/publicação/restart.

### Incremento — 08/10/2026: recuperação de snapshot anterior

- Nova execução pode recuperar primeiro snapshot íntegro entre5 recentes da mesma base/tenant/projeto,com aviso explícito. Mesma run prioriza seu próprio orçamento e bloqueia corrupção,sem regredir consumo. Erro DB não aciona fallback; chunks vinculados ao run do marker,índices únicos/canônicos.
- Regressões RED/GREEN e mock com order/limit reais. Suíte atual1583passaram31skipped após6regressões metadata notes/designDirection inválidos; TypeScript reviewer confirmou fix restrito. Gates finais tsc/lint/diffcheck/build aprovados (lint0erros2warnings preexistentes,build24warnings tracing). Segurança restrita sem achados;code-reviewer aprovou loaders após primeira falha API. Sem prova de DB real/coverage/browser para fallback.
- Sem browser/cobertura percentual/live,E2B0/3,sem commit/migration remota/publicação/restart. Próximo:preview last-valid e browser/compatibilidade Vite; detalhes de corrupção/limites no handoff.

### Incremento — 08/10/2026: leitura Unicode sem estouro de resposta

- Read limita página JSON completa a30KB,preserva linhas/codepoints,continuação exata e arquivo original. Valores null/inseguros e offset dentro emoji rejeitados;linha gigante usa caracteres. Regressões RED/GREEN com concatenação de Unicode/escapes/CRLF fiel.
-1598 testes passaram,31skipped;TypeScript/lint focado/diffcheck aprovados. Build aprovado24warnings tracing preexistentes;segurança final falhou por API/watchdog,sem aprovação;code-reviewer e TypeScript aprovaram recorte. Browser/e2e runner falhou por API;consulta direta confirmou ausência Playwright/agent-browser local/global,sem navegador executado. Sem live/E2B,0/3;demais pendências no handoff.

### Incremento — 08/10/2026: Chromium autorizado e preview real

- Usuário autorizou instalar Playwright/Chromium. Novo `npm run sites:test-preview` roda fixture sintética via Vite loopback,sem Next/env real/DB/IA/E2B;virtual source só no iframe isolado.
- **4 testes browser passaram32.6s**:same-length troca sem src iframe mudar,retenção de último render durante erro sintaxe/restauração,tablet768/mobile390 sem overflow,timer/promessa com alert/reload. Mobile anunciava390 mas renderizava374,corrigido moldura430;banner modeopen permite testes acessíveis sem alterar segurança iframe.
- Retenção nativa Sandpack resolve caso sintaxe,não comprova todos crashes React/Vite/assets. Reviews React/security restritos aprovados;geral scripts falhouAPI em3tentativas,sem aprovação geral do harness. Gates finais1598testes31skipped,TypeScript/lint focado0erros/diffcheck/build aprovados (24warnings tracing preexistentes).
- Audit produção apontou9vuln(1critical Next16.3.1);sem auditfixforce/upgrade automático. Host teste não inicia Next. Sem publicação/commit/migration/E2B0/3/restart. Detalhes de falhas intermediárias no handoff.

### Incremento — 08/10/2026: recuperação React19 e diagnóstico HMR

- Baseline4browserPASS45.1s e1598offlinePASS31skipped. Novas regressões reproduziram perda de DOM em crash render/efeito e alerta obsoleto após corrigir primeira criação inválida. Retenção nativa variou entre execuções; NÃO é garantia de last-good.
- Bootstrap agora limpa somente diagnóstico anterior no HMR `check`, mantendo listeners/head. Cleanup remove status handler. Tentativa inicial em `apply` apagava erro novo: runtime Sandpack avalia antes de emitir apply por módulo; reviewer identificou ordem real, regressão RED confirmou e fix `check` passou34unit. Não limpar em idle/timeout para ocultar erro.
- Harness ampliado para render/efeito, dois ciclos de falha/restauração, primeira criação render/sintaxe inválida; observação de retenção separada dos asserts de recuperação. Identidade do nó iframe verificada além de src após achado MEDIUM corrigido. Viewport aguarda preview inicial e confirma aria-pressed para não aceitar clique perdido. Sem candidate/last-good ainda.
- Gates do código HMR final:1600testesPASS31skipped,90arquivos;buildPASS24warnings tracing preexistentes;tsc/lintfocado0erros/diffcheckPASS sequencial. Tsc concorrente com build falhou uma vez por .next/types ausentes temporariamente;sequencial passou. Browser final após identidade e optimizeDeps.entries:9PASS1FAIL `bpv8k0dk6`1.4min;alerta pós-crash render intermitente não apareceu. Run anterior falhou efeito,intermediária10PASS. Não declarar browser aprovado;instrumentar aplicação snapshot/reload/compilação antes de repetir. Identidade iframe/recuperação2ciclos/primeira criação e4originais passaram na última run.
- Code-reviewer e React aprovaram delta final;security reavaliou `check` sem achados. TypeScript reviewer aprovou somente versão inicial apply;reavaliação final check falhouAPI. Review amplo inicial do harness falhouAPI;posterior restrito concluiu e confirmou fix identidade. TDD-guide falhouAPI,RED/GREEN executado diretamente. Sem coverage percentual/IA/E2B(0/3)/dados reais/commit/publicação/migration/restart/novas dependências. Próximo:plano focado candidate/last-good e expansão JSON/CSS/SVG/assets,conforme handoff.

### Incremento — 08/10/2026: edição live com outro modelo gratuito

- Usuário pediu continuidade até entrega validada e autorizou testes com modelos gratuitos OpenRouter/NVIDIA. Mantidos limites sem fallback pago/publicação/migration remota/commit;E2B0/3.
- Baseline offline reexecutado:1600PASS31skipped (`bja2hchit`,19.85s).
- Catálogo público confirmou preços0 e tools de `cohere/north-mini-code:free`. Script existente `test-site-free.ts` concluiu exit0 (`bf6xfrsl2`):9requests físicos incluindo catálogo,59119tokens conservadores;troca textual e cor por patches exatos,demais bytes preservados. Fontes apenas:sem build/render/QA visual/persistência DB/criação. Falha anterior Nemotron permanece histórica,não corrigida ou aprovada por este resultado.
- Diagnóstico Chromium e plano last-good em análise;nenhuma mudança de runtime neste ponto. Não declarar entrega completa.

### Incremento — 08/10/2026: cobertura e lifecycle do operador

- Provider coverage-v82.1.9 instalado sob pedido de liberdade para finalizar validação;vitest.config escopo src/lib/sites e thresholds80. Medição real (`bm4oiah0p`):83.96%linhas/statements,89.13%funções,85.09%branches;sem componentes/página/API/provider compartilhado.
- Instrumentação confirmou reload do operador e perda do snapshot:aria-pressed voltou false (`bvyw76e1n`,9PASS1FAIL). Anexo enums-only persistente no processo do teste,sem URLs/logs brutos. Review inicial apontou status bruto e perda de história,reparados;reavaliação geral falhouAPI.
- Server fixture imutável com watch:null;fontes virtuais continuam HMR no iframe.20browserPASS (`br02r0exf`,1.3min),assert1navegação operador por jornada. Essa aprovação antecede novo last-good.
- Viewport:RED de identidade confirmou desmontagem tablet;três providers substituídos por uma superfície estável,dimensões dinâmicas. Review React apontou recorte100%,RED confirmou,largura completa+rolagem corrigiu. Teste geometria foi ajustado para parar no primeiro ancestor rolável (não chamar recorte de página rolável). GREEN viewport+tsc/lint (`b0r4m8t42`);nova revisão final pendente.
- Last-good:novos REDs obrigatórios de retenção em crash render e sonda commit/efeito. Implementação de dois runtimes e interceptação createRoot em desenvolvimento;35unit passaram,primeiro browser candidato em andamento. Sem afirmar last-good aprovado.

### Incremento — 08/10/2026: candidato isolado e última montagem aceita

- Dois runtimes no máximo,candidato com snapshot immutable eUUID;origem/source/schema/version fencing;promoção mantém nó do candidato,sem executar fonte no host. Bootstrap intercepta createRoot CJS antes main real eProbe efeito+task+2rAF evidencia montagem inicial. Não usa done como prontidão. Garantia limitada:erros futuros/assíncronos/Suspense não têm rollback automático após promoção.
- REDs render retenção e sonda confirmados;review React achados HIGH caughtError/incomplete foram corrigidos e revisados. Catch de preparação não derruba accepted;reload candidato conserva anterior;timeout pausa hidden;listener continua depois promoção. Security apontou3achados corrigidos(strictstatus/versionlayout/markerúltimo),reavaliação bloqueada worktree unverifiable. Ainda faltam testes adversariais dedicados e revisão geral/TypeScript final.
- `bn61ydt20`:tsc/lintPASS+12browserPASS54.3s,incluindo retenção render/efeito/sintaxe/incomplete,primeira falha,ErrorBoundary,viewport identidade/geometria e async. `bg2imo6wz`:1603PASS31skipped,coverage85.18%branches/83.96%linhas/89.13%funções no lib/sites. `b7862s6ro`:buildPASS.
- Runner criação/retomada em memória novo com2testsGREEN e review geral restrito aprovado. Duas tentativas CLI falharam ANTES catálogo por imports server antes dotenv;corrigidos imports agent/models/prompts dinâmicos. Live Cohere seguinte confirmou catálogo,2chats,40845tokens conservadores e parou:teto60k incompatível reserva16k de criação. Teto criação explícito160k (máximo),edição default60k,10requests10min mantidos;RED confirmado,próximo gate/live em andamento. Nenhum sucesso de criação declarado.

### Incremento — 08/10/2026: regressões adversariais e criação interrompida

-18jornadas×2 **36browserPASS2.5min** (`bwp37mib1`),semretries. Promoção mantém iframe+estado;málformed conserva pending;stale capture removido realmente;timeout semroot descarta;HTMLmarker/HTMLinválido preservamaccepted;JSONCSSSVG naturalWidth/CSS reais. Tsc posterior falhou inferência fixture,tipado WebsiteFiles;`bad40ephd`tsc/lint/diffPASS. Reviews React e geral final curtos aprovados;securityfixes confirmados por geral final.
- Criação live ainda NÃO aprovada:Poolside transporteFAIL3chats63921;Cohere8kFAIL4chats85165;NVIDIA lightningfree timeoutAbortError7chats152610/10min. Snapshot editado preservado somente fontes em `test-results/site-creation-nemotron.json.partial.json`;inclui class em TSX e telefoneinventado,apesar de syntaxPASS. Não ampliarquota/retrycego nem apresentar parcial como criação concluída.
- Diagnóstico mínimo AST class/for em tagsHTML React intrínsecas,sem alterarfontes/custom/webcomponents:RED confirmado e48focadosGREEN+tsc/lint (`bjteyquja`). Build/suitecoverage pós-helper em andamento `bami8of5a`;reviewhelper `a1aca371f2a6b482b` em andamento. Sem IA/E2B build para essasfontes. E2B0/3.
- Script parcial preservação agora captura falha filesystem sem substituir erro original;reviewMEDIUM originoufix. Próximo:diagnóstico tipo/contatosinventados,recuperação de fixture mantendo arquivos,QA browser do editorpolling eassetsprivados. Projeto real continua semlink/tenantautenticado.

### Histórico do primeiro incremento (antes da execução de testes):
- Contrato compartilhado de orçamento aceita campos opcionais de QA mantendo checkpoints legados; antes o agente enviava seis campos e a persistência aceitava exatamente quatro.
- Retry da mesma execução preserva orçamento; nova execução explícita recupera arquivos/pedido sem herdar consumo da run anterior. Quotas globais permanecem no banco.
- Ferramentas leem linhas numeradas por padrão, validam intervalos e mantêm modo de caracteres explícito; busca aceita filtro `path`.
- Validação estática adiciona diagnóstico sintático via TypeScript instalado, somente em memória e sem execução de fontes, com linha/coluna/contexto.
- Regressões adicionadas em `src/lib/sites/__tests__/tools.test.ts` e `worker.test.ts`.

**Bloqueio de verificação:** chamadas Agent/PowerShell/WebFetch recusadas pelo classificador do auto mode com `cc/claude-opus-4-5-20251101 is temporarily unavailable`. Nenhum teste desta sessão executado; não afirmar RED/GREEN, cobertura, build ou revisão aprovados. Nenhuma chamada live de IA/E2B, leitura remota de logs ou alteração do site existente nesta sessão. Preview/HMR, endpoint de rascunho, guarda de loops, diagnóstico durável e fast path ainda pendentes.

Próximo passo: executar `npm test -- src/lib/sites/__tests__/tools.test.ts src/lib/sites/__tests__/worker.test.ts src/lib/sites/agent.test.ts`, corrigir regressões e seguir o plano. Obter o link do projeto antes de consultar dados reais. Preservar todos os diffs preexistentes; sem commit.

---

## Atualização — 05/10/2026: continuidade entre modelos

Checkpoint durável do agente após cada ferramenta e edição extraída: arquivos completos, pedido pendente, última nota de progresso, assets e direção de design. Usa mensagens internas fragmentadas (abaixo do limite SQL de 64.000 caracteres) e marcador de conclusão gravado por último. A leitura recupera apenas snapshots completos do mesmo tenant/projeto/revisão; edição manual ou conclusão que avança a revisão impede recuperação de estado antigo. Mensagens privadas de checkpoint ficam fora do chat e do histórico enviado ao modelo. Falha de persistência interrompe a execução. Nenhuma migration remota necessária.

A seleção de modelo vale para o próximo pedido: aguardar ou cancelar a execução atual, selecionar o modelo e enviar “continue”. É necessário reiniciar o worker para carregar o código novo; execuções anteriores a esta mudança não têm checkpoints retroativos. Resposta ainda não recebida do provedor e escrita ainda não confirmada pelo banco não têm garantia de recuperação. O preview permanece na revisão concluída até a próxima conclusão; checkpoints são rascunhos internos.

Validação: 1.306 testes offline passaram (31 skipped), incluindo falha de provedor seguida de retomada com outro modelo, arquivos grandes/Unicode, isolamento de tenant/projeto/revisão e falha de gravação. Verificação final: TypeScript aprovado; lint global sem erros (1.642 avisos preexistentes); build aprovado (24 avisos de tracing fora deste ajuste); 144 testes focados reexecutados após o ajuste final; git diff --check aprovado. Sem chamadas pagas, publicação ou commit.

---

## Atualização — 05/10/2026: Otimização E2B para Máximo Uso Gratuito

Otimização do pipeline de sandbox E2B para operação com custo mínimo no plano Hobby gratuito ($100 créditos sem cartão):
1. **Runner Playwright ultra-rápido (`sandbox/site-studio/run.mjs`)**: Flags de alta performance no Chromium (`--disable-dev-shm-usage`, `--disable-gpu`, `--no-zygote`), substituição de `networkidle` (ociosidade artificial de 500ms por página) por `domcontentloaded` + `document.fonts.ready`. Tempo total de sandbox reduzido de ~25-40s para ~8-12s (gasto 3x a 4x menor de créditos por build).
2. **Timeout e Fail-Closed seguro (`build-provider.ts`)**: Timeout reduzido de 180s para 60s, evitando que eventuais travamentos consumam créditos em excesso.
3. **Provisionador com 1 comando (`npm run sites:provision-template`)**: Script `scripts/provision-site-template.mjs` que valida credenciais, compila o template com recursos ideais (2 vCPU / 2048 MB), grava `E2B_SITE_TEMPLATE_ID` no `.env.local` e faz teste de integridade da sandbox.
4. **Gates**: 1.300 testes aprovados (31 skipped), typecheck e lint sem erros. Sem chamadas pagas não autorizadas.

---

## Atualização — 05/10/2026: Impeccable integral por etapa

Integração fundamentada no upstream fixado em `87a6ab0c145adb85cbd428a99fa1377305e0818d`. Ver `docs/SITE_STUDIO_IMPECCABLE.md` para fontes, cobertura e adaptações do executor. Toggle controla prompt/ferramentas/revisão/eventos; criação carrega todos os fundamentos integrais; biblioteca completa consultável; contrato privado exigido antes de código e persistido por revisão; crítica visual exige evidências. Removidas receitas fixas por segmento. Sem migration, publicação ou chamada paga.

Gates iniciais: 1.297 testes passaram (31 skipped), TypeScript e lint focado sem erros.

Ajustes finais: (1) a direção privada é recuperada pela linhagem de revisões do mesmo tenant/projeto (até 6 níveis), então edições manuais no editor não apagam a identidade; (2) em redesign explícito a direção anterior entra como "a substituir", não "a preservar"; (3) sem build configurado, o resumo real do agente é mantido e a revisão visual Impeccable aparece como pendente.

Gates finais: `npm test` 1.300 passaram (31 skipped, inclui PGlite), `tsc --noEmit` sem erros, eslint focado sem erros (apenas avisos preexistentes). Sem migration, publicação ou chamada paga.

---

## Atualização — 05/10/2026: imagens e custo de edição

Correções e estudo detalhados em `docs/SITE_STUDIO_OTIMIZACAO.md`: ligação dos assets ao preview com renovação de URLs, intenção de logo após anexo, validação de logo omitida, patch SEARCH/REPLACE sem sobrescrita, compactação de leituras antigas e recortes explícitos de fontes. Alterações anteriores locais foram preservadas. Não houve commit, chamada paga, publicação ou migration remota.

Verificação final: suíte completa passou com 1.283 testes (31 skipped); 120 testes focados passaram após integração com alterações simultâneas na seleção de modelos; TypeScript e ESLint sem erros (1.640 warnings no lint global); lint focado final sem erros; build de produção aprovado; git diff --check aprovado. O build anterior registrou 24 warnings de tracing em áreas fora do Studio. Alterações simultâneas de gateway/aliases de assets foram preservadas; a seleção foi ajustada para não usar modelo textual em QA visual nem inventar modelo OpenRouter ausente.

---

# Site Studio — Progresso e pendências (18/09/2026)

Branch `main`, HEAD `3c3bf40`. Todas as alterações NÃO commitadas (não commitar sem pedido explícito).

## Estado verificado agora (offline)

- Suíte completa `src/lib/sites` + `src/lib/__tests__`: 75 arquivos passando, 18 skipped (dependem de env/credenciais), 1039 testes, 0 falhas.
- Teste SQL real em PGlite (`website-studio-sql.test.ts`, 31/31) roda por padrão no `npm test` — valida migration `migrations/016_website_studio.sql` inteira: quotas, claims CAS, idempotência, RLS service-role, deployments, formulário/lead atômico, RPC `website_list_recoverable_deployments`.
- Suíte de providers (`site-providers.test.ts`, 107/107): espelho das transições SQL + reconciliação Cloudflare + timeouts de rede no fluxo de publicação.
- Worker (`src/lib/sites/__tests__/worker.test.ts`, 29/29): heartbeat, renovação de lease, recuperação de deployments e shutdown.

## Verificado nesta sessão

- Quotas: reserva de tokens antes de cada chamada OpenRouter (incluindo fallbacks) com settlement pelo gasto real; builds pagos são admitidos por execução E2B antes do provider (sem dupla cobrança com `queue_build`).
- Deployments (Cloudflare): phases `reserved → version_creating → version_ready → activating`; `website_renew_deployment` renova lease a cada 60s com fencing por `claim_id`; abort ao perder claim; reconcilia versão por `deployment.id` após resposta ambígua; consulta versão ativa antes de ativar (sem POST duplicado); falha terminal `failed` só antes de `activating`.
- Formulário CRM: idempotência por chave, rate limit por projeto e IP, criação de lead atômica com origem `website` e dedup por `(client_id, remoteJid)` derivado do telefone.
- Worker: heartbeat ocioso via `website_claim_next_run` (~3s), renovação de lease durante execução, health real em `getWebsiteIntegrations`.
- Worker — recuperação de deployments travados (pendência antiga #1, resolvida): loop dedicado a cada 60s via RPC `website_list_recoverable_deployments` (paginação keyset `p_after_id`, lotes de 5, preserva lease ativa), chamando `resumeSiteDeployment` com CAS e timeout de run; erros não abortam o ciclo; encerramento limpo no shutdown (`src/lib/sites/worker.ts:202`).
- Provider de deployment: chamadas Supabase do fluxo de publicação (claim, leitura, checkpoints, finish, renew) usam `AbortSignal.any([signal, AbortSignal.timeout(10_000)])` — corrige vazamento de abort/cancel no resume.
- Gates rodados: `npm run lint` (0 erros), `npx tsc --noEmit --incremental false` (0 erros), `npm run build` (ok — `src/lib/setup-sql.ts` regenerado com a migration 016), `git diff --check` (limpo, apenas avisos CRLF).
- Docs sincronizadas (18/09): `SITE_STUDIO_PROVIDERS.md` agora documenta `version_creating`, a machine monotônica de phases, `website_renew_deployment` (lease 15-300s, fencing por claim), `website_list_recoverable_deployments` (keyset, lotes de 5) e o `website_submit_form` real (remoteJid derivado do telefone + dedup `ON CONFLICT` — comportamento canônico coberto pelos testes PGlite). `idempotency_key` verificada: bruta em `publishSite` (`deployment-provider.ts:397`) e nos dois RPCs (016:861, 1018) — docs corretas. `SITE_STUDIO.md` não cita mais `website_agent_runs`.
- UI — pendências antigas #4 resolvidas (18/09):
  - Skills do projeto: builtins são `always`/`automatic` por design e `selected_skill_ids uuid[]` impede marcá-las sem migration; painel do projeto agora explica isso e aponta o caminho (duplicar skill padrão na biblioteca com ativação Manual).
  - Undo/redo do editor: mudanças externas de `files` (ação do agente, restauração, salvar) agora empilham o snapshot anterior no `undoStack` (`site-files-panel.tsx`) — Ctrl+Z volta ao estado pré-mudança como rascunho.
  - Assets/URLs assinadas: bug real — `listWebsiteAssets` retornava linhas cruas sem assinar, então os thumbs do chat nunca renderizavam após recarregar (upload recém-feito funcionava por assinar no POST). Agora assina apenas os `ready`; statuses pending/failed/deleting seguem visíveis sem URL. Teto conhecido: TTL de 300s; a lista reassina ao remontar a página.
  - `GET /builds`: screenshots base64 completos saem apenas no build mais recente e nos builds da revisão atual (thumb da lista de sites + checagem de reuso de publicação); demais builds retornam `screenshots` vazio e a UI já tratava ausência ("Aprovada com ressalvas", fallback de letra).
- Gates re-rodados pós-correções de UI: `npm run lint` (0 erros), `npx tsc --noEmit --incremental false` (0), `npm test` (75 arquivos, 1039 testes, 0 falhas; assets 17/17), `npm run build` (ok).

## Pendências (o que falta)

1. **Credenciais — READY — AWAITING CREDENTIALS:** `E2B_API_KEY`, `E2B_SITE_TEMPLATE_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SITES_WORKER_ENABLED=true`. Migration nunca aplicada em banco real; fluxo E2E real (criar→conversar→validar→publicar→copiar URL) não executado.
2. **Browser QA:** Playwright não instalado no repo; não usar o Puppeteer do Painel para testar código gerado.
3. **Exemplos Aurora/Norte:** só gerar com opt-in explícito (chamadas pagas).
4. **Revisão independente de segurança/UX/custos.**

## Retomar

- Testes: `npm test` (vitest, uma passada).
- Worker: `npm run sites:worker`.
- Gates: `npm run lint` → `npx tsc --noEmit --incremental false` → `npm run build` → `git diff --check`.
- Chaves da sessão: SQL `ses_f4e5acbe2ffemAhEFc7MZ6femv`, skills/assets/prompts `ses_f4e5acbbdffekPVunMExc4GA5T`, worker/agente `ses_f4e5acb98ffe36q4NXNta7KAMw`, UI `ses_f4e5acb71ffeZtZGY30X3Xollg`, reconciliação quotas `ses_f4d52f96affeUyKB48GOyd10Sb`, deployments `ses_f4d52f91cffey0qTX7HCOhRuzg`.
