# Follow-ups — estado e histórico

## Estado atual — 2026-10-11

O worker atual usa a migration incremental `021_agent_followup_claims.sql`, claim por tarefa, token de ownership, intenção pré-envio persistida e finalização idempotente. Requer `AGENT_FOLLOWUP_WORKER_ENABLED=true` após aplicar a migration e revisar a configuração; padrão false. A aplicação em banco real e envio de WhatsApp NÃO foram executados nesta validação.

Preparação expirada pode ser recuperada com fencing. Envio iniciado ou resultado desconhecido permanece `sending`/`ambiguous`: nunca é reenviado automaticamente. Confirmação perdida exige reconciliação de provider/DB; não há promessa de exactly-once externa. Resposta do contato, pausa e vínculo da instância são revalidados antes da intenção; resposta concorrente posterior ainda é possível.

Testes PGlite validam transições e isolamento em banco embarcado; chamadas concorrentes no mesmo PGlite são serializadas e não comprovam dois backends PostgreSQL reais. Testes de worker usam transporte mockado, sem WhatsApp real.

Validação offline em 2026-10-11: 11 testes SQL de claim e 20 testes do worker aprovados; cobertura do worker 98,55% de linhas/statements, 100% de funções e 91,35% de branches. Suíte completa: 1.789 aprovados e 31 skipped. Lint, TypeScript e build sintético aprovados. Isso não comprova migração/WhatsApp reais nem prontidão integral do produto.

## Histórico antigo

> As afirmações abaixo de prontidão, datas e métricas são históricas e não representam os gates atuais. Não executar SQL/mensagens reais sem aprovação específica.

**Data:** Janeiro 2025
**Status:** ✅ PRONTO PARA PRODUÇÃO

---

## 🎯 O QUE FOI IMPLEMENTADO

### ✅ 1. Interface de Controle Multi-Agente
**Arquivo:** `src/app/follow-up-control/page.tsx`

**Funcionalidades:**
- 🤖 Seletor de agente (qualquer agente da conta)
- ⏸️ Master switch (liga/desliga sistema)
- 🎛️ 4 follow-ups configuráveis (1h, 4h, 24h, 48h)
- ⏱️ Timing ajustável por follow-up
- 📝 Templates editáveis com variáveis
- 💾 Salva no banco (isolado por agente e client_id)
- 📊 Estatísticas em tempo real
- 🔄 Restaurar padrões

**Multi-tenant:** ✅ Só mostra agentes do client_id do usuário logado

---

### ✅ 2. Banco de Dados
**Migration:** `migrations/018_agent_followups_multi_tenant.sql`

**Tabela criada:** `agent_followups`

**Campos principais:**
- `client_id` - Isolamento multi-tenant
- `agent_id` - Qual agente é responsável
- `session_id` - Sessão de conversa original
- `remote_jid` - WhatsApp JID do contato
- `current_step` - Etapa atual (1-4)
- `next_send_at` - Quando enviar próxima mensagem
- `status` - pending, sent, cancelled, completed, failed

**Índices de performance:**
- `idx_agent_followups_worker_query` - Query principal do worker
- `idx_agent_followups_client_id` - Isolamento multi-tenant
- Mais 7 índices adicionais

**Row Level Security (RLS):**
- ✅ Usuários só veem follow-ups da própria conta
- ✅ Service role tem acesso total (worker)

---

### ✅ 3. Worker Automático
**Arquivo:** `src/workers/agent-followup-worker.ts`

**Processamento a cada 2 minutos:**
1. Busca follow-ups pendentes (status=pending, next_send_at <= agora)
2. Verifica se lead respondeu (cancela se sim)
3. Busca configuração do agente
4. Renderiza template com dados do lead
5. Envia mensagem via Evolution API
6. Atualiza status e agenda próximo follow-up
7. Salva no histórico de chat

**Funcionalidades:**
- ✅ Multi-tenant (respeita client_id)
- ✅ Multi-agente (cada agente tem sua config)
- ✅ Cancelamento automático se lead responder
- ✅ Suporte a steps desativados (pula para próximo)
- ✅ Rate limit (2s entre mensagens)
- ✅ Tratamento de erros robusto
- ✅ Logs detalhados

---

### ✅ 4. Integração com Agent Process
**Arquivo:** `src/app/api/agent/process/route.ts` (modificado)

**Agendamento automático:**
- ✅ Agenda follow-up após primeira mensagem bem-sucedida
- ✅ Verifica se follow-ups estão habilitados
- ✅ Não cria duplicados (verifica se já existe)
- ✅ Calcula delay do primeiro follow-up
- ✅ Erro no follow-up não quebra resposta principal

**Condições para agendar:**
- Mensagem enviada com sucesso
- Não é modo teste
- Agente tem `follow_up.enabled = true`
- Não existe follow-up ativo para esta sessão

---

### ✅ 5. Worker Scheduler
**Arquivo:** `src/instrumentation.ts` (modificado)

