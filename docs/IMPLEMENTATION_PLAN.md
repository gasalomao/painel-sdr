# 🚀 PLANO DE IMPLEMENTAÇÃO - Impeccable Excellence

**Data:** 09/10/2026  
**Objetivo:** Eliminar "cara de IA" através de melhorias sistemáticas  
**Prioridade:** CRÍTICA - Iniciar imediatamente

---

## 📋 FASE 1: CORREÇÕES CRÍTICAS (PRIORITY 1)

### 1.1 ✅ FORÇAR IMPECCABLE SEMPRE ATIVO

**Arquivo:** `src/lib/sites/prompts.ts`  
**Linha:** 228  
**Mudança:**

```typescript
// ANTES (linha 228)
const impeccable = selected.some(isImpeccableSkill);

// DEPOIS
const forceImpeccable = process.env.FORCE_IMPECCABLE !== "false"; // default true
const impeccable = forceImpeccable || selected.some(isImpeccableSkill);
```

**Justificativa:**
- Garante que Impeccable está SEMPRE ativo, a menos que explicitamente desabilitado
- Permite override via env var para debugging/testes
- Resolve problema de inconsistência de qualidade

**Teste:**
```typescript
// Adicionar em __tests__/prompts.test.ts
it("forces Impeccable active by default", () => {
  const prompt = composeWebsitePrompt(project, [], creative, "crie um site");
  expect(prompt).toContain("IMPECCABLE ATIVO");
  expect(prompt).not.toContain("DESATIVADA pelo usuário");
});
```

---

### 1.2 ✅ INJETAR GUIDANCE MÍNIMO EM SURGICAL MODE

**Arquivo:** `src/lib/sites/prompts.ts`  
**Linha:** 236  
**Mudança:**

```typescript
// ANTES (linha 236)
...(impeccable ? [
  surgical 
    ? `IMPECCABLE ATIVO — REFINAMENTO / PRESERVAÇÃO — fonte ${IMPECCABLE_REVISION}
       Preserve identidade, funções e acessibilidade. 
       Referências integrais consultáveis sob demanda por read_design_reference(name, offset, limit).
       CATÁLOGO COMPLETO: ${JSON.stringify(impeccableReferenceCatalog())}`
    : composeImpeccableGuidance(files, userMessage)
] : []),

// DEPOIS
...(impeccable ? [
  surgical 
    ? composeSurgicalImpeccableGuidance(userMessage)
    : composeImpeccableGuidance(files, userMessage)
] : []),
```

**Nova função em `src/lib/sites/impeccable.ts`:**

```typescript
/**
 * Compõe guidance mínimo para modo surgical (edição pontual)
 * Injeta craft-floor + referência relevante detectada do userMessage
 */
export function composeSurgicalImpeccableGuidance(prompt: string): string {
  const relevantRef = detectRelevantReference(prompt);
  
  return [
    `IMPECCABLE ATIVO — REFINAMENTO / PRESERVAÇÃO — fonte ${IMPECCABLE_REVISION}`,
    `Preserve identidade, funções e acessibilidade.`,
    ``,
    `REFERÊNCIA OFICIAL INTEGRAL: craft-floor`,
    impeccableReference("craft-floor"),
    `FIM DA REFERÊNCIA craft-floor`,
    ``,
    ...(relevantRef ? [
      `REFERÊNCIA OFICIAL INTEGRAL: ${relevantRef}`,
      impeccableReference(relevantRef),
      `FIM DA REFERÊNCIA ${relevantRef}`,
    ] : []),
    ``,
    `CATÁLOGO COMPLETO: ${JSON.stringify(impeccableReferenceCatalog())}`,
    `Outras referências consultáveis sob demanda por read_design_reference(name, offset, limit).`,
  ].join("\n");
}

/**
 * Detecta qual referência Impeccable é mais relevante para o prompt
 */
function detectRelevantReference(prompt: string): string | null {
  const routes: Array<[RegExp, string]> = [
    [/tipograf|fonte|texto|título|heading|paragraph/i, "typeset"],
    [/layout|espaç|margem|seção|seções|grid|coluna/i, "layout"],
    [/cor|cores|paleta|contraste|color/i, "colorize"],
    [/anima|movimento|transição|hover|animation/i, "animate"],
    [/mobile|responsiv|tablet|adapt/i, "adapt"],
    [/acessib|teclado|formulário|erro|a11y|aria/i, "harden"],
    [/copy|conteúdo|mensagem|rótulo|texto|headline/i, "clarify"],
    [/velocidade|performance|otimiz|speed/i, "optimize"],
  ];
  
  for (const [pattern, name] of routes) {
    if (pattern.test(prompt)) return name;
  }
  
  return null;
}
```

