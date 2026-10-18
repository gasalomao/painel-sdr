# Spec: lead-reminders

Status: tarefas livres e por lead implementadas e verificadas localmente em 18/10/2026; ativação no banco real e teste autenticado pendentes. A decisão abaixo substitui o limite anterior de um lembrete por lead. SQL preparado localmente, nunca aplicado automaticamente. Resultados em `docs/DASHBOARD_TASKS.md`.

## Objetivo

Organizar tarefas livres ou ligadas a leads com texto, vencimento e conclusão persistente na Dashboard, preservando os lembretes atuais da ficha e sem disparar mensagens ou agendamentos comerciais.

## Critérios de sucesso

1. Criar tarefa com texto livre obrigatório, data/hora obrigatórias e lead opcional. Datas exibidas no horário local do usuário e persistidas como instante inequívoco.
2. Validar entradas no servidor, incluindo comprimento, data válida e acesso ao lead. Não aceitar client_id como autoridade de autorização.
3. Editar/reagendar, concluir por checkbox e reabrir tarefas. Repetir uma conclusão não altera sua data nem duplica eventos. Apresentar erro se a gravação não atingir o registro autorizado.
4. Ficha mantém o lembrete legado atual, com conclusão/reagendamento acessíveis. Tarefas novas e histórico são gerenciados na Dashboard; vínculo com lead oferece atalho para sua ficha, sem consulta por cartão.
5. Dashboard mostra tarefas atrasadas, em até 30 minutos, próximas 24h e futuras, ordenadas por vencimento, com totais e paginação; filtro de concluídas mantém histórico. Vínculo abre o lead correto sem depender dos filtros atuais de /leads.
6. Destaque visual indica a proximidade e o atraso, atualizado com a aba visível. Visualizar a tarefa não a conclui; somente o checkbox grava a conclusão. Não criar central de notificações neste recorte.
7. Fechar o navegador não perde lembretes. Ao retornar, os não concluídos vencidos aparecem como atrasados. Não prometer alerta externo, push, email ou mensagem com o painel fechado.
8. Lembretes manuais nunca enviam mensagem comercial ao lead e não iniciam sequências automáticas de follow-up.
9. Reutilizar tarefa/lembrete/notificação existentes quando compatíveis, respeitando permissões e isolamento por cliente. Não introduzir worker ou polling agressivo se consulta por vencimento resolver.
10. Não consultar histórico inteiro nem gerar uma chamada por lead; consultas filtradas e limitadas, índices adequados se schema exigir ajuste.

## Contratos

- Entrada usa `text`, `due_at` e `lead_id` opcional; escopo do cliente é derivado da sessão autenticada.
- Identidade e links de lead fornecidos por lead-workspace.
- Resumo de próxima ação é calculado sobre tarefas pendentes; visualização e conclusão são estados distintos.
- Organizer e agendamentos foram inspecionados: têm efeitos automáticos incompatíveis com tarefas pessoais. Tabela própria aprovada; SQL apenas preparado, aplicação no banco real depende de ação do usuário.

## Stack e estrutura

Next.js 16, React 19, TypeScript 5, Supabase e UI existente. Integrações na ficha em src/app/leads/, dashboard e notificações existentes; APIs em src/app/api/, regras em src/lib/, testes em src/lib/__tests__/.

## Comandos

- Testes offline: npm run test -- --maxWorkers=1 --minWorkers=1
- Tipos: npx tsc --noEmit
- Lint: npm run lint
- Build: npm run build
- Desenvolvimento: npm run dev

## Estilo

Mesmas convenções do projeto: funções exportadas tipadas, sem any, validação nos limites e erros em português. Reutilizar o cliente Supabase de src/lib.

```ts
export function isReminderOverdue(dueAt: string, now: Date): boolean {
  return new Date(dueAt).getTime() < now.getTime();
}
```

## Testes

Vitest: validação de datas e limites, horário local/UTC, atrasados, ordenação, conclusão/cancelamento e leituras independentes. APIs: sem sessão, lead de outro cliente, alteração de outro registro, zero linhas e falhas. Componente: criar, editar, concluir, reagendar, erros e link da dashboard. Teste SQL local com PGlite se houver migration; nunca usar banco real para validação sem opt-in.

## Limites

- Sempre: tenant derivado da autenticação, persistência antes de sucesso, consultas limitadas e sem envio automático.
- Pedir antes: schema novo, dependências, integração externa, commit ou publicação.
- Nunca: migration em banco real, aviso externo não contratado, criação duplicada de scheduler ou uso de follow-up de mensagens como lembrete pessoal.

## Fora do escopo

Push, email, lembrete por WhatsApp, recorrência avançada, sincronização com calendário externo e automação comercial.

## Decisão aprovada — lista de tarefas na Dashboard

- Criar, editar e reagendar texto livre obrigatório (até 1.000 caracteres), data/hora obrigatórias, vínculo opcional com lead. Várias tarefas podem compartilhar o mesmo lead.
- Checkbox conclui somente após gravação; conclusão guarda `completed_at`, mantém histórico e permite reabrir. Vencimento nunca conclui automaticamente.
- Dashboard oferece filtros Pendentes/Concluídas e agrupamento visual Atrasadas, Em até 30 min, Próximas 24h e Futuras. Datas no horário local, armazenamento TIMESTAMPTZ. Lista paginada com totais independentes da página.
- Atualização a cada 30s somente com aba visível, ao voltar à aba e após mutações. Destaque visual por proximidade, sem som/push externo ou avisos repetitivos. Não promete notificação com o painel fechado.
- Persistência nova `dashboard_tasks` com `client_id`, `text`, `due_at`, `completed_at`, `lead_id` opcional e timestamps. RLS sem acesso anon/authenticated direto; acesso por API server-side autenticada, sempre no tenant da sessão, inclusive admin.
- `GET/POST /api/tasks` lista/cria; `PATCH /api/tasks/[id]` edita ou conclui/reabre; `GET /api/tasks/leads?q=` busca limitada para vínculo. Não aceita `client_id` ou `completed_at` do cliente.
- Lembretes legados continuam na ficha e na API existentes. A lista da Dashboard também os exibe sem duplicação, com conclusão pela API CRM. Histórico persistente e reabertura se aplicam às tarefas novas; o lembrete legado é identificado como tal. Não mover/apagar dados existentes por migration.
- Se a tabela ainda não existe, a Dashboard mantém leitura/conclusão dos lembretes antigos e mostra orientação com o caminho do SQL; criação de tarefas novas fica indisponível. Não apresentar banco indisponível como lista vazia/sucesso.
- SQL idempotente em `migrations/017_dashboard_tasks.sql`, apenas preparado. Nenhum banco real, serviço externo, commit ou deploy sem pedido explícito.
- Verificação offline: API (sessão, tenant, lead estrangeiro, validação, paginação, persistência/erros), UI (criar, editar, checkbox, reabrir, erros, proximidade e legado), SQL real local PGlite (constraints, índices, RLS). Navegador autenticado permanece pendente sem opt-in.