**Ticker adicionado:**
```typescript
// A cada 2 minutos
globalThis.agentFollowupTickerId = setInterval(async () => {
  const { runFollowUpWorker } = await import("@/workers/agent-followup-worker");
  await runFollowUpWorker();
}, 1000 * 120);
```

**Proteção contra overlap:** ✅ Flag `agentFollowupTicking`

---

### ✅ 6. API de Estatísticas
**Arquivo:** `src/app/api/followup/stats/route.ts`

**Endpoint:** `GET /api/followup/stats?agent_id=X`

**Retorna:**
```json
{
  "success": true,
  "agent": { "id": 1, "name": "Sarah SDR" },
  "stats": {
    "total": 150,
    "pending": 30,
    "sent": 80,
    "completed": 25,
    "cancelled": 10,
    "failed": 5,
    "nextScheduled": 15,
    "conversionRate": "6.7%"
  },
  "byStep": {
    "step_1": 40,
    "step_2": 30,
    "step_3": 20,
    "step_4": 10
  }
}
```

**Multi-tenant:** ✅ Só retorna dados do client_id do usuário

---

## 🚀 COMO FUNCIONA

### Fluxo Completo

```
1. ENVIO INICIAL
   Agent envia primeira mensagem → Agenda follow-up (step 1, delay 1h)

2. AFTER 1 HORA
   Worker detecta follow-up pendente → Verifica se lead respondeu
   ├─ Se respondeu → Cancela follow-up (status=cancelled)
   └─ Se não respondeu → Envia mensagem step 1 → Agenda step 2 (delay 4h)

3. AFTER 4 HORAS
   Worker detecta follow-up pendente → Verifica se lead respondeu
   ├─ Se respondeu → Cancela follow-up
   └─ Se não respondeu → Envia mensagem step 2 → Agenda step 3 (delay 24h)

4. AFTER 24 HORAS
   Worker detecta follow-up pendente → Verifica se lead respondeu
   ├─ Se respondeu → Cancela follow-up
   └─ Se não respondeu → Envia mensagem step 3 → Agenda step 4 (delay 48h)

5. AFTER 48 HORAS
   Worker detecta follow-up pendente → Verifica se lead respondeu
   ├─ Se respondeu → Cancela follow-up
   └─ Se não respondeu → Envia mensagem step 4 → Completa (status=completed)
```

---

## 📊 CONFIGURAÇÃO

### 1. Executar Migration
```sql
-- No Supabase SQL Editor
psql < migrations/018_agent_followups_multi_tenant.sql
```

### 2. Acessar Interface
```
http://localhost:3000/follow-up-control
```

### 3. Configurar Agente
1. Selecione o agente no dropdown
2. Ative o master switch
3. Configure delays e mensagens
4. Salvar

### 4. Testar
1. Envie uma mensagem via agent
2. Aguarde 1 hora (ou ajuste delay para 1 minuto para teste)
3. Verifique logs: `[FOLLOWUP WORKER]`

---

## 🧪 TESTE COMPLETO

### Passo 1: Configurar
```
1. Acesse /follow-up-control
2. Selecione agente "Sarah SDR"
3. Ative sistema (switch master)
4. Mude delay 1h para 1 minuto (teste rápido)
5. Salvar
```

### Passo 2: Testar Agendamento
```
1. Abra /chat
2. Envie mensagem para um lead de teste
3. Verifique banco:
   SELECT * FROM agent_followups WHERE status = 'pending';
4. Deve aparecer 1 registro com next_send_at daqui 1 minuto
```

### Passo 3: Testar Worker
```
1. Aguarde 2-3 minutos (worker roda a cada 2min)
2. Verifique logs do servidor:
   "[FOLLOWUP WORKER] 1 follow-up(s) pendente(s)"
   "[FOLLOWUP WORKER] ✓ Mensagem enviada"
3. Verifique banco:
   SELECT * FROM agent_followups;
   - status mudou para "sent"
   - current_step mudou para 2
   - next_send_at agendado para próximo step
```

### Passo 4: Testar Cancelamento
```
1. Lead responde no WhatsApp
2. Aguarde próximo tick do worker
3. Verifique banco:
   SELECT * FROM agent_followups WHERE status = 'cancelled';
4. Follow-up deve estar cancelado
```

---

## 📁 ARQUIVOS MODIFICADOS/CRIADOS

### Criados
```
✅ migrations/018_agent_followups_multi_tenant.sql
   Tabela + índices + RLS

✅ src/workers/agent-followup-worker.ts
   Worker automático (520 linhas)

✅ src/app/api/followup/stats/route.ts
   API de estatísticas

✅ src/app/follow-up-control/page.tsx (reescrito)
   Interface multi-agente (650 linhas)
```

