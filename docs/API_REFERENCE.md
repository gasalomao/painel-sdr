# Referência da API

98 endpoints em `src/app/api/`. Todos respondem JSON. Autenticação via cookie `sdr_session` (JWT) exceto onde indicado.

## Convenções

| Aspecto | Detalhe |
|---------|---------|
| **Auth** | Cookie `sdr_session` (JWT hash em `auth_sessions`) |
| **Multi-tenant** | `getClientIdFromRequest()` extrai `client_id` do JWT |
| **Admin-only** | `session.isAdmin === true` |
| **Internal** | Header `x-internal-secret` (schedulers → API) |
| **Webhooks** | API key ou signature verification (sem JWT) |
| **Content-Type** | `application/json` (exceto `upload-media`: `multipart/form-data`) |
| **Erros** | `{ error: "mensagem" }` com HTTP status apropriado |

---

## Autenticação

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/auth/login` | Login com email + senha → seta cookie `sdr_session` |
| POST | `/api/auth/logout` | Logout → revoga sessão |
| GET | `/api/auth/session` | Sessão atual (`{ client, isAdmin, features, impersonating }`) |
| POST | `/api/auth/change-password` | Alterar senha |
| GET | `/api/auth/google/url` | URL de OAuth do Google (Calendar) |
| GET | `/api/auth/callback/google` | Callback OAuth → salva tokens |

---

## Admin (admin-only)

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/admin/clients` | Lista todos os tenants |
| POST | `/api/admin/clients` | Cria novo tenant |
| GET | `/api/admin/clients/[id]` | Detalhes de um tenant |
| PATCH | `/api/admin/clients/[id]` | Atualiza tenant (features, modelo IA, etc.) |
| DELETE | `/api/admin/clients/[id]` | Remove tenant |
| POST | `/api/admin/clients/[id]/impersonate` | Impersona tenant (login como) |
| POST | `/api/admin/stop-impersonate` | Para impersonação |

---

## Agentes de IA

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/agents` | Lista agentes do tenant |
| POST | `/api/agent/process` | Processa mensagem via IA (chat) — **core** |
| POST | `/api/agent/rewrite` | Reescreve mensagem com IA |
| POST | `/api/agent/control` | Liga/desliga bot por sessão |
| POST | `/api/agent/clear-memory` | Limpa histórico/summary da sessão |
| GET | `/api/agent/pause-config` | Config de pausa atual |
| POST | `/api/agent/pause-config` | Atualiza config de pausa |
| GET | `/api/agent/diagnose-ai` | Diagnóstico do pipeline de IA |
| GET | `/api/agent/diagnose-rag` | Diagnóstico do RAG (embeddings) |
| POST | `/api/agent/knowledge/save` | Salva documento na base de conhecimento |
| POST | `/api/agent/knowledge/reindex` | Reindexa embeddings (chunk + embed) |
| POST | `/api/agent/reindex-kb` | Reindexa toda a base (alias) |

### `/api/agent/process` (Core)

```json
// Request
{
  "remoteJid": "5511999999999@s.whatsapp.net",
  "instanceName": "sdr",
  "messageText": "Quero agendar",
  "agentId": 1
}

// Response
{
  "reply": "Claro! Qual o melhor horário?",
  "stageChanged": false,
  "variables": { "nome": "João" }
}
```

**Pipeline interno:**
1. Session lookup/creation
2. Bot status check (bot_active?)
3. Stage machine advancement
4. RAG context injection
5. History summary (se longo)
6. `generateText()` via AI provider
7. Variable capture
8. Webhook fire (se configurado)

---

## Organizador IA

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/organizer` | Config do organizer |
| PATCH | `/api/organizer` | Atualiza config |
| PATCH | `/api/organizer/global-toggle` | Liga/desliga globalmente |
| GET | `/api/organizer/effective-prompt` | Prompt efetivo (com variáveis resolvidas) |
| PATCH | `/api/organizer/model` | Altera modelo de IA |
| POST | `/api/organizer/run-now` | Executa imediatamente (manual) |
| POST | `/api/organizer/suggest-prompt` | IA sugere prompt de organizador |
| POST | `/api/organizer/suggest-kanban` | IA sugere colunas kanban |
| GET | `/api/organizer/history` | Histórico de execuções |
| DELETE | `/api/organizer/history` | Limpa histórico |
| POST | `/api/ai-organize` | Endpoint interno (schedulers) — executa triagem |
| GET | `/api/ai-organize/config` | Config global do organizer |

