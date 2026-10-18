# Tarefas e lembretes da Dashboard

## Ativar no Supabase

1. Abra `migrations/017_dashboard_tasks.sql` e confira o projeto Supabase de destino.
2. No **SQL Editor** desse projeto, execute o conteúdo completo do arquivo.
3. Atualize a Dashboard. O botão **Nova tarefa** ficará disponível quando a tabela puder ser consultada.

O arquivo é aditivo e reexecutável: cria `dashboard_tasks`, índices e proteções; não apaga nem migra os lembretes atuais. Leads vinculados a tarefas não podem ser transferidos para outro cliente sem antes remover o vínculo; isso evita tarefas presas a um lead estrangeiro. Nenhum SQL é executado automaticamente pela interface ou pelo build. A migration depende das tabelas existentes `clients` e `leads_extraidos`. A conexão server-side usa `SUPABASE_SERVICE_ROLE_KEY`, nunca exposta ao navegador.

Se o SQL ainda não foi aplicado, a Dashboard mostra o caminho do arquivo e continua exibindo os lembretes antigos. Outros erros de banco são mostrados como falhas, não como lista vazia.

## Usar

- **Nova tarefa:** escreva a atividade e escolha data/hora. Vincule um lead pela busca se necessário; pode deixar **Sem lead — tarefa livre**.
- **Pendentes:** todas as tarefas não concluídas, paginadas por vencimento. Atrasadas, até 30 minutos, próximas 24h e futuras recebem rótulos distintos.
- **Check:** conclui após salvar no banco. O horário passar não conclui a tarefa.
- **Concluídas:** histórico com data da conclusão; desmarque o check para reabrir.
- **Lápis:** altera texto, prazo ou vínculo com o lead. O link do lead abre sua ficha.
- Durante a edição, salve ou cancele antes de trocar de tarefa; isso evita descartar o rascunho por acidente. Falha ao salvar mantém o formulário preenchido.

Datas são exibidas no horário local do dispositivo e armazenadas como instante com timezone. A lista atualiza a cada 30 segundos enquanto a aba está visível e ao retornar à aba. Não envia WhatsApp, email, som ou push; não há alerta com o painel fechado.

## Lembretes existentes

Os itens em **Lembretes das fichas** continuam usando `leads_extraidos.next_follow_up` e o texto existente. O check remove a pendência do lead, sem histórico de conclusão. Crie tarefas na nova lista quando precisar de várias atividades ou histórico. Nenhuma anotação geral é sobrescrita.

Tarefas novas vinculadas a leads são gerenciadas na Dashboard; não substituem o lembrete legado exibido na ficha/Kanban. O bloco legado mostra atrasados e próximas 24h com total e lista limitada; a ficha continua acessível em **Ver leads**.

## Verificação e limites

APIs exigem sessão e restringem operações ao cliente atual, inclusive administradores. Leitura/escrita direta via chave anon é bloqueada. Não misturar tarefas com `appointments`: agendamentos têm automações de calendário/mensagens e conclusão automática incompatíveis com este fluxo.

Testes locais usam mocks de APIs e Postgres PGlite. Isso não substitui aplicar o SQL e validar criação, recarregamento, conclusão e reabertura no seu ambiente autenticado.

Verificação local em 18/10/2026, após as correções das revisões independentes:

- `npm run test -- --maxWorkers=1 --minWorkers=1`: **2.280 passaram, 31 pulados**; 128 arquivos aprovados e 18 pulados. Inclui 80 testes de tarefas (18 API, 32 validação, 9 SQL, 21 UI) e 60 de CRM/drawer (43 API, 17 UI). Cobertura percentual não medida nesta rodada.
- `npx tsc --noEmit --incremental false`, `npm run build` e `git diff --check`: aprovados. O diff tem somente avisos de conversão LF/CRLF.
- `npm run lint`: 0 erros e 1.705 avisos no projeto; ESLint focado de tarefas, CRM e drawer sem avisos.
- Revisões independentes de backend e UI revalidaram as correções sem achados impeditivos restantes. Gravação confirmada não é reportada como erro por falha posterior na busca do nome do lead; respostas atrasadas não substituem rascunhos nem atualizam outra ficha.
- Navegador isolado com componentes/CSS reais, revalidado após as correções às 22:57 UTC: criar, concluir por teclado, histórico, reabrir, foco e rascunhos passaram em **320, 768 e 1440 px**, sem overflow. Foram 54 requests interceptadas, nenhuma externa e nenhum erro JavaScript; 18 HTTP 503 eram esperados da fixture de lembretes legados. Sem Next completo, autenticação ou dados reais, baseline visual ou auditoria WCAG completa. Artefatos locais em `C:\Users\Salomão\AppData\Local\Temp\opencode\dashboard-ui-qa-20261018-final\` (`QA.md`, `report.json` e 15 screenshots).

Uma execução anterior da suíte com dois workers passou os testes, mas falhou no encerramento do Chromium do scraper (timeout do hook). As rodadas finais com um worker passaram sem alterar esse teste.

**Pendente:** aplicação manual do SQL e teste autenticado da Dashboard completa com persistência real. Nenhum banco remoto, serviço real, publicação ou commit foi acionado. A sincronização completa das fotos do WhatsApp continua pendente e não é validada por estes resultados.
