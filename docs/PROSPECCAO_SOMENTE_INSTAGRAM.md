# Filtro Somente com Instagram

## Objetivo e contrato aprovado
Adicionar **Somente com Instagram** em Captura e Automação de Prospecção Sites. Aprovado pelo usuário: usar o link de perfil informado no Google Maps, sem pesquisar no site ou abrir Instagram. Não confirma existência/atividade da conta remotamente.

- Campo `filterWithInstagram?: boolean`: ausente/false mantém comportamento anterior; true exige perfil identificado no painel do negócio.
- Estados independentes dos dois formulários; combinar por E com telefone, site, duplicidade e `minReviews`, sem ligar comentários/IA.
- Validar booleano nas APIs e entrada da engine, sem converter strings/números por truthiness.
- Persistir em `scrape_filters.filterWithInstagram`, preservando campos e marcadores no PATCH; propagar no início e reposição da automação.
- Perfil precisa ter domínio Instagram legítimo e caminho de usuário; rejeitar domínio parecido, menção na query, home, login, arquivos reservados, posts/reels e links de autores/outros negócios. Decodificar o segmento de usuário uma única vez antes de validar, rejeitando escapes inválidos e separadores adicionais. Reaproveitar o DOM já carregado. Redirecionamento explícito do Google pode ser normalizado localmente; sem navegação.
- Atribuição ao negócio: aceitar links da região informativa identificada pelo nome do negócio e controles de endereço/telefone, ou do campo `authority` do próprio painel. Não aceitar links soltos em perguntas/recomendações só por estarem no painel. Sem contato reconhecível, não presumir Instagram.
- Sem perfil confirmado, descartar antes da coleta profunda de comentários e, por defesa, antes de salvar/contar/notificar. Só aprovados preenchem quota.
- Não interromper por inatividade enquanto engine correspondente está ativa; preservar correções anteriores.
- Preservar definição preexistente de “sem site”: se o Maps informar Instagram no botão Website, esse botão continua contando como site para esse filtro. Não reinterpretar silenciosamente o filtro anterior.

## Estrutura, stack e estilo
Next.js 16.3.1, React 19, TypeScript 5, Vitest 2, Puppeteer instalado. Preservar padrões locais, textos em português, sem novos `any`.
- `src/app/prospeccao-sites/page.tsx`: checkbox acessível, estado/payload separados.
- `src/app/api/scraper/route.ts`, `src/app/api/automations/route.ts`, `src/app/api/automations/[id]/route.ts`: fronteiras autenticadas.
- `src/lib/scraper-engine.ts`: extração e filtro antecipado/final.
- `src/lib/automation-worker.ts`: início/reposição.
- `src/lib/__tests__`: testes reais com fronteiras externas simuladas; DOM Chromium offline.

Exemplo do contrato: `scrape_filters: { minReviews: 100, filterWithInstagram: true }` exige ambos. Funções exportadas com retorno explícito; URL validada com `URL`, não substring.

## Plano e tarefas
1. Engine: testes de links/escopo/filtro falhando; normalização mínima local e filtro antecipado/final; verificar testes e Chromium offline.
2. APIs e worker: testes de booleanos, legado, PATCH e reposição; implementar propagação sem migration.
3. UI: testes de independência, valor padrão/payload e acessibilidade; acrescentar controle no padrão existente.
4. Revisão independente, regressão completa, tipos, lint, build e navegador local; registrar resultados e limites abaixo.

## Comandos e estratégia de teste
- `npm test -- src/lib/__tests__/scraper-filters-early.test.ts src/lib/__tests__/scraper-review-count-pipeline.test.ts`
- `npm test -- src/lib/__tests__/scraper-route-isolation.test.ts src/lib/__tests__/automations-min-reviews-api.test.ts src/lib/__tests__/automation-worker-min-reviews.test.ts src/lib/__tests__/prospeccao-min-reviews-ui.test.tsx`
- `npm test`
- `npx --no-install tsc --noEmit`
- `npm run lint`
- `npm run build`
Cobrir URL válida/inválida, escopo do negócio, combinações, legado, booleanos inválidos, persistência, reposição, quota e ausência de chamadas adicionais. Navegador local: página/CSS reais e serviços simulados; não declarar integração com produção.

## Limites
Sempre preservar mudanças locais anteriores, stealth, isolamento por cliente, filtros, comentários/IA. Pedir antes de mudar esquema, dependências ou critério aprovado. Nunca commitar, publicar, migrar banco real, enviar mensagens, gravar leads de produção ou chamar serviços pagos neste trabalho.

## Como usar
Em **Prospecção Sites > Captura** ou **Automação**, marque **Somente com Instagram** em Filtros Automáticos. Cada formulário mantém sua escolha. Desmarcado não restringe por Instagram. Exemplo: mínimo 100 + Instagram aceita apenas negócios com pelo menos 100 avaliações e perfil identificado no Maps. Não é necessário ativar comentários/IA.

