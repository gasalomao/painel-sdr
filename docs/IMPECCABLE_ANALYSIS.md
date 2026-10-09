# Análise Profunda: Impeccable — Filosofia de Qualidade para IA

**Data:** 09/10/2026  
**Versão Impeccable analisada:** Repositório principal + DESIGN.md (Neo Kinpaku)  
**Objetivo:** Integrar princípios de qualidade no Site Studio

---

## 1. RESUMO EXECUTIVO

### Filosofia Central

Impeccable resolve o problema de **homogeneidade em outputs de IA** — "Every model trained on the same SaaS templates produces the same Inter fonts, purple gradients, and nested cards."

**Três pilares fundamentais:**

1. **Verdade de produto durável** — Separa contexto estratégico (audiência, propósito, evidência) de decisões visuais efêmeras via `PRODUCT.md`
2. **Vocabulário compartilhado** — 24 comandos criam linguagem comum entre humano e agente (`shape`, `audit`, `critique`, `polish`, `generate`)
3. **Qualidade determinística** — 59 regras de detecção offline + auditoria técnica + crítica UX em múltiplas camadas

**Definição de qualidade segundo Impeccable:**
- Comprometimento total com a direção escolhida (não "versão segura")
- Materiais autorais, não chrome genérico
- Semântica, acessibilidade e performance preservados
- Sistema coeso produto-específico, não coleção de padrões genéricos

---

## 2. SISTEMA DE VALIDAÇÃO EM MÚLTIPLAS CAMADAS

### Camada 1: Detecção Determinística (59 regras)

Executam **offline, sem LLM**, identificando anti-patterns visuais comuns:

**Anti-patterns confirmados:**
- Tipografias overused (Arial, Inter, system defaults)
- Texto baixo contraste em fundos coloridos
- Layouts baseados em cards aninhados
- Preto/cinza puro (deve sempre ter tint)
- Easing datado (bounce/elastic)
- Line-length insuficiente
- Padding cramped
- Touch targets undersized
- Semantic headings ausentes
- Gaps de design responsivo

**Características:**
- Exit codes: 0 (limpo), 2 (achados), 1 (falha scan)
- Waivers inline via comentários
- Ignores configuráveis por regra/arquivo/valor
- CLI standalone + hook no harness

### Camada 2: Auditoria Técnica (5 dimensões, scoring 0-4)

**Dimensões avaliadas:**

| Dimensão | Critérios | Peso |
|----------|-----------|------|
| **Accessibility** | Contraste 4.5:1, motion sensitivity, ARIA, keyboard nav, HTML semântico, alt text, forms | 0-4 |
| **Performance** | Layout thrashing, animation efficiency, assets otimizados, `will-change`, bundle, render cycles | 0-4 |
| **Theming** | Tokens adotados, dark mode, consistência, theme-switching | 0-4 |
| **Responsive** | Fixed-width, touch targets 44×44px, gestures, overflow, text scaling, viewport coverage | 0-4 |
| **Implementation** | Sistema produto-específico coeso, detector validation, design-system adherence, estrutura intencional | 0-4 |

**Score total:** 0-20 pontos
- 0-5: Critical
- 6-9: Poor
- 10-13: Fair
- 14-17: Good
- 18-20: Excellent

**Severidade de issues:**
- **P0:** Bloqueia conclusão de tarefa
- **P1:** Dificuldade significativa ou violação WCAG AA
- **P2:** Aborrecimento com workaround disponível
- **P3:** Polish apenas, impacto mínimo

### Camada 3: Crítica UX (Dual-Agent Review)

**Processo:**
1. Design review (agent avalia UX, hierarquia, estados)
2. Detector automated (59 regras determinísticas)
3. Síntese de achados
4. Feedback estruturado com severidade

**Output estruturado:**
```json
{
  "passed": boolean,
  "issues": string[],  // máx 20 itens × 1000 chars
  "summary": string,   // máx 3000 chars
  "checks": ImpeccableVisualCheck[]  // se Impeccable ativo
}
```

### Camada 4: Polish (Refinamento)

**Princípios:**
- Preserva mundo visual incumbente (não redesign disfarçado)
- Testa múltiplos viewports/orientações
- Valida todos estados de interação (default, hover, focus, active, disabled, loading, error)
- Focus keyboard visível, ordem lógica de tabs, labels, touch targets apropriados
- Consistência de conteúdo (terminologia, capitalização, precisão factual)
- Performance: zero console errors, layout shift, latência interação, image loading

