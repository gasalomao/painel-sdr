# 🔬 Impeccable Deep Dive - Arquitetura e Oportunidades

**Data:** 09/10/2026  
**Status:** Análise técnica profunda do sistema atual  
**Objetivo:** Identificar TODAS as oportunidades de melhoria para eliminar "cara de IA"

---

## 🏗️ ARQUITETURA ATUAL

### 1. Sistema de Skills (src/lib/sites/skills.ts)

```typescript
const definitions: Array<[string, string, string, string[], number, WebsiteSkill["trigger_mode"], string, string]> = [
  ["impeccable-design", "Impeccable Design (Anti-AI)", "design", 
   ["impeccable", "design", "anti-ai", "original", "ui", "craft", "layout", "typography"], 
   100,  // PRIORIDADE MÁXIMA
   "always",  // SEMPRE ATIVO (em teoria)
   IMPECCABLE_SKILL_DESCRIPTION, 
   IMPECCABLE_SKILL_INSTRUCTIONS
  ],
];
```

**✅ Pontos Fortes:**
- Skill builtin com prioridade 100
- Trigger mode "always" = deveria estar sempre ativo
- Versão 3 (já passou por iterações)

**❌ Pontos Fracos:**
- **CRÍTICO:** Apesar de trigger_mode="always", a skill pode ser DESABILITADA pelo usuário
- Linha 244 de prompts.ts mostra que há um caminho onde Impeccable está DESATIVADO
- Não há garantia de que a skill está ativa em TODOS os projetos

---

### 2. Sistema de Referências (src/lib/sites/impeccable.ts)

```typescript
export const IMPECCABLE_FOUNDATIONS = [
  "skill",           // Documento raiz da skill
  "craft-floor",     // Fundamentos de qualidade
  "init",            // Inicialização
  "new-work",        // Trabalho novo
  "mode-persuade",   // Modo persuasão
  "mode-operate",    // Modo operação
  "mode-read",       // Modo leitura
  "typeset",         // Tipografia
  "layout",          // Layout
  "colorize",        // Cores
  "animate",         // Animação
  "adapt",           // Responsividade
  "harden",          // Acessibilidade
  "clarify",         // Copy
  "optimize"         // Performance
] as const;
```

**Upstream Data:**
- Arquivo: `src/lib/sites/impeccable/upstream.json`
- Revisão: SHA-1 commitado
- Documentos: 33+ referências completas
- Licença: Apache 2.0 (verificada por hash SHA-256)

**✅ Pontos Fortes:**
- Referências COMPLETAS do framework original
- Integridade verificada por hash SHA-256
- Tool `read_design_reference` implementada e funcional
- Sistema de leitura paginada (offset/limit)

**❌ Pontos Fracos:**
- Referências só são injetadas quando `impeccable = true`
- Sistema de "routes" para refinamentos pode NÃO carregar referências necessárias
- Agente pode não saber QUANDO usar `read_design_reference`

---

### 3. Composição de Prompt (src/lib/sites/prompts.ts)

#### 3.1 Detecção de Skill Ativa

```typescript
const selected = resolveActiveWebsiteSkills(project, skills, userMessage);
const impeccable = selected.some(isImpeccableSkill);
```

**PROBLEMA:** `selected.some(isImpeccableSkill)` pode retornar FALSE se:
- Usuário desabilitou a skill manualmente
- Skill foi sobrescrita com override privado
- Bug na lógica de `resolveActiveWebsiteSkills`

#### 3.2 Limites de Contexto

```typescript
const maxPromptLength = surgical ? 20_000 
  : impeccable ? 240_000  // 10x mais contexto!
  : files && Object.keys(files).length ? 80_000 
  : 24_000;
```

**✅ Excelente:** Impeccable recebe 240k tokens (vs 24k normal)

**❌ Problema:** Em modo "surgical" (edição pontual), limit cai para 20k mesmo com Impeccable ativo!

#### 3.3 Injeção de Guidance

```typescript
...(impeccable ? [
  surgical 
    ? `IMPECCABLE ATIVO — REFINAMENTO / PRESERVAÇÃO — fonte ${IMPECCABLE_REVISION}
       Preserve identidade, funções e acessibilidade. 
       Referências integrais consultáveis sob demanda por read_design_reference(name, offset, limit).
       CATÁLOGO COMPLETO: ${JSON.stringify(impeccableReferenceCatalog())}`
    : composeImpeccableGuidance(files, userMessage)
] : []),
```

