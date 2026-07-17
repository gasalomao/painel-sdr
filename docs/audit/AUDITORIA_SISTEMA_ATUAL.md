# Auditoria do Sistema Atual — Painel SDR

> **Data:** 2026-07-14
> **Objetivo:** Inventariar todas as funcionalidades do sistema atual antes da migração para Chatwoot + Evolution GO.

---

## Stack Confirmada

| Componente | Tecnologia | Versão |
|------------|-----------|--------|
| Frontend | Next.js (App Router) | 16.2.3 |
| UI | React 19 + TailwindCSS | - |
| Backend | Next.js API Routes (serverless) | - |
| Banco | Supabase (PostgreSQL) | hospedado |
| WhatsApp | Evolution API (Node.js) | hospedado Easypanel |
| Redis | BullMQ (filas) | opcional (resiliente se offline) |
| IA | Google Gemini + OpenRouter + Gateway (CLIProxyAPI) + DeepSeek | - |
| Deploy | Easypanel na Hostinger | Docker |
| Storage | Supabase Storage (bucket `whatsapp_media`) | - |

## Provedor WhatsApp Atual

- **Evolution API** (Node.js/Baileys) hospedada em `https://sistema-evolution-api.ridnii.easypanel.host`
- API Key: `Gabriel@3074`
- Instância padrão: `sdr`
- Webhook: recebe em `/api/webhooks/whatsapp`

## Funcionalidades Inventariadas

### Chat
| # | Funcionalidade | Localização | Status |
|---|---------------|-------------|--------|
| 1 | Lista de conversas (agrupada por remote_jid) | `src/app/chat/page.tsx` | Preservar |
| 2 | Filtro por instância | `chat/page.tsx` | Preservar |
| 3 | Mensagens em tempo real (Supabase Realtime) | `chat/page.tsx` | Preservar |
| 4 | Envio de texto | `src/lib/channel.ts` | Preservar |
| 5 | Exibição de áudio (player WhatsApp) | `chat/page.tsx` | Preservar |
| 6 | Exibição de imagem/documento | `chat/page.tsx` | Preservar |
| 7 | Status de envio/entrega/leitura | `chat/page.tsx` | Preservar |
| 8 | Resposta citada | `chat/page.tsx` | Preservar |
| 9 | Busca de conversas | `chat/page.tsx` | Preservar |
| 10 | Indicador "digitando" | - | Verificar |

### Webhook (recebimento)
| # | Funcionalidade | Localização | Status |
|---|---------------|-------------|--------|
| 11 | Receber mensagens de texto | `src/app/api/webhooks/whatsapp/route.ts` | Migrar adaptador |
| 12 | Receber áudio (transcrição whisper/Gemini) | `webhooks/whatsapp/route.ts` | Preservar |
| 13 | Receber imagem (descrição Gemini) | `webhooks/whatsapp/route.ts` | Preservar |
| 14 | Receber documento (extração Gemini) | `webhooks/whatsapp/route.ts` | Preservar |
| 15 | Anti-duplicação (message_id) | `webhooks/whatsapp/route.ts` | Preservar |
| 16 | Upload de mídia (Supabase Storage) | `webhooks/whatsapp/route.ts` | Preservar |
| 17 | Auto-pausa quando humano responde | `webhooks/whatsapp/route.ts` | Preservar |
| 18 | Buffer de mensagens (agrupamento) | `agent/process/route.ts` | Preservar |

### IA (Agente SDR)
| # | Funcionalidade | Localização | Status |
|---|---------------|-------------|--------|
| 19 | Agente de IA com ferramentas (function calling) | `src/app/api/agent/process/route.ts` | Preservar |
| 20 | Roteamento de provedor (Gemini/OpenRouter/Gateway/DeepSeek) | `src/lib/ai-provider.ts` | Preservar |
| 21 | Failover entre contas gateway | `ai-provider.ts` + `gateway-cooldown.ts` | Preservar |
| 22 | Modo de raciocínio universal (0/1/2) | `ai-provider.ts` | Preservar |
| 23 | Contexto total (sumarização do histórico) | `history-summary.ts` | Preservar |
| 24 | Prompt caching (Gemini implícito + Claude cache_control) | `ai-provider.ts` | Preservar |
| 25 | Pausa pós-agendamento (2h por contato) | `agent/process/route.ts` | Preservar |
| 26 | Transcrição de áudio grátis (whisper.cpp) | `whisper-manager.ts` | Preservar |
| 27 | Conector OAuth (Antigravity/Codex/Gemini) | `gateway-proxy-manager.ts` | Preservar |
| 28 | DeepSeek modo conta (PoW + clipboard capture) | `deepseek-chat-client.ts` | Preservar |

### Organizador IA (Kanban)
| # | Funcionalidade | Localização | Status |
|---|---------------|-------------|--------|
| 29 | Kanban customizável (CRUD de colunas) | `src/app/organizador/page.tsx` | Preservar |
| 30 | IA move leads no kanban (adaptativo is_terminal) | `src/app/api/ai-organize/route.ts` | Preservar |
| 31 | Scheduler automático (5 min) | `src/instrumentation.ts` | Preservar |
| 32 | Backup duplo (auth-files no Supabase) | `gateway-auth-backup.ts` | Preservar |

### Outros Módulos
| # | Funcionalidade | Localização | Status |
|---|---------------|-------------|--------|
| 33 | Disparo em massa (campanhas) | `src/app/disparo/` | Preservar |
| 34 | Follow-up automático | `src/app/follow-up/` | Preservar |
| 35 | Google Calendar (agendamento) | `src/app/calendario/` | Preservar |
| 36 | Multi-tenant (isolamento por client_id) | `src/lib/tenant.ts` | Preservar |
| 37 | Admin (impersonação, gestão) | `src/app/api/admin/` | Preservar |

## Dependências do Evolution API Atual

O sistema depende de:
- **Evolution API** para: receber webhooks, enviar mensagens, QR code, status
- **Tabela `chats_dashboard`**: todas as mensagens (texto + mídia)
- **Tabela `messages` (V2)**: mensagens com relacionamento a instância
- **Tabela `channel_connections`**: vincula instância → agente
- **Tabela `sessions`**: estado do bot por contato (pausa, estágio, variáveis)

## Pontos de Acoplamento com Evolution API

1. `src/lib/channel.ts` — envio de mensagens (`sendMessage`, `sendMedia`)
2. `src/app/api/webhooks/whatsapp/route.ts` — parse de webhooks Evolution
3. `src/app/api/whatsapp/*` — status de instância, QR code
4. `src/app/api/evolution/*` — config da Evolution
5. Webhook payload shape (formato específico da Evolution API)

## Riscos da Migração

1. **Payload de webhook diferente**: Evolution GO tem formato diferente de Evolution API
2. **Endpoints diferentes**: rotas mudaram (ex: `/send/text` vs `/message/sendText`)
3. **Licença obrigatória**: Evolution GO exige ativação
4. **2 databases PostgreSQL**: GO precisa de `evogo_auth` + `evogo_users`
5. **Histórico**: mensagens antigas ficam no Supabase (não migrar — apenas adaptar o que chega novo)