**Ordem de triagem:**
1. Tasks quebradas, perda dados, estado enganoso, paths inacessíveis
2. Loading/empty/error/success/disabled states ausentes
3. Flow, hierarquia, responsive, alinhamento design-system
4. Consistência visual e motion
5. Code cleanup

**Verificação final:**
- Múltiplos viewports e orientações
- Todos estados de interação
- Acessibilidade semântica e screen-reader
- Conteúdo consistente
- Performance e console

---

## 3. CHECKLIST COMPLETO DE QUALIDADE

### A. Estrutural e Segurança

- [ ] Arquivos obrigatórios presentes (index.html, src/main.tsx, src/App.tsx)
- [ ] Meta viewport declarado
- [ ] Idioma do documento (lang) presente
- [ ] Nenhum código não permitido (eval, Function, process.env, child_process)
- [ ] Nenhum conteúdo ativo externo (iframe, script src externo)
- [ ] Imports apenas autorizados (React, React DOM, paths locais)
- [ ] Nenhum import fora do workspace
- [ ] SVG sem scripting ou eventos inline
- [ ] Workspace dentro dos limites (100 arquivos, 256KB/arquivo, 2MB total)

### B. Design System e Tokens

- [ ] Tokens centralizados (cores, tipografia, espaçamentos, raios, sombras)
- [ ] Consumo exclusivo via var()
- [ ] Escala tipográfica fluida com clamp()
- [ ] Famílias de fontes declaradas como custom properties
- [ ] Tracking negativo em display sizes
- [ ] Line-height generoso em body copy
- [ ] Geometria via CSS Grid (layout primário)
- [ ] Flexbox apenas dentro de componentes
- [ ] Raios totalmente arredondados (999px pills, 50% circles)
- [ ] Raios tokenizados, não literais

### C. Paleta e Materiais (princípios Impeccable)