**DESCOBERTA CRÍTICA:**

**Modo Surgical (edição simples):**
- NÃO injeta referências completas
- Apenas diz "você pode ler"
- Espera que agente saiba QUANDO ler
- **RESULTADO:** Agente pode ignorar Impeccable em 90% das edições!

**Modo Full (criação/redesign):**
- Injeta TODAS as 15 referências fundamentais completas
- Pode consumir 150k+ tokens só de referências
- **RESULTADO:** Contexto pesado, mas completo

---

### 4. Compactação de Histórico (src/lib/sites/agent.ts)

```typescript
const compactedHistory = compactAgentHistory(
  input.history.map((h) => ({ role: h.role, content: h.content })) as Message[],
  20  // APENAS 20 MENSAGENS
);
```

**PROBLEMA GRAVE:**

1. **Perda de Contexto Visual:**
   - Design decisions em mensagens antigas são descartadas
   - Paleta de cores definida há 25 mensagens? Perdida.
   - Direção tipográfica definida no início? Perdida.

2. **Impeccable Precisa de MUITO Contexto:**
   - Design é iterativo e cumulativo
   - Cada decisão visual se baseia nas anteriores
   - 20 mensagens não são suficientes

3. **Compactação é Agnóstica:**
   - Não preserva mensagens com `record_design_direction`
   - Não preserva mensagens com decisões de paleta
   - Não preserva mensagens com refinamentos visuais

**SOLUÇÃO:** Compactação inteligente que:
- Preserva TODAS as mensagens com design tokens
- Preserva TODAS as mensagens com `record_design_direction`
- Aumenta limite para 50-80 mensagens quando Impeccable ativo
- Nunca compacta últimas 30 mensagens (contexto recente)

---

### 5. Cache de Resposta (src/lib/sites/agent.ts)

```typescript
const requestKey = this.buildCacheKey(
  input.model,
  systemPrompt,
  compactedHistory,
  input.files
);

const cachedResponse = this.responseCache.get(requestKey);
if (cachedResponse) {
  return cachedResponse;  // RESPOSTA IDÊNTICA!
}
```

**PROBLEMA FILOSÓFICO COM IMPECCABLE:**

**Impeccable = Originalidade e Craft**
- Cada site deve ser único
- Paletas autorais derivadas do negócio
- Layouts intencionais e específicos

**Cache = Repetição**
- Sites similares retornam resposta idêntica
- Mesmo briefing = mesmo output
- **CONTRADIÇÃO FUNDAMENTAL**

**Casos Problemáticos:**

1. **"Crie um site para uma cafeteria"**
   - Cache: retorna o mesmo site para TODAS as cafeterias
   - Impeccable: cada cafeteria deveria ter identidade única

2. **"Ajuste a cor do botão para azul"**
   - Cache: sempre o mesmo tom de azul
   - Impeccable: azul deve derivar da paleta autoral do site

**SOLUÇÕES POSSÍVEIS:**

A) **Desabilitar cache quando Impeccable ativo**
```typescript
if (this.impeccableActive) {
  // Nunca usar cache - sempre gerar fresh
} else {
  // Cache normal para eficiência
}
```

B) **Adicionar "design seed" ao cache key**
```typescript
const designSeed = crypto.randomUUID().slice(0, 8);
const cacheKey = this.buildCacheKey(..., designSeed);
// Cada execução tem seed diferente = sem cache hit
```

C) **TTL drasticamente reduzido**
```typescript
const cacheTTL = impeccable ? 30_000 : 300_000; // 30s vs 5min
```

**RECOMENDAÇÃO:** Opção A (desabilitar) - alinhamento filosófico com Impeccable

---

### 6. Smart Validator (src/lib/sites/agent.ts)

```typescript
if (this.smartValidator.isInValidationLoop()) {
  const feedback = this.smartValidator.getValidationFeedback();
  messages.push({
    role: "user",
    content: `ATENÇÃO: ${feedback}. Tente uma abordagem diferente.`
  });
}
```

**PROBLEMA COM DESIGN ITERATIVO:**

**Cenário Real:**

1. **Iteração 1:** "Mude cor do CTA para verde"
   - Validator registra: 1 tentativa

2. **Iteração 2:** "Verde muito vibrante, ajuste para tom mais suave"
   - Validator registra: 2 tentativas

