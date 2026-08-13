# Pipeline de IA

O sistema integra múltiplos provedores de IA com roteamento automático, failover, RAG (Retrieval-Augmented Generation), descoberta dinâmica de modelos, controle de custos e transcrição de áudio gratuita.

## Arquitetura

```
┌──────────────────────────────────────────────────────────┐
│                    ai-provider.ts                         │
│                 (camada de abstração)                     │
│                                                          │
│  generateText(model, prompt, opts) ──┐                   │
│  startAiChat(model, system, opts) ───┤                   │
│                                       │                   │
│         ┌─────────────────────────────┼─────────────┐    │
│         │                             │             │    │
│    ┌────▼────┐  ┌────────────┐  ┌────▼─────┐  ┌────▼──┐ │
│    │ Gemini  │  │ OpenRouter │  │ Gateway  │  │DeepSeek│ │
│    │(Google) │  │ (300+ mod) │  │(CLIProxy)│  │(Web)  │ │
│    └────┬────┘  └─────┬──────┘  └────┬─────┘  └───────┘ │
│         │              │              │                   │
│    ┌────▼────┐  ┌──────▼──────┐  ┌───▼──────────────┐   │
│    │gemini-  │  │openrouter-  │  │gateway-model-    │   │
│    │call.ts  │  │model-disc.  │  │discovery.ts      │   │
│    │+ dead   │  │+ embeddings │  │(multi-account)   │   │
│    │model fb │  │             │  │                  │   │
│    └─────────┘  └─────────────┘  └──────────────────┘   │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ rag.ts      │  │ pricing.ts   │  │ token-usage.ts │  │
│  │ (embeddings)│  │ ($/token)    │  │ (log de custo) │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Provedores

### 1. Google Gemini

| Aspecto | Detalhe |
|---------|---------|
| Prefixo | `gemini:` |
| Pacote | `@google/generative-ai` |
| Auth | API Key (`GEMINI_API_KEY` ou `ai_organizer_config.api_key`) |
| Modelos | Discovery dinâmico via `ListModels` API |
| Fallback | Detecta modelo morto (404) → troca automaticamente |
| Embeddings | `gemini-embedding-001` (768 dims) para RAG |

**Dead Model Fallback** (`gemini-call.ts`):
```
1. callGeminiWithFallback(model, prompt)
2. Se 404 "model not found":
   a. pickBestFlashModel() (do cache de discovery)
   b. buildFallbackChain() (lista de alternativas)
   c. Retry com próximo modelo vivo
3. isDeadModelError() marca modelo para não reusar
```

### 2. OpenRouter

| Aspecto | Detalhe |
|---------|---------|
| Prefixo | `openrouter:` |
| Auth | API Key (`OPENROUTER_API_KEY` ou `ai_organizer_config.openrouter_api_key`) |
| Modelos | 300+ modelos de múltiplos providers |
| Discovery | `GET openrouter.ai/api/v1/models` |
| Embeddings | Suporte a modelos de embedding via API |
| Gratuito | Modelos com sufixo `:free` |

### 3. Gateway (CLIProxyAPI)

| Aspecto | Detalhe |
|---------|---------|
| Prefixo | `gateway:` |
| Auth | Management key + OAuth tokens por conta |
| Contas | Gemini, Claude, OpenAI, Antigravity |
| Multi-conta | Round-robin entre contas com cooldown |
| Install | 1-clique via `/api/gateway-proxy/install` |
| Self-hosted | CLIProxyAPI roda como processo embutido |

**Cooldown de Contas** (`gateway-cooldown.ts`):
```
429 (rate limit) → cooldown exponencial (dobra, cap 1h)
401/403 (auth) → marca como DEAD (reset no restart)
```

### 4. DeepSeek Chat (Web)

| Aspecto | Detalhe |
|---------|---------|
| Tipo | API reversa (não oficial) |
| Auth | Session token (gerenciado via extensão/import) |
| PoW | SHA3-256 Proof-of-Work (WASM acelerado) |
| Rate limit | Intervalo mínimo configurável |
| Multi-token | Rotação round-robin com cooldown |

## RAG (Retrieval-Augmented Generation)

**Arquivo**: `src/lib/rag.ts`

### Pipeline de Indexação

```
Documento (agent_knowledge)
    │
    ▼
chunkText(content, {maxSize: 2000, overlap: 200})
    │  Estratégia: parágrafo → sentença → hard-split
    ▼
embedTexts(chunks, model="gemini-embedding-001")
    │  Batch de 100 chunks por chamada
    ▼
agent_knowledge_chunks (Postgres + pgvector)
    embedding vector(768)
    content_hash (dedup sha256)
    
HNSW Index (vector_cosine_ops, m=16, ef_construction=64)
```

### Pipeline de Busca

```
Query do usuário
    │
    ▼
embedQuery(text) → vector(768)
    │
    ▼