## Resultados — 18/10/2026
- Engine/helper: ciclo vermelho/verde comprovado. Execução focada inicial: 72 testes aprovados, incluindo 32 de URL e 16 de DOM Chromium offline. Foram acrescentados depois cenários para comentários profundos ligados, persistência do perfil e interação com botão Website; incluídos na regressão final.
- APIs/worker: 41 falhas esperadas antes da implementação; depois 117 testes aprovados nas três suítes focadas. Abrange booleanos inválidos, legado, PATCH preservado e reposição.
- Página real em jsdom: 20 testes aprovados, com 5 casos novos para o filtro.
- Navegador Edge real, página/controles/CSS reais em fixture Vite com serviços simulados: 1440×1000 e 320×900 aprovados. Padrão desligado, alternância por Space, label associado, independência entre abas e payloads com Instagram/minReviews verificados; comentários/IA não foram ligados. Sem overflow horizontal, erros de console ou requisições externas. Oito screenshots e `report.json` em `C:\Users\Salomão\AppData\Local\Temp\opencode\instagram-browser-qa\`. Três screenshots inspecionadas visualmente (Captura mobile e Automação desktop/mobile); sem baseline de comparação visual automatizada.
- Verificação final após as correções: `npx --no-install tsc --noEmit --incremental false` aprovado. ESLint focado do helper/testes aprovado; agente de APIs/worker também validou tipos e lint: zero erros, 27 avisos preexistentes no escopo.
- `npm run build`: reexecutado e aprovado após as correções, com TypeScript. ESLint completo final: **zero erros, 1697 avisos preexistentes**, mesmo total anterior; executado por `node node_modules/eslint/bin/eslint.js --format json --output-file <arquivo temporário>` (o encaminhamento de argumentos pelo `npm run lint -- ...` falhou neste shell). Nenhuma alteração fora do escopo no build.
- **Regressão completa final: 2113 aprovados, 31 ignorados, zero falhas**, em 118,42s; 117 arquivos aprovados e 18 ignorados. Pipeline Chromium offline: **20/20**, sem timeout de hook ou aviso de limpeza lenta. Execução sem build/lint nem carga artificial concorrentes. `git diff --check` aprovado.
- Primeira regressão completa: 2059 aprovados, 31 ignorados e 1 falha de timeout no novo cenário Chromium de cinco painéis, além de timeout no afterAll. Rodou simultaneamente com build/lint; diagnóstico aos 8s localizou espera na **limpeza do perfil**, depois da saída do processo. O caso novo usava o padrão de 5s, enquanto os cenários Chromium anteriores usam 20s; alinhado ao limite existente, sem mudar deadlines de navegação nem timeout do hook. Segunda execução completa, sem build concorrente: **2060 aprovados, 31 ignorados, zero falhas**, 117 arquivos aprovados e 18 ignorados, em 112,47s; Chromium 18/18, sem aviso de limpeza lenta. Isso não prova ausência de sensibilidade a carga. Diagnóstico isolado confirmou `EBUSY` nos arquivos LevelDB do perfil temporário após abort imediato no Windows; sob carga, retries recursivos podem exceder 10s. Teardown corrigido para iniciar shutdown gracioso e abortar só a árvore própria se continuar ativa após 2s, aguardando integralmente `browser.close()` e limpeza. Sem aumento do timeout do hook; revisão independente aprovou o teardown. Uma execução posterior coincidiu com carga artificial do diagnóstico e não foi usada como baseline. Todos os processos/perfis experimentais foram encerrados/limpos.
- Revisão independente de UI/APIs/worker: aprovada sem novos bugs; reexecução offline das quatro suítes com **137/137** aprovados (UI 20, rota scraper 29, APIs 40, worker 48). Revisão inicial da engine/helper encontrou três P2 reproduzidos: links de terceiros no painel, login/arquivo reservado aceitos e perfil percent-encoded rejeitado. Corrigidos com testes vermelhos antes: contatos limitados ao bloco informativo/authority, caminhos reservados bloqueados e decodificação única. Execução focada após correções: **127/127** (helper 83, Chromium 20, filtros 11, isolamento 13). Nova revisão independente aprovada: **157/157** nas quatro suítes helper/pipeline/filtros/contagem, mais seis fixtures independentes com callback DOM exato de produção e zero requisições. Regressão completa após os últimos ajustes aprovada conforme resultado final acima. Nenhum achado concreto pendente nas revisões.
- Inspeção somente leitura no Maps em três negócios confirmou `role="region"`, `aria-label="Informações de <nome>"`, controles `data-item-id="address"`/`phone:...` e Instagram em `a[data-item-id="authority"]`. Sem executar engine, gravar leads ou abrir Instagram. Estrutura de outras versões/idiomas do Maps continua sujeita a mudança.

## Limites da evidência
DOM do Maps é simulado nos testes Chromium; não houve nova captura no Google com gravação nem validação remota da conta Instagram. A presença real de um Instagram sem link no Maps não pode ser inferida. Não houve benchmark fim a fim: filtro não acrescenta navegação/espera/requisição, mas pode exigir percorrer mais resultados para preencher a quota.
