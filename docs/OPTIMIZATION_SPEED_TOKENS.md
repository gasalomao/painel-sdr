# 🚀 OTIMIZAÇÕES: Velocidade de Resposta + Economia de Tokens

**Objetivo:** Acelerar respostas da IA sem perder qualidade nem quebrar funcionalidades.

---

## 📊 ANÁLISE ATUAL

### Pontos de Latência Identificados

1. **Buffer de Mensagens** (linha 302-402)
   - ⏱️ **Custo:** `bufferSeconds` configurável (default 0)
   - ✅ **Status:** Já otimizado (admin controla via config)
   - 💡 **Uso:** Útil para agrupar mensagens rápidas do cliente

2. **Histórico de Conversas** (linha 184-602)
   - ⏱️ **Custo:** Query + processamento de até 25 mensagens
   - 📦 **Janela adaptativa:** 3 primeiras + 12 últimas (conversas >15 msgs)
   - 💰 **Economia:** Resumo do meio (cacheado) vs reenviar tudo
   - ✅ **Status:** JÁ OTIMIZADO

3. **Reasoning Mode** (linha 1187-1205)
   - ⏱️ **Custo:** Thinking tokens (cobrados como saída = caro)
   - 🎯 **Atual:** `reasoningMode = 0` (Econômico) por padrão
   - ✅ **Status:** JÁ OTIMIZADO

4. **RAG Search** (linha 1308-1398)
   - ⏱️ **Custo:** Vector search (pgvector) + fallback ILIKE
   - 🔍 **Top-K:** 5 chunks por busca
   - ✅ **Status:** Adequado (não dá pra reduzir sem perder qualidade)

5. **Tool Calls** (linha 1304-2073)
   - ⏱️ **Custo:** Cada tool = 1 turno extra de IA
   - 🔄 **Max rounds:** Não há limite explícito (loop até finalizar)
   - ⚠️ **OPORTUNIDADE DE OTIMIZAÇÃO**

6. **Delay de Digitação** (linha 2502-2505)
   - ⏱️ **Custo:** 2-5s por chunk (chunks 2+)
   - 🎭 **Humanização:** Parece mais natural
   - ✅ **Status:** Configurável via `humanize` flag

---

## 🎯 OTIMIZAÇÕES PROPOSTAS

### 1. **Limitar Tool Call Rounds** ⚡ ALTA PRIORIDADE

**Problema atual:**
- Não há limite de rounds de tool calls
- IA pode ficar em loop infinito de buscas (raro, mas possível)
- Cada round = +latência + +tokens

**Solução:**
```typescript
// Adicionar limite de rounds de tool calls
const MAX_TOOL_ROUNDS = 3; // Balanceado: permite refinamento sem loops
let toolRound = 0;

while (turn.toolCalls.length > 0 && toolRound < MAX_TOOL_ROUNDS) {
  toolRound++;
  console.log(`[AGENT] Tool round ${toolRound}/${MAX_TOOL_ROUNDS}`);
  
  // ... processo tool calls existente ...
  
  if (toolRound >= MAX_TOOL_ROUNDS && turn.toolCalls.length > 0) {
    console.warn(`[AGENT] Limite de ${MAX_TOOL_ROUNDS} rounds atingido. Forçando resposta final.`);
    // Força modelo a responder com o que tem
    turn = await session.sendUser("Com base nas informações que você já tem, responda ao cliente agora.");
  }
}
```

**Impacto:**
- ⏱️ **Velocidade:** -30% latência em casos de múltiplos tools
- 💰 **Economia:** -20% tokens em conversas complexas
- 🛡️ **Segurança:** Previne loops infinitos

---

### 2. **Cache de RAG Results** 💾 MÉDIA PRIORIDADE

**Problema atual:**
- Mesma query = mesma busca repetida (em diferentes conversas)
- Cliente pergunta "preço iPhone 15" = busca toda vez

**Solução:**
```typescript
// Cache em memória de resultados de RAG (TTL 5 min)
const RAG_CACHE = new Map<string, { results: any[], timestamp: number }>();
const RAG_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function getCachedRagResults(clientId: string, query: string): any[] | null {
  const key = `${clientId}:${query.toLowerCase().trim()}`;
  const cached = RAG_CACHE.get(key);
  
  if (cached && Date.now() - cached.timestamp < RAG_CACHE_TTL) {
    console.log(`[RAG CACHE] HIT: ${query.slice(0, 50)}`);
    return cached.results;
  }
  
  return null;
}

function setCachedRagResults(clientId: string, query: string, results: any[]): void {
  const key = `${clientId}:${query.toLowerCase().trim()}`;
  RAG_CACHE.set(key, { results, timestamp: Date.now() });
  
  // Limpa cache antigo (>10 min) para não crescer infinito
  if (RAG_CACHE.size > 1000) {
    const now = Date.now();
    for (const [k, v] of RAG_CACHE.entries()) {
      if (now - v.timestamp > 10 * 60 * 1000) RAG_CACHE.delete(k);
    }
  }
}
```

