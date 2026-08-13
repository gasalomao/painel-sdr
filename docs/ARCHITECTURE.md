# Arquitetura do Sistema

## Visão Geral

O Painel SDR é uma plataforma SaaS multi-tenant construída sobre Next.js 16 (App Router) que integra IA conversacional, WhatsApp, CRM, automação de prospecção e agendamento em um único produto.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENTES (Browser)                           │
│                    Dashboard / CRM / Chat / IA                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTPS + Cookie JWT
┌──────────────────────────────▼──────────────────────────────────────┐
│                    Next.js 16 (Standalone)                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────────┐   │
│  │ proxy.ts │─►│ API      │─►│ lib/     │─►│ Supabase (Postgres)│   │
│  │ (guard)  │  │ Routes   │  │ (66 mods)│  │ + pgvector + RT   │   │
│  └──────────┘  │ (32 dirs)│  └────┬─────┘  └───────────────────┘   │
│                └──────────┘       │                                 │
│  ┌───────────────────────────────┐│                                 │
│  │ instrumentation.ts (scheduler)││                                 │
│  │  ├─ Organizer IA (5min)      ││                                 │
│  │  ├─ Automation ticker (60s)  ││                                 │
│  │  ├─ Campaign ticker (90s)    ││                                 │
│  │  ├─ Follow-up ticker (2min)  ││                                 │
│  │  └─ Appointment ticker (60s) ││                                 │
│  └───────────────────────────────┘│                                 │
└───────────────────────────────────┼─────────────────────────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
    ┌─────────▼─────────┐  ┌────────▼────────┐  ┌──────────▼──────────┐
    │   Evolution API   │  │   AI Providers  │  │     Google APIs     │
    │   (WhatsApp)      │  │                 │  │                     │
    │  ┌──────────────┐ │  │ • Gemini        │  │ • Calendar API v3   │
    │  │ V2 (Baileys) │ │  │ • OpenRouter    │  │ • OAuth2            │
    │  │ GO (whatsmeow)│ │  │ • Gateway Proxy │  └─────────────────────┘
    │  │ Cloud (Meta) │ │  │ • DeepSeek Chat │
    │  └──────────────┘ │  └─────────────────┘
    └───────────────────┘
              │
    ┌─────────▼─────────┐
    │   Redis + BullMQ  │
    │   (filas opcionais)│
    └───────────────────┘
```

## Componentes Principais

### 1. Proxy (Route Guard) — `src/proxy.ts`

Next.js 16 renomeou `middleware.ts` para `proxy.ts`. É o **único ponto de entrada** para todas as requisições.

**Responsabilidades:**
- Verificação de sessão JWT (cookie `sdr_session`)
- Redirecionamento para `/login` se não autenticado
- Gate de admin (`/admin` requer `isAdmin`)
- Feature gating por cliente (14 features)
- Bypass para webhooks e rotas internas

**Fluxo:**
```
Request → public route? → next()
        → has internal secret? → next()  
        → has valid session? → no? → redirect /login
        → admin route + isAdmin? → next()
        → feature enabled? → no? → redirect /?blocked=
        → next()
```

### 2. API Routes — `src/app/api/`

32 diretórios com 98+ endpoints REST. Todas seguem o padrão:
- Extração de tenant via `requireClientId(req)` → `client_id`
- Filtro `.eq("client_id", clientId)` em todas as queries Supabase
- Resposta JSON padronizada
- Tratamento de erro com fallback gracioso (PGRST204 para colunas inexistentes)

### 3. Biblioteca Core — `src/lib/`

66 arquivos organizados em 7 categorias:

| Categoria | Arquivos | Função |
|-----------|----------|--------|
| IA & LLM | 27 | Provedores, RAG, embeddings, pricing, discovery |
| Workers | 5 | Automação, campanhas, follow-up, agendamentos, Redis |
| WhatsApp/Canais | 7 | Evolution V2/GO, Cloud API, roteamento |
| Integração | 9 | Google Calendar, Scraper, Whisper, Gateway Proxy |
| Business Logic | 13 | Agenda, funil, templates, prioridade, brand |
| Supabase/Auth | 7 | Clientes, sessões, tenant, auth edge/node |
| Inbox | 3 | Normalização de conversas, filtros |

### 4. Frontend — `src/app/` (páginas) + `src/components/`

17 páginas com App Router, dark mode hardcoded, componentes shadcn/ui (base-ui/react).

**Padrões:**
- Sem React Query/SWR — `useState` + `useEffect` + fetch direto
- Real-time via Supabase Postgres Changes
- Feature gating no UI via `session.features[key]`
- Dynamic imports para libs browser-only (recharts, react-big-calendar)

### 5. Schedulers — `src/instrumentation.ts`

Registrado via hook `register()` do Next.js. Roda apenas em Node runtime (não edge). Inicia 6 timers em background:

| Timer | Intervalo | Função |
|-------|-----------|--------|
| Organizer IA | 5 min | Triagem automática de leads com IA |
| Automation | 60s | State machine de automações |
| Campaign safety-net | 90s | Recuperação de campanhas órfãs |
| Follow-up | 2 min | Follow-ups automáticos + promoção |
| Appointment reminders | 60s | Lembretes + sync Google Calendar |
| Boot recovery | 1x | Restaurar campanhas em progresso |

Cada timer tem guard anti-sobreposição (flag booleana `in-flight`).

### 6. Banco de Dados — Supabase (PostgreSQL)

- **40 tabelas** (33 canônicas + 7 opcionais)
- Extensão `pgvector` para RAG (embeddings 768-dim)
- Sem RLS — isolamento 100% na aplicação via `client_id`
- 3 triggers de auto-resolução de tenant
- Publicação Realtime em ~15 tabelas

## Fluxo de Dados Principais

### Mensagem recebida do WhatsApp → Resposta da IA

```
1. Evolution API → POST /api/webhooks/evolution-go
2. Webhook valida assinatura, resolve instance → client_id
3. Mensagem persistida em chats_dashboard + messages
4. Session lookup (contact_id + instance_name)
5. Bot status check (active? human_takeover? paused?)
6. Se bot_active → POST /api/agent/process (via import direto)
7. Agent process:
   a. Carrega prompt do agente + funil + variáveis
   b. RAG: busca knowledge_chunks por similaridade
   c. IA provider: generateText (Gemini/OpenRouter/Gateway)
   d. Parsing de resposta (funnel stage, schedule, etc.)
   e. Persiste resposta + atualiza session