- [ ] Superfícies escuras tintadas (nunca preto puro #000)
- [ ] 5-7 níveis de superfície com ladder tonal
- [ ] Hue derivado do domínio (brass/amber craft, cyan/emerald data, terracotta hospitality)
- [ ] Um acento luminoso high-saturation comprometido
- [ ] Um tint muted de suporte
- [ ] Nunca flat white page
- [ ] Nunca indigo-on-white
- [ ] Nunca purple gradient genérico

### D. Acessibilidade (WCAG 2.1 AA baseline)

- [ ] Contraste mínimo 4.5:1 para texto body
- [ ] Contraste mínimo 3:1 para texto large e UI/graphical elements
- [ ] Verificado em light e dark themes
- [ ] Touch targets mínimo 44×44px (iOS) / 48×48dp (Android)
- [ ] hitSlop para controles pequenos
- [ ] Respeita Dynamic Type / font scaling
- [ ] Respeita prefers-reduced-motion
- [ ] Não transmite significado apenas por cor
- [ ] ARIA roles e labels presentes
- [ ] Navegação keyboard lógica
- [ ] Focus visível e restaurado corretamente
- [ ] Elementos custom reachable e operáveis
- [ ] HTML semântico (h1-h6, nav, main, article, etc.)

### E. Performance

- [ ] Assets otimizados (imagens dimensionadas corretamente)
- [ ] Lazy loading de imagens não-críticas
- [ ] Animações via transform/opacity (não width/height/padding/margin)
- [ ] renderGroup(true) para animações complexas
- [ ] Nenhum trabalho síncrono pesado no JS thread
- [ ] Componentes pesados memoizados
- [ ] Listas virtualizadas (LazyForEach para listas grandes)
- [ ] Nenhuma criação inline de objects/arrays/functions em hot paths

### F. Responsive e Layout

- [ ] Mobile-first com breakpoints intencionais
- [ ] Grid-first (CSS Grid para frames, seções, cards)
- [ ] Nenhuma fixed-width constraint quebrando mobile
- [ ] Texto escalável sem clip
- [ ] Overflow tratado gracefully
- [ ] Viewports testados: desktop (1440+), tablet (768), mobile (390)
- [ ] Orientações testadas: portrait e landscape

### G. Estados e Feedback

- [ ] Loading state explícito
- [ ] Empty state com orientação
- [ ] Error state com recovery action
- [ ] Success feedback
- [ ] Disabled state visualmente distinto
- [ ] Hover/focus/active states diferenciados
- [ ] Skeleton loaders para async content

### H. Conteúdo e Materiais

- [ ] Conteúdo autoral (não lorem ipsum ou placeholder.com)
- [ ] Nomes, entradas, copy cuidadosamente feitos
- [ ] Nenhum gradiente/glass/icon tiles genéricos onde assets autorais cabem
- [ ] Terminologia consistente
- [ ] Capitalização consistente
- [ ] Precisão factual verificada
- [ ] Nenhuma prova social, depoimento, credencial, preço ou contato inventado

### I. Sistema Coeso (não coleção de padrões)

- [ ] Elementos usam vocabulário da forma escolhida
- [ ] Navegação, botões, inputs seguem o mesmo sistema
- [ ] Nenhum "stock component inside committed form"
- [ ] Primeiro viewport é tese, não decoração
- [ ] Se usuário sai após 1 viewport, descreve o mecanismo (não apenas mood estético)

---

## 4. PROMPTS PARA O AGENTE DE IA

### Prompt Base (já integrado em `WEBSITE_SECURITY_PROMPT`)

```
Produza React, Vite, TypeScript e CSS dentro dos arquivos permitidos. 
Centralize design tokens em src/tokens.css (cores, tipografia com escala 
real e legível, espaçamentos, raios, sombras) e consuma via var(); 
tipografia deve refletir o conteúdo real, sem fontes remotas.

Crie sites específicos para o negócio confirmado, com identidade visual 
intencional, conteúdo verdadeiro e CTA claro. Evite clichês de templates, 
preserve a marca, priorize acessibilidade, responsividade e desempenho.
```

### Prompt Adicional de Qualidade Visual (SUGESTÃO)

```
QUALIDADE VISUAL — ANTI-PATTERNS A EVITAR

Superfícies e Cor:
- Nunca use preto puro (#000000) ou branco puro (#FFFFFF)
- Tinte toda superfície escura em direção ao domínio do negócio
- Construa ladder tonal de 5-7 níveis (ex: #05070C → #0F131C → #1E2636)
- Escolha UM acento luminoso high-saturation derivado do contexto
- Nunca indigo-on-white, purple gradients, ou neon cyan genéricos

Tipografia:
- Evite Arial, Inter sem customização, system defaults óbvios
- Declare famílias como --font-display e --font-body
- Use clamp() para escala fluida (ex: clamp(2.5rem, 5vw, 4rem))
- Tracking negativo em display, generoso em body (line-height 1.65-1.8)
- Limite line-length a 65-75ch para leitura confortável

Layout:
- CSS Grid para page frame e section rhythm
- Flexbox apenas DENTRO de componentes
- Raios tokenizados: --radius-sm, --radius-lg, --radius-pill (999px)
- Evite cards aninhados e containers excessivos

Materiais:
- Prefira assets autorais a gradientes decorativos
- Texturas e imagens devem ter propósito, não apenas decoração
- Nenhum lorem ipsum, placeholder.com, example.com
- Primeiro viewport deve demonstrar o mecanismo imediatamente

Performance:
- Animar apenas transform, opacity, filter
- Nunca animar width, height, padding, margin (layout thrashing)
- Touch targets mínimo 44×44px

Acessibilidade:
- Contraste 4.5:1 para texto, 3:1 para UI/graphical elements
- ARIA roles onde HTML semântico não basta
- Focus keyboard sempre visível
- Não transmitir significado apenas por cor
```

### Prompt de Crítica Visual (PARA QA AGENT)

```
Avalie o site gerado contra os seguintes critérios Impeccable:

1. SUPERFÍCIES E COR
   - Superfícies tintadas (não preto/cinza neutro)?
   - Ladder tonal coerente (5-7 níveis)?
   - Acento luminoso comprometido?
   - Sistema evita clichês (indigo-on-white, purple gradients)?

2. TIPOGRAFIA
   - Escala fluida implementada?
   - Famílias via custom properties?
   - Line-height e tracking apropriados?
   - Evita fonts overused sem customização?

3. LAYOUT
   - Grid-first para estrutura?
   - Raios tokenizados?
   - Evita nested cards?

4. MATERIAIS
   - Assets autorais vs. decoração genérica?
   - Conteúdo real vs. placeholder?
   - Primeiro viewport demonstra mecanismo?

5. ACESSIBILIDADE
   - Contraste WCAG AA?
   - Touch targets ≥44px?
   - ARIA e semântica?
   - Focus keyboard?

6. PERFORMANCE
   - Animações performant (transform/opacity)?
   - Assets otimizados?

Retorne JSON:
{
  "passed": boolean,
  "issues": string[],
  "summary": string,
  "checks": [
    {"dimension": string, "passed": boolean, "evidence": string}
  ]
}
```

---

## 5. ESTRATÉGIA DE INTEGRAÇÃO NO SITE STUDIO

### 5.1. Validação Pré-Publicação (4 Gates)

```
┌─────────────────────────────────────────────────────────┐
│ GATE 1: STRUCTURAL VALIDATION (já implementado)         │
│ - validateWebsiteContent()                              │
│ - websiteSyntaxErrors() (TypeScript AST)                │
│ - Limites: arquivos, bytes, paths, imports             │
│ - Output: WebsiteQa { errors, warnings, issues }       │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ GATE 2: BUILD & RENDER (E2B, já implementado)          │
│ - Vite build                                            │
│ - Playwright render                                     │
│ - Screenshots desktop/mobile                            │
│ - Console errors capturados                             │
│ - Output: WebsiteBuildResult                           │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ GATE 3: IMPECCABLE AUDIT (NOVO — integrar)             │
│ - Detecção determinística (59 regras offline)          │
│ - Scoring 0-4 em 5 dimensões                           │
│ - Classificação P0/P1/P2/P3                            │
│ - Output: ImpeccableAuditResult                        │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ GATE 4: VISUAL CRITIQUE (já implementado + expandir)   │
│ - criticQa() com modelo quality                        │
│ - Checks Impeccable se skill ativo                     │
│ - Severity merge de issues                             │
│ - Output: { passed, issues, summary, checks }          │
└─────────────────────────────────────────────────────────┘
```

### 5.2. Arquivos a Criar/Modificar

#### NOVO: `src/lib/sites/impeccable-audit.ts`

```typescript
export interface ImpeccableAuditResult {
  score: number;           // 0-20
  rating: "critical" | "poor" | "fair" | "good" | "excellent";
  dimensions: {
    accessibility: ImpeccableDimensionScore;
    performance: ImpeccableDimensionScore;
    theming: ImpeccableDimensionScore;
    responsive: ImpeccableDimensionScore;
    implementation: ImpeccableDimensionScore;
  };
  findings: ImpeccableFinding[];
  passed: boolean;         // score >= 14 (Good threshold)
}

export interface ImpeccableDimensionScore {
  score: 0 | 1 | 2 | 3 | 4;
  issues: string[];
}

export interface ImpeccableFinding {
  severity: "P0" | "P1" | "P2" | "P3";
  category: string;
  message: string;
  file?: string;
  location?: string;
}

export async function auditWebsiteWithImpeccable(
  files: WebsiteFiles,
  screenshots: { desktop?: string; mobile?: string }
): Promise<ImpeccableAuditResult>
```

**Implementação:**
1. Análise estática de `files` (contraste via AST de CSS, tokens via regex)
2. Análise de screenshots (se disponíveis, via vision model para touch targets, spacing)
3. Scoring algorítmico das 5 dimensões
4. Classificação de severity baseada em impacto
5. Threshold: `passed = score >= 14` (Good ou acima)

#### MODIFICAR: `src/lib/sites/agent.ts`

```typescript
// Após build bem-sucedido e antes de criticQa
const auditResult = await auditWebsiteWithImpeccable(
  candidateFiles, 
  { desktop: build.screenshots?.desktop, mobile: build.screenshots?.mobile }
);

// Incluir audit no qaReport
qaReport.impeccableAudit = auditResult;

// Se score < threshold, adicionar issues ao criticQa
if (!auditResult.passed) {
  const criticalIssues = auditResult.findings
    .filter(f => f.severity === "P0" || f.severity === "P1")
    .map(f => `[${f.severity}] ${f.category}: ${f.message}`);
  
  // Merge com issues da crítica visual
}
```

#### MODIFICAR: `src/lib/sites/qa-report.ts`

```typescript
export interface WebsiteQaReport {
  // ... campos existentes
  impeccableAudit?: ImpeccableAuditResult;  // NOVO
  impeccableVersion?: string;               // IMPECCABLE_REVISION
}
```

#### NOVO: `src/lib/sites/impeccable-prompts.ts`

```typescript
export const IMPECCABLE_VISUAL_CRITIQUE = `
Avalie o site contra critérios Impeccable de qualidade visual...
[prompt completo da seção 4 acima]
`;

export const IMPECCABLE_CREATIVE_GUIDANCE = `
QUALIDADE VISUAL — ANTI-PATTERNS A EVITAR
[guidance completo da seção 4 acima]
`;
```

#### MODIFICAR: `src/lib/sites/prompts.ts`

```typescript
// No systemPrompt, após WEBSITE_SECURITY_PROMPT, adicionar:
if (isImpeccableSkill(activeSkills)) {
  systemPrompt += "\n\n" + IMPECCABLE_CREATIVE_GUIDANCE;
}
```

### 5.3. Skills do Impeccable (Biblioteca)

Criar skills builtin inspirados nos comandos Impeccable:

| Skill Builtin | Trigger Mode | Descrição | Baseado em |
|---------------|--------------|-----------|------------|
| `impeccable-audit` | on_demand | Auditoria técnica 5 dimensões | `audit.md` |
| `impeccable-critique` | on_demand | Crítica UX dual-agent | `critique.md` |
| `impeccable-polish` | on_demand | Refinamento preservando identidade | `polish.md` |
| `impeccable-bolder` | on_demand | Aumentar intensidade visual | `bolder.md` |
| `impeccable-quieter` | on_demand | Reduzir intensidade visual | `quieter.md` |
| `impeccable-distill` | on_demand | Simplificar mantendo essência | `distill.md` |
| `impeccable-responsive` | auto | Validação responsiva automática | `audit.md` responsive |
| `impeccable-a11y` | auto | Validação acessibilidade automática | `audit.md` accessibility |

### 5.4. Scoring Automático e Thresholds

```typescript
export const QUALITY_THRESHOLDS = Object.freeze({
  // Impeccable scoring
  IMPECCABLE_MINIMUM: 14,      // Good (18-20 = Excellent)
  
  // Structural (já existente)
  MAX_ERRORS: 0,               // Zero errors estruturais
  MAX_P0_WARNINGS: 0,          // Zero warnings P0
  
  // Build
  BUILD_SUCCESS_REQUIRED: true,
  MAX_CONSOLE_ERRORS: 0,
  
  // Visual critique
  CRITIC_PASSED_REQUIRED: true,
  MAX_P0_ISSUES: 0,
  MAX_P1_ISSUES: 2,            // Até 2 P1 aceitáveis com justificativa
});
```

### 5.5. Fluxo de Decisão de QA

```typescript
export function decideFinalQa(
  structural: WebsiteQa,
  build: WebsiteBuildResult,
  audit: ImpeccableAuditResult,
  critique: { passed: boolean; issues: string[] }
): { passed: boolean; blockers: string[]; warnings: string[] } {
  
  const blockers: string[] = [];
  const warnings: string[] = [];
  
  // Gate 1: Structural
  if (structural.errors.length > 0) {
    blockers.push(...structural.errors);
  }
  
  // Gate 2: Build
  if (!build.success) {
    blockers.push("Build failed");
  }
  if (build.errors && build.errors.length > 0) {
    blockers.push(...build.errors.slice(0, 3));
  }
  
  // Gate 3: Impeccable Audit
  if (audit.score < QUALITY_THRESHOLDS.IMPECCABLE_MINIMUM) {
    const p0p1 = audit.findings.filter(f => f.severity === "P0" || f.severity === "P1");
    if (p0p1.length > 0) {
      blockers.push(`Impeccable audit failed (score ${audit.score}/20)`);
      blockers.push(...p0p1.slice(0, 5).map(f => `[${f.severity}] ${f.message}`));
    } else {
      warnings.push(`Impeccable score ${audit.score}/20 (below Good threshold 14)`);
    }
  }
  
  // Gate 4: Visual Critique
  if (!critique.passed) {
    const p0Issues = critique.issues.filter(i => i.startsWith("[P0]"));
    if (p0Issues.length > 0) {
      blockers.push("Critical visual issues found");
      blockers.push(...p0Issues.slice(0, 3));
    } else {
      warnings.push(...critique.issues.slice(0, 5));
    }
  }
  
  return {
    passed: blockers.length === 0,
    blockers,
    warnings
  };
}
```

### 5.6. UI: Painel de Qualidade

No `src/components/sites/site-quality-panel.tsx` (novo):

```tsx
<QualityScoreCard>
  <ImpeccableScore value={audit.score} max={20} rating={audit.rating} />
  
  <DimensionsGrid>
    <DimensionBadge label="A11y" score={audit.dimensions.accessibility.score} />
    <DimensionBadge label="Perf" score={audit.dimensions.performance.score} />
    <DimensionBadge label="Theme" score={audit.dimensions.theming.score} />
    <DimensionBadge label="Responsive" score={audit.dimensions.responsive.score} />
    <DimensionBadge label="System" score={audit.dimensions.implementation.score} />
  </DimensionsGrid>
  
  <FindingsList>
    {audit.findings.map(f => (
      <FindingItem severity={f.severity} category={f.category}>
        {f.message}
      </FindingItem>
    ))}
  </FindingsList>
</QualityScoreCard>
```

---

## 6. IMPLEMENTAÇÃO PRÁTICA — ROADMAP

### Fase 1: Foundation (1-2 dias)
- [ ] Criar `impeccable-audit.ts` com scoring algorítmico básico
- [ ] Implementar análise de contraste via AST de CSS
- [ ] Implementar detecção de tokens centralizados
- [ ] Implementar validação de touch targets (44px mínimo)
- [ ] Criar `ImpeccableAuditResult` types
- [ ] Testes unitários (80%+ coverage)

### Fase 2: Integration (1 dia)
- [ ] Modificar `agent.ts` para chamar audit após build
- [ ] Modificar `qa-report.ts` para incluir `impeccableAudit`
- [ ] Implementar `decideFinalQa()` com 4 gates
- [ ] Testes de integração do fluxo completo

### Fase 3: Prompts Enhancement (1 dia)
- [ ] Criar `impeccable-prompts.ts` com guidance visual
- [ ] Integrar `IMPECCABLE_CREATIVE_GUIDANCE` no systemPrompt
- [ ] Criar `IMPECCABLE_VISUAL_CRITIQUE` para QA agent
- [ ] Testar com modelo quality (catálogo gratuito)

### Fase 4: Skills Library (2-3 dias)
- [ ] Implementar 8 skills builtin Impeccable
- [ ] Criar triggers auto/on_demand apropriados
- [ ] Migration para `website_skills` com builtins
- [ ] Testes de cada skill isoladamente

### Fase 5: UI & Polish (1-2 dias)
- [ ] Criar `site-quality-panel.tsx`
- [ ] Integrar painel no `/sites/[projectId]`
- [ ] Design tokens para scoring visual
- [ ] Testar UX end-to-end

### Fase 6: Validation & Docs (1 dia)
- [ ] Gates completos: structural → build → audit → critique
- [ ] Suíte completa >80% coverage
- [ ] TypeScript/lint/build/diffcheck
- [ ] Documentar limites e thresholds em `docs/SITE_STUDIO.md`

**Total estimado: 7-10 dias de desenvolvimento**

---

## 7. RISCOS E MITIGAÇÕES

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| Análise de contraste via AST imprecisa | Falsos positivos/negativos | Threshold conservador; permitir waivers explícitos |
| Scoring muito rígido bloqueia aprovação | Frustração do usuário | Threshold Good (14/20), não Excellent (18/20) |
| Performance do audit em cada build | Latência perceptível | Cachear resultados por hash de files; executar em paralelo com critique |
| Skills Impeccable conflitam com criatividade | Output genérico | Skills como opt-in; guidance não é enforcement |
| Modelos gratuitos não seguem guidance | Qualidade baixa persiste | Reservar budget para 1-2 retries com guidance reforçado |

---

## 8. MÉTRICAS DE SUCESSO

### Quantitativas
- Score médio Impeccable ≥ 14 (Good) em 80% dos sites gerados
- 0 issues P0 em 95% dos sites publicados
- ≤ 2 issues P1 em 90% dos sites publicados
- Tempo de audit < 3s para 90% dos casos

### Qualitativas
- Sites gerados não se parecem com "template genérico"
- Paleta e tipografia refletem o domínio do negócio
- Primeiro viewport demonstra o mecanismo, não apenas mood
- Materiais autorais presentes (não lorem/placeholder)

---

## 9. REFERÊNCIAS

- Repositório Impeccable: https://github.com/pbakaus/impeccable
- DESIGN.md (Neo Kinpaku): Sistema de design completo
- skill/reference/: 50 arquivos de referência (audit, critique, polish, etc.)
- WCAG 2.1 AA: https://www.w3.org/WAI/WCAG21/quickref/
- Vite docs: https://vitejs.dev/guide/
- React 19: https://react.dev/blog/2024/04/25/react-19-upgrade-guide

---

**Próximos passos imediatos:**
1. Aprovar estratégia de integração
2. Criar branch `feat/impeccable-quality`
3. Implementar Fase 1 (Foundation) com TDD
4. Review após cada fase antes de seguir

**Não fazer sem aprovação explícita:**
- Instalar Impeccable CLI ou engine Rust
- Aplicar migrations em DB remoto
- Executar análise em sites de produção existentes
- Commitar código antes de review completo