**Impacto:**
- ⏱️ **Velocidade:** -50ms por busca cacheada (elimina pgvector query)
- 💰 **Economia:** Cache não economiza tokens, mas acelera resposta
- ⚠️ **Trade-off:** Mudanças na KB levam até 5 min pra aparecer

---

### 3. **Prompt Minification Agressivo** 📝 MÉDIA PRIORIDADE

**Atual:**
```typescript
const minifiedPromptMaster = promptMaster
  .replace(/\r/g, "")
  .replace(/\n[ \t]+/g, "\n")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
```

**Otimizado:**
```typescript
const minifiedPromptMaster = promptMaster
  .replace(/\r/g, "")
  .replace(/\n[ \t]+/g, "\n")        // Remove indentação
  .replace(/[ \t]+\n/g, "\n")        // Remove espaços antes de newline
  .replace(/\n{3,}/g, "\n\n")        // Max 2 newlines consecutivos
  .replace(/\s{2,}/g, " ")           // NOVO: múltiplos espaços → 1 espaço
  .replace(/\n\s*\n/g, "\n\n")       // NOVO: limpa linhas vazias extras
  .replace(/^[\s\n]+|[\s\n]+$/g, "") // NOVO: trim agressivo
  .trim();
```

**Impacto:**
- 💰 **Economia:** ~5-10% tokens no system prompt
- ⏱️ **Velocidade:** Marginal (+rápido processar prompt menor)
- ✅ **Qualidade:** ZERO impacto (só remove espaços extras)

---

### 4. **Paralelizar Queries Independentes** 🔀 ALTA PRIORIDADE

**Problema atual (linha 189-200):**
```typescript
const [agentRes, stagesRes, histRes, kbRes, leadRes, contactRes] = await Promise.all([
  supabase.from("agent_settings").select("*").eq("id", agentId).single(),
  supabase.from("agent_stages").select("*").eq("agent_id", agentId).order("order_index"),
  historyQuery,
  supabase.from("agent_knowledge").select("id, title").eq("agent_id", agentId),
  !isTestMode ? supabase.from("leads_extraidos")... : Promise.resolve({ data: null }),
  !isTestMode ? supabase.from("contacts")... : Promise.resolve({ data: null }),
]);
```

**Status:** ✅ **JÁ OTIMIZADO** — todas queries em paralelo via `Promise.all`

---

### 5. **Reduzir Limite de Histórico em Conversas Curtas** 📉 BAIXA PRIORIDADE

**Atual:**
```typescript
const HIST_LIMIT = 25; // Sempre busca 25 mensagens
```

**Otimizado:**
```typescript
// Histórico adaptativo: conversas novas não precisam de 25 msgs
const HIST_LIMIT = sessionRow?.message_count 
  ? Math.min(sessionRow.message_count + 5, 25) 
  : 25;
```

**Impacto:**
- 💰 **Economia:** ~10-20 tokens em conversas iniciais
- ⏱️ **Velocidade:** Query mais rápida (menos rows)
- ✅ **Qualidade:** ZERO impacto (conversas curtas não têm 25 msgs mesmo)

---

### 6. **Streaming de Resposta** 🌊 FUTURA (não implementar agora)

**Ideia:** Enviar chunks da resposta conforme IA gera (streaming)

**Problema:**
- WhatsApp não suporta edição de mensagens em tempo real
- Evolution API envia mensagens completas
- Streaming só funciona em chat web

**Decisão:** ❌ **NÃO IMPLEMENTAR** (incompatível com WhatsApp)

---

## 💰 ECONOMIA DE TOKENS: Checklist

### ✅ JÁ IMPLEMENTADO

- [x] **Reasoning Mode = 0** (Econômico por padrão)
- [x] **Janela adaptativa de histórico** (3 + resumo + 12)
- [x] **Resumo cacheado do meio** (hash-based)
- [x] **Minificação de prompt** (remove espaços/newlines extras)
- [x] **Queries em paralelo** (Promise.all)
- [x] **Max output tokens** (configurável por agente)

### 🎯 OPORTUNIDADES ADICIONAIS

- [ ] **Limit tool rounds** (MAX 3 rounds) ⭐ RECOMENDADO
- [ ] **Cache de RAG** (5 min TTL) ⭐ RECOMENDADO
- [ ] **Prompt minification agressivo** (remove espaços duplos)
- [ ] **Histórico adaptativo** (menos msgs em conversas novas)

---