3. **Iteração 3:** "Perfeito, agora ajuste o padding"
   - Validator registra: 3 tentativas
   - **LOOP DETECTADO!** ❌

**Mas isso NÃO É UM LOOP - é refinamento de qualidade!**

**Impeccable PRECISA de iterações:**
- Polish refinements são esperados
- Ajustes de tipografia levam 3-5 tentativas
- Paleta de cores é iterativa por natureza

**SOLUÇÃO:**

```typescript
// Não contar como "erro" se:
const isDesignRefinement = (
  lastErrors.every(e => e.includes("cor") || e.includes("fonte") || e.includes("espaçamento"))
  && !lastErrors.some(e => e.includes("TypeError") || e.includes("SyntaxError"))
);

if (isDesignRefinement) {
  // Não é loop - é polish!
  // Permitir mais tentativas (6-8 vs 3)
}
```

---

### 7. Prompt Criativo Genérico (src/lib/sites/prompts.ts)

```typescript
creative_prompt: "Crie sites específicos para o negócio confirmado, 
com identidade visual intencional, conteúdo verdadeiro e CTA claro. 
Evite clichês de templates, preserve a marca, priorize acessibilidade, 
responsividade e desempenho. Faça alterações mínimas e verificáveis; 
não invente fatos ou resultados."
```

**PROBLEMA:** Muito genérico e abstrato

**O que está faltando:**

1. **Exemplos concretos de ANTI-padrões:**
   - ❌ "Gradiente roxo-azul-rosa"
   - ❌ "Hero com imagem desfocada de escritório"
   - ❌ "CTAs 'Saiba Mais' sem função"
   - ❌ "Ícones de check em 3 colunas"

2. **Exemplos concretos de BOM design:**
   - ✅ "Paleta monocromática com 1 acento autoral"
   - ✅ "Layout baseado em grid com hierarquia clara"
   - ✅ "Tipografia escalada (clamp) sem tamanhos fixos"
   - ✅ "CTAs com copy específico do negócio"

3. **Princípios Impeccable específicos:**
   - Derivar paleta do domínio (não de templates)
   - Layouts que servem o conteúdo (não o inverso)
   - Hierarquia tipográfica real (não decorativa)
   - Interações intencionais (não por convenção)

---

## 🎯 MATRIZ DE QUALIDADE ANTI-IA

### Checklist Visual (O que falta implementar)

#### 1. Paleta de Cores