---

## Campanhas e Disparo

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/campaigns` | Lista campanhas |
| POST | `/api/campaigns` | Cria campanha |
| GET | `/api/campaigns/[id]` | Detalhes + targets + logs |
| PATCH | `/api/campaigns/[id]` | Atualiza (status, template, etc.) |
| POST | `/api/campaigns/[id]` | Ação (start, pause, cancel) |
| DELETE | `/api/campaigns/[id]` | Remove campanha |

---

## Follow-up

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/followup` | Lista campanhas de follow-up |
| POST | `/api/followup` | Cria campanha de follow-up |
| GET | `/api/followup/[id]` | Detalhes + targets |
| PATCH | `/api/followup/[id]` | Atualiza |
| DELETE | `/api/followup/[id]` | Remove |
| POST | `/api/followup/[id]/enroll` | Inscreve leads (batch) |
| POST | `/api/followup/[id]/preview` | Preview de mensagem renderizada |
| POST | `/api/followup/[id]/tick` | Força execução de um tick |

---

## Automação

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/automations` | Lista automações |
| POST | `/api/automations` | Cria automação (scrape → disparo → follow-up) |
| GET | `/api/automations/[id]` | Detalhes + logs |
| PATCH | `/api/automations/[id]` | Atualiza config |
| DELETE | `/api/automations/[id]` | Remove |
| POST | `/api/automations/[id]/start` | Inicia execução |
| POST | `/api/automations/[id]/pause` | Pausa execução |

---

## CRM / Leads

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/leads/create` | Cria lead manualmente |
| POST | `/api/leads/save` | Atualiza lead (edit inline kanban) |
| DELETE | `/api/leads/delete` | Remove lead |
| POST | `/api/leads/analyze` | Lead Intelligence (enriquecimento IA) |

---

## Kanban

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/kanban-columns` | Lista colunas do tenant |
| POST | `/api/kanban-columns` | Cria coluna |
| PATCH | `/api/kanban-columns` | Reordena/atualiza múltiplas colunas |
| PATCH | `/api/kanban-columns/[id]` | Atualiza uma coluna |
| DELETE | `/api/kanban-columns/[id]` | Remove coluna |

---

## Chat / Inbox

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/chat/sync` | Sincroniza mensagens (pull incremental) |
| POST | `/api/chat/sync-evolution` | Sync via Evolution API (fetch remoto) |
| GET | `/api/chat/messages` | Busca mensagens paginadas |
| DELETE | `/api/chat/messages` | Apaga mensagem |
| POST | `/api/send-message` | Envia mensagem WhatsApp (manual) |
| POST | `/api/upload-media` | Upload de mídia (multipart) → URL temporária |

---

## WhatsApp / Instâncias

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/whatsapp` | Lista instâncias + status |
| POST | `/api/whatsapp` | Cria instância (Evolution) |
| POST | `/api/whatsapp/setup` | Setup inicial (webhook, config) |
| GET | `/api/whatsapp/cloud` | Lista instâncias Cloud API |
| POST | `/api/whatsapp/cloud` | Registra/configura Cloud API |
| POST | `/api/whatsapp/instance/delete` | Deleta instância |
| GET | `/api/whatsapp/proxy` | Status do proxy WhatsApp |
| POST | `/api/whatsapp/proxy` | Configura proxy |
| DELETE | `/api/whatsapp/proxy` | Remove proxy |
| GET | `/api/instances` | Lista instâncias (alias) |
| GET | `/api/instances/stats` | Estatísticas por instância |

---

## Contatos

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/contacts/avatars` | Lista URLs de avatar |
| POST | `/api/contacts/avatars` | Atualiza avatar de um contato |
| POST | `/api/contacts/sync-avatars` | Sync em massa (bulk profile pics) |

---

## Agendamentos / Calendário

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/appointments` | Lista agendamentos (range) |
| POST | `/api/appointments` | Cria agendamento |
| GET | `/api/appointments/[id]` | Detalhes |
| PATCH | `/api/appointments/[id]` | Atualiza |
| DELETE | `/api/appointments/[id]` | Remove |
| GET | `/api/appointments/sync` | Sync Google Calendar → appointments |
| POST | `/api/calendario/connect-google` | Conecta Google Calendar (OAuth) |
| POST | `/api/calendario/rewrite-message` | Reescreve mensagem com IA |
| POST | `/api/calendario/send-followup` | Envia follow-up manual |

---

## Prospecção / Scraper

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/scraper` | Status do scraper |
| POST | `/api/scraper` | Inicia scrape Google Maps (SSE progress) |

