# AUDIT SYSTEM MAP

## Escopo e estado

- Workspace: `C:\Users\Salomão\Desktop\painel-sdr-main`
- Git: branch `main`, sem alterações preexistentes no início da auditoria.
- Total rastreado: 446 arquivos, aproximadamente 5,1 MB.
- Nenhum teste, build, migration, servidor, worker ou integração foi executado durante discovery.

## Visão arquitetural inicial

Aplicação full-stack monolítica em Next.js App Router, com páginas React, APIs server-side, schedulers in-process, integrações externas e persistência Supabase/PostgreSQL. Existe código BullMQ separado, mas sua operacionalidade ainda precisa ser comprovada.

```text
Navegador
  -> Next.js pages/components
  -> src/proxy.ts
  -> src/app/api/**/route.ts
  -> src/lib/*
  -> Supabase/PostgreSQL/Storage/Realtime
  -> Evolution/WhatsApp Cloud/Google/IA/webhooks externos

Next.js process start
  -> src/instrumentation.ts
  -> timers de organizer/automation/campaign/follow-up/appointments/calendar

Worker opcional
  -> src/workers/message-worker.ts
  -> Redis/BullMQ
  -> integrações de mensagem
```

## Classificação do repositório

| Classe | Área | Quantidade/observação |
|---|---|---|
| SOURCE | `src/app` | 146 arquivos; UI e 105 rotas API |
| SOURCE | `src/lib` | 143 arquivos; integrações, regras e testes misturados |
| SOURCE | `src/components` | 38 componentes React |
| SOURCE | `src/hooks` | 3 hooks |
| SOURCE | `src/types` | 2 arquivos |
| SOURCE | `src/workers` | 1 worker BullMQ |
| SOURCE | `src/instrumentation.ts` | bootstrap de schedulers |
| SOURCE | `src/proxy.ts` | gate global de requests |
| SOURCE/DATA | `migrations` | 50 arquivos SQL |
| SOURCE/OPS | `scripts` | 6 scripts build/diagnóstico/backfill/recovery |
| SOURCE/OPS | `security` | SQL de inventário, hardening, restore e recriação |
| TEST | `src/lib/__tests__` | 69 suites e 2 setups |
| CONFIG | raiz, `.github` | npm, TS, Next, ESLint, Vitest, Docker e CI |
| GENERATED | `src/lib/setup-sql.ts` | SQL embutido gerado |
| GENERATED/VENDOR | `src/lib/deepseek/sha3-wasm-base64.ts` | WASM externo embutido |
| VENDOR | `public/opus/encoderWorker.min.js` | worker minificado de terceiro |
| VENDOR | `node_modules` | dependências instaladas, fora da revisão source |
| BUILD OUTPUT | `.next`, `tsconfig.tsbuildinfo` | artefatos locais ignorados |
| UNKNOWN | `security/Supabase Snippet SQL Query.csv` | snapshot operacional sem proveniência validada |

## Aplicações e superfícies

### UI

17 páginas `page.tsx`:

- `/`
- `/login`
- `/admin/clientes`
- `/agente`
- `/automacao`
- `/calendario`
- `/captador`
- `/chat`
- `/configuracoes`
- `/disparo`
- `/follow-up`
- `/historico-ia`
- `/leads`
- `/organizador`
- `/prospeccao-sites`
- `/tokens`
- `/whatsapp`

### APIs

- Diretório: `src/app/api`
- 105 arquivos `route.ts` em 36 grupos de primeiro nível.
- Maiores grupos: `agent`, `organizer`, `auth`, `webhooks`, `deepseek-chat`, `followup`, `prospeccao-sites`, `whatsapp`, `admin`, `automations`, `leads`, `tokens`.
- Rotas dinâmicas manipulam clientes, appointments, campaigns, automations, follow-ups e prospecção.

### Entry points

| Entry point | Papel | Side effects potenciais |
|---|---|---|
| `src/app/layout.tsx` | layout web | render e providers |
| `src/app/**/page.tsx` | páginas | chamadas API e Supabase client-side |
| `src/app/api/**/route.ts` | REST handlers | DB, storage, IA, mensagens, processos |
| `src/proxy.ts` | autenticação/gating | permite ou bloqueia requests |
| `src/instrumentation.ts` | startup server | inicia timers e jobs |
| `src/workers/message-worker.ts` | worker separado | consome fila e envia mensagens |
| `scripts/build-setup-sql.mjs` | prebuild | escreve `src/lib/setup-sql.ts` |
| `scripts/backfill-rag.mjs` | operação manual | embeddings e escrita no Supabase |
| `scripts/recover-sdr-chats.js` | operação manual | upsert no Supabase |
| `scripts/check-migrations.mjs` | diagnóstico | consulta Supabase |
| `scripts/diag-ai.mjs` | diagnóstico | consulta Supabase/providers |
| `scripts/test-transcription.mjs` | teste manual | subprocessos e arquivo local |

## Módulos de domínio iniciais