searchKnowledge(query, agent_id, limit=5)
    │  RPC: match_knowledge_chunks
    │  Cosine similarity ≥ 0.35 (threshold)
    ▼
Top-K chunks → injetados no prompt do agente
```

### Script de Backfill

```bash
node scripts/backfill-rag.mjs [agent_id]
# Re-processa todos os agent_knowledge documents
# Dedup por content_hash (idempotente)
# Batch de 50 inserts, 100 embeddings
```

## Roteamento de Modelos

### Resolução (ai-default-model.ts)

```
1. resolveModel(modelRef, clientId)
2. mapModel(alias) → canonical ID
   Ex: "gemini-1.5-flash" → "gemini-2.0-flash-001"
3. resolveModelForClient(clientId)
   → clients.default_ai_model override
4. enforceClientDefaultModel(clientId)
   → SaaS tier check (downgrade se exceder tier)
5. providerOf(modelRef) → "gemini" | "openrouter" | "gateway"
```

### Reasoning Modes

```typescript
resolveReasoningMode(level: 0|1|2|3):
  0 → thinking disabled
  1 → low budget
  2 → medium budget  
  3 → high budget

// Gemini: mapped to thinkingBudget config
// OpenRouter: mapped to reasoning_effort parameter
```

## Controle de Custos

### Pricing (pricing.ts)

```typescript
// Cache de preços LiteLLM (24h)
await ensurePricing()
// Fonte: raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json

// Cálculo de custo
computeCost(model, promptTokens, completionTokens):
  cost_usd = (prompt_tokens * input_price + completion_tokens * output_price) / 1_000_000

// Cache de FX USD→BRL (6h)
await ensureFxRate()
usdToBRL(usd) → BRL
```

### Token Usage (token-usage.ts)

```typescript
// Log de cada chamada de IA
logTokenUsage({
  source: "agent" | "organizer" | "campaign" | "followup",
  source_id: "...",
  model: "gemini-2.0-flash-001",
  prompt_tokens: 1234,
  completion_tokens: 567,
  total_tokens: 1801,
  cost_usd: 0.0023,
})
// → INSERT INTO ai_token_usage
```

### Dashboard de Tokens

Página `/tokens` mostra:
- Custo diário (Recharts area chart)
- Custo por source (pie chart)
- Custo por model (bar chart)
- Custo por client (admin view)
- Filtros por período

## Discovery de Modelos

| Provider | Cache | API | Frequência |
|----------|-------|-----|------------|
| Gemini | 10 min | `generativelanguage.googleapis.com/v1beta/models` | Auto-refresh |
| OpenRouter | 10 min | `openrouter.ai/api/v1/models` | Auto-refresh |
| Gateway | 10 min | `<proxy>/v1/models` por endpoint | Auto-refresh |

### UI Model Grouping

```typescript
// model-grouping.ts
groupModels(models) → {
  "Google Gemini": {
    "gemini-2.0-flash": [model1, model2],
    "gemini-2.5-pro": [model3],
  },
  "OpenAI": { ... },
  "Anthropic": { ... },
}
```

## History Summary

**Arquivo**: `src/lib/history-summary.ts`

Para conversas longas que excedem o limite de tokens:

```
1. Manter primeiras N mensagens (contexto inicial)
2. Manter últimas M mensagens (contexto recente)
3. Sumarizar mensagens do meio via IA
4. HMAC-keyed cache (consistência entre chamadas)
5. Persistido em sessions (coluna summary)
```

## Web Search

**Arquivo**: `src/lib/web-search.ts`

```
needsFreshWebSearch(query)?
  → Detecta keywords temporais: "hoje", "agora", "preço atual", "última"
  → SIM: webSearch(query) → top results
  → formatResultsForAI(results) → injetado no prompt
  → webFetchPage(url) opcional (full page content)
```

## Whisper.cpp (Transcrição de Áudio)

**Arquivo**: `src/lib/whisper-manager.ts`

```
1. Áudio recebido (WhatsApp) → media_url (.ogg)
2. Download + ffmpeg → WAV 16kHz mono
3. whisper-cli + ggml-base.bin (74MB) → texto
4. Texto inserido como mensagem
5. Fallback: Gemini se whisper indisponível
```

| Aspecto | Detalhe |
|---------|---------|
| Modelo | `ggml-base.bin` (74MB) |
| Idioma | Auto-detect |
| Runtime | Subprocesso (binário baixado no boot) |
| Custo | Gratuito (on-device) |
| Fallback | Gemini API |

## Lead Intelligence

**Arquivo**: `src/lib/lead-intelligence.ts` (1574 linhas — maior arquivo do projeto)

```
analyzeLead(lead):
  1. Web scraping: Google Maps, redes sociais, reviews
  2. AI analysis: categoria, ICP score, pontos fortes/fracos
  3. Structured output: { name, address, category, rating, reviews, website, social }
  4. Cache em leads_extraidos.intelligence (JSONB)
  5. intelligenceToPromptContext() → contexto para agentes
```
