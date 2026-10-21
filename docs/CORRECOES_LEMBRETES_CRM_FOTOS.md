# Correções de lembretes, vínculo CRM e fotos

## Escopo solicitado

| Frente | Resultado verificável |
| --- | --- |
| Lembretes | Excluir tarefa pendente ou concluída com confirmação; cancelar não altera nada; falha preserva item e contadores. Remover lembrete de ficha nunca exclui o lead. |
| Chat / CRM | Identificar o lead existente do mesmo cliente e sua etapa real, inclusive personalizada, apesar da formatação do telefone. Vínculo inválido usa busca alternativa segura; ambiguidade e erro não equivalem a lead inexistente. |
| Fotos | Exibir fotos disponíveis para o número correto; sincronização manual renova fotos ausentes ou vencidas; preservar cache válido em falha; distinguir fotos atualizadas, ausência de foto, cache e erro sem anunciar sucesso falso. |

## Implementação e limites

- Reutilizar componentes, utilitários, APIs e clientes Supabase existentes; sem dependências ou migrações novas.
- Manter isolamento por cliente, validação de entradas, cancelamento, paginação e proteção contra respostas antigas e ações duplicadas.
- Preservar os arquivos locais anteriores de login, calendário e sidebar.
- Testes com dados sintéticos e serviços simulados. Sem exclusão de dados reais, acesso ao banco real, publicação ou commit.
- Fotos privadas, indisponíveis ou inexistentes no WhatsApp não podem ser recuperadas à força; a interface deve informar esse limite.

## Verificação

- Regressões focadas em Vitest: vermelho antes da correção, verde após.
- Navegador local com serviços externos bloqueados: exclusão/cancelamento/erro, etapa CRM, sincronização e apresentação das fotos; desktop e celular.
- Verificação integrada: `npm test -- --maxWorkers=2 --minWorkers=1`, `npm run build`, `npx --no-install tsc --noEmit`, `npm run lint`.
- Revisão independente dos diffs de correção antes da entrega.

## Estado

Lembretes, CRM e fotos encerrados pela revisão independente, sem achados Required/Critical pendentes. Revalidação final aprovada após os cinco fixes: 2.891 testes, build, TypeScript, lint sem erros e 22 cenários de navegador. Alterações somente locais, sem commit ou publicação.

### Reprodução inicial

- Navegador Edge headless, dados sintéticos, 1440 e 375 px, requisições externas bloqueadas.
- Widget não oferece exclusão de tarefas pendentes/concluídas; teste de interação para excluir falha por controle inexistente.
- Chat informa contato não cadastrado apesar de haver lead com telefone formatado e variante brasileira sem/com nono dígito na mesma base sintética.
- Capturas e relatório locais em `.impeccable/fixes-qa/results/before*` (ignorados pelo Git).
- Nenhum erro JavaScript ou overflow horizontal nos seis cenários iniciais. Isso não substitui a validação após as correções.

### Primeira validação (anterior à segunda rodada de fotos)

- Tarefas/lembretes: executor comprovou vermelho antes e 54 testes focados verdes depois; lint focado sem erros.
- CRM: executor comprovou vermelho antes e 42 testes focados verdes após a correção final (API 18, helper 16, sidebar 8); lint focado sem erros. A revisão identificou persistência indevida da chave canônica; corrigida com `contactCrmTransportJid`, mantendo JID/telefone reais ao criar lead e deixando a equivalência com/sem nono dígito somente para comparação. LID não é convertido em telefone.
- Edge, 320/375/768/1440 px: cancelar exclusão não envia DELETE; falha preserva tarefa e permite repetir; excluir pendente/concluída atualiza contadores; teclado funcional. Remover lembrete antigo envia somente limpeza do lembrete, nunca DELETE de lead.
- Edge, mesmas larguras: etapa personalizada aparece; consulta com falha e identidade ambígua não oferecem criação duplicada; tentar novamente recupera consulta.
- Revisão independente de tarefas encontrou diálogo inacessível com texto multilinha longo; corrigido com altura máxima por viewport e rolagem interna. Regressão de 994 caracteres vermelha antes, 32 testes do widget verdes depois; Edge 320×667 e 375×667 confirmou Cancelar e Excluir alcançáveis. Revisão dessa frente encerrada sem bloqueios.
- Fotos: executor comprovou regressões em vermelho antes e 139 testes focados verdes em 11 arquivos depois; lint focado sem erros.
- Edge, 320/375/768/1440 px: sincronização manual exibe imagem carregada/decodificada; 375 px: resultado parcial com falha não anuncia sucesso completo, ausência de foto disponibilizada pelo WhatsApp aparece separadamente.
- Total de 19 cenários de navegador aprovados, sem erros JavaScript; inclui foto HTTP 404 com fallback de iniciais. Requisições de fotos interceptadas localmente e demais serviços externos bloqueados. Relatório local em `.impeccable/fixes-qa/results/interactions.json`.
- Suíte integrada: 2.843 testes aprovados em 158 arquivos; 31 testes de 18 arquivos ignorados pelos guards de execução live. A execução começou após a correção final de CRM.
- `npm run build`: aprovado, incluindo compilação Next.js 16.3.1, checagem TypeScript e geração de 67 páginas estáticas.
- `npx --no-install tsc --noEmit`: aprovado, sem saída de erro.
- `npm run lint`: aprovado, zero erros e 1.705 avisos no projeto; não tratado como lint totalmente limpo.
- `git diff --check`: aprovado; somente avisos de conversão LF/CRLF do Git no Windows.
- Snapshot SHA-256 confirmou os 12 arquivos locais anteriores de login/calendário/sidebar sem alterações por esta correção.
- Revisão independente do CRM encerrada sem bloqueios; a conferência adicional verificou por asserts a compatibilidade do JID preservado com seleção da sessão e consulta do histórico. Revisão de fotos solicitou correções, registradas abaixo.