| Domínio | UI/API | Lógica principal | Dados/integrações |
|---|---|---|---|
| Auth/admin | `api/auth`, `api/admin`, login/admin pages | `auth.ts`, `auth-edge.ts`, `tenant.ts`, `internal-auth.ts` | auth sessions, clients, JWT cookie |
| Chat/inbox | chat page, `api/chat`, `api/send-message` | channel/evolution/inbox helpers | chats, contacts, sessions, messages |
| WhatsApp | whatsapp page, `api/whatsapp`, `api/webhooks` | evolution providers, whatsapp-cloud | Evolution V2/GO, Meta Cloud, Storage |
| IA/agentes | agente/config pages, `api/agent`, `api/ai-*` | ai-provider, ai-combos, RAG, gateways | Gemini, OpenRouter, DeepSeek, vector DB |
| CRM/leads | leads page, `api/leads`, organizer | lead intelligence, organizer | leads, contacts, chats |
| Campanhas | disparo page, `api/campaigns` | campaign-worker | messages, AI, WhatsApp |
| Automações | automacao page, `api/automations` | automation-worker | schedules, WhatsApp, AI |
| Follow-up | follow-up page, `api/followup` | followup-worker | history, lead state, messages |
| Agenda | calendario page, `api/appointments`, `api/calendario` | appointment-worker, calendar sync | Google Calendar, appointments |
| Prospecção | prospeccao page, `api/scraper`, `api/prospeccao-sites` | scraper-engine, reviews-ai | Chromium, Maps, webhooks, IA |
| Tokens/config | tokens/config pages, settings APIs | provider credentials/config | Supabase, local filesystem, providers |

## Persistência

### PostgreSQL/Supabase

- 50 scripts em `migrations`.
- 17 arquivos numerados; colisões em prefixos `006`, `007` e `009`.
- 33 arquivos sem numeração canônica.
- `migrations/schema.sql` está vazio apesar da documentação tratá-lo como referência completa.
- DDL aparece em pelo menos três representações: `migrations/SETUP_COMPLETO.sql`, `src/lib/setup-sql.ts` e `security/recria-banco.sql`.
- O estado real aplicado em produção permanece NÃO VALIDADO.

### Storage e Realtime

- Código e SQL indicam buckets de mídia e Supabase Realtime.
- Policies, privacidade efetiva dos buckets e publication membership permanecem NÃO VALIDADOS.

### Redis/BullMQ

- Cliente e worker existem.
- Producer, queue contract, startup e deploy do worker permanecem NÃO VALIDADOS.

## Integrações externas

| Integração | Código/config | Escrita/efeito potencial |
|---|---|---|
| Supabase | `src/lib/supabase*.ts` | DB, Storage, Realtime |
| Evolution V2 | `src/lib/evolution.ts` | mensagens e webhooks |
| Evolution GO | `src/lib/providers/evolution-go.ts` | mensagens e webhooks |
| WhatsApp Cloud | `src/lib/whatsapp-cloud.ts` | mensagens, mídia e status |
| Gemini | SDK e helpers | chat, embeddings, organização |
| OpenRouter | discovery/providers | chat e áudio |
| DeepSeek/gateway | clients e manager | processos, credenciais e chat |
| Google Calendar | calendar helpers | OAuth e sync bidirecional |
| Puppeteer/Google Maps | scraper-engine | navegação externa e captura |
| Webhooks configuráveis | scraper/automations | HTTP outbound para URL externa |
| Whisper/FFmpeg | rotas e runtime | subprocessos e arquivos temporários |

## Trust boundaries

1. Navegador para Next.js API.
2. Headers/cookies para proxy e handlers.
3. Tenant do JWT para filtros de `client_id`.
4. Webhooks externos para persistência e IA.
5. Inputs de URLs para fetch server-side.
6. Uploads e mídia para Storage.
7. Outputs de IA para lógica/persistência.
8. Scheduler/worker para operações mutáveis e envio real.
9. Anon key pública para Supabase.
10. Credenciais de providers no DB e filesystem.

## Testes

- Runner: Vitest em ambiente Node.
- Padrão global: `src/**/*.test.ts`.
- 69 suites.
- Existem suites live/e2e/probe; algumas usam opt-in, pelo menos duas precisam validação especial por possível ausência de guard.
- O setup lê `.env.local`/`.env`; por isso `npm test` ainda não está classificado como seguramente isolado.
- Não foram encontrados Playwright, Cypress, Jest, snapshots ou coverage configurada.

## CI/CD e deploy

- GitHub Actions executa lint, test e build em Node 20.
- Docker gera output standalone e inicia apenas `node server.js`.
- Não há CD, migration automation, deploy manifest, IaC, Docker Compose ou Supabase CLI.
- Build executa `scripts/build-setup-sql.mjs` antes do Next build e pode modificar arquivo rastreado.

## Maiores arquivos e hotspots

- `src/app/configuracoes/page.tsx` — aproximadamente 205 KB.
- `src/app/api/agent/process/route.ts` — aproximadamente 137 KB.
- `src/app/prospeccao-sites/page.tsx` — aproximadamente 129 KB.
- `src/lib/scraper-engine.ts` — aproximadamente 112 KB.
- `src/app/agente/_tabs/info-tab.tsx` — aproximadamente 87 KB.

Esses arquivos exigem revisão por fluxo, não conclusão automática de baixa qualidade.

## Áreas não validadas

- Estado do banco real, migrations aplicadas, RLS, grants e policies.
- Topologia de produção, número de réplicas e workers externos.
- Credenciais atuais e se valores detectados já foram rotacionados.
- E2E real de login, chat, campanhas, webhooks, agenda e IA.
- Compatibilidade runtime do container.
- Custos, quotas e limites reais dos providers.
- Browser accessibility e comportamento responsivo.