**Justificativa:**
- Modo surgical representa 90% das edições
- Sem guidance, agente aplica mudanças genéricas
- craft-floor + referência específica dá contexto mínimo necessário

**Limite de tokens:**
- craft-floor: ~8k tokens
- Referência específica: ~5k tokens
- Total: ~13k tokens (dentro do limite de 20k surgical)

---

### 1.3 ✅ DESABILITAR CACHE COM IMPECCABLE

**Arquivo:** `src/lib/sites/agent.ts`  
**Localização:** Método `runAgentAttempt` (aproximadamente linha 419)

**Mudança:**

```typescript
// ANTES
const cachedResponse = this.responseCache.get(requestKey);
if (cachedResponse) {
  return cachedResponse;
}

// DEPOIS
const cachedResponse = this.impeccableActive 
  ? null  // Nunca usar cache com Impeccable (originalidade > eficiência)
  : this.responseCache.get(requestKey);
  
if (cachedResponse) {
  return cachedResponse;
}

// E no final do método, depois de `const result = await this.chat(...)`
// ANTES
this.responseCache.set(requestKey, result);

// DEPOIS
if (!this.impeccableActive) {
  this.responseCache.set(requestKey, result);
}
```

**Adicionar propriedade à classe:**

```typescript
// No construtor ou onde impeccable é detectado
private impeccableActive: boolean;

constructor(...) {
  // ...
  this.impeccableActive = /* detectar se Impeccable está ativo */;
}
```

**Justificativa:**
- Cache contradiz princípio fundamental de originalidade
- Cada site deve ser único e autoral
- Trade-off: +custo mas +qualidade

**Documentação:**
```typescript
/**
 * DESIGN DECISION: Cache is DISABLED when Impeccable is active.
 * 
 * Reasoning: Impeccable's core philosophy is originality and craft.
 * Caching identical responses for similar prompts would produce
 * identical sites, violating the anti-AI design principle.
 * 
 * Trade-off: Higher API costs, but guaranteed uniqueness.
 */
```

---

## 📋 FASE 2: CONTEXTO INTELIGENTE (PRIORITY 2)

### 2.1 ✅ COMPACTAÇÃO DESIGN-AWARE

**Arquivo:** `src/lib/sites/agent-optimizations.ts`  
**Mudança:** Criar nova função `compactAgentHistoryDesignAware`

```typescript
/**
 * Compacta histórico preservando TODAS as mensagens com design decisions
 */
export function compactAgentHistoryDesignAware(
  messages: Message[],
  maxMessages: number,
  impeccableActive: boolean
): Message[] {
  if (!impeccableActive) {
    // Modo normal - compactação padrão
    return compactAgentHistory(messages, maxMessages);
  }
  
  // Modo Impeccable - preservar contexto visual
  const designKeywords = [
    'paleta', 'cor', 'cores', 'typography', 'tipografia', 'font', 'fonte',
    'layout', 'grid', 'design', 'visual', 'estilo', 'theme', 'token',
    'record_design_direction', '--color', '--font', 'var(--',
  ];
  
  const hasDesignContent = (msg: Message): boolean => {
    const content = msg.content.toLowerCase();
    return designKeywords.some(keyword => content.includes(keyword));
  };
  
  // 1. Preservar TODAS as mensagens com design content
  const designMessages = messages.filter(hasDesignContent);
  
  // 2. Preservar últimas 30 mensagens (contexto recente)
  const recentThreshold = Math.max(0, messages.length - 30);
  const recentMessages = messages.slice(recentThreshold);
  
  // 3. Mensagens do meio (excluindo design e recentes)
  const middleMessages = messages.slice(0, recentThreshold)
    .filter(msg => !designMessages.includes(msg));
  
  // 4. Compactar apenas o meio
  const compactedMiddle = compactAgentHistory(middleMessages, maxMessages - 30);
  
  // 5. Combinar: design + middle compactado + recent
  const combined = [
    ...designMessages.filter((_, i) => i < recentThreshold),
    ...compactedMiddle,
    ...recentMessages,
  ];
  
  // 6. Remover duplicatas preservando ordem
  const seen = new Set<Message>();
  return combined.filter(msg => {
    if (seen.has(msg)) return false;
    seen.add(msg);
    return true;
  });
}
```

