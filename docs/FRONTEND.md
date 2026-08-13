# Frontend

## Stack

| Tecnologia | Versão | Uso |
|------------|--------|-----|
| Next.js | 16.2.3 | Framework (App Router, standalone) |
| React | 19.2.4 | UI runtime |
| TypeScript | 5 | Tipagem estrita |
| Tailwind CSS | 4 | Estilização |
| shadcn/ui (base-ui) | — | Componentes |
| lucide-react | 1.8 | Ícones |
| @dnd-kit | 6/10/3 | Drag & drop (Kanban) |
| react-big-calendar | 1.19 | Calendário |
| Recharts | 3.8 | Gráficos |
| sonner | 2.0 | Toasts |
| date-fns | 4.3 | Datas (pt-BR) |

## Páginas

### Dashboard (`/`) — `src/app/page.tsx`

Página inicial com KPIs operacionais.

**Métricas exibidas:**
- Leads hoje
- Conversas hoje (dedup por JID)
- Agendamentos
- Instâncias online
- Campanhas ativas
- Follow-ups ativos

**Recursos:**
- Auto-refresh a cada 30s
- `hasFeature(key)` para mostrar/esconder cards por feature flag
- `isFirstTime` → card de onboarding
- DashboardCalendarWidget (agendamentos do dia)
- Tabela de leads recentes
- `BlockedFeatureBanner` quando feature bloqueada

### Login (`/login`) — `src/app/login/page.tsx`

Tela split-screen. Esquerda: brand + features. Direita: formulário email/senha.

**Fluxo:** POST `/api/auth/login` → redirect `?from=` ou `/`

### CRM / Leads (`/leads`) — `src/app/leads/page.tsx`

Gestão completa de leads com 2 visualizações: Lista e Kanban.

**Recursos:**
- Kanban board com DnD (`KanbanBoard.tsx`) — arrastar cards entre colunas
- Cores customizáveis por coluna
- Edição inline de nome do lead
- AddLeadDialog para criação manual
- Lead Intelligence Batch (enriquecimento IA em massa)
- Busca, filtros, export Excel
- 11 índices otimizando queries

### Chat / Inbox (`/chat`) — `src/app/chat/page.tsx`

Inbox de mensagens WhatsApp em tempo real.

**Layout 3-painel:**
1. **Conversation List** — lista de conversas com filtros
2. **Message Thread** — histórico de mensagens com bubbles
3. **Contact Sidebar** — dados do contato, tags, notes

**Real-time:** Supabase Postgres Changes em `chats_dashboard` e `sessions`

**Componentes inbox/ (11 arquivos):**
- conversation-list, message-thread, message-composer
- message-bubble, message-actions, message-reactions
- contact-sidebar, ai-thread-banner, reply-quote
- template-picker, quick-reply-picker

### Agentes de IA (`/agente`) — `src/app/agente/page.tsx`

Configuração de agentes de IA conversacionais.

**Estrutura:**
- `page.tsx` — estado central + handlers
- `_components/` (10 arquivos): AgentSwitcher, SortableStage, LeadSelector, PromptPreview, WebhookGuide, SectionCard, SaveButton, EmptyState, CopyButton, Toggle
- `_tabs/` (5 arquivos):
  - **InfoTab** (1497 linhas) — identidade, prompt, knowledge base, webhook, Google Calendar
  - **AjustesTab** — modelo, horários, variáveis capturadas
  - **EtapasTab** — funil de etapas (DnD reorder)
  - **TestesTab** — teste de prompts
  - **LogsTab** — logs de execução

### WhatsApp (`/whatsapp`) — `src/app/whatsapp/page.tsx`

Gestão de instâncias WhatsApp.

**Recursos:**
- QR code para conectar
- Status da conexão (open/close/connecting)
- Configuração Cloud API (Meta)
- CRUD de instâncias
- Auto-link de agente ao conectar

### Prospecção / Scraper (`/captador`) — `src/app/captador/page.tsx`

Scraper de Google Maps com Puppeteer.

**Recursos:**
- Busca por nicho + região
- SSE (Server-Sent Events) para progresso real-time
- Extração de reviews
- Deduplicação contra CRM
- Envio para n8n webhook

### Disparo / Campanhas (`/disparo`) — `src/app/disparo/page.tsx`

Campanhas de envio em massa.

**Recursos:**
- Editor de template com variáveis (`{{nome_empresa}}`, `{{saudacao}}`)
- Personalização com IA (opcional)
- Filtros: min reviews, min rating
- Intervalos aleatórios (anti-ban)
- Janela de horário BRT
- Mídia anexa (imagem, documento)
- Logs em tempo real
- Status: draft → running → done

### Automação (`/automacao`) — `src/app/automacao/page.tsx`

Pipeline completo: Scrape → Disparo → Follow-up.

**Configuração:**
- Nichos e regiões
- Template de disparo
- Steps de follow-up (multi-step JSONB)
- Intervalos e janelas de horário
- IA para personalização
- Execução automática ou manual

### Calendário (`/calendario`) — `src/app/calendario/page.tsx`

Visualização de agendamentos com react-big-calendar.

**Recursos:**
- CalendarGrid com DnD (mover/redimensionar eventos)
- Cores do Google Calendar
- Integração Google OAuth
- Filtros por agente, status

### Follow-up (`/follow-up`) — `src/app/follow-up/page.tsx`

Campanhas de follow-up multi-step.

**Recursos:**
- Steps com templates
- Intervalos entre steps
- IA model para personalização
- Status por target (pending/waiting/responded/exhausted)

### Configurações (`/configuracoes`) — `src/app/configuracoes/page.tsx`

**3525 linhas** — maior arquivo do projeto.