### Segunda rodada: achados de fotos

1. **Aliases conflitantes:** identidade exata válida prevalece sobre variante BR; JIDs explícitos conflitantes ficam separados em consulta, contagem, persistência e retorno. Fallback de variante única permanece quando não há conflito conhecido. Executor comprovou 8 falhas RED iniciais e 2 regressões adicionais, depois GREEN com 33 testes; lint focado sem erros e 14 avisos preexistentes. Revisor encerrou o achado e a revisão integrada com reproduções nas duas ordens dos JIDs, fallback único, persistência e próxima consulta; nenhum Required/Critical pendente.
2. **Drawer apagando foto preservada:** resposta com `noPhoto: 1`, `preserved: 1` e URL válida agora mantém foto na ficha/lista e informa preservação, sem anunciar foto nova. Executor comprovou RED com 9 falhas e GREEN com 32 testes do drawer; revisor confirmou preservação e proteção contra respostas antigas, encerrando o achado.
3. **Resposta antiga após trocar cliente:** descartar lote abortado antes dos callbacks, separar cancelamento manual de invalidação por tenant e impedir que conclusão antiga substitua estado/controller novos. Corrigido; 4 regressões vermelhas antes, 22 testes dos dois arquivos verdes depois. Revisor confirmou por quatro reproduções independentes o descarte durante fetch/JSON e a preservação do cancelamento manual; achado encerrado.
4. **Sync de conversas com falso sucesso:** bulk oferece modo estrito usado pela API; falhas de rede/HTTP/JSON e resposta 200 com erro/parcial não viram sucesso. A segunda chamada da lista verifica HTTP e indicadores de erro, preservando estado sem toast de sucesso. Executor comprovou 6 falhas RED da API e 4 da UI; GREEN com 52 testes em 4 arquivos, também reexecutados pelo orquestrador. Revisor encerrou o achado após reproduções independentes dos provedores e handler de conversas.
5. **Identidade de foto no drawer:** usa `getPhotoJid(remoteJid) ?? getPhotoJid(telefone)`, incluindo LID com telefone válido e prefixo `phone:+55`. Reset do indicador de busca por geração evita bloqueio ao trocar lead. Edge 375 px comprovou fallback pelo telefone e foto preservada decodificada na ficha/lista. Revisor encerrou o achado.

### Verificação da segunda rodada

- Navegador: **22 cenários aprovados**, incluindo troca de cliente durante resposta pendente (fotos/progresso antigos descartados) e cancelamento manual (lote atual aplicado, próximo lote não iniciado). Sem erros JavaScript.
- O servidor de fixtures recarregava a página quando agentes editavam arquivos, interrompendo um clique do teste de lembretes; desativado HMR apenas nesse servidor de teste. A execução completa posterior passou.
- Reexecução pelo orquestrador: 151 testes aprovados em 8 arquivos de tarefas/CRM/drawer/ciclo de fotos; outros 52 testes aprovados em 4 arquivos do bulk/API/lista de conversas.
- Todos os achados encerrados. Revisão integrada de cache/refresh, APIs, página, drawer e conversas não identificou regressões concretas.

### Revalidação final — 20/10/2026, após todas as correções

| Verificação | Resultado |
| --- | --- |
| Suíte completa | **2.891 testes aprovados em 159 arquivos**; 31 testes de 18 arquivos ignorados pelos guards de execução live. |
| Build | Aprovado, Next.js 16.3.1; compilação, TypeScript e geração de 67 páginas estáticas concluídos. |
| TypeScript separado | `npx --no-install tsc --noEmit` aprovado, sem erros. |
| Lint | **Zero erros, 1.703 avisos** no projeto; não significa ausência de avisos. |
| Navegador | **22 cenários aprovados**, zero erros JavaScript; viewports 320/375/768/1440 px e diálogos longos em 320×667/375×667. |
| Revisão independente | Lembretes, CRM e cinco achados de fotos encerrados sem Required/Critical. |
| Preservação | SHA-256 dos 12 arquivos locais anteriores idêntico; snapshot dos 45 arquivos de código locais permaneceu idêntico durante a validação final. |
| Diff e dependências | `git -c core.autocrlf=false diff --check` aprovado; sem mudanças em `package.json`, `package-lock.json` ou `AGENTS.md`. |

Logs locais: `%LOCALAPPDATA%\Temp\opencode\fixes-{all-tests,build,types,lint}.log`. Cobertura percentual não aferida nesta rodada. Checagem limitada das linhas novas não encontrou padrões de segredos; não equivale a auditoria completa.

A inspeção das capturas sintéticas confirmou controles e mensagens legíveis nos exemplos revisados; não é uma certificação de acessibilidade, comparação visual completa ou execução da aplicação autenticada em produção.

Nenhum serviço real foi chamado nesta segunda rodada. Sem exclusão real, migration, commit, push ou publicação. Fotos privadas/indisponíveis continuam sujeitas ao que o WhatsApp disponibiliza.