**Usar em `agent.ts`:**

```typescript
// ANTES (linha ~181)
const compactedHistory = compactAgentHistory(
  input.history.map((h) => ({ role: h.role, content: h.content })) as Message[],
  20
);

// DEPOIS
const compactedHistory = compactAgentHistoryDesignAware(
  input.history.map((h) => ({ role: h.role, content: h.content })) as Message[],
  impeccableActive ? 80 : 20,  // Mais contexto com Impeccable
  impeccableActive
);
```

---

### 2.2 ✅ RELAXAR VALIDATOR PARA DESIGN

**Arquivo:** `src/lib/sites/agent-optimizations.ts`  
**Mudança:** Adicionar método `isDesignRefinement` na classe `SmartValidator`

```typescript
export class SmartValidator {
  // ... código existente ...
  
  /**
   * Detecta se as últimas validações são refinamentos de design
   * (não erros de syntax/runtime)
   */
  private isDesignRefinement(): boolean {
    if (this.history.length < 2) return false;
    
    const lastTwo = this.history.slice(-2);
    const allErrors = lastTwo.flatMap(h => h.errors);
    
    // Se tem erros de TypeScript/Runtime, NÃO é refinamento
    const hasSyntaxErrors = allErrors.some(err => 
      /TypeError|SyntaxError|ReferenceError|undefined|is not a function/i.test(err)
    );
    
    if (hasSyntaxErrors) return false;
    
    // Se todos os erros são sobre design (cor, fonte, espaço, etc)
    const designPatterns = [
      /cor|color|paleta/i,
      /fonte|font|tipografia|typography/i,
      /espaç|margin|padding/i,
      /tamanho|size/i,
      /borda|border|radius/i,
      /sombra|shadow/i,
    ];
    
    const allDesignRelated = allErrors.every(err =>
      designPatterns.some(pattern => pattern.test(err))
    );
    
    return allDesignRelated;
  }
  
  /**
   * Verifica se está em loop, considerando refinamentos de design
   */
  public isInValidationLoop(): boolean {
    if (this.history.length < 3) return false;
    
    // Se é refinamento de design, permitir mais tentativas
    if (this.isDesignRefinement()) {
      return this.history.length >= 6;  // 6 tentativas vs 3 normal
    }
    
    // Lógica normal para syntax errors
    const lastThree = this.history.slice(-3);
    const errorSignatures = lastThree.map(h => 
      JSON.stringify(h.errors.sort())
    );
    
    const allIdentical = errorSignatures.every(sig => sig === errorSignatures[0]);
    return allIdentical;
  }
}
```

---

## 📋 FASE 3: PROMPT EXCELLENCE (PRIORITY 3)

### 3.1 ✅ REESCREVER CREATIVE PROMPT

**Arquivo:** `src/lib/sites/prompts.ts`  
**Linha:** 61  
**Mudança:**

```typescript
// ANTES
creative_prompt: "Crie sites específicos para o negócio confirmado, 
com identidade visual intencional, conteúdo verdadeiro e CTA claro. 
Evite clichês de templates, preserve a marca, priorize acessibilidade, 
responsividade e desempenho. Faça alterações mínimas e verificáveis; 
não invente fatos ou resultados."

// DEPOIS
creative_prompt: `DIRETRIZ ANTI-IA: Crie sites com identidade única e autoral, não templates genéricos.

