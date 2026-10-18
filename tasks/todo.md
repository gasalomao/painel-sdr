# Tarefas: CRM de Leads

## Atual — lista de tarefas aprovada

- [x] SQL aditivo idempotente `017_dashboard_tasks.sql`, RLS e testes PGlite locais. Não aplicado no banco real.
- [x] APIs de tarefas livres/por lead: listar com totais/paginação, criar, editar, concluir/reabrir; isolamento e validação testados.
- [x] Dashboard: texto e prazo, checkbox, histórico, destaque até 30 min, filtros, paginação, falhas e atualização sem consultas agressivas.
- [x] Preservar lembretes antigos e mostrar necessidade de SQL se tabela ausente.
- [x] Revisões independentes de UI/backend sem achados impeditivos restantes; testes offline, tipos, lint e build aprovados.
- [ ] Ativação real: aplicar manualmente `migrations/017_dashboard_tasks.sql` no projeto correto e validar persistência em sessão autenticada. Exige autorização; não executado.

Verificação final em 18/10/2026: **2.280 testes passaram**, 31 pulados (128 arquivos aprovados e 18 pulados); 80 testes de tarefas e 60 de CRM/drawer incluídos. `npx tsc --noEmit --incremental false`, `npm run build` e `git diff --check` passaram. Lint global: 0 erros e 1.705 avisos; lint focado de tarefas/CRM/drawer sem avisos. Navegador isolado final: fluxos e foco aprovados em 320/768/1440 px, sem overflow ou erro JavaScript; APIs simuladas. Instruções e limites em `docs/DASHBOARD_TASKS.md`. Nenhum commit, publicação ou SQL remoto.

## Ajustes atuais — fotos sem conversa e lembretes descritivos

- [ ] Fotos: percorrer todos os leads do cliente, não somente os contatos conhecidos pelo WhatsApp; lotes limitados e progresso real.
- [ ] Fotos: validar conexão do cliente em todos os caminhos; números inválidos não geram chamadas; falhas não apagam fotos válidas.
- [x] Lembretes: texto livre + vencimento na ficha e descrição destacada na Dashboard; conclusão limpa `next_follow_up`.
- [x] Persistência sem migration: `business_details.lembrete_texto` guarda o texto, sem sobrescrever `observacoes` nem outros dados comerciais. `next_follow_up` guarda o vencimento em UTC. Um lembrete ativo por lead.
- [ ] Fotos (revisão independente): remover fallback GO/global sem vínculo de instância; não converter erro do provedor em ausência/foto nula; validar URL/tamanho e tratar erros Supabase antes de anunciar sucesso.
- [ ] Verificação final offline, tipos, lint e build após os ajustes de fotos.
- [ ] Validação real com Evolution e navegador autenticado (exige opt-in; ainda não realizada).

Os itens históricos abaixo descrevem a primeira entrega; não substituem as pendências atuais.

- [x] Task 1.1: Segurança de Tenant e Backend
  - Acceptance: `/api/leads/save` e `/api/contacts/sync-avatars` validam posse de instância e de contato por `client_id`; nenhuma leitura anônima cross-tenant.
  - Verify: Testes unitários com Vitest (`src/app/api/contacts/sync-avatars/__tests__/route.test.ts`).
  - Files: `src/app/api/leads/save/route.ts`, `src/app/api/contacts/sync-avatars/route.ts`.

- [x] Task 1.2: Endpoints de Anotações e Lembrete
  - Acceptance: Rota server-side para atualizar `observacoes` e `next_follow_up` com validação de formato e autorização por tenant.
  - Verify: Testes com Vitest (`src/app/api/leads/[id]/crm/__tests__/route.test.ts`).
  - Files: `src/app/api/leads/[id]/crm/route.ts`.

- [x] Task 1.3: Sincronização Segura de Fotos
  - Acceptance: Rota de sincronização paginada em lotes de até 50 JIDs, com cache de 24h e rejeição de base64.
  - Verify: Testes unitários e integração com cache de `contacts` (`src/app/api/contacts/avatars/__tests__/route.test.ts`).
  - Files: `src/app/api/contacts/sync-avatars/route.ts`, `src/app/api/contacts/avatars/route.ts`.

- [x] Task 2.1: Painel Lateral `LeadDrawer`
  - Acceptance: Ficha abre à direita ao clicar no cartão/linha do lead, sem recarregar o quadro; cabeçalho com foto WhatsApp, telefone com cópia, links de WhatsApp e Maps.
  - Verify: Testes unitários com Vitest (`src/components/leads/__tests__/lead-drawer.test.tsx`).
  - Files: `src/components/leads/lead-drawer.tsx`, `src/app/leads/page.tsx`.

- [x] Task 2.2: Bloco de Anotações Internas
  - Acceptance: Campo de texto livre para `observacoes`, botão salvar, indicação visual de salvo/erro, persistência imediata.
  - Verify: Testes unitários de digitação e salvamento (`src/components/leads/__tests__/lead-drawer.test.tsx`).
  - Files: `src/components/leads/lead-drawer.tsx`.

- [x] Task 2.3: Bloco de Lembretes no Lead
  - Acceptance: Seletor de data/hora, botão de salvar lembrete, botão de marcar como concluído (limpa `next_follow_up`).
  - Verify: Testes unitários de reagendamento e conclusão (`src/components/leads/__tests__/lead-drawer.test.tsx`).
  - Files: `src/components/leads/lead-drawer.tsx`.

- [x] Task 3.1: Fotos nos Cartões do Kanban
  - Acceptance: Cartões exibem `profile_pic_url` do cache de `contacts` quando disponível, com fallback de iniciais; sem chamadas remotas no carregamento do quadro.
  - Verify: 21 testes de regressão do `KanbanBoard` preservados e passando.
  - Files: `src/app/leads/_components/KanbanBoard.tsx`, `src/app/leads/page.tsx`.

- [x] Task 3.2: Botão de Sincronização em Lote
  - Acceptance: Botão na barra de ferramentas de `/leads` executa sincronização com feedback visual (progresso, total atualizado).
  - Verify: Disparo da rota `/api/contacts/sync-avatars` com feedback visual via Sonner toast.
  - Files: `src/app/leads/page.tsx`.

- [x] Task 4.1: Widget de Lembretes na Dashboard
  - Acceptance: Exibe contagem e lista de retornos atrasados e para hoje na página inicial (`src/app/page.tsx`).
  - Verify: Testes unitários com Vitest (`src/components/__tests__/dashboard-reminders-widget.test.tsx`).
  - Files: `src/components/dashboard-reminders-widget.tsx`, `src/app/page.tsx`.

- [x] Task 4.2: Navegação Direta para o Lead
  - Acceptance: Clicar no lembrete na Dashboard abre `/leads?openLeadId=<id>`, abrindo o `LeadDrawer` automaticamente.
  - Verify: Parâmetro `openLeadId` escutado no `useEffect` de `src/app/leads/page.tsx` abrindo o `LeadDrawer`.
  - Files: `src/app/leads/page.tsx`, `src/components/dashboard-reminders-widget.tsx`.
