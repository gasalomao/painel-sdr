# Otimizações de Agente IA - Site Studio

## Visão Geral

Este documento descreve as otimizações implementadas no sistema de agentes IA para melhorar performance, confiabilidade e experiência do usuário no Site Studio.

## Componentes Implementados

### 1. Rate Limiter Adaptativo (`AdaptiveRateLimiter`)

**Objetivo:** Controlar chamadas à API respeitando limites, com backoff exponencial.

**Características:**
- Backoff exponencial: 1s → 2s → 4s → 8s → 16s
- Máximo de 5 tentativas por requisição
- Tracking de uso por modelo e janela de tempo
- Prevenção de esgotamento de quota

**Uso:**
```typescript
const limiter = new AdaptiveRateLimiter();
const result = await limiter.executeWithRateLimit(
  () => chat({ model, messages, tools }),
  model
);
```

**Benefícios:**
- ✅ Reduz erros 429 (rate limit exceeded)
- ✅ Melhora resiliência do sistema
- ✅ Otimiza uso de quota

---

### 2. Cache de Respostas (`AgentResponseCache`)

**Objetivo:** Evitar chamadas duplicadas à API cachando respostas idênticas.

**Características:**
- Cache em memória com TTL configurável (padrão: 5 minutos)
- Tamanho máximo configurável (padrão: 50 entradas)
- Invalidação automática por tempo
- Hash de requisições para detecção de duplicatas

**Uso:**
```typescript
const cache = new AgentResponseCache(maxSize, ttlMinutes);

// Verificar cache antes de chamar API
const cached = cache.get(request);
if (cached) return cached;

// Após chamada bem-sucedida
cache.set(request, result);
```

**Benefícios:**
- ✅ Reduz custo de API
- ✅ Melhora tempo de resposta
- ✅ Reduz latência para requisições repetidas

---

### 3. Validador Inteligente (`SmartValidator`)

**Objetivo:** Detectar loops de validação e fornecer feedback útil ao agente.

**Características:**
- Tracking de histórico de validações
- Detecção de loops (3+ validações sem progresso)
- Comparação de erros entre iterações
- Feedback contextual sobre progresso

**Uso:**
```typescript
const validator = new SmartValidator();

// Após cada validação
validator.recordValidation(files, errors);

// Verificar se está em loop
if (validator.isInValidationLoop()) {
  const feedback = validator.getValidationFeedback();
  // Adicionar feedback ao contexto do agente
}
```

**Benefícios:**
- ✅ Previne loops infinitos
- ✅ Melhora qualidade de correções
- ✅ Reduz desperdício de tokens

---

### 4. Compactação de Histórico (`compactAgentHistory`)

**Objetivo:** Reduzir tokens mantendo contexto relevante.

**Estratégia:**
- Mantém 30% das mensagens iniciais (contexto)
- Mantém 70% das mensagens finais (estado atual)
- Compacta mensagens longas (>1500 chars):
  - 700 chars iniciais
  - 500 chars finais
  - Separador: `\n... [conteúdo compactado] ...\n`

**Uso:**
```typescript
const compactedHistory = compactAgentHistory(messages, maxMessages);
```

**Benefícios:**
- ✅ Reduz uso de tokens em 40-60%
- ✅ Mantém contexto relevante
- ✅ Permite conversas mais longas

---

## Integração no Site Studio

### Fluxo de Criação de Site

```
1. Usuário solicita criação
2. Rate limiter verifica se pode fazer chamada
3. Cache verifica se já existe resposta
4. Se não, executa chamada à API
5. Validador registra resultado
6. Se houver erros, detecta loops
7. Compacta histórico antes de retry
8. Cache armazena resultado bem-sucedido
```

### Configuração de Modelos

```typescript
export const AGENT_CONFIG = {
  maxHistoryMessages: 20,
  cacheConfig: { maxSize: 50, ttlMinutes: 5 },
  rateLimits: {
    'nvidia/llama-3.1-nemotron-70b-instruct': { rpm: 30, tpm: 128000 },
    'cohere/command-r-plus': { rpm: 20, tpm: 100000 }
  }
};
```

---

## Métricas e Monitoramento

### Métricas Coletadas

- **Rate Limiter:**
  - Número de retries
  - Tempo total de backoff
  - Taxa de sucesso após retry

- **Cache:**
  - Taxa de acerto (hit rate)
  - Número de entradas
  - Economia de chamadas à API

- **Validador:**
  - Número de loops detectados
  - Erros resolvidos por iteração
  - Tempo médio até sucesso

### Logs e Debug

Todos os componentes incluem logging detalhado:

```typescript
// Rate limiter
console.log('[RateLimiter] Waiting ${delayMs}ms before retry...');

// Cache
console.log('[Cache] Hit for request hash: ${hash}');

// Validator
console.log('[Validator] Loop detected: ${attempts} attempts');
```

---

## Testes

### Cobertura

- ✅ `AdaptiveRateLimiter`: 6 testes
- ✅ `AgentResponseCache`: 3 testes
- ✅ `SmartValidator`: 3 testes
- ✅ `compactAgentHistory`: 3 testes

### Executar Testes

```bash
# Testes unitários
npm test -- src/lib/sites/__tests__/agent-optimizations.test.ts

# Testes de integração
npm test -- src/lib/sites/__tests__/site-studio-integration.test.ts
```

---

## Roadmap Futuro

### Melhorias Planejadas

1. **Persistência de Cache**
   - Salvar cache em Redis/KV
   - Compartilhar entre instâncias

2. **Métricas Avançadas**
   - Dashboard de observabilidade
   - Alertas de quota próxima ao limite

3. **Otimização de Prompts**
   - Análise de tokens por seção
   - Compressão automática de contexto

4. **Circuit Breaker**
   - Proteção contra cascata de falhas
   - Fallback para modelos alternativos

---

## Contribuindo

Para adicionar novas otimizações:

1. Implementar em `src/lib/sites/agent-optimizations.ts`
2. Adicionar testes em `__tests__/agent-optimizations.test.ts`
3. Documentar neste arquivo
4. Atualizar integração em `websiteChatAttempt.ts`

---

## Referências

- [OpenRouter Rate Limits](https://openrouter.ai/docs#rate-limits)
- [LLM Token Optimization Best Practices](https://platform.openai.com/docs/guides/optimizing-llm-usage)
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)