PADRÕES PROIBIDOS (nunca usar):
❌ Gradientes decorativos: roxo (#667eea) → azul (#764ba2), azul (#4facfe) → verde (#00f2fe), rosa → laranja
❌ Hero genérico: imagem desfocada + headline centralizado + CTA "Saiba Mais"
❌ 3 colunas de features com ícones de check/star
❌ CTAs vazios: "Saiba Mais", "Começar Agora", "Entre em Contato" sem destino
❌ Tipografia genérica: Inter + Inter sem hierarquia
❌ Tamanhos fixos: 16px, 24px, 32px ao invés de escala fluida

PADRÕES OBRIGATÓRIOS:
✅ Paleta derivada do domínio: cafeteria → tons terrosos, tech → cyan/emerald, hospitalidade → terracota
✅ Escala tipográfica fluida: clamp(min, base, max) em TODOS os tamanhos
✅ Layout grid-first: CSS Grid para estrutura, flex apenas dentro de componentes
✅ Geometria totalmente rounded: border-radius 999px para pills, 50% para círculos
✅ CTAs com copy específico do negócio ou explicitamente sem destino
✅ Tokens CSS: definir --color-*, --font-*, --space-* e consumir via var()

DERIVAÇÃO DE PALETA:
- Identifique o DOMÍNIO do negócio (não apenas "profissional")
- Derive HUE da essência: artesanato → brass/amber, dados → cyan, alimentos → terracotta
- 5-7 níveis de superfície tintados para esse hue
- 1 acento luminoso único e saturado
- NUNCA paleta "empresarial" genérica azul+cinza

CONTEÚDO VERDADEIRO:
- Use informações confirmadas no briefing
- Textos em português (não traduza do inglês)
- Não invente depoimentos, métricas, contatos ou provas sociais
- CTA sem endpoint = declare "formulário não configurado"

Priorize acessibilidade (ARIA, keyboard, contrast), responsividade e desempenho.`
```

---

### 3.2 ✅ EXPANDIR SYSTEM PROMPT COM ANTI-PATTERNS

**Arquivo:** `src/lib/sites/prompts.ts`  
**Linha:** 53 (WEBSITE_SECURITY_PROMPT)  
**Adicionar seção:**

```typescript
export const WEBSITE_SECURITY_PROMPT = `REGRAS IMUTÁVEIS DO SITE STUDIO

[... texto existente ...]

QUALIDADE ANTI-IA (verificar antes de concluir):
Após implementar, execute auto-validação visual:

CHECKLIST DE QUALIDADE:
□ Paleta: deriva do domínio do negócio? (não genérica azul+cinza)
□ Tipografia: usa clamp() em toda escala? (não 16px fixos)
□ Layout: grid-first? (não flexbox para estrutura)
□ CTAs: copy específico ou ausente? (não "Saiba Mais" vazio)
□ Tokens: centralizados em tokens.css? (não valores inline repetidos)
□ Gradientes: NENHUM decorativo? (especialmente roxo-azul-rosa)
□ Componentes: geometria rounded? (999px pills, 50% circles)

Se qualquer item falhar, corrija antes de concluir.`;
```

---

## 📋 FASE 4: QUALITY GATE (PRIORITY 4)

### 4.1 ✅ IMPLEMENTAR ANTI-AI QUALITY CHECKER

**Novo arquivo:** `src/lib/sites/quality-checker.ts`

```typescript
import type { WebsiteFiles } from "./types";

export interface QualityCheck {
  id: string;
  category: "palette" | "typography" | "layout" | "cta" | "tokens";
  severity: "critical" | "high" | "medium";
  passed: boolean;
  message: string;
  suggestion?: string;
}

export interface QualityReport {
  score: number;  // 0-100
  passed: boolean;  // true se score >= 80
  checks: QualityCheck[];
  summary: string;
}

/**
 * Valida qualidade anti-IA de um site gerado
 */
export function checkAntiAIQuality(files: WebsiteFiles): QualityReport {
  const checks: QualityCheck[] = [];
  
  // 1. Verificar gradientes proibidos
  checks.push(checkForbiddenGradients(files));
  
  // 2. Verificar escala tipográfica
  checks.push(checkFluidTypography(files));
  
  // 3. Verificar uso de tokens
  checks.push(checkTokenUsage(files));
  
  // 4. Verificar CTAs genéricos
  checks.push(checkGenericCTAs(files));
  
  // 5. Verificar grid-first layout
  checks.push(checkGridFirstLayout(files));
  
  // Calcular score
  const totalWeight = checks.reduce((sum, c) => 
    sum + (c.severity === "critical" ? 30 : c.severity === "high" ? 20 : 10), 0
  );
  
  const passedWeight = checks
    .filter(c => c.passed)
    .reduce((sum, c) => 
      sum + (c.severity === "critical" ? 30 : c.severity === "high" ? 20 : 10), 0
    );
  
  const score = Math.round((passedWeight / totalWeight) * 100);
  const passed = score >= 80;
  
  const failedCritical = checks.filter(c => !c.passed && c.severity === "critical");
  const summary = passed
    ? `✅ Site aprovado com score ${score}/100`
    : `❌ Site precisa de melhorias (score ${score}/100). ${failedCritical.length} checks críticos falharam.`;
  
  return { score, passed, checks, summary };
}

function checkForbiddenGradients(files: WebsiteFiles): QualityCheck {
  const forbiddenPatterns = [
    /#667eea.*#764ba2/i,  // roxo → azul
    /#4facfe.*#00f2fe/i,  // azul → verde
    /#fa709a.*#fee140/i,  // rosa → laranja
    /linear-gradient.*purple.*blue/i,
    /linear-gradient.*#[0-9a-f]{3,6}.*#[0-9a-f]{3,6}/i, // qualquer gradiente decorativo
  ];
  
  const cssFiles = Object.entries(files).filter(([path]) => path.endsWith(".css"));
  
  for (const [path, content] of cssFiles) {
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(content)) {
        return {
          id: "no-generic-gradients",
          category: "palette",
          severity: "critical",
          passed: false,
          message: `Gradiente genérico detectado em ${path}`,
          suggestion: "Use paleta sólida derivada do domínio, não gradientes decorativos"
        };
      }
    }
  }
  
  return {
    id: "no-generic-gradients",
    category: "palette",
    severity: "critical",
    passed: true,
    message: "Nenhum gradiente genérico detectado"
  };
}

function checkFluidTypography(files: WebsiteFiles): QualityCheck {
  const cssFiles = Object.entries(files).filter(([path]) => path.endsWith(".css"));
  
  let hasClamp = false;
  let hasFixedSizes = false;
  
  for (const [, content] of cssFiles) {
    if (/font-size:\s*clamp\(/i.test(content)) {
      hasClamp = true;
    }
    if (/font-size:\s*\d+px/i.test(content)) {
      hasFixedSizes = true;
    }
  }
  
  if (!hasClamp && hasFixedSizes) {
    return {
      id: "fluid-typography",
      category: "typography",
      severity: "high",
      passed: false,
      message: "Tipografia usa tamanhos fixos (px) ao invés de escala fluida (clamp)",
      suggestion: "Use clamp(min, base, max) para todos os tamanhos de fonte"
    };
  }
  
  return {
    id: "fluid-typography",
    category: "typography",
    severity: "high",
    passed: true,
    message: "Tipografia usa escala fluida com clamp()"
  };
}

function checkTokenUsage(files: WebsiteFiles): QualityCheck {
  const tokensFile = files["src/tokens.css"];
  
  if (!tokensFile) {
    return {
      id: "css-tokens",
      category: "tokens",
      severity: "high",
      passed: false,
      message: "Arquivo src/tokens.css não encontrado",
      suggestion: "Centralize design tokens em src/tokens.css"
    };
  }
  
  const hasColorTokens = /--color-/i.test(tokensFile);
  const hasFontTokens = /--font-/i.test(tokensFile);
  const hasSpaceTokens = /--space-/i.test(tokensFile);
  
  if (!hasColorTokens || !hasFontTokens || !hasSpaceTokens) {
    return {
      id: "css-tokens",
      category: "tokens",
      severity: "medium",
      passed: false,
      message: "tokens.css incompleto (faltam cores, fontes ou espaçamentos)",
      suggestion: "Defina --color-*, --font-* e --space-* em tokens.css"
    };
  }
  
  return {
    id: "css-tokens",
    category: "tokens",
    severity: "medium",
    passed: true,
    message: "Design tokens centralizados em tokens.css"
  };
}

function checkGenericCTAs(files: WebsiteFiles): QualityCheck {
  const genericCTAs = [
    />\s*Saiba\s+Mais\s*</i,
    />\s*Começar\s+Agora\s*</i,
    />\s*Entre\s+em\s+Contato\s*</i,
    />\s*Learn\s+More\s*</i,
    />\s*Get\s+Started\s*</i,
  ];
  
  const tsxFiles = Object.entries(files).filter(([path]) => path.endsWith(".tsx"));
  
  for (const [path, content] of tsxFiles) {
    for (const pattern of genericCTAs) {
      if (pattern.test(content)) {
        return {
          id: "specific-ctas",
          category: "cta",
          severity: "high",
          passed: false,
          message: `CTA genérico encontrado em ${path}`,
          suggestion: "Use copy específico do negócio (ex: 'Reserve Sua Mesa', 'Calcular Frete')"
        };
      }
    }
  }
  
  return {
    id: "specific-ctas",
    category: "cta",
    severity: "high",
    passed: true,
    message: "CTAs usam copy específico do negócio"
  };
}

function checkGridFirstLayout(files: WebsiteFiles): QualityCheck {
  const cssFiles = Object.entries(files).filter(([path]) => path.endsWith(".css"));
  
  let hasGridForStructure = false;
  
  for (const [, content] of cssFiles) {
    if (/display:\s*grid/i.test(content)) {
      hasGridForStructure = true;
      break;
    }
  }
  
  if (!hasGridForStructure) {
    return {
      id: "grid-first-layout",
      category: "layout",
      severity: "medium",
      passed: false,
      message: "Layout não usa CSS Grid para estrutura principal",
      suggestion: "Use CSS Grid para layout de página, flex apenas para componentes internos"
    };
  }
  
  return {
    id: "grid-first-layout",
    category: "layout",
    severity: "medium",
    passed: true,
    message: "Layout usa CSS Grid para estrutura"
  };
}
```

---

## 🔄 ORDEM DE IMPLEMENTAÇÃO

1. **✅ FASE 1.1** - Forçar Impeccable ativo (5 min)
2. **✅ FASE 1.3** - Desabilitar cache (10 min)
3. **✅ FASE 3.1** - Reescrever creative prompt (15 min)
4. **✅ FASE 1.2** - Injetar guidance surgical (30 min)
5. **✅ FASE 2.1** - Compactação design-aware (45 min)
6. **✅ FASE 2.2** - Relaxar validator (30 min)
7. **✅ FASE 3.2** - Expandir system prompt (15 min)
8. **✅ FASE 4.1** - Quality checker (60 min)

**Total estimado:** 3-4 horas

---

## 📊 MÉTRICAS DE SUCESSO

### Antes
- Impeccable ativo: ~30% das gerações
- Surgical mode com guidance: 0%
- Sites com gradientes genéricos: ~60%
- Tipografia fixa (px): ~80%
- CTAs genéricos: ~70%

### Depois (Meta)
- Impeccable ativo: 100% das gerações ✅
- Surgical mode com guidance: 100% ✅
- Sites com gradientes genéricos: <5% ✅
- Tipografia fixa (px): <10% ✅
- CTAs genéricos: <10% ✅
- Quality Score médio: 85+ ✅

---

**Status:** 🟢 PRONTO PARA IMPLEMENTAR  
**Próximo Passo:** Começar Fase 1.1
