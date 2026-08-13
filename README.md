<div align="center">

# Painel SDR

**Plataforma completa de Sales Development Representative (SDR) com IA, WhatsApp, automação e CRM multi-tenant.**

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-blue?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-green?logo=supabase)](https://supabase.com/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-4-38bdf8?logo=tailwind-css)](https://tailwindcss.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## Visão Geral

Painel SDR é uma plataforma all-in-one para equipes de vendas que combina:

- **Agentes de IA** para atendimento e qualificação de leads 24/7
- **WhatsApp** integrado via Evolution API para comunicação em massa e individual
- **CRM/Kanban** com pipeline visual e gestão de leads
- **Automação** de follow-ups e campanhas de disparo
- **Prospecção** automatizada com scraper do Google Maps
- **Agendamento** com sincronização bidirecional do Google Calendar
- **Multi-tenant** — cada cliente tem seu próprio espaço isolado

## Funcionalidades Principais

| Módulo | Descrição |
|--------|-----------|
| **Agentes de IA** | Chatbot com RAG, base de conhecimento vetorial, múltiplos provedores (OpenRouter, Gemini, DeepSeek) |
| **WhatsApp** | Integração Evolution API, envio/recebimento de mensagens, mídia, webhooks |
| **Leads / CRM** | Pipeline kanban, intelligence enrichment, captura automática de dados |
| **Disparo / Campanhas** | Campanhas em massa com IA generativa, humanização de mensagens, rate limiting |
| **Automação** | Follow-ups automáticos, encaminhamento para humano, escalonamento |
| **Prospecção** | Scraper de Google Maps com Puppeteer, extração de contatos e reviews |
| **Calendário** | Sync bidirecional Google Calendar, gestão de agendamentos |
| **Organizador** | Triagem automática de contatos com IA |
| **Dashboard** | Métricas em tempo real, histórico de IA, relatórios |

## Stack Tecnológica

- **Framework:** Next.js 16 (App Router, Standalone output, Turbopack)
- **Frontend:** React 19, Tailwind CSS 4, shadcn/ui, Recharts, react-big-calendar
- **Backend:** Next.js API Routes, BullMQ workers
- **Banco de Dados:** Supabase (PostgreSQL + Realtime + Storage + RLS)
- **IA/LLM:** OpenRouter, Google Gemini, DeepSeek, RAG com embeddings
- **WhatsApp:** Evolution API
- **Filas:** Redis + BullMQ (degrade gracefully sem Redis)
- **Scraping:** Puppeteer-core + Stealth plugin
- **Áudio:** Whisper.cpp (transcrição on-device gratuita)
- **Deploy:** Docker multi-stage, Easypanel

## Pré-requisitos

- Node.js 20+
- npm 10+
- Supabase (projeto próprio ou self-hosted)
- Evolution API (para WhatsApp)
- Redis (opcional — o app funciona sem, mas filas/cron não rodam)

## Configuração

1. **Clone o repositório:**

```bash
git clone https://github.com/gasalomao/painel-sdr.git
cd painel-sdr
```

2. **Instale as dependências:**

```bash
npm install
```

3. **Configure as variáveis de ambiente:**

```bash
cp .env.example .env.local
```

Edite `.env.local` com suas credenciais reais (Supabase, Evolution API, Redis, etc.).

4. **Aplique as migrations no Supabase:**

As migrations SQL estão em `migrations/`. Execute em ordem numérica no SQL Editor do Supabase:

```
migrations/001_multi_tenant.sql
migrations/002_fix_webhook_logs_and_backfill.sql
migrations/003_auto_client_id_triggers.sql
...
```

O arquivo `migrations/schema.sql` contém o schema completo de referência.

5. **Rode em desenvolvimento:**

```bash
npm run dev
```

Acesse [http://localhost:3000](http://localhost:3000)

## Deploy com Docker

O projeto usa Dockerfile multi-stage otimizado para Easypanel/VPS:

```bash
docker build -t painel-sdr .
docker run -p 3000:3000 --env-file .env.local painel-sdr
```

Para deploy completo no Easypanel, consulte [docs/PASSO_A_PASSO_DEPLOY.md](docs/PASSO_A_PASSO_DEPLOY.md) e [docs/DEPLOY_EASYPANEL.md](docs/DEPLOY_EASYPANEL.md).

## Estrutura do Projeto

```
src/
├── app/                    # Next.js App Router (páginas + API routes)
│   ├── api/                # 98 endpoints REST em 32 grupos
│   ├── agente/             # Interface do agente de IA
│   ├── automacao/          # Gestão de automações
│   ├── chat/               # Inbox de mensagens
│   ├── disparo/            # Campanhas de disparo
│   ├── leads/              # CRM / Pipeline kanban
│   ├── prospeccao-sites/   # Scraper Google Maps
│   ├── calendario/         # Agendamento + Google Calendar
│   └── ...
├── components/             # Componentes React reutilizáveis
├── lib/                    # Lógica de negócio, workers, integrações
│   ├── workers/            # BullMQ workers (campaign, followup, appointment)
│   ├── providers/          # Adapters de provedores de IA
│   ├── rag.ts              # Retrieval-Augmented Generation
│   ├── evolution.ts        # Evolution API client
│   ├── supabase.ts         # Client Supabase
│   └── ...
├── hooks/                  # React hooks customizados
└── types/                  # Definições de tipos TypeScript

migrations/                 # SQL migrations (Supabase)
docs/                       # Documentação de deploy e integrações
scripts/                    # Scripts de build e manutenção
public/                     # Assets estáticos
```

## Scripts Disponíveis

| Comando | Descrição |
|---------|-----------|
| `npm run dev` | Servidor de desenvolvimento |
| `npm run build` | Build de produção (gera SQL + Next.js build) |
| `npm start` | Servidor de produção |
| `npm test` | Roda testes (Vitest) |
| `npm run test:watch` | Testes em modo watch |
| `npm run lint` | ESLint |

## Variáveis de Ambiente

| Variável | Descrição | Obrigatória |
|----------|-----------|:-----------:|
| `NEXT_PUBLIC_SUPABASE_URL` | URL do projeto Supabase | Sim |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Chave anônima do Supabase | Sim |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server-side only) | Sim |
| `EVOLUTION_API_URL` | URL da instância Evolution API | Sim |
| `EVOLUTION_API_KEY` | API key da Evolution | Sim |
| `EVOLUTION_INSTANCE` | Nome da instância | Sim |
| `REDIS_HOST` | Host Redis | Não |
| `REDIS_PORT` | Porta Redis | Não |
| `REDIS_PASSWORD` | Senha Redis | Não |
| `ADMIN_PASSWORD` | Senha de acesso admin | Sim |
| `NEXT_PUBLIC_APP_URL` | URL pública do app | Sim |

Veja [`.env.example`](.env.example) para o template completo.

## Documentação

Documentação técnica completa em [`docs/`](docs/):

| Documento | Descrição |
|-----------|-----------|
| [Arquitetura](docs/ARCHITECTURE.md) | Visão geral, componentes, fluxo de dados |
| [Referência da API](docs/API_REFERENCE.md) | 98+ endpoints REST documentados |
| [Banco de Dados](docs/DATABASE.md) | 40 tabelas, relacionamentos, índices |
| [Pipeline de IA](docs/AI_PIPELINE.md) | Provedores, RAG, failover, custos |
| [Canais WhatsApp](docs/CHANNELS.md) | Evolution V2/GO, Cloud API, roteamento |
| [Workers](docs/WORKERS.md) | 6 schedulers: organizer, automação, campanhas |
| [Segurança](docs/SECURITY.md) | Auth, multi-tenancy, feature gating |
| [Frontend](docs/FRONTEND.md) | 17 páginas, componentes, hooks |

Guias operacionais:

- [Passo a Passo Deploy](docs/PASSO_A_PASSO_DEPLOY.md)
- [Deploy Easypanel](docs/DEPLOY_EASYPANEL.md)
- [Variáveis Easypanel](docs/VARIAVEIS_EASYPANEL.md)
- [Integração N8N](docs/N8N_INTEGRACAO.md)
- [Restore / Backup](docs/RESTORE.md)

## Contribuindo

Contribuições são bem-vindas! Veja [CONTRIBUTING.md](CONTRIBUTING.md) para o workflow.

1. Fork o projeto
2. Crie uma branch (`git checkout -b feature/nova-feature`)
3. Commit suas mudanças (`git commit -m 'feat: adiciona nova feature'`)
4. Push para a branch (`git push origin feature/nova-feature`)
5. Abra um Pull Request

## Licença

Este projeto está licenciado sob a Licença MIT — veja [LICENSE](LICENSE) para detalhes.

---

<div align="center">

Desenvolvido por [Salomão AI](https://github.com/gasalomao)

</div>
