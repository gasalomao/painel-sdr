# Documentação Técnica — Painel SDR

Bem-vindo à documentação técnica completa do Painel SDR. Esta seção cobre todos os aspectos do sistema, da arquitetura ao deployment.

## Índice

| Documento | Descrição |
|-----------|-----------|
| [Arquitetura do Sistema](./ARCHITECTURE.md) | Visão geral, fluxo de dados, componentes e padrões |
| [Referência da API](./API_REFERENCE.md) | Todos os 98+ endpoints REST documentados |
| [Esquema do Banco de Dados](./DATABASE.md) | 40 tabelas, relacionamentos, triggers, índices |
| [Modelo de Segurança](./SECURITY.md) | Autenticação, multi-tenancy, RLS, feature gating |
| [Workers e Schedulers](./WORKERS.md) | Automação, campanhas, follow-up, lembretes |
| [Pipeline de IA](./AI_PIPELINE.md) | Provedores, RAG, embeddings, roteamento, custos |
| [Canais de WhatsApp](./CHANNELS.md) | Evolution API, Cloud API, abstração multi-provider |
| [Frontend](./FRONTEND.md) | Páginas, componentes, hooks, padrões UI |
| [Deployment](./DEPLOY_EASYPANEL.md) | Guia de deploy no Easypanel (já existente) |
| [Variáveis de Ambiente](./VARIAVEIS_EASYPANEL.md) | Referência de env vars (já existente) |
| [Integração N8N](./N8N_INTEGRACAO.md) | Wiring com n8n (já existente) |
| [Disaster Recovery](./RESTORE.md) | Plano de recuperação (já existente) |

## Estatísticas do Sistema

| Métrica | Valor |
|---------|-------|
| Tabelas no banco | 40 (33 canônicas + 7 opcionais) |
| Endpoints de API | 98+ em 32 grupos |
| Módulos em `src/lib/` | 66 arquivos |
| Páginas frontend | 17 rotas |
| Workers/schedulers | 6 timers em background |
| Provedores de IA | 3 (Gemini, OpenRouter, Gateway/CLIProxyAPI) |
| Provedores de WhatsApp | 3 (Evolution V2, Evolution GO, Cloud API) |
| Migrações SQL | 39 arquivos |
| Stack | Next.js 16, React 19, Supabase, Redis/BullMQ |