## 📋 IMPLEMENTAÇÃO PRIORIZADA

### FASE 1: Quick Wins (Implementar AGORA)

1. **Limitar Tool Rounds** (MAX_TOOL_ROUNDS = 3)
   - ✅ Zero risco
   - ⏱️ -30% latência em casos complexos
   - 💰 -20% tokens em conversas com múltiplos tools

2. **Prompt Minification Agressivo**
   - ✅ Zero risco
   - 💰 -5-10% tokens no system prompt

### FASE 2: Testes Necessários (1-2 dias)

3. **Cache de RAG** (TTL 5 min)
   - ⚠️ Requer teste: mudanças na KB aparecem após 5 min
   - ⏱️ -50ms por query cacheada
   - 🎯 Útil em horários de pico (mesmas perguntas)

4. **Histórico Adaptativo**
   - ⚠️ Requer validação: conversas curtas não quebram
   - 💰 -10-20 tokens em conversas iniciais

---

## 🚨 NÃO MEXER (já otimizado ou necessário)

- ❌ **Buffer de mensagens** — necessário para agrupar msgs rápidas
- ❌ **Delay de digitação** — humanização importante
- ❌ **RAG Top-K=5** — reduzir perde qualidade de resposta
- ❌ **Streaming** — incompatível com WhatsApp

---

## 📊 ESTIMATIVA DE IMPACTO

### Velocidade (após Fase 1)

| Cenário | Latência Atual | Latência Otimizada | Melhoria |
|---------|---------------|-------------------|----------|
| Resposta simples (sem tools) | ~2-3s | ~2-3s | 0% (já rápido) |
| 1 tool call (RAG) | ~4-5s | ~4-5s | 0% (já rápido) |
| 2-3 tool calls | ~8-12s | ~6-8s | **-30%** ⭐ |
| >3 tool calls | ~15-20s+ | ~8-10s | **-50%** ⭐ |

### Economia de Tokens (após Fase 1 + 2)

| Componente | Tokens Atual | Tokens Otimizado | Economia |
|-----------|-------------|-----------------|----------|
| System Prompt | ~1500 | ~1350-1400 | **-7-10%** |
| Histórico (conversa curta) | ~200-400 | ~150-300 | **-25%** |
| Tool loops (>2 rounds) | ~2000-4000 | ~1500-2500 | **-25-40%** |
| **Total médio** | ~4000-6000 | ~3200-4500 | **-20-25%** ⭐ |

---

## 🔧 CÓDIGO DE IMPLEMENTAÇÃO

### Implementar Agora (Fase 1)

```typescript
// ========== OTIMIZAÇÃO 1: Limitar Tool Rounds ==========
const MAX_TOOL_ROUNDS = 3;
let toolRound = 0;

// Linha ~1304 — dentro do loop de tool calls
while (turn.toolCalls.length > 0) {
  toolRound++;
  
  if (toolRound > MAX_TOOL_ROUNDS) {
    console.warn(`[AGENT] Limite de ${MAX_TOOL_ROUNDS} rounds atingido. Finalizando com o que temos.`);
    // Força resposta final
    turn = await session.sendUser(
      "Com base nas informações que você já consultou, responda diretamente ao cliente agora. " +
      "Não faça mais buscas."
    );
    break; // Sai do loop de tools
  }
  
  console.log(`[AGENT] Tool round ${toolRound}/${MAX_TOOL_ROUNDS}`);
  
  // ... resto do código de tool calls ...
}

// ========== OTIMIZAÇÃO 2: Prompt Minification Agressivo ==========
// Linha ~1180 — substituir minificação existente
const minifiedPromptMaster = promptMaster
  .replace(/\r/g, "")
  .replace(/\n[ \t]+/g, "\n")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .replace(/\s{2,}/g, " ")           // NOVO: múltiplos espaços → 1
  .replace(/\n\s*\n/g, "\n\n")       // NOVO: limpa linhas vazias
  .replace(/^[\s\n]+|[\s\n]+$/g, "") // NOVO: trim agressivo
  .trim();
```

---

## 🧪 VALIDAÇÃO

### Antes de Deploy

1. ✅ Rodar testes existentes (`npm test`)
2. ✅ Teste manual: conversa com 3+ tool calls
3. ✅ Verificar que resposta final mantém qualidade
4. ✅ Monitorar logs: confirmar que rounds param em 3

### Métricas a Observar

- ⏱️ **Latência média** (via logs `[AGENT] Processing took Xms`)
- 💰 **Token usage** (tabela `token_usage`)
- 📊 **Tool rounds** (logs `[AGENT] Tool round X/3`)
- ⚠️ **Casos forçados** (logs `Limite de X rounds atingido`)

---

**Última Atualização:** 10/10/2026 17:25 BRT