### Prospecção Sites

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/prospeccao-sites/leads` | Lista leads sem website |
| DELETE | `/api/prospeccao-sites/leads` | Remove leads |
| GET | `/api/prospeccao-sites/campaigns` | Lista campanhas |
| POST | `/api/prospeccao-sites/campaigns` | Cria campanha |
| GET | `/api/prospeccao-sites/campaigns/[id]` | Detalhes |
| PATCH | `/api/prospeccao-sites/campaigns/[id]` | Atualiza |
| POST | `/api/prospeccao-sites/campaigns/[id]` | Ação (start/pause) |
| DELETE | `/api/prospeccao-sites/campaigns/[id]` | Remove |
| POST | `/api/prospeccao-sites/opt-out` | Marca opt-out |

---

## Modelos de IA

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/ai-models` | Lista todos os modelos (Gemini + OpenRouter + Gateway) |
| GET | `/api/ai-models/embeddings` | Lista modelos de embedding disponíveis |
| GET | `/api/settings/embedding-model` | Modelo de embedding atual |
| PATCH | `/api/settings/embedding-model` | Altera modelo de embedding |
| GET | `/api/settings/lead-intelligence` | Config de lead intelligence |
| PATCH | `/api/settings/lead-intelligence` | Atualiza config |

---

## Tokens / Custos

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/tokens` | Dados de uso e custo (charts) |
| GET | `/api/tokens/diagnose` | Diagnóstico de custo |
| GET | `/api/tokens/pricing` | Cache de preços atuais |
| POST | `/api/tokens/pricing` | Força refresh de preços |
| POST | `/api/tokens/recalc` | Recalcula custos retroativamente |

---

## Configurações

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/evolution/config` | Config Evolution V2 |
| POST | `/api/evolution/config` | Salva config V2 |
| PATCH | `/api/evolution/config` | Atualiza V2 |
| GET | `/api/evolution-go/config` | Config Evolution GO |
| POST | `/api/evolution-go/config` | Salva config GO |
| PATCH | `/api/evolution-go/config` | Atualiza GO |
| GET | `/api/config/ngrok` | URL ngrok atual |
| POST | `/api/config/ngrok` | Configura ngrok |
| POST | `/api/gateway-proxy` | Proxy para CLIProxyAPI (install, models, etc.) |

---

## Webhooks (sem JWT)

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| GET | `/api/webhooks/evolution-go` | — | Challenge de verificação Evolution |
| POST | `/api/webhooks/evolution-go` | API key | Recebe eventos Evolution V2/GO |
| GET | `/api/webhooks/whatsapp` | verify_token | Challenge Cloud API |
| POST | `/api/webhooks/whatsapp` | X-Hub-Signature-256 | Recebe eventos Cloud API |
| POST | `/api/webhooks/whatsapp/echo` | — | Echo webhook (debug) |
| GET | `/api/webhooks/whatsapp-cloud` | verify_token | Challenge Cloud API (alias) |
| POST | `/api/webhooks/whatsapp-cloud` | X-Hub-Signature-256 | Recebe eventos Cloud API (alias) |
| GET | `/api/webhooks/register` | Lista webhooks registrados |
| POST | `/api/webhooks/register` | Registra webhook na Evolution |
| GET | `/api/webhooks/diagnose` | Diagnóstico de webhook |

---

## DeepSeek Chat (API Reversa)

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/deepseek-chat/v1/models` | Lista modelos (formato OpenAI) |
| POST | `/api/deepseek-chat/v1/chat/completions` | Chat completion (formato OpenAI) |
| POST | `/api/deepseek-chat/manage` | Gerencia tokens |
| POST | `/api/deepseek-chat/import-bookmarklet` | Importa session token |
| GET | `/api/deepseek-chat/userscript.user.js` | Userscript (Tampermonkey) |

---

## Setup / Diagnóstico

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/setup-db` | Status do banco (tabelas existentes) |
| POST | `/api/setup-db` | Executa setup (cria tabelas faltantes) |
| GET | `/api/test-evo` | Testa conectividade Evolution API |
