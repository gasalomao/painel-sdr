# Workers e Schedulers

O sistema opera com 6 timers em background registrados via `src/instrumentation.ts` (hook `register()` do Next.js). Todos rodam dentro do processo do servidor Next.js (não são processos separados).

## Visão Geral

| Timer | Intervalo | Guard | Arquivo |
|-------|-----------|-------|---------|
| Organizer IA | 5 min | `organizerTicking` | `lib/organizer-config-cache.ts` + `/api/ai-organize` |
| Automation | 60s | `automationTicking` | `lib/automation-worker.ts` |
| Campaign safety-net | 90s | `campaignTicking` | `lib/campaign-worker.ts` |
| Follow-up | 2 min | `followupTicking` | `lib/followup-worker.ts` |
| Appointment | 60s | `appointmentTicking` | `lib/appointment-worker.ts` |
| Boot recovery | 1x no boot | — | `recoverRunningCampaigns()` |

Todos os timers:
- Guardados em `globalThis` (sobrevivem a HMR)
- Tem flag `in-flight` para prevenir sobreposição
- Boot delay de 15-20s para Supabase estar pronto

---

## 1. Organizer IA (5 min)

**Arquivo**: `src/lib/organizer-config-cache.ts` + `src/app/api/ai-organize/route.ts`

### Fluxo

```
A cada 5 minutos:
1. getOrganizerConfig() (cache 60s) → config global
2. SELECT * FROM clients WHERE organizer_enabled != false
3. Para cada client:
   a. Hora atual ≥ organizer_execution_hour? (default 20)
   b. Já rodou hoje? (organizer_last_run)
   c. Se não: POST /api/ai-organize
      Headers: x-internal-secret
      Body: { clientId, clientName, config, trigger: "schedule" }
4. Em /api/ai-organize:
   a. Carrega kanban_columns do client
   b. Carrega leads sem ia_last_analyzed_at recente
   c. Builda prompt com buildOrganizerSystemPrompt()
   d. Adiciona contexto: kanban columns, appointments, date context
   e. generateText() via AI provider
   f. Parsing: status novo + justificativa + resumo
   g. UPDATE leads_extraidos SET status=..., justificativa_ia=...
   h. INSERT historico_ia_leads (auditoria)
   i. UPDATE clients SET organizer_last_run=NOW()
```

### Configuração por Cliente

| Campo | Default | Descrição |
|-------|---------|-----------|
| `organizer_enabled` | `false` | Liga/desliga para o cliente |
| `organizer_execution_hour` | `20` | Hora do dia para rodar (0-23) |
| `organizer_last_run` | — | Timestamp da última execução |

---

## 2. Automation Ticker (60s)

**Arquivo**: `src/lib/automation-worker.ts`

### State Machine

```
idle → scraping → campaigning → following → done
                                   ↓
                              (error → paused)
```

### Fluxo por Tick

```
1. SELECT * FROM automations WHERE status = 'running'
2. Para cada automação:
   a. phase = 'idle' → start scraping (se niches/regions configurados)
   b. phase = 'scraping' → checa se scrape terminou
      → scraped_count targets? avança para 'campaigning'
   c. phase = 'campaigning' → checa se campanha terminou
      → followup_enabled? cria followup_campaign → 'following'
      → sem followup? → 'done'
   d. phase = 'following' → checa se followup terminou → 'done'
   e. phase = 'done' → status = 'done', finished_at = NOW()
3. Erro em qualquer fase → status = 'paused', last_error registrado
```

### APIs

| Função | Descrição |
|--------|-----------|
| `tickAllAutomations()` | Itera todas as automações running |
| `startAutomation(id)` | Inicia automação: cria campaign + followup |
| `pauseAutomation(id)` | Pausa automação |

---

## 3. Campaign Ticker (90s)

**Arquivo**: `src/lib/campaign-worker.ts`

### Propósito

Safety-net para campanhas que perderam seu timer interno (restart, deploy, crash).

### Fluxo

```
1. recoverRunningCampaigns() no boot
   → SELECT * FROM campaigns WHERE status = 'running'
   → Para cada: tickRunningCampaigns()
   
2. A cada 90s:
   → SELECT * FROM campaigns WHERE status = 'running'
   → tickRunningCampaigns():
     a. Encontra próximo target pending
     b. Renderiza template (renderTemplate)
     c. Opcional: personaliza com IA (personalize_with_ai)
     d. Verifica janela de horário BRT (9h-20h default)
     e. Envia via channel.sendMessage
     f. Jitter aleatório entre min/max interval
     g. UPDATE campaign_targets SET status='sent'
     h. Se erro: status='failed', incrementa failed_count
   c. Todos targets processados? → campaign.status = 'done'
```

### Controle de Janela de Horário

```typescript
function isWithinHourWindow(startHour, endHour): boolean
// Default: 9h-20h BRT (America/Sao_Paulo)
// Horário do navegador converte para BRT
```

### Jitter Anti-Ban

```typescript
function jitterMs(min, max): number
// Random entre min_interval_seconds e max_interval_seconds
// Default: 60s-180s (1-3 minutos)
```

---

## 4. Follow-up Ticker (2 min)

