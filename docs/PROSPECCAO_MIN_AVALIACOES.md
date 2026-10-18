# Filtro por quantidade mínima de avaliações

## Objetivo e contrato aprovado
Na Captura e na Automação de Prospecção Sites, configurar `minReviews`: inteiro entre 0 e 2147483647, inclusive. Ausente ou 0 desativa. Aceitar negócios cujo total agregado de avaliações no Google seja maior ou igual ao mínimo, independentemente da média de estrelas ou quantidade de comentários capturados. Com filtro ativo, total desconhecido não passa.

## Como usar
Em **Prospecção Sites**, abra **Captura** ou **Automação** e preencha **Mínimo de avaliações no Google** antes de iniciar/criar. Os campos são independentes. Exemplo: `100` aceita negócios com pelo menos 100 avaliações, inclusive negativas ou sem comentário; `0` desativa. Não é necessário ligar captura de comentários nem resumo por IA.

## Implementação mínima
1. Extrair e normalizar o total já disponível nos cartões/painel do Maps; não adicionar navegação, esperas, chamadas externas ou ativar comentários/IA. Separadores de milhares e abreviações k/mil/M devem ser interpretados corretamente. Abreviações são aproximadas: evitar descarte precoce quando o arredondamento puder cruzar o mínimo; usar o painel já aberto para refinamento. Se só restar abreviação, aceitar apenas quando sua margem inferior confirmar o mínimo; um total exato do cartão não é substituído por painel abreviado.
2. Rejeitar cartões seguramente abaixo do mínimo antes de abrir detalhes; total desconhecido usa o painel já existente. Aplicar defesa final antes de salvar/contar/notificar. Não substituir total agregado por tamanho da amostra de comentários.
3. Encaminhar o mesmo campo no início e na reposição da automação. Persistir no JSON `scrape_filters`, sem migration. Automações antigas mantêm o comportamento.
4. Não encerrar automação por ausência de leads aprovados enquanto o scraper correspondente continua ativo. Manter detecção de conclusão e limites existentes.

## Estrutura e estilo
- `src/app/prospeccao-sites/page.tsx`: controles e payloads dos dois fluxos, preservando estilo local e textos em português.
- `src/app/api/scraper`, `src/app/api/automations`: validar entrada na fronteira e manter escopo autenticado.
- `src/lib/scraper-engine.ts`: pipeline de extração/filtro e persistência.
- `src/lib/automation-worker.ts`: execução inicial, reposição e progresso.
- `src/lib/__tests__`: Vitest, testes reais das funções e dependências externas simuladas. Funções exportadas tipadas, sem novos `any`.

## Verificação
- `npm test -- src/lib/__tests__/scraper-review-count.test.ts src/lib/__tests__/scraper-review-count-pipeline.test.ts`: parsing, limiares e pipeline com DOM Chromium offline. Requer Chrome/Edge/Chromium local; aceita caminho explícito em `PUPPETEER_EXECUTABLE_PATH`.
- Testar APIs, propagação inicial/reposição, legado, desconhecidos, quota e descarte antecipado sem navegação.
- `npm test`: regressão completa.
- `npx tsc --noEmit`: tipos.
- `npm run lint`: registrar limitações preexistentes sem limpeza fora do escopo.
- `npm run build`: compilação de produção, sem publicar nem alterar banco remoto.
- Verificação de navegador local quando disponível; distinguir simulação de captura real no Google.

## Evidência de DOM
Inspeção somente leitura em 18/10/2026, Edge isolado, busca `padaria Vitória ES`: cartões retornaram `(4.659)`, `(3.196)` e `(59)` em `.UY7F9`; ARIA do cartão chamou esses totais de “comentários”. O painel confirmou o mesmo total em `.F7nice [aria-label="4.659 avaliações"]`. Esse rótulo do Google é o agregado de votos, não a quantidade de comentários carregados. Barras por estrela, tópicos e totais do perfil dos autores são subconjuntos e não podem substituir o agregado.