**❌ Cara de IA:**
- [ ] Gradiente roxo (#667eea) → azul (#764ba2)
- [ ] Gradiente azul (#4facfe) → verde (#00f2fe)
- [ ] Gradiente rosa (#fa709a) → laranja (#fee140)
- [ ] Paleta "profissional" genérica (azul + cinza)
- [ ] Cores neon/vibrantes sem justificativa

**✅ Anti-IA:**
- [ ] Paleta derivada do domínio do negócio
- [ ] 5-7 níveis de superfície com tint intencional
- [ ] 1 acento luminoso único (não 3-4)
- [ ] Justificativa verbal da paleta no design direction
- [ ] Sem gradientes decorativos

#### 2. Tipografia

**❌ Cara de IA:**
- [ ] Inter + Inter (sem hierarquia)
- [ ] Tamanhos fixos (16px, 24px, 32px)
- [ ] Line-height genérico (1.5 everywhere)
- [ ] Sem negative tracking em displays

**✅ Anti-IA:**
- [ ] Escala completa com clamp()
- [ ] Custom properties (var(--font-family-*))
- [ ] Line-height específico por contexto
- [ ] Tracking ajustado (apertado em display, generoso em body)

#### 3. Layout

**❌ Cara de IA:**
- [ ] Hero → 3 colunas de features → CTA → Footer
- [ ] Tudo centralizado
- [ ] Containers com max-width: 1200px fixo
- [ ] Flexbox para tudo

**✅ Anti-IA:**
- [ ] Grid-first (CSS Grid carrega estrutura)
- [ ] Assimetria intencional
- [ ] Ritmo visual consistente
- [ ] Layouts que servem o conteúdo específico

#### 4. Componentes

**❌ Cara de IA:**
- [ ] Botões com border-radius: 8px padrão
- [ ] Cards com sombra xl sutil
- [ ] Ícones de check/star em features
- [ ] Testemunhos com foto circular + estrelas

**✅ Anti-IA:**
- [ ] Geometria totalmente rounded (999px pills, 50% circles)
- [ ] Sombras tokenizadas e consistentes
- [ ] Componentes específicos do domínio
- [ ] Sem provas sociais genéricas

#### 5. Copy e CTA

**❌ Cara de IA:**
- [ ] "Saiba Mais" sem destino
- [ ] "Começar Agora" genérico
- [ ] "Entre em Contato" vazio
- [ ] Headlines "Transforme Seu Negócio"

**✅ Anti-IA:**
- [ ] CTAs com copy específico do negócio
- [ ] Headlines derivadas do value prop real
- [ ] Formulários com destino funcional ou declarado indisponível
- [ ] Copy em português (não traduzido do inglês)

---

## 🚨 PROBLEMAS CRÍTICOS IDENTIFICADOS

### Problema 1: Skill Não Garantidamente Ativa

**Severidade:** 🔴 CRÍTICA

**Evidência:**
- `trigger_mode: "always"` não garante ativação
- Linha 244 de prompts.ts prova que há path onde Impeccable está OFF
- Usuário pode criar override privado e desabilitar

**Impacto:**
- Sites gerados SEM Impeccable = "cara de IA" garantida
- Inconsistência de qualidade entre projetos

**Solução:**
```typescript
// Forçar Impeccable SEMPRE em produção
const impeccable = true; // Hardcoded
// OU
const impeccable = selected.some(isImpeccableSkill) || 
  (process.env.FORCE_IMPECCABLE !== "false");
```

---

### Problema 2: Referências Não Carregadas em Surgical Mode

**Severidade:** 🔴 CRÍTICA

**Evidência:**
- Modo surgical só mostra catálogo
- Não injeta referências completas
- Agente deve "adivinhar" quando ler

**Impacto:**
- 90% das edições são surgical (troca de cor, texto, etc)
- Nesses casos, Impeccable guidance NÃO está presente
- Resultado: edições genéricas mesmo com skill ativa

**Solução:**
```typescript
// Sempre injetar pelo menos craft-floor + referência relevante
if (surgical && impeccable) {
  const relevant = detectRelevantReference(userMessage);
  parts.push(impeccableReference("craft-floor"));
  parts.push(impeccableReference(relevant));
}
```

---

### Problema 3: Cache Mata Originalidade

**Severidade:** 🟡 ALTA

**Evidência:**
- Cache retorna resposta idêntica para contextos similares
- TTL de 5 minutos

**Impacto:**
- "Crie site para cafeteria" = sempre o mesmo site
- Contradiz princípio fundamental do Impeccable (originalidade)

**Solução:**
- Desabilitar cache quando Impeccable ativo
- OU adicionar randomness ao cache key

---

### Problema 4: Compactação Perde Contexto Visual

**Severidade:** 🟡 ALTA

**Evidência:**
- Apenas 20 mensagens preservadas
- Não distingue mensagens de design

**Impacto:**
- Paleta definida há 25 mensagens = perdida
- Design direction anterior = esquecido
- Inconsistência visual ao longo da conversa

**Solução:**
```typescript
// Compactação inteligente
function compactWithDesignAwareness(
  messages: Message[], 
  maxMessages: number
): Message[] {
  // 1. Preservar TODAS com design tokens
  const designMessages = messages.filter(hasDesignContent);
  
  // 2. Preservar últimas 30 (contexto recente)
  const recent = messages.slice(-30);
  
  // 3. Compactar o resto
  const middle = messages.slice(0, -30)
    .filter(m => !designMessages.includes(m));
  
  return [...designMessages, ...compactMiddle(middle), ...recent];
}
```

---

### Problema 5: Validator Bloqueia Refinamentos

**Severidade:** 🟠 MÉDIA

**Evidência:**
- 3 iterações = "loop detectado"
- Design polish é iterativo por natureza

**Impacto:**
- Agente para de refinar antes de atingir qualidade
- "Verde vibrante → suave → perfeito" é bloqueado na 3ª tentativa

**Solução:**
```typescript
// Distinguir erros de syntax vs refinamentos de design
if (isDesignPolish && !hasSyntaxErrors) {
  maxAttempts = 8; // vs 3 normal
}
```

---

## 📊 MÉTRICAS DE QUALIDADE (A Implementar)

### Pre-Deploy Quality Gate

**Checklist Automático:**

```typescript
interface AntiAIQualityCheck {
  // Paleta
  hasGenericGradient: boolean;           // ❌ se true
  hasDerivedPalette: boolean;            // ✅ se true
  paletteJustification: string | null;   // ✅ se presente
  
  // Tipografia
  usesFixedSizes: boolean;               // ❌ se true
  usesClampScale: boolean;               // ✅ se true
  hasProperHierarchy: boolean;           // ✅ se true
  
  // Layout
  isGenericHeroStructure: boolean;       // ❌ se true
  usesGridFirst: boolean;                // ✅ se true
  hasIntentionalAsymmetry: boolean;      // ✅ se true
  
  // CTAs
  hasGenericCTAs: boolean;               // ❌ se true
  hasSpecificCTAs: boolean;              // ✅ se true
  
  // Overall
  antiAIScore: number;                   // 0-100
  canDeploy: boolean;                    // true se score >= 80
}
```

---

## 🎯 PLANO DE IMPLEMENTAÇÃO

### FASE 1: CORREÇÕES CRÍTICAS (2-4h)

#### 1.1 Garantir Impeccable Sempre Ativo
- [ ] Forçar `impeccable = true` em produção
- [ ] Remover possibilidade de desabilitar skill builtin
- [ ] Adicionar variável de ambiente `FORCE_IMPECCABLE`

#### 1.2 Injetar Referências em Surgical Mode
- [ ] Detectar referência relevante do userMessage
- [ ] Injetar craft-floor + relevante sempre
- [ ] Garantir agente tem guidance mínimo

#### 1.3 Desabilitar Cache com Impeccable
- [ ] Adicionar flag `this.impeccableActive`
- [ ] Skip cache quando Impeccable ativo
- [ ] Documentar trade-off custo/qualidade

---

### FASE 2: CONTEXTO INTELIGENTE (4-6h)

#### 2.1 Compactação Design-Aware
- [ ] Implementar `hasDesignContent(message)`
- [ ] Preservar mensagens com tokens/paleta
- [ ] Aumentar limite para 50-80 mensagens

#### 2.2 Relaxar Validator para Design
- [ ] Detectar design polish vs syntax errors
- [ ] Aumentar maxAttempts para refinamentos
- [ ] Não bloquear ajustes de cor/tipografia

---

### FASE 3: PROMPT EXCELLENCE (6-8h)

#### 3.1 Reescrever Creative Prompt
- [ ] Adicionar exemplos concretos de anti-padrões
- [ ] Adicionar exemplos concretos de bom design
- [ ] Listar gradientes proibidos explicitamente

#### 3.2 Expandir System Prompt
- [ ] Adicionar "Forbidden Visual Patterns" section
- [ ] Adicionar "Design Derivation Rules"
- [ ] Adicionar "Quality Self-Check" instructions

---

### FASE 4: QUALITY GATE (8-10h)

#### 4.1 Implementar Anti-AI Checker
- [ ] Detectar gradientes genéricos (regex + HSL analysis)
- [ ] Validar escala tipográfica (grep clamp())
- [ ] Verificar CTAs específicos vs genéricos

#### 4.2 Visual Quality Score
- [ ] Calcular score 0-100
- [ ] Bloquear deploy se score < 80
- [ ] Gerar relatório de melhorias

---

## 📈 RESULTADOS ESPERADOS

### Antes das Melhorias
- [ ] Impeccable ativo em ~30% das gerações (quando usuário lembra de ativar)
- [ ] Surgical mode sem guidance = 90% das edições genéricas
- [ ] Cache gerando sites idênticos para briefings similares
- [ ] Perda de contexto visual após 20 mensagens
- [ ] Refinamentos bloqueados prematuramente

### Depois das Melhorias
- [ ] Impeccable ativo em 100% das gerações (forçado)
- [ ] Surgical mode com guidance mínimo = 80%+ das edições com qualidade
- [ ] Zero cache hits = cada site é único
- [ ] Contexto visual preservado por toda conversa
- [ ] Refinamentos permitidos até atingir excelência

### Métricas de Qualidade
- [ ] 0% sites com gradientes roxo-azul-rosa
- [ ] 100% sites com paleta derivada do domínio
- [ ] 90%+ sites com tipografia escalada (clamp)
- [ ] 100% CTAs com copy específico ou ausente
- [ ] Anti-AI Quality Score médio: 85+ (vs ~50 atual)

---

**Status:** 🟡 Análise completa - Aguardando estudo do framework Impeccable pelos agentes  
**Próximos Passos:** Implementar Fase 1 (Correções Críticas)