**Arquivo**: `src/lib/followup-worker.ts`

### Fluxo

```
1. promoteStalePrimeiroContato()
   → SELECT sessions WHERE status='primeiro_contato' AND created_at < NOW()-24h
   → UPDATE SET status='follow-up' (auto-promoção)

2. tickAllAutoCampaigns()
   → SELECT followup_campaigns WHERE status='active'
   → Para cada: tickCampaign():
     a. SELECT followup_targets WHERE status='pending' OR 'waiting'
     b. next_send_at <= NOW()? → processa
     c. Lead respondeu desde último envio?
        → SIM: status='responded', para follow-up
        → NÃO: envia próximo step
     d. Renderiza template do step atual
     e. Opcional: personalizeFollowupWithAI (IA lê histórico)
     f. Envia via channel.sendMessage
     g. current_step++, calcula next_send_at
     h. Todos steps enviados? → status='exhausted'
```

### Detecção de Resposta

```sql
-- Se o lead enviou qualquer mensagem após o último follow-up:
SELECT 1 FROM messages 
WHERE session_id = target.session_id 
  AND sender = 'customer' 
  AND created_at > target.last_sent_at
```

### AI Personalization

```typescript
async personalizeFollowupWithAI(target, campaign):
  1. getConversationHistory(session_id, lastMessages)
  2. Build prompt: "Personalize this follow-up based on conversation..."
  3. generateText(campaign.ai_model, prompt)
  4. Retorna mensagem personalizada
```

---

## 5. Appointment Ticker (60s)

**Arquivo**: `src/lib/appointment-worker.ts` + `src/lib/google-calendar-sync.ts`

### Sub-timers

O ticker de 60s tem 3 funções com cadências diferentes:

| Função | Cadência | Descrição |
|--------|----------|-----------|
| `tickReminders()` | A cada tick (60s) | Envia lembretes de agendamentos próximos |
| `tickGoogleSyncAll()` | A cada 3 ticks (~3min) | Sincroniza Google Calendar → appointments |
| `tickAutoPromote()` | A cada 5 ticks (~5min) | Promove leads em coluna terminal |

### tickReminders()

```
1. SELECT appointments WHERE status IN ('confirmed','tentative')
   AND start_at BETWEEN NOW() AND NOW()+reminder_offset
   AND NOT already_reminded
2. Para cada: envia WhatsApp com template de lembrete
3. Marca reminder_sent_at
```

### tickGoogleSyncAll()

```
1. SELECT agent_settings WHERE options.google_tokens IS NOT NULL
2. Para cada agente com Google conectado:
   a. Listar eventos do Google Calendar (last 7 days → next 30 days)
   b. Para cada evento: upsert em appointments
      - Match por google_event_id
      - Diff: só atualiza se title/start/end/status mudou
3. Eventos cancelados no Google → status='cancelled'
```

### tickAutoPromote()

```
1. SELECT sessions WHERE status IN kanban_columns (terminal: 'fechado','perdido','sem_contato')
   AND created_at < NOW()-30 days
2. NÃO move (já está em coluna terminal)
3. Apenas reporta métricas de stale leads
```

---

## 6. Worker Standalone (BullMQ)

**Arquivo**: `src/workers/message-worker.ts`

### Propósito

Processa fila de envio de mensagens via Redis/BullMQ. **Opcional** — o sistema funciona sem Redis (envio síncrono).

### Configuração

```bash
# Worker roda como processo separado:
node src/workers/message-worker.ts

# Não é iniciado pelo Dockerfile CMD
# Requer deployment como segundo serviço no Easypanel
```

### Job

```typescript
// Payload do job
{
  remoteJid: string,       // JID do destinatário
  text: string,            // Conteúdo
  media?: MediaData,       // Mídia opcional
  instanceName: string,    // Instância WhatsApp
  messageDbId?: string,    // ID em messages (V2)
  legacyDbId?: number,     // ID em chats_dashboard (legado)
}

// Processamento:
// 1. channel.sendMessage() ou channel.sendMedia()
// 2. Update messages.delivery_status = 'sent'
// 3. Update chats_dashboard.status_envio = 'sent'
// 4. On error: mark error + rethrow (BullMQ retry)
```

### Concorrência

```typescript
new Worker(QUEUE_NAME, processor, { concurrency: 5 });
// Processa até 5 mensagens em paralelo
```

### Graceful Shutdown

```typescript
process.on('SIGTERM', async () => {
  await worker.close();  // Aguarda jobs em andamento
  process.exit(0);
});
```

---

## Redis — Degradação Graciosa

**Arquivo**: `src/lib/redis-queue.ts`

```typescript
// Se Redis indisponível:
// - getRedisConnection() retorna null
// - getMessageQueue() retorna null
// - pauseAiForJid/resumeAiForJid no-op
// - Worker não inicia
// - Server Next.js continua funcionando (envio síncrono)
```

| Função | Sem Redis |
|--------|-----------|
| Envio de mensagem | Síncrono (inline) |
| Pausa IA por JID | Não funciona |
| Fila de mensagens | Não processa |
| Campaign/follow-up | Funciona (usa setTimeout inline) |