## Resultado da validação — 18/10/2026
- Execução completa **após a correção do encerramento**: **1957 passaram, 31 ignorados, 0 falhas**, em **116 arquivos aprovados e 18 ignorados**, duração **102,88s**. Esse resultado inclui a correção final da ordem das asserções no cleanup. Os testes live continuam dependentes de opt-in; nenhum teste novo foi ignorado neste ambiente. A focada também passou **55/55**, incluindo encerramento. Nenhuma registrou timeout ou aviso de fechamento lento. Duas execuções anteriores tiveram timeout no encerramento apesar das assertions aprovadas; diagnóstico e correção estão registrados abaixo.
- Dentro da suíte: **43** testes do parser/limiar, **12** da engine com Chromium real offline, **24** do worker, **24** das APIs de automação, **18** da rota do scraper, **15** da página, além de filtros antecipados e isolamento de tenant. Cobertura percentual não foi medida.
- Após a leitura separada por `TreeWalker`, `npm run build` foi reexecutado e aprovado, incluindo TypeScript e geração de **67 páginas**; `npx --no-install tsc --noEmit` também passou. `npm run lint` reexecutado: **0 erros, 1697 warnings** preexistentes; sem limpeza fora do escopo.
- Edge real, interface e CSS reais em fixture Vite isolada, APIs/SSE simulados: Captura e Automação verificadas em **1440×1000** e **320×900**. Estados independentes, validação acessível, payloads, comentários/IA desligados e contador de leads SSE aprovados; sem erros de console ou tráfego externo. Evidências locais em `C:\Users\Salomão\AppData\Local\Temp\opencode\min-reviews-browser-qa\`.
- Inspeção final somente leitura no Google confirmou que o resumo dentro de `[role="main"]` e o controle `moreReviews` retornam **4.659 avaliações**, sem cair nas exclusões de autor/outros negócios. Isso verifica seletores, não uma captura de produção com gravação.
- Revisão independente em contexto separado reproduziu quatro casos e confirmou suas correções: nota decimal concatenada ao total, cartão exato substituído por painel abreviado, total do autor confundido com agregado e nota inteira misturada aos milhares separados por espaço. Corrigidos: token numérico estruturado, preferência por exatidão, fontes restritas ao resumo/controle agregado do negócio e leitura separada dos nós de texto. Outro negócio no feed, fallback pelo controle agregado e total legítimo `5 123` também estão cobertos.
- Falha inicial da integração offline: timeout seguido de singleton ocupado. O teste agora compartilha o navegador com contextos isolados e cancela navegação pendente no teardown; uma regressão confirma liberação e início do próximo run. Mantidos os limites de espera de 15s/5s. A fase exata do timeout original não foi registrada; a nova suíte registra etapas para diagnóstico e passou sob concorrência normal.
- Encerramento do Chromium: na versão instalada, `BrowserLauncher.closeBrowser()` aguarda CDP e `browserProcess.hasClosed()` sem deadline de saída; este último só resolve após saída **e** limpeza do perfil. O fallback de 5s não se aplica ao caminho CDP. O teste agora usa o `signal` do launcher para encerrar somente sua árvore de processos, aguarda `exit` e mantém `browser.close()` para concluir a limpeza. Também restaura os spies depois de cada caso, **após** conferir ausência de tráfego externo/chamadas HTTP e aceleração das esperas; a revisão separada detectou e corrigiu uma ordem que apagava o histórico do mock antes dessa asserção. Não aumentou o hook de 10s nem ignorou testes. Logs temporários de sucesso foram removidos; diagnóstico após 8s informa PID e fase pendente. As falhas antigas não tinham instrumentação suficiente para provar se o gatilho específico era CDP, shutdown do Edge ou limpeza do perfil; não se afirma essa causa histórica.
- O filtro acrescenta leitura local do DOM e descarte antecipado, sem navegação/espera/requisição adicional. Não houve benchmark de tempo fim a fim no Google; mínimo restritivo pode exigir percorrer mais resultados para atingir a mesma quantidade de leads aprovados.

## Limites
Preservar stealth, isolamento por cliente, filtros existentes, expansão geográfica e configuração de comentários/IA. Sem dependências novas, sem commit, sem deploy, sem migration ou serviços pagos. Nenhuma mensagem real foi enviada nem lead de produção gravado para esta verificação. Google pode alterar DOM; testes locais não equivalem a garantia absoluta sobre serviço externo.