**4 seções:**
1. **Gemini API Key** — input + validação
2. **OpenRouter Key** — input + validação
3. **Gateway Multi-Conexão** — CLIProxyAPI, endpoints, cooldown
4. **Conector Embutido** — Install/uninstall, OAuth login, account management

### Organizador IA (`/organizador`) — `src/app/organizador/page.tsx`

Triagem automática de leads com IA.

**Recursos:**
- Kanban columns customizáveis (CRUD)
- Prompt editor do organizer
- Configuração de horário de execução
- Sugestões de IA
- Histórico de execuções (ai_organizer_runs)

### Histórico IA (`/historico-ia`) — `src/app/historico-ia/page.tsx`

Auditoria de movimentações de leads pela IA.

**Recursos:**
- Logs agrupados por batch
- Status antigo → novo, razão, resumo
- Filtros por data, JID, batch

### Tokens (`/tokens`) — `src/app/tokens/page.tsx`

Dashboard de custos de IA.

**Recursos:**
- Gráfico de custo diário (Recharts)
- Custo por source, model, client
- Filtros por período
- Métricas em BRL e USD

### Prospecção Sites (`/prospeccao-sites`) — `src/app/prospeccao-sites/page.tsx`

Prospecção de sites sem website.

**6 abas:**
1. Captura — buscar empresas sem site
2. Leads — lista de prospects
3. Revisão — validar leads
4. Disparo — campanhas para esses leads
5. Histórico — execuções passadas
6. Automação — pipeline completo

### Admin (`/admin/clientes`) — `src/app/admin/clientes/page.tsx`

CRUD de clientes (tenants). Admin-only.

**Recursos:**
- Criar/editar/deletar clientes
- Configurar features por cliente (14 toggles)
- Setar modelo de IA padrão
- Impersonação (login como cliente)

## Componentes

### Layout (`src/components/layout/`)

| Componente | Descrição |
|------------|-----------|
| `sidebar.tsx` | Navegação lateral. Filtra itens por `session.features`. |
| `header.tsx` | Cabeçalho com saudação + ações contextuais. |
| `impersonation-banner.tsx` | Banner amarelo quando admin impersona cliente. |

### Compartilhados (`src/components/`)

| Componente | Descrição |
|------------|-----------|
| `ai-module-shared.tsx` | `AIModelSelect` / `ModelOptions` — dropdown unificado de modelos |
| `add-lead-dialog.tsx` | Modal de criação de lead (usado em /leads e /chat) |
| `media-uploader.tsx` | Upload de mídia com validação de tipo/tamanho WhatsApp |
| `calendar-status-bar.tsx` | Status da conexão Google Calendar |
| `connect-google-dialog.tsx` | Modal de OAuth do Google |
| `dashboard-calendar-widget.tsx` | Widget de agendamentos do dia no dashboard |
| `ngrok-quick-connect.tsx` | Atalho para conectar via ngrok (dev) |
| `lead-intelligence-batch.tsx` | Enriquecimento de leads em lote com IA |
| `send-followup-dialog.tsx` | Modal de envio de follow-up manual |

### UI Primitives (`src/components/ui/`)

17 arquivos shadcn/ui (base-ui/react, não Radix):

```
avatar, badge, button, card, checkbox, dialog, dropdown-menu,
input, label, number-input (CUSTOM), scroll-area, select,
separator, switch, tabs, textarea, tooltip
```

**Custom:** `number-input.tsx` — implementação própria sobre base-ui.

### Inbox (`src/components/inbox/`)

11 componentes para a tela de chat:

```
conversation-list      — lista de conversas com filtros
message-thread         — thread de mensagens
message-composer       — input de envio + mídia
message-bubble         — bubble de mensagem (com timestamp, status)
message-actions        — ações (responder, reagir, apagar)
message-reactions      — emojis de reação
contact-sidebar        — dados do contato
ai-thread-banner       — indicador de IA ativa
reply-quote            — quote de mensagem respondida
template-picker        — seleção de templates
quick-reply-picker     — respostas rápidas
```

## Hooks

### `use-realtime.ts`

```typescript
// Subscrição Supabase Realtime
useRealtime({ table, filter, onPayload }) 
// Postgres Changes em chats_dashboard, sessions
// Auto-cleanup on unmount
```

### `use-gateway-accounts.ts`

```typescript
// Lista de contas do CLIProxyAPI com TTL cache
useGatewayAccounts()
// Refresh automático a cada 30s
```

### `use-ai-models.ts`

```typescript
// Lista de modelos de IA de todos providers
useAiModels()
// Agrega: Gemini + OpenRouter + Gateway
// Agrupa por provider e family
// TTL cache
```

## Padrões

### State Management

Sem React Query/SWR. Todas as páginas usam `useState` + `useEffect` + `fetch()` direto para API routes, ou `supabase` client direto para queries de leitura.

### Feature Gating no UI

```tsx
// Em cada página:
const { session } = useClientSession();
const featureOn = session?.isAdmin || session?.features?.leads !== false;

if (!featureOn) return <BlockedFeature />;
```

### Dynamic Imports

```tsx
// Libs browser-only carregadas dinamicamente:
const CalendarGrid = dynamic(() => import('./_components/CalendarGrid'), { ssr: false });
const TokensCharts = dynamic(() => import('./_components/TokensCharts'), { ssr: false });
```

### Dark Mode

Hardcoded `<html lang="pt-BR" className="dark">`. Sem toggle. Tema escuro permanente.

### Tipo de Sistema

`src/types/index.ts` — 647 linhas com types para: Profile, Account, Contact, Tag, Conversation, Message, Automation, Broadcast, Pipeline, Deal, Template, QuickReply, etc.