### Modificados
```
✅ src/instrumentation.ts
   Adiciona ticker do worker

✅ src/app/api/agent/process/route.ts
   Adiciona agendamento após envio

✅ src/app/follow-up/page.tsx
   Adiciona botão "Controle Sarah" → "Controle Follow-ups"

✅ src/app/chat/page.tsx
   Fix do ícone Maps (busca por remoteJid também)
```

---

## ⚙️ VARIÁVEIS DE AMBIENTE

Nenhuma nova variável necessária. Usa as mesmas do Evolution API:
- `EVOLUTION_API_URL`
- `EVOLUTION_API_KEY`

---

## 🔒 SEGURANÇA MULTI-TENANT

### Isolamento Garantido

**1. Interface (`/follow-up-control`)**
```typescript
// Só mostra agentes do client_id do usuário
const { data: profile } = await supabase
  .from("profiles")
  .select("client_id")
  .eq("id", user.id)
  .single();

const { data: agents } = await supabase
  .from("agent_settings")
  .select("*")
  .eq("client_id", profile.client_id); // ← Isolamento
```

**2. Worker**
```typescript
// Cada follow-up tem client_id
// RLS garante isolamento no banco
SELECT * FROM agent_followups
WHERE status = 'pending'
  AND client_id = '...' // ← RLS automático
```

**3. API de Estatísticas**
```typescript
// Verifica ownership do agente
const { data: agent } = await supabase
  .from("agent_settings")
  .select("*")
  .eq("id", agentId)
  .eq("client_id", clientId); // ← Isolamento
```

---

## 📊 MÉTRICAS E MONITORAMENTO

### Logs do Worker
```
[FOLLOWUP WORKER] 5 follow-up(s) pendente(s)
[FOLLOWUP WORKER] Processando #123 - Agente 1, Step 2/4, JID 5511999999999@s.whatsapp.net
[FOLLOWUP WORKER] Lead 5511999999999 respondeu - cancelando follow-up #123
[FOLLOWUP WORKER] ✓ Follow-up #124 enviado - próximo step 3 agendado para 2025-01-11T15:30:00Z
[FOLLOWUP WORKER] ✓ Processamento concluído
```

### Query de Monitoramento
```sql
-- Follow-ups por status
SELECT status, COUNT(*)
FROM agent_followups
GROUP BY status;

-- Taxa de resposta por agente
SELECT
  a.name as agente,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE f.status = 'cancelled') as responderam,
  ROUND(100.0 * COUNT(*) FILTER (WHERE f.status = 'cancelled') / COUNT(*), 2) as taxa_resposta
FROM agent_followups f
JOIN agent_settings a ON a.id = f.agent_id
GROUP BY a.name;

-- Próximos follow-ups (24h)
SELECT
  a.name as agente,
  f.remote_jid,
  f.current_step,
  f.next_send_at
FROM agent_followups f
JOIN agent_settings a ON a.id = f.agent_id
WHERE f.status = 'pending'
  AND f.next_send_at <= NOW() + INTERVAL '24 hours'
ORDER BY f.next_send_at;
```

---

## ✅ CHECKLIST DE VALIDAÇÃO

### Infraestrutura
- [x] Migration executada
- [x] Tabela `agent_followups` criada
- [x] Índices criados
- [x] RLS configurado
- [x] Worker adicionado ao instrumentation.ts

### Funcionalidades
- [x] Interface multi-agente funciona
- [x] Salva configuração no banco
- [x] Worker processa follow-ups
- [x] Envia mensagens via Evolution
- [x] Cancela se lead responder
- [x] Agenda próximo step corretamente
- [x] Respeita steps desativados
- [x] Estatísticas carregam

### Multi-Tenant
- [x] Interface só mostra agentes da conta
- [x] Worker respeita client_id
- [x] API stats valida ownership
- [x] RLS bloqueia acesso entre contas

### Testes
- [x] Agendamento automático após envio
- [x] Worker processa follow-ups
- [x] Cancelamento ao responder
- [x] Múltiplos agentes simultâneos
- [x] Múltiplos clientes isolados

---

## 🎉 RESULTADO FINAL

✅ **Sistema 100% funcional**
✅ **Multi-agente (qualquer agente, não só Sarah)**
✅ **Multi-tenant (isolamento por client_id)**
✅ **Automação completa (worker a cada 2 minutos)**
✅ **Interface visual intuitiva**
✅ **Estatísticas em tempo real**
✅ **Documentação completa**

---

## 🚀 PRÓXIMOS PASSOS OPCIONAIS

### Dashboard Avançado
- Gráficos de conversão por step
- Timeline de envios
- A/B testing de mensagens

### Inteligência Artificial
- IA sugere melhor horário de envio
- IA personaliza mensagens por lead
- IA aprende com respostas

### Notificações
- Alertar quando follow-up converte
- Notificar falhas de envio
- Resumo diário por email

---

**Status:** ✅ FASE 2 COMPLETA E TESTADA
**Pronto para produção:** SIM
**Risco:** Baixo (testado e documentado)
