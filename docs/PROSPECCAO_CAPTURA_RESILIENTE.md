# Captura resiliente por meta — Prospecção Sites

## Objetivo e contrato
Corrigir o ciclo de captura compartilhado pelo Captador Maps e pelas automações, priorizando Prospecção Sites. O pedido define três invariantes do mesmo fluxo: contar somente leads novos válidos, percorrer regiões próximas sem afrouxar o nicho/filtros e retomar o progresso persistido.

Critérios de aceite:
1. Uma automação com meta 20 e 13 capturados mantém 13/20 após pausa, erro, reinício do processo ou clique em retomar; solicita somente o restante e não recaptura nem redispara os anteriores.
2. O vínculo persistido dos leads e seu cliente são a fonte de verdade. Nunca usar somente contagem em memória ou timestamp de uma tentativa reiniciada.
3. Uma busca repetida evita leads já existentes no CRM do cliente e prioriza caminhos ainda não esgotados. A memória nunca atravessa clientes ou combinações incompatíveis de nichos/filtros.
4. Ao faltar resultado, expandir para áreas próximas em ordem geográfica determinística, preservando o nicho e todos os filtros. Não saltar arbitrariamente para capitais distantes.
5. Abaixo da meta, ausência temporária de novos resultados não vira DONE nem inicia disparo como se a meta tivesse sido atingida. Preservar progresso, registrar motivo e reagendar com espera limitada por tentativa; pausa manual sempre prevalece.
6. Erros de persistência não podem virar sucesso ou fazer o lead contar antes da gravação confirmada. Capturas concorrentes e callbacks antigos não podem sequestrar o estado de outra execução.
7. Exibir progresso atual/meta e falhas de start/pause na interface, atualizando sem exigir F5.

## Estrutura e estilo
Next.js 16.3 / React 19 / TypeScript / Supabase / Puppeteer stealth / Vitest já instalados. Código em `src/lib/scraper-engine.ts`, `src/lib/geo-regions.ts`, `src/lib/automation-worker.ts`, APIs existentes e `src/app/prospeccao-sites/page.tsx`. Testes em `src/lib/__tests__`. Reutilizar persistência existente quando suficiente; nenhuma dependência nova.

Padrão de escopo: `db.from("automations").select("*").eq("id", automationId).eq("client_id", clientId)`. Tipos explícitos em novas funções exportadas; mensagens de interface em português.

## Plano e verificação
1. Reproduzir reset de progresso, término prematuro e repetição/expansão em regressões offline.
2. Corrigir checkpoint e retomada; corrigir planejamento/deduplicação e contagem confirmada; integrar scheduler.
3. Atualizar contador e ações da interface; verificar cenários de 13/20, retomada, erro e pausa.
4. Revisão independente, suíte completa, TypeScript, lint e build. Chromium offline para DOM real com rede/DB simulados; não confundir com validação de produção.

Comandos: `npm test -- --maxWorkers=1 --minWorkers=1`; `npx --no-install tsc --noEmit`; `npm run lint`; `npm run build`.

## Casos de regressão obrigatórios
- Pausar em 13/20, retomar e capturar 7: total final 20, sem zerar baseline nem incluir capturas de outra automação.
- Repetir nicho/região com todos os primeiros resultados no CRM: não contam; percorrer nova área e salvar somente os inéditos.
- Região sem aprovados, resultado abaixo do mínimo, sem telefone/site/Instagram incompatível: manter todos os filtros e expandir sem DONE falso.
- Falha temporária de navegação ou escrita: preservar checkpoint, respeitar espera e permitir pausa; falha de banco não consome candidato definitivamente.
- Pausa durante tentativa/retry, reinício enquanto navegador fecha e callback atrasado: comando mais recente prevalece; nenhuma execução toma a de outra automação/cliente.
- Município ambíguo/estado por extenso/bairro e município pequeno: não inferir capital distante como cidade vizinha; manter a origem ou pedir correção quando não puder resolver com segurança.
- Meta atingida: não coletar excedente, não iniciar dois disparos, não reenviar aos mesmos alvos na retomada.

