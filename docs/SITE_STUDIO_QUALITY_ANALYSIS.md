# 🎯 Análise de Qualidade Site Studio - Impeccable Integration

**Data:** 09/10/2026  
**Objetivo:** Transformar o Site Studio em uma máquina de gerar sites PERFEITOS, eliminando a "cara de IA"  
**Framework Referência:** [pbakaus/impeccable](https://github.com/pbakaus/impeccable)

---

## 📊 ESTADO ATUAL DA INTEGRAÇÃO

### ✅ O Que Já Existe

1. **Skill Impeccable Design**
   - ID: `builtin:impeccable-design`
   - Status: SEMPRE ATIVO (priority 100, trigger_mode "always")
   - Versão: 3
   - Localização: `src/lib/sites/skills.ts`

2. **Documentos Impeccable Upstream**
   - Arquivo: `src/lib/sites/impeccable/upstream.json`
   - Revisão: impeccable-20241204T205607Z
   - Documentos disponíveis: 33 referências completas
   - Tamanho: 96 linhas JSON

3. **Integração no Prompt System**
   - Arquivo: `src/lib/sites/prompts.ts`
   - Função: `composeWebsitePrompt()` - linha 221
   - Lógica: Detecta skill ativa e injeta guidance Impeccable
   - Máx tokens Impeccable: 240,000 (vs 24,000 normal)

4. **Funções Core Impeccable**
   - `composeImpeccableGuidance()` - Compõe orientação completa
   - `impeccableReferenceCatalog()` - Lista referências disponíveis
   - `impeccableReviewChecks()` - Valida dimensões de qualidade
   - `impeccableCriticInstructions()` - Instruções para QA visual
   - `isImpeccableSkill()` - Detecta se skill está ativa
   - `isWebsiteRedesign()` - Detecta pedidos de redesign

5. **Sistema de QA Visual**
   - Arquivo: `src/lib/sites/agent.ts` - linha 93
   - Função: `criticQa()` - Valida passed/issues/summary
   - Integração com screenshots reais para validação visual
   - Checks estruturados por dimensão (ImpeccableVisualCheck[])

---

## 🔍 PONTOS FRACOS IDENTIFICADOS

### 1. **Problema: Skill Impeccable NÃO está realmente ativa por padrão**

**Evidência:**
```typescript
// src/lib/sites/skills.ts:7
["impeccable-design", ..., "always", ...]

// Mas em src/lib/sites/prompts.ts:244
if (!impeccable) parts.push("DIRETRIZ DE SKILLS: Nenhuma skill de design adicional 
está ativa neste turno (a diretriz Impeccable Design está DESATIVADA pelo usuário).")
```

**Impacto:** O usuário precisa ATIVAR manualmente, mas skill builtin deveria estar sempre ON.

**Solução:** Garantir que skill builtin:impeccable-design seja aplicada automaticamente em TODOS os projetos.

---

### 2. **Problema: Referências Impeccable não estão sendo lidas dinamicamente**

**Evidência:**
```typescript
// src/lib/sites/prompts.ts:236
`Referências integrais consultáveis sob demanda por 
read_design_reference(name, offset, limit).`
```

**Problema:** 
- Tool `read_design_reference` existe no sistema?
- Se existe, agente está usando?
- Se não existe, por que prometer ao agente?

**Solução:** Implementar tool real ou remover promessa falsa do prompt.

---

### 3. **Problema: Compactação de histórico DEMAIS agressiva pode perder contexto Impeccable**

**Evidência:**
```typescript
// src/lib/sites/agent.ts:181
const compactedHistory = compactAgentHistory(
  input.history.map((h) => ({ role: h.role, content: h.content })) as Message[],
  20  // APENAS 20 MENSAGENS!
);
```

**Impacto:** 
- Impeccable precisa de MUITO contexto para design consistency
- 20 mensagens podem perder direção visual anterior
- Design tokens e paleta podem não ser preservados

**Solução:** 
- Aumentar limite quando Impeccable ativo (50-80 mensagens)
- Preservar SEMPRE mensagens com design direction
- Nunca compactar mensagens com color palette / typography

---

### 4. **Problema: Cache de resposta pode quebrar criatividade visual**

**Evidência:**
```typescript
// src/lib/sites/agent.ts:419
const cachedResponse = this.responseCache.get(requestKey);
if (cachedResponse) {
  // Retorna resposta idêntica!
}
```

**Impacto:**
- Design único e autoral precisa de variação
- Cache pode gerar sites idênticos para contextos similares
- Impeccable é sobre ORIGINALIDADE, não repetição

**Solução:**
- Desabilitar cache quando Impeccable ativo
- OU adicionar "design seed" no cache key
- OU diminuir TTL drasticamente (30s vs 5min)

---

### 5. **Problema: Smart Validator pode bloquear refinamentos visuais**

**Evidência:**
```typescript
// src/lib/sites/agent.ts:484
if (this.smartValidator.isInValidationLoop()) {
  messages.push({ role: "user", content: feedback });
}
```

**Impacto:**
- Refinamentos visuais iterativos são esperados em design de qualidade
- Validator pode interpretar ajustes de cor/tipografia como "loop"
- Impeccable PRECISA de múltiplas iterações para atingir perfeição

**Solução:**
- Relaxar validação quando Impeccable ativo
- Não contar ajustes de design tokens como "loop"
- Permitir mais tentativas (6-8 vs 2-3)

---

### 6. **Problema: Prompt criativo genérico não reflete padrões Impeccable**

**Evidência:**
```typescript
// src/lib/sites/prompts.ts:61
creative_prompt: "Crie sites específicos para o negócio confirmado, 
com identidade visual intencional, conteúdo verdadeiro e CTA claro. 
Evite clichês de templates..."
```

**Problema:**
- Prompt muito genérico e vago
- Não menciona princípios específicos Impeccable
- Não dá exemplos concretos de "anti-AI"

**Solução:** Reescrever com exemplos CONCRETOS:
- ❌ "gradiente roxo-azul genérico"
- ✅ "paleta monocromática com acento único"
- ❌ "hero com imagem de fundo desfocada"
- ✅ "layout baseado em grid com hierarquia clara"

---

### 7. **Problema: Não há verificação pós-geração de "cara de IA"**

**Evidência:** Sistema valida sintaxe/build mas não design quality

**O Que Falta:**
- Checklist anti-clichês:
  - [ ] Sem gradientes roxo-azul-rosa
  - [ ] Sem imagens de stock genéricas
  - [ ] Sem "lorem ipsum" ou textos placeholder
  - [ ] Sem CTAs "Saiba Mais" vazios
  - [ ] Paleta de cores autoral e justificada
  - [ ] Tipografia com hierarquia real
  - [ ] Espaçamento intencional

**Solução:** Adicionar "Anti-AI Quality Gate" antes de aprovar site.

---

## 📋 PLANO DE AÇÃO (A SER DETALHADO)

### Fase 1: Correções Imediatas (2-4h)
1. Garantir skill Impeccable ativa por padrão
2. Implementar tool `read_design_reference` 
3. Ajustar compactação de histórico
4. Revisar política de cache

### Fase 2: Melhorias Prompt (4-6h)
1. Reescrever creative_prompt com Impeccable principles
2. Adicionar exemplos concretos bons/ruins
3. Integrar checklist anti-clichê no system prompt
4. Melhorar instruções de design tokens

### Fase 3: QA Visual Avançado (6-8h)
1. Implementar Anti-AI Quality Gate
2. Adicionar validação de paleta de cores
3. Checklist automático de design patterns
4. Integração com Impeccable review checks

### Fase 4: Refinamentos Iterativos (4-6h)
1. Relaxar Smart Validator para design
2. Permitir mais iterações em Impeccable mode
3. Adicionar feedback visual estruturado
4. Sistema de "design critiques" automáticos

---

## 🎯 MÉTRICAS DE SUCESSO

**Antes:**
- [ ] Sites com gradientes genéricos
- [ ] CTAs "Saiba Mais" sem função
- [ ] Paletas de cores não justificadas
- [ ] Layouts que "parecem IA"

**Depois:**
- [ ] 0% gradientes roxo-azul-rosa genéricos
- [ ] 100% CTAs funcionais com copy específico
- [ ] Paleta de cores derivada do negócio
- [ ] Layouts únicos e intencionais
- [ ] Tipografia com hierarquia real
- [ ] Espaçamentos baseados em tokens consistentes

---

## 📚 RECURSOS PENDENTES

- [ ] Estudo completo do framework Impeccable (agente em execução)
- [ ] Documentação de todos os 33 documentos upstream
- [ ] Exemplos práticos de antes/depois
- [ ] Guia de prompts anti-AI para usuários

---

**Status:** 🟡 ANÁLISE INICIAL COMPLETA - Aguardando estudo Impeccable framework  
**Próximo Passo:** Aguardar resultado do agente + criar plano detalhado de implementação
