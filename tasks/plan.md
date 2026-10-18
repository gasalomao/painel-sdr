# Implementation Plan: CRM de Leads (Ficha, Lembretes e Fotos WhatsApp)

Estado e verificações atuais em `tasks/todo.md`; as fases abaixo preservam o plano original, não representam conclusão das fotos. Ativação das tarefas em `docs/DASHBOARD_TASKS.md`.

## Ampliação atual aprovada — tarefas livres e por lead

1. Persistência aditiva `dashboard_tasks`, constraints, índices e RLS; SQL local idempotente e testes PGlite, sem aplicar no Supabase real.
2. APIs autenticadas de listagem paginada, criação, edição, conclusão/reabertura e busca de lead do tenant. Validar datas de calendário e entradas, verificar erros e zero linhas.
3. Transformar widget existente em lista de tarefas com formulário, check, histórico, estados por proximidade e atualização leve. Preservar lembretes legados e mostrar claramente a necessidade do SQL quando ausente.
4. Testes de regressão das APIs/UI, tipos, lint, build e revisão independente. Nenhum commit. Fotos são uma pendência separada; não ampliar este recorte.


## Correção de fotos antes do envio ao GitHub — aprovada

1. Remover fallback global/entre provedores nos caminhos de fotos do CRM, cache e sincronização. Resolver conexão pelo cliente da sessão, inclusive administrador.
2. Validar JIDs/URLs, preservar foto e timestamp em falhas; erro de persistência não conta como atualização. Cache positivo de 24h e negativo de 1h.
3. Paginar todos os leads por ID, 40 registros por requisição, até 5 chamadas simultâneas, timeout por chamada. A interface segue o cursor, mostra contagens e interrompe os próximos lotes ao cancelar.
4. Testes offline de isolamento/falhas/paginação/cancelamento, revisão independente, tipos, lint e build. Commit e push para `origin/main` autorizados pelo pedido de envio para EasyPanel; não aplicar SQL nem chamar a Evolution real.

## Overview
Implementação do escopo aprovado em 18/10/2026: ficha lateral profissional do lead (`LeadDrawer`), anotações duráveis em `observacoes`, lembretes comerciais visíveis no lead e na Dashboard (`next_follow_up`), e fotos de perfil do WhatsApp obtidas e sincronizadas em lotes via cache de `contacts` sem armazenamento binário no banco de dados.

## Architecture Decisions
1. **Ficha em Painel Lateral (`LeadDrawer`)**:
   - Escolha aprovada pelo usuário. Desliza à direita sem desmontar o Kanban.
   - O Kanban mantém seu estado e seus 21 testes aprovados sem alteração estrutural no arraste.
2. **Reaproveitamento de Schema Atual (Zero Migrations no banco real)**:
   - Anotações: coluna existente `leads_extraidos.observacoes` (TEXT).
   - Lembretes: coluna existente `leads_extraidos.next_follow_up` (TIMESTAMPTZ) formatada em ISO UTC.
   - Fotos: coluna existente `contacts.profile_pic_url` vinculada por `client_id` + `remoteJid`.
3. **Segurança Multi-tenant Estrita**:
   - Todas as mutações e leituras sensíveis usam rotas server-side protegidas com `requireClientId`.
   - Remoção de vazamentos cross-tenant em `/api/contacts/sync-avatars` e `/api/leads/save`.
4. **Performance e Cache de Fotos**:
   - Cache com TTL de 24 horas no banco (`contacts.profile_pic_fetched_at`).
   - Sincronização em lotes paginados no backend, sem loop paralelo descontrolado no browser.
   - Nenhum download de arquivo binário; apenas URLs válidas são registradas.

---

## Task List

### Phase 1: Segurança e Contratos de Backend
- [ ] Task 1.1: Proteger rotas de Leads e Avatares contra vazamento multi-tenant (`/api/leads/save`, `/api/contacts/sync-avatars`).
- [ ] Task 1.2: Endpoints de Anotações e Lembrete do Lead com validação de `client_id` e atualização atômica.
- [ ] Task 1.3: Endpoint de sincronização de fotos em lotes com rate limit, validação de posse da instância e cache negativo.

### Checkpoint: Backend & Segurança
- [ ] Testes unitários de isolamento e validação de tenant aprovados.

### Phase 2: Interface da Ficha do Lead (`LeadDrawer`)
- [ ] Task 2.1: Criar componente `LeadDrawer` com abas (Visão Geral, Anotações, Lembretes) e atalhos rápidos (WhatsApp, copiar telefone, Maps).
- [ ] Task 2.2: Bloco de Anotações com gravação assíncrona, confirmação e estado de salvamento.
- [ ] Task 2.3: Bloco de Lembretes do Lead com seleção de data/hora, marcação de concluído e reagendamento.

### Checkpoint: Ficha Funcional
- [ ] Abertura pelo Kanban e pela Lista; testes de interação e acessibilidade aprovados.

### Phase 3: Fotos do WhatsApp & Kanban
- [ ] Task 3.1: Exibir foto do WhatsApp (com fallback elegante de iniciais) no `LeadDrawer` e nos cartões do `KanbanBoard`.
- [ ] Task 3.2: Botão de Sincronizar Fotos na barra de ferramentas de `/leads` com indicador de progresso e relatório final.

### Phase 4: Lembretes na Dashboard
- [ ] Task 4.1: Criar widget `DashboardFollowUpsWidget` no painel principal listando retornos atrasados e agendados para hoje.
- [ ] Task 4.2: Integração de atalho para abrir o lead diretamente na ficha a partir da Dashboard.

### Checkpoint Final
- [ ] Suíte de testes completa aprovada (`npm run test`).
- [ ] Build sem erros (`npm run build`).
- [ ] Lint sem erros impeditivos (`npm run lint`).