## Decisões de implementação
- Checkpoint em `automations.scrape_filters`, com IDs de leads confirmados, sessão/tentativa, lease/heartbeat, fase de retomada e horário de retry. Atualizações comparadas com o snapshot atual (JSONB/status/fase/timestamp) e repetidas de forma limitada em caso de concorrência.
- Marcador de sessão em `leads_extraidos.business_details._automationCapture`, na mesma inserção do lead, permite reconciliar queda entre inserção e checkpoint. Não inferir propriedade por crescimento da tabela ou data de inserção.
- Automações antigas sem vínculo comprovável não podem recuperar automaticamente os 13 apenas pela contagem: preservar o valor e informar necessidade de revisão, sem anexar leads arbitrários do CRM.
- Municípios/coordenadas locais de fonte versionada e licença MIT, sem API geográfica em tempo de execução. Expansão por distância em linha reta à origem resolvida, mantendo o estado e sem afrouxar os filtros. Isso não representa distância de estrada nem garante estoque de empresas.
- Cada tentativa tem orçamento finito de consultas; novas tentativas usam memória persistida e espera, sem ocupar indefinidamente o scheduler. Falhas externas não marcam uma região como esgotada.
- Configuração de público/meta fica protegida após início da sessão; mudar o público exige nova automação, não reutilizar os capturados antigos.

## Limites
Sempre: preservar isolamento por cliente, opt-out, prevenção de reenvio, filtros e stealth. Nunca: fabricar leads, reduzir filtros para completar a meta, afirmar disponibilidade infinita do Google, executar loop ocupado ilimitado ou marcar falha como sucesso. Sem commit/push, deploy, migração remota, mensagens reais ou serviços pagos sem nova autorização. Testes não escrevem no banco real.

Não se promete "perfeito" ou "nunca falha": o comportamento verificável é recuperação segura, progresso durável e conclusão verdadeira. Fontes externas podem acabar, bloquear ou mudar DOM; isso deve ficar explícito, recuperável e sem perda dos leads já capturados.

## Validação inicial
Antes das alterações: 2.416 testes aprovados, 31 testes live ignorados por opt-in; 138 arquivos aprovados e 18 ignorados. Nenhuma captura real ou mensagem enviada.

## Validação final e auditoria independente

### 1. Auditoria e endurecimento (Revisão adversária independente)
- **Máquina de estados (`automation-worker.ts`)**:
  - Resolução de retomada segura caso pausa ou reinício ocorra durante inteligência/preparação do disparo (`phase: "dispatching"` com `campaign_id: null`): em vez de erro de duplicidade que travava permanentemente a automação, a preparação do disparo é retomada sem duplicar mensagens.
  - Prevenção de estouro de cabeçalho HTTP 414 (URI Too Long) no PostgREST: filtro de deduplicação migrado para memória local com paginação de índice por cursor `.gt("id", cursor)`.
  - Chunking de `remoteJids` em lotes de 100 na fase de follow-up, evitando falhas de rede em campanhas volumosas.
  - Proteção contra falhas transitórias na Evolution API durante canonicalização de números WhatsApp.
- **Motor de captura e CRM (`scraper-engine.ts`)**:
  - `checkCrmDuplicate`: tratamento explícito de duplicatas múltiplas no CRM (`PGRST116`) sem abortar o scraper com exceção não tratada.
  - `placeUrlKey`: normalização imune a parâmetros de tracking (`?entry=ttu`, `?entry=ts`, `?authuser=0`, `?hl=pt-BR`) mantendo preservado o identificador canônico do Google Maps.
  - Prevenção contra leads órfãos no banco: verificação atômica de continuidade (`run.keepRunning && activeRun === run`) imediatamente antes do `INSERT`, com higienização de `_automationCapture` em caso de rejeição no checkpoint.
  - Eliminação de travamentos ao retomar busca: detecção de novos cartões no DOM para descarte de `seenURLs` acumuladas no cursor sem disparar falso timeout de progresso.
  - Sinalização de término precoce no bloco `finally` (`run.isStopping = true`) para impedir condições de corrida com novas requisições de início de captura.
- **Teardown do Chromium em testes**:
  - Adicionado encerramento forçado determinístico com timeout de 30s no hook de finalização offline, resolvendo a concorrência sob carga total.

### 2. Resultados dos testes automatizados
- **Suíte focada de captura e automação**: 19 arquivos, 581 testes aprovados (100% de sucesso).
- **Suíte geral do repositório**: 148 arquivos, 2.694 testes aprovados (31 testes live ignorados por opt-in).
- **Verificação visual e comportamento em navegador (Puppeteer offline)**:
  - Resolução 1440px e 320px validadas com sucesso (`capture-progress-browser-qa.mjs`).
  - Progresso 13/20 preservado, badge de contagem visível, travas de ação concorrente e polling de estado ativos.
- **Compilação TypeScript (`tsc --noEmit`)**: 0 erros.
- **Análise estática (`eslint`)**: 0 erros (avisos legados mantidos intactos).
- **Git**: 0 commits realizados, 0 pushes, nenhuma alteração enviada a servidores remotos.