8. Mensagem enviada via channel.sendMessage → Evolution API
9. Persistida com sender_type=ai
```

### Campanha de Disparo (Mass Send)

```
1. Usuário cria campanha em /disparo
2. Leads importados ou do scraper → campaign_targets
3. startCampaign():
   a. Para cada target: janela de horário BRT? 
   b. Renderiza template ({{nome_empresa}}, {{saudacao}})
   c. Opcional: personaliza com IA
   d. Envia via channel.sendMessage
   e. Jitter aleatório (min/max interval)
   f. Atualiza campaign_targets.status
4. Campaign ticker (90s) recupera se container reiniciar
5. Logs em campaign_logs (info/success/warning/error)
```

### Prospecção Automatizada (Scraper → Disparo → Follow-up)

```
1. Usuário configura automação em /automacao
2. startAutomation():
   Phase 1 - Scrape: Puppeteer + Google Maps
     → leads_extraidos + automation_logs
   Phase 2 - Dispatch: campaign_targets → enviar
     → messages + campaign_logs  
   Phase 3 - Follow-up: followup_targets → multi-step
     → followup_logs
3. State machine: idle → scraping → campaigning → following → done
4. Ticker de automação (60s) avança fases
```

## Padrões de Design

### Multi-Tenancy

O isolamento entre tenants é feito em **3 camadas**:

1. **Aplicação** (primary): `requireClientId(req)` → `.eq("client_id", clientId)` em toda query
2. **Database triggers** (auto-fill): 3 funções resolvem `client_id` via `instance_name → channel_connections`
3. **JWT** (identidade): session contém `clientId`, `isAdmin`, `impersonating`

### Resiliência

- **Redis opcional**: app funciona sem Redis (filas não rodam, mas server não crasha)
- **Supabase mock**: se URL inválida, Proxy mock retorna `{data:[], error:null}`
- **Session fails-open**: se DB cair, `isSessionLive` retorna `true` (evita logout em massa)
- **Campaign recovery**: ticker de 90s restaura campanhas perdidas em restart
- **PGRST204 fallback**: colunas inexistentes não quebram a request

### Provider Abstraction

Canais de WhatsApp e provedores de IA seguem o padrão **primary + fallback**:

```
Evolution V2 (primary) → Evolution GO (fallback)
Gemini (primary) → OpenRouter (fallback) → Gateway (fallback)
```

### Internal Secret

Comunicação server-to-server (scheduler → API, webhook → agent) usa header `x-internal-secret`. Mesma chave que assina JWTs (`AUTH_SECRET || SUPABASE_SERVICE_ROLE_KEY`).

## Árvore de Diretórios

```
painel-sdr/
├── src/
│   ├── app/                      # 17 páginas + 32 dirs de API
│   │   ├── api/                  # 98+ endpoints REST
│   │   ├── agente/               # Config de agentes IA
│   │   ├── automacao/            # Pipeline de prospecção
│   │   ├── chat/                 # Inbox de mensagens
│   │   ├── disparo/              # Campanhas de disparo
│   │   ├── leads/                # CRM / Kanban
│   │   └── ...
│   ├── components/               # 12 componentes + inbox/ + layout/ + ui/
│   ├── hooks/                    # 3 hooks customizados
│   ├── lib/                      # 66 módulos core
│   │   ├── providers/            # Adapters de WhatsApp
│   │   ├── deepseek/             # PoW solver + WASM
│   │   ├── inbox/                # Normalização de conversas
│   │   └── __tests__/            # Testes Vitest
│   ├── types/                    # Type system (647 linhas)
│   ├── workers/                  # BullMQ worker standalone
│   ├── proxy.ts                  # Route guard (Next 16)
│   └── instrumentation.ts        # Boot scheduler
├── migrations/                   # 39 arquivos SQL
├── scripts/                      # 5 scripts de build/manutenção
├── docs/                         # Esta documentação
├── public/                       # Assets estáticos
├── Dockerfile                    # Multi-stage (deps→build→runner)
├── package.json
└── next.config.ts
```
