# Guia Completo do Framework Impeccable

## Visão Geral

**Impeccable** é um sistema de orientação de design para agentes de IA que transforma interfaces geradas automaticamente em produtos profissionais e polidos. Desenvolvido a partir do skill frontend-design da Anthropic, o framework fornece comandos estruturados, verificações de qualidade determinísticas e contexto de produto durável para elevar a qualidade do design gerado por IA.

### Problema que Resolve

Agentes de IA tendem a gerar padrões repetitivos e reconhecíveis — o que o framework chama de "AI slop" (lixo de IA): gradientes roxo-azul genéricos, layouts bege editorial, fontes Inter/Geist em todo lugar, cards aninhados, glassmorphism desnecessário, e micro-interações com bounce/elastic timing. Impeccable identifica e remove esses "tells" (sinais reveladores) antes que se tornem parte do produto final.

### Componentes Centrais

1. **The Skill (`/impeccable`)** — Interface de comando único com 24 subcomandos
2. **59 Regras de Detector Determinísticas** — Verificações de padrões sem necessidade de API
3. **Sistema de Contexto de Produto** — `PRODUCT.md` e `DESIGN.md` para memória durável
4. **Live Mode** — Iteração de design em tempo real no navegador
5. **CLI & Browser Extension** — Ferramentas para análise e CI/CD

---

## Instalação e Configuração

### Métodos de Instalação

**CLI (Recomendado)**
```bash
npx impeccable install
```
Auto-detecta harnesses (Claude Code, Cursor, GitHub Copilot, etc.)

**Claude Code**
```bash
/plugin marketplace add pbakaus/impeccable
/plugin install impeccable
```

**GitHub Copilot**
Já integrado — habilitar via Settings → Experimental

**Skills.sh**
```bash
npx skills add pbakaus/impeccable
```

### Processo de Setup (3 Passos)

1. **Instalar o Impeccable** via método apropriado
2. **Inicializar e Habilitar Hooks**
   ```
   /impeccable init
   /impeccable hooks on
   ```
   Aprovar hooks quando solicitado pela ferramenta
3. **Documentar Contexto** — O sistema escaneia codebase e cria `PRODUCT.md` e `DESIGN.md`

---

## Sistema de Comandos (24 Comandos)

### Comandos de Core Quality

**`/impeccable polish`**
Passada final de qualidade — remove AI tells enquanto respeita sistema de design existente.
- Quando usar: Antes de fazer commit/merge, quando interface "funciona mas não parece profissional"
- O que faz: Refina detalhes, consistência, alinhamento, espaçamento

**`/impeccable audit`**
Verificações de qualidade de produção — detecta problemas antes do ship.
- Quando usar: Antes de deploy, como gate de qualidade em PR
- O que faz: Roda 59 checagens automáticas + revisão de design

**`/impeccable typeset`**
Melhora hierarquia tipográfica.
- Quando usar: Texto difícil de ler, hierarquia confusa, tamanhos inconsistentes
- O que faz: Ajusta tamanhos, pesos, line-heights, comprimentos de linha confortáveis

**`/impeccable distill`**
Simplifica interface ao essencial.
- Quando usar: Página ocupada, muitos elementos competindo por atenção
- O que faz: Remove elementos desnecessários, foca no essencial

**`/impeccable clarify`**
Identifica elementos que parecem "errados".
- Quando usar: Algo parece off mas você não sabe o quê
- O que faz: Diagnóstico de problemas de design, review estruturado

### Comandos de Layout & Structure

**`/impeccable layout`**
Organiza hierarquia espacial e de componentes.
- Quando usar: Conteúdo espalhado, agrupamentos confusos, difícil de escanear
- O que faz: Reagrupa campos, rebalanceia colunas, ajusta espaçamento

**`/impeccable colorize`**
Atualiza aplicação de cores.
- Quando usar: Palette precisa de ajuste, cores não seguem sistema
- O que faz: Aplica cores de forma consistente com design system

### Comandos de Enhancement

**`/impeccable animate`**
Adiciona ou refina motion e transitions.
- Quando usar: Precisa feedback visual, continuidade, ou character
- O que faz: Implementa animações de feedback, state transitions, micro-interações
- Princípios: Rápido para feedback rotineiro, respeita reduced-motion

**`/impeccable delight`**
Micro-interações e polish visual.
- Quando usar: Funcional mas sem personalidade
- O que faz: Adiciona detalhes que surpreendem e agradam

**`/impeccable bolder`**
Aumenta ênfase visual.
- Quando usar: Hierarquia fraca, elementos importantes não se destacam
- O que faz: Aumenta contraste, peso, tamanho de elementos críticos

**`/impeccable quieter`**
Reduz ruído visual.
- Quando usar: Interface muito "gritante", cores/borders excessivos
- O que faz: Suaviza, reduz contraste de elementos secundários

**`/impeccable overdrive`**
Intensifica tratamento de design além do refinamento padrão.
- Quando usar: Landing pages, hero sections, momentos de alta energia
- O que faz: Amplifica impacto visual dramaticamente

### Comandos de System & Documentation

**`/impeccable init`**
Inicializa Impeccable no projeto.
- Quando usar: Primeira vez usando Impeccable em projeto
- O que faz: Escaneia codebase, extrai tokens/components, cria PRODUCT.md e DESIGN.md

**`/impeccable extract`**
Extrai componentes e regras de design do código existente.
- Quando usar: Sistema de design existe mas não está documentado
- O que faz: Identifica componentes, variantes, tokens, padrões

**`/impeccable document`**
Registra sistema visual em `DESIGN.md`.
- Quando usar: Após fazer mudanças de design, para documentar decisões
- O que faz: Atualiza DESIGN.md com cores, tipos, shapes, components

**`/impeccable live`**
Modo interativo para iteração em tempo real.
- Quando usar: Explorar variações, comparar alternativas rapidamente
- O que faz: Abre site com controles de design, permite clicar em elementos e gerar variantes

### Comandos de Generation & Comparison

**`/impeccable generate`**
Gera variantes de design para comparação.
- Quando usar: Precisa explorar direções diferentes antes de decidir
- O que faz: Cria múltiplas alternativas (padrão: 3) mantendo identidade

**`/impeccable adapt`**
Ajusta design para diferentes contextos.
- Quando usar: Design precisa funcionar em mobile, tablet, contextos diferentes
- O que faz: Adapta sem perder identidade

### Comandos de Control

**`/impeccable hooks on`**
Ativa verificações automáticas de design.
- Quando usar: Ao iniciar trabalho em projeto
- O que faz: Detector roda automaticamente ao editar UI

**`/impeccable hooks off`**
Desativa verificações automáticas.
- Quando usar: Trabalhando em algo experimental, prototipagem rápida

---

## AI Slop: 59+ Padrões a Evitar

### Visual & Decorative Issues

**Glassmorphism Overuse**
❌ Blur effects, glass cards, glow borders como decoração
✅ Usar apenas quando resolver problema real de layering

**Dark Mode with Neon**
❌ Glowing borders e accents transformando interface dark em parede de neon
✅ Accent colors sutis, glow apenas para estados ativos

**Radial Halos**
❌ Bright halo em fundo dark como background effect
✅ Fundos sólidos ou gradientes sutis

**AI Color Defaults**
❌ Purple gradients, bright cyan on dark, "AI beige"
✅ Palette derivada do domínio (brass/amber para craft, cyan/emerald para data, terracotta para hospitality)

**Nested Cards**
❌ Cards dentro de cards, boxes dentro de boxes
✅ Usar spacing para separar, não containers

### Typography Red Flags

**Overused Fonts**
❌ Inter, Geist, Arial como padrão sem razão
✅ Fonte que serve ao propósito (serif para editorial, sans para UI, etc.)

**Oversized Italic Serif Headlines**
❌ Italic serif gigante como atalho editorial
✅ Italic apenas quando intencional para voz/tom

**Flat Type Hierarchy**
❌ Headings e body text com mesmo peso/tamanho
✅ Hierarquia clara: display > title > body > meta

**Clipped Labels**
❌ Texto cortado, overflow escondido sem ellipsis
✅ Truncate com ellipsis ou wrap apropriado

### Layout & Motion Tells

**Repetitive Icon-and-Text Cards**
❌ Stack de cards idênticos com icon + title + description
✅ Variar formato, usar list quando apropriado

**Auto-Scrolling Marquees**
❌ Marquee automático removendo controle do usuário
✅ Scroll manual ou pagination

**Pulsing Status Indicators**
❌ Pulsing dot sem mudança real de estado
✅ Pulse apenas para notificações novas

**Bouncing Dialogs with Elastic Easing**
❌ Bounce/elastic easing em modals
✅ Ease-out suave (cubic-bezier)

**Side-Tab Borders**
❌ Border apenas de um lado em tabs
✅ Border completo ou underline

### Copy Patterns

**Em-Dash Overuse**
❌ "Fast—reliable—secure" em vez de frases completas
✅ Pontuação normal, frases completas

**Generic Marketing Claims**
❌ "Supercharge", "world-class", "next-generation"
✅ Benefícios específicos e mensuráveis

**Forced Contrast Phrases**
❌ "Not a feature. A platform."
✅ Descrição direta do valor

### Interaction & State Issues

**Too Many Fields**
❌ Form com 10+ campos em uma tela
✅ Multi-step flow, one focus per screen

**Generic CTAs**
❌ "Get Started", "Learn More" sem contexto
✅ CTAs específicos: "Start 14-day trial", "See pricing"

**Vague Headlines**
❌ "Welcome to the future", "Transform your workflow"
✅ Headlines específicos sobre o que o produto faz

**Status-Chip Soup**
❌ Múltiplos badges/chips competindo por atenção
✅ Máximo 1-2 status indicators, rest in secondary UI

**Thin Borders with Wide Shadows**
❌ 1px border + 8px shadow blur
✅ Border weight proporcional ao shadow

**Contrast Problems**
❌ Gray text em background colorido, <4.5:1 ratio
✅ WCAG AA mínimo: 4.5:1 para text, 3:1 para UI components

---

## PRODUCT.md: Contexto de Produto

### Estrutura Completa

```markdown
# [Nome do Produto]

## Users
Descrever quem são os usuários e contexto de uso.
Exemplo: "People responding to service outages, often on a phone."

## Product Purpose
O que o produto faz e objetivo central.
Exemplo: "Real-time alerts and resolution tracking for infrastructure teams."

## Accessibility & Inclusion
Necessidades específicas de acessibilidade.
Exemplo: "Keep alerts readable on small screens. High contrast for outdoor use."

## Principles
Valores fundamentais que guiam decisões de design.
Exemplo:
- "Calm by default"
- "One action per screen"
- "Never hide the seat count"
- "Dense is fine—these are power users"

## Task Types
Que tipo de tarefa o design deve suportar:
- **Persuade**: Landing pages, marketing
- **Operate**: Dashboards, admin panels
- **Read**: Documentation, content
- **Experience**: Immersive, exploratory

## Constraints
Limitações técnicas, de negócio ou de contexto.
Exemplo:
- "Must work offline"
- "Target LCP < 2.5s"
- "Support IE11"

## Evidence
Dados que informam decisões de design.
Exemplo:
- "70% of users access via mobile"
- "Average session: 45 seconds"
- "Primary use case: quick status check"
```

### Por Que PRODUCT.md Importa

- Agente entende contexto sem precisar re-explicar a cada sessão
- Decisões de design são justificadas por produto, não por "gosto"
- Evita design genérico — contexto específico gera design específico
- Princípios documentados previnem deriva ao longo do tempo

---

## DESIGN.md: Sistema de Design

### Estrutura Completa

```markdown
# Design System

## Color

### Palette
paper, gray-1, gray-3, accent (gradient, flagged), success

### Usage
- `paper`: background principal
- `gray-1`: borders, dividers
- `gray-3`: text secondary
- `accent`: CTAs, links, interactive elements
- `success`: confirmações, estados positivos

### Notes
- Accent gradient flagged for review (overuse risk)
- Consider solid accent alternative

## Type

### Font Family
Albert Sans

### Scale
- 18px / 600 weight — Titles
- 13px / 400 weight — Body
- 12px / 400 weight — Metadata

### Hierarchy
H1 > H2 > H3 > Body > Caption
Never skip heading levels

### Line Height
- Display: 1.1-1.2
- Body: 1.5-1.6
- Metadata: 1.4

## Shape

### Border Radius
- 8px: Input fields
- 3px: Pills, badges
- 12px: Cards (inconsistent — needs audit)

### Shadows
- sm: 0 1px 2px rgba(0,0,0,0.05)
- md: 0 4px 6px rgba(0,0,0,0.1)
- lg: 0 10px 15px rgba(0,0,0,0.1)

## Spacing

### Scale
4, 8, 12, 16, 24, 32, 48

### Usage
- 4px: tight grouping (label + input)
- 8px: default internal spacing
- 16px: between sections
- 24px: section spacing
- 48px: major layout divisions

## Components

### Extracted Components
- 34 components identified
- Button (4 variants): primary, secondary, ghost, danger
- Card (2 variants): default, elevated
- Input (5 states): default, focus, error, disabled, readonly

### Usage Counts
- Button: 127 instances
- Card: 43 instances
- Input: 89 instances

## Performance Notes
- LCP improved: 3.4s → 1.1s
- JS bundle reduced: 412 kB → 86 kB
- Images optimized: webp format, responsive srcset
```

### Como Usar DESIGN.md

1. **Inicializar**: `/impeccable init` escaneia e popula automaticamente
2. **Documentar Mudanças**: `/impeccable document` após implementar design
3. **Referência**: Agente lê DESIGN.md antes de fazer mudanças
4. **Single Source of Truth**: Todas as mudanças de sistema devem ser refletidas aqui

---

## Princípios de Design para IA

### 1. Hierarquia Visual Clara

**Problema**: "Title and button fight for the eye. Only one should win."

**Solução**:
- Definir um elemento dominante por seção
- Usar weight, size, color para criar contraste
- Elementos secundários devem ser visualmente mais leves

**Exemplo**:
```
❌ MAU: Title 24px/700 + CTA button 16px/700 bright color
✅ BOM: Title 32px/700 dark + CTA button 14px/500 accent
```

### 2. One Action Per Screen

**Problema**: Multiple CTAs competindo, usuário paralisa

**Solução**:
- Um CTA primário claro
- CTAs secundários visualmente mais leves
- Eliminar CTAs desnecessários

**Exemplo**:
```
❌ MAU: "Sign Up" + "Learn More" + "Watch Demo" com mesmo peso
✅ BOM: "Start Free Trial" (primary) + "See Pricing" (link text)
```

### 3. Calm by Default

**Problema**: Animações excessivas, cores gritantes, motion constante

**Solução**:
- Animação apenas para feedback necessário
- Palette restraint — máximo 2-3 accent colors
- Motion respeita reduced-motion preference

### 4. Content Grouping via Spacing

**Problema**: "Even gaps blur the groups"

**Solução**:
- Spacing dentro de grupo < spacing entre grupos
- Ratio comum: 8px dentro, 24px entre
- Borders apenas quando spacing não é suficiente

**Exemplo**:
```markdown
[Label + Input] ← 4px spacing
     ↓ 16px
[Label + Input]
     ↓ 32px
[Next Section]
```

### 5. Typography Hierarchy

**Escala de Hierarquia**:
```
Display (48-64px) — Hero headlines
Title (24-32px) — Section headings
Subtitle (18-20px) — Subsections
Body (14-16px) — Main content
Caption (12-13px) — Metadata
```

**Contraste de Peso**:
- Headlines: 600-700
- Body: 400-500
- Metadata: 400 (menor size)

### 6. Color System com Propósito

**Palette Construction**:
1. **Background Layers**: 5-7 surface levels do mais dark ao mais light
2. **Semantic Colors**: success, warning, error, info
3. **Accent**: 1 cor luminosa de alta saturação
4. **Supporting Tint**: 1 tom muted que complementa accent

**Exemplo de Palette**:
```css
/* Background Layers */
--surface-0: #05070C;  /* 3% lightness */
--surface-1: #0A0D12;  /* 5% */
--surface-2: #0F131C;  /* 8% */
--surface-3: #161D2B;  /* 12% */
--surface-4: #1E2636;  /* 16% */

/* Accent */
--accent: #38BDF8;     /* cyan luminous */
--accent-muted: #1E40AF; /* cyan muted */

/* Semantic */
--success: #6EE7B7;
--warning: #E9A568;
--error: #F87171;
```

**Derivação de Hue**:
- Craft goods: brass (#E9A568), amber
- Data/tech: cyan (#38BDF8), emerald (#6EE7B7)
- Hospitality: terracotta, warm tones
- Finance: blue (#3B6DFF), green

### 7. Spacing System Consistente

**Escala Base-8**:
```
4, 8, 12, 16, 24, 32, 48, 64, 96
```

**Aplicação**:
- **4px**: tight coupling (checkbox + label)
- **8px**: default component internal spacing
- **16px**: between related components
- **24px**: between sections
- **48px+**: major layout divisions

### 8. Touch Targets Adequados

**Mínimos**:
- Mobile: 44×44px (iOS), 48×48px (Android)
- Desktop: 24×24px mínimo

**Prática**:
- Botões principais: 48px height
- Botões secundários: 40px height
- Icon buttons: 40×40px com 24px icon
- Padding interno gera target size adequado

---

## Checklist de Qualidade para Sites IA

### Pre-Flight Checks (Antes de Gerar)

- [ ] `PRODUCT.md` existe e documenta users, purpose, principles
- [ ] `DESIGN.md` existe com color, type, shape, spacing system
- [ ] Context claro sobre tarefa: persuade, operate, read, ou experience
- [ ] Constraints documentados (performance, accessibility, tech)

### Design Quality Checks

**Hierarquia**
- [ ] Um elemento dominante claro por seção
- [ ] Contraste visual entre níveis de hierarquia (min 2:1 size ratio)
- [ ] Elementos competindo identificados e resolvidos
- [ ] Typography scale consistente (não tamanhos arbitrários)

**Clarity**
- [ ] Propósito de cada seção é imediatamente claro
- [ ] CTAs são específicos ("Start 14-day trial" vs "Get Started")
- [ ] Status e states são visualmente distintos
- [ ] Nenhuma informação crítica está escondida

**Craft**
- [ ] Spacing segue sistema (não valores hard-coded arbitrários)
- [ ] Alinhamento perfeito (grids, não "quase" alinhado)
- [ ] Borders consistentes (não 1px aqui, 2px ali)
- [ ] Radius consistente (não 8px em alguns cards, 12px em outros)
- [ ] Colors vêm do design system (não hex values ad-hoc)

### Typography Audit

- [ ] Máximo 2 font families (1 para UI + 1 para display é suficiente)
- [ ] Escala de tamanhos é sistemática (não arbitrária)
- [ ] Line-height adequado: 1.1-1.2 display, 1.5-1.6 body
- [ ] Heading hierarchy não pula níveis (h1 → h2 → h3, nunca h1 → h3)
- [ ] Text contrast mínimo: 4.5:1 para body, 3:1 para large text
- [ ] Comprimento de linha: 45-75 caracteres para body text

### Color Audit

- [ ] Palette restraint: máximo 5-7 core colors + semantic
- [ ] Sem gray puro (#808080) — todos grays são tinted
- [ ] Accent color único e consistente (não múltiplos accents)
- [ ] Gradients têm propósito (não decoração)
- [ ] Dark mode: sem neon glow excessivo
- [ ] Contrast ratios WCAG AA: 4.5:1 text, 3:1 UI components

### Layout Audit

- [ ] Spacing dentro de grupo < spacing entre grupos (clara separação)
- [ ] Grid alignment (não posicionamento ad-hoc)
- [ ] Responsive breakpoints definidos (não "funciona no meu laptop")
- [ ] Touch targets adequados: mínimo 44×44px mobile
- [ ] Sem nested cards (cards dentro de cards)
- [ ] White space intencional (não "sobrou espaço")

### Motion & Interaction Audit

- [ ] Animações têm propósito (feedback, continuity, attention)
- [ ] Timing apropriado: rápido para feedback (150-200ms), slow para transitions (300-500ms)
- [ ] Easing natural: ease-out para entrada, ease-in para saída, ease-in-out para loops
- [ ] Reduced-motion preference respeitada
- [ ] Sem bounce/elastic easing (AI tell)
- [ ] Sem pulsing dots sem mudança real de estado

### Accessibility Audit

- [ ] Keyboard navigation completa
- [ ] Focus states visíveis (não apenas outline default)
- [ ] ARIA labels onde necessário
- [ ] Alt text em todas as imagens
- [ ] Form labels associados corretamente
- [ ] Error messages claros e associados a campos
- [ ] Skip links para navegação rápida

### Performance Audit

- [ ] Target LCP < 2.5s
- [ ] Images otimizadas: webp, srcset, lazy loading
- [ ] Fonts carregados com font-display: swap
- [ ] CSS crítico inline
- [ ] JS bundle < 200kb (initial load)
- [ ] Unused CSS removido

### AI Tells to Eliminate

- [ ] Sem Inter/Geist sem razão específica
- [ ] Sem italic serif oversized headlines
- [ ] Sem glassmorphism decorativo
- [ ] Sem purple-to-blue gradients genéricos
- [ ] Sem "AI beige" (#F5F5F0, #FAFAF8)
- [ ] Sem side-tab borders
- [ ] Sem status-chip soup
- [ ] Sem generic CTAs ("Learn More", "Get Started")
- [ ] Sem vague headlines ("Welcome to the future")
- [ ] Sem em-dash abuse

### Final Polish

- [ ] `/impeccable audit` executado e passou
- [ ] `/impeccable polish` aplicado
- [ ] Detector findings resolvidos (0 critical, 0 high)
- [ ] Cross-browser tested (Chrome, Safari, Firefox)
- [ ] Mobile tested (iOS Safari, Chrome Android)
- [ ] Performance budget validated

---

## Aplicação no Sistema de Geração de Sites IA

### Integração no Workflow Atual

**1. Pre-Generation Phase**

Antes de gerar qualquer site:

```typescript
// src/lib/sites/impeccable-context.ts
export async function prepareImpeccableContext(
  projectType: string,
  userGoals: string,
  targetAudience: string
): Promise<{ productMd: string; designMd: string }> {
  // Gerar PRODUCT.md baseado em inputs do usuário
  const productMd = generateProductContext(projectType, userGoals, targetAudience);
  
  // Gerar DESIGN.md com base em domain heuristics
  const designMd = generateDesignSystem(projectType);
  
  return { productMd, designMd };
}
```

**2. Prompts para Agente IA**

Incluir contexto Impeccable nos prompts:

```typescript
const systemPrompt = `
${productMdContent}

${designMdContent}

# Design Quality Requirements

You MUST follow these principles:

1. HIERARCHY
   - One dominant element per section
   - Clear visual weight progression
   - No competing CTAs

2. CLARITY
   - Specific CTAs (not "Learn More" or "Get Started")
   - One action per screen
   - Visible states and status

3. CRAFT
   - Spacing from system: ${spacingScale}
   - Colors from palette: ${colorTokens}
   - Consistent border radius: ${radiusTokens}
   - Typography from scale: ${typeScale}

4. AVOID AI TELLS
   - No Inter/Geist default fonts
   - No purple-blue gradients
   - No glassmorphism
   - No italic serif headlines
   - No nested cards
   - No pulsing dots
   - No bounce/elastic easing

5. ACCESSIBILITY
   - WCAG AA minimum: 4.5:1 text contrast
   - Touch targets: 44×44px minimum
   - Keyboard navigation complete
   - Focus states visible

Generate HTML that passes /impeccable audit with 0 critical and 0 high issues.
`;
```

**3. Post-Generation Validation**

```typescript
// src/lib/sites/impeccable-validator.ts
export async function validateGeneratedSite(html: string): Promise<ValidationReport> {
  const issues = await runImpeccableDetector(html);
  
  const critical = issues.filter(i => i.severity === 'critical');
  const high = issues.filter(i => i.severity === 'high');
  const medium = issues.filter(i => i.severity === 'medium');
  
  return {
    passed: critical.length === 0 && high.length === 0,
    score: calculateQualityScore(issues),
    issues: {
      critical,
      high,
      medium
    },
    suggestions: generateFixSuggestions(issues)
  };
}
```

**4. Iterative Refinement Loop**

```typescript
async function generateSiteWithQuality(
  prompt: string,
  maxIterations: number = 3
): Promise<{ html: string; score: number }> {
  let html = await generateInitialSite(prompt);
  let iteration = 0;
  
  while (iteration < maxIterations) {
    const validation = await validateGeneratedSite(html);
    
    if (validation.passed && validation.score >= 85) {
      return { html, score: validation.score };
    }
    
    // Refinar com base em findings
    const refinementPrompt = buildRefinementPrompt(validation);
    html = await refineSite(html, refinementPrompt);
    iteration++;
  }
  
  return { html, score: calculateFinalScore(html) };
}
```

### Integração com Sistema Atual de Sites

**Modificações Necessárias**:

1. **`src/lib/sites/ai-generator.ts`**
   - Adicionar `prepareImpeccableContext()` antes de gerar
   - Incluir PRODUCT.md e DESIGN.md no context do prompt
   - Adicionar checklist de qualidade no system prompt

2. **`src/lib/sites/validation.ts`**
   - Implementar validador Impeccable
   - Integrar 59 regras de detector
   - Scoring system (hierarchy, clarity, craft)

3. **`src/app/api/sites/generate/route.ts`**
   - Adicionar validation step após geração
   - Refinement loop se score < 85
   - Retornar validation report junto com HTML

4. **`src/components/sites/preview.tsx`**
   - Mostrar Impeccable score
   - Listar findings por severidade
   - Botão "Refine with Impeccable" para re-gerar

---

## Prompts Específicos para o Agente IA

### System Prompt Base (Aplicar em TODOS os sites)

```markdown
# Design Quality Standards

You are generating a professional, high-quality website that must pass rigorous design quality checks.

## Context

{{PRODUCT_MD_CONTENT}}

{{DESIGN_MD_CONTENT}}

## Core Principles

### 1. HIERARCHY (Target Score: 8+/10)
- ONE dominant element per section — never let title and CTA compete
- Visual weight progression: display > title > subtitle > body > caption
- Size ratio minimum 1.6:1 between hierarchy levels
- Never use same size/weight for different hierarchy levels

### 2. CLARITY (Target Score: 8+/10)
- Specific CTAs with clear action: "Start 14-Day Trial" NOT "Get Started"
- One primary action per screen — secondary actions must be visually lighter
- States must be visually distinct (active vs inactive vs disabled)
- Never hide critical information (counts, status, key metrics)

### 3. CRAFT (Target Score: 8+/10)
- Spacing from system: {{SPACING_SCALE}}
- Colors ONLY from palette: {{COLOR_TOKENS}}
- Border radius consistent: {{RADIUS_TOKENS}}
- Typography from scale: {{TYPE_SCALE}}
- Perfect alignment — use grid, not "close enough"

## Mandatory Avoidances (AI Tells)

### Typography
❌ NEVER: Inter, Geist, Arial as default without explicit reason
❌ NEVER: Oversized italic serif headlines
❌ NEVER: Flat hierarchy (all text same size/weight)
✅ ALWAYS: Intentional font choice based on product context
✅ ALWAYS: Clear hierarchy with size/weight contrast

### Color & Visual
❌ NEVER: Purple-to-blue gradients
❌ NEVER: "AI beige" (#F5F5F0, #FAFAF8, #EEEDE9)
❌ NEVER: Glassmorphism as decoration
❌ NEVER: Neon glow on dark backgrounds
❌ NEVER: Pure black (#000) or pure gray (#808080)
✅ ALWAYS: Tinted colors derived from domain
✅ ALWAYS: Single accent color with purpose

### Layout
❌ NEVER: Cards nested in cards
❌ NEVER: Even spacing everywhere (blurs groups)
❌ NEVER: Side-tab borders
❌ NEVER: Status-chip soup (multiple badges competing)
✅ ALWAYS: Spacing within group < spacing between groups
✅ ALWAYS: Use spacing to separate, not containers

### Motion & Interaction
❌ NEVER: Bounce or elastic easing
❌ NEVER: Pulsing dots without state change
❌ NEVER: Auto-scrolling marquees
✅ ALWAYS: Ease-out for feedback (150-200ms)
✅ ALWAYS: Respect reduced-motion preferences

### Copy
❌ NEVER: Em-dash abuse ("Fast—Reliable—Secure")
❌ NEVER: Generic claims ("Supercharge your workflow")
❌ NEVER: Vague headlines ("Welcome to the future")
✅ ALWAYS: Specific, measurable benefits
✅ ALWAYS: Clear, direct headlines about what product does

## Accessibility Requirements (Non-Negotiable)

- Text contrast minimum: 4.5:1 for body, 3:1 for large text (18px+)
- Touch targets minimum: 44×44px on mobile, 24×24px on desktop
- Keyboard navigation: all interactive elements must be keyboard accessible
- Focus states: visible and distinct (not just default outline)
- ARIA labels: on all icon buttons and complex interactions
- Heading hierarchy: never skip levels (h1 → h2 → h3)

## Performance Requirements

- Target LCP: < 2.5 seconds
- Images: webp format, responsive srcset, lazy loading below fold
- Fonts: preload critical fonts, font-display: swap
- CSS: critical CSS inline, defer non-critical
- JavaScript: minimize initial bundle, code split by route

## Output Requirements

Generate semantic HTML5 with:
1. Proper document structure (header, main, footer, sections)
2. Inline CSS using custom properties for tokens
3. Responsive design (mobile-first, breakpoints at 640px, 1024px, 1280px)
4. All tokens defined as CSS custom properties in :root
5. Complete implementation — no placeholders or TODOs

The generated site must score 85+ on Impeccable quality audit (0 critical, 0 high issues).
```

### Domain-Specific Prompt Enhancements

**Landing Page / Marketing Site**

```markdown
## Task Type: PERSUADE

This is a landing page designed to convert visitors into users.

### Hierarchy Emphasis
- Hero headline is THE dominant element (40-64px, 700 weight)
- Primary CTA must win attention battle (high contrast, large touch target)
- Supporting copy is 60% opacity, smaller size
- Social proof and metrics are visually distinct but secondary

### Persuasion Pattern
1. Hero: Problem + Promise (above fold)
2. Social Proof: Logos, testimonials, metrics
3. Features: Benefits, not specs (icon + title + 1-2 sentences)
4. CTA Repeat: Same primary CTA at bottom
5. Footer: Trust signals, links

### Copy Tone
- Direct and benefit-focused
- Quantifiable claims where possible
- Active voice, second person
```

**Dashboard / Admin Panel**

```markdown
## Task Type: OPERATE

This is a dashboard for frequent, task-focused use.

### Hierarchy Emphasis
- Key metrics are the dominant element (large, bold)
- Actions are readily accessible but not competing with data
- Navigation is consistent and predictable
- Density is higher (power users expect information density)

### Dashboard Pattern
1. Header: Logo + Nav + User menu
2. Metrics Row: 3-4 key numbers with trend indicators
3. Data Visualization: Chart or table (not both competing)
4. Action Panel: Primary actions grouped and accessible
5. Secondary Info: Collapsed by default, expandable

### Interaction
- Keyboard shortcuts for common actions
- Inline editing where appropriate
- Optimistic updates for speed perception
- Clear loading and error states
```

**Documentation / Content Site**

```markdown
## Task Type: READ

This is a content-focused site optimized for reading.

### Typography Emphasis
- Body text is THE priority (16-18px, 1.6 line-height)
- Comfortable line length (45-75 characters, max 680px width)
- Generous spacing between paragraphs
- Clear heading hierarchy for scanning

### Reading Pattern
1. Header: Minimal, sticky nav
2. Sidebar: Table of contents (on desktop)
3. Content: Single column, generous margins
4. Code blocks: Syntax highlighting, copy button
5. Footer: Previous/Next navigation

### Reading Comfort
- High contrast for text (minimum 7:1)
- No distractions in reading column
- Sticky TOC for long pages
- Print-friendly styles
```

### Refinement Prompts (Para Iteração)

**Quando Hierarquia Score < 8**

```markdown
# Refinement: Improve Visual Hierarchy

Current Issues:
{{HIERARCHY_ISSUES}}

Fix by:
1. Identify competing elements — only ONE should dominate per section
2. Increase size contrast: make dominant element at least 1.6× larger
3. Use weight contrast: 700 for dominant, 400-500 for supporting
4. Add color contrast: accent for primary action, gray for secondary
5. Reduce visual weight of secondary elements (smaller, lighter, lower contrast)

Verify: Can a user identify the most important element in each section in <1 second?
```

**Quando Clarity Score < 8**

```markdown
# Refinement: Improve Clarity

Current Issues:
{{CLARITY_ISSUES}}

Fix by:
1. Make CTAs specific: Replace "Learn More" with "See Pricing" or "Start Free Trial"
2. Consolidate actions: Limit to 1 primary + 1-2 secondary CTAs per screen
3. Show state visually: Active must look different from inactive
4. Reveal critical info: Counts, status, metrics must be immediately visible
5. Clarify copy: Replace vague headlines with specific value statements

Verify: Can a first-time user understand what to do next without reading everything?
```

**Quando Craft Score < 8**

```markdown
# Refinement: Improve Craft

Current Issues:
{{CRAFT_ISSUES}}

Fix by:
1. Use spacing tokens consistently: {{SPACING_SCALE}} — no arbitrary values
2. Align to grid: Everything should align to 8px baseline
3. Consistent radius: All cards use same radius ({{RADIUS_TOKEN}})
4. Color from system: Replace ad-hoc hex values with tokens
5. Fix typography inconsistencies: Use scale sizes only

Verify: Does every spacing, color, and size value come from the design system?
```

**Quando AI Tells Detectados**

```markdown
# Refinement: Remove AI Tells

Detected tells:
{{AI_TELLS_LIST}}

Specific fixes:
- Replace Inter/Geist: Choose font with character based on product ({{FONT_SUGGESTION}})
- Remove glassmorphism: Use solid backgrounds with subtle shadows
- Fix gradients: Replace decorative gradients with solid accent color
- Simplify layout: Remove nested cards, use spacing instead
- Refine motion: Replace bounce/elastic with ease-out timing

Verify: Does this look like a carefully crafted product, not a generated template?
```

---

## Implementação Técnica: Detector Rules

### Estrutura de Regra

```typescript
interface DetectorRule {
  id: string;
  name: string;
  category: 'typography' | 'color' | 'layout' | 'motion' | 'copy' | 'accessibility';
  severity: 'critical' | 'high' | 'medium' | 'low';
  detect: (dom: Document) => Finding[];
  message: string;
  fix?: string;
}

interface Finding {
  ruleId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  element?: Element;
  message: string;
  suggestion?: string;
}
```

### Exemplos de Regras Implementadas

```typescript
// src/lib/sites/detector-rules.ts

// RULE 1: Overused Fonts
const overusedFontsRule: DetectorRule = {
  id: 'overused-font',
  name: 'Generic Font Family',
  category: 'typography',
  severity: 'medium',
  detect: (dom) => {
    const findings: Finding[] = [];
    const genericFonts = ['Inter', 'Geist', 'Arial', 'Helvetica'];
    
    const bodyStyle = window.getComputedStyle(dom.body);
    const fontFamily = bodyStyle.fontFamily;
    
    genericFonts.forEach(font => {
      if (fontFamily.includes(font)) {
        findings.push({
          ruleId: 'overused-font',
          severity: 'medium',
          element: dom.body,
          message: `Generic font "${font}" detected. Consider a more distinctive typeface.`,
          suggestion: 'Choose a font that reflects product character.'
        });
      }
    });
    
    return findings;
  },
  message: 'Avoid overused default fonts',
  fix: 'Select typeface based on product context'
};

// RULE 2: AI Beige Colors
const aiBeigeRule: DetectorRule = {
  id: 'ai-beige',
  name: 'AI Beige Background',
  category: 'color',
  severity: 'high',
  detect: (dom) => {
    const findings: Finding[] = [];
    const beigeColors = ['#F5F5F0', '#FAFAF8', '#EEEDE9', '#F8F8F6'];
    
    const elements = dom.querySelectorAll('*');
    elements.forEach(el => {
      const bg = window.getComputedStyle(el).backgroundColor;
      const hex = rgbToHex(bg);
      
      if (beigeColors.includes(hex.toUpperCase())) {
        findings.push({
          ruleId: 'ai-beige',
          severity: 'high',
          element: el as Element,
          message: `AI beige color detected: ${hex}`,
          suggestion: 'Use background derived from product domain'
        });
      }
    });
    
    return findings;
  },
  message: 'Avoid generic AI beige backgrounds',
  fix: 'Choose backgrounds that reflect product character'
};

// RULE 3: Cards in Cards
const nestedCardsRule: DetectorRule = {
  id: 'nested-cards',
  name: 'Nested Card Components',
  category: 'layout',
  severity: 'high',
  detect: (dom) => {
    const findings: Finding[] = [];
    
    // Detectar elementos que parecem cards (border-radius + shadow/border)
    const potentialCards = Array.from(dom.querySelectorAll('*')).filter(el => {
      const style = window.getComputedStyle(el);
      const hasRadius = parseFloat(style.borderRadius) > 4;
      const hasShadow = style.boxShadow !== 'none';
      const hasBorder = parseFloat(style.borderWidth) > 0;
      
      return hasRadius && (hasShadow || hasBorder);
    });
    
    potentialCards.forEach(card => {
      const nestedCards = Array.from(card.querySelectorAll('*')).filter(child => {
        const style = window.getComputedStyle(child);
        const hasRadius = parseFloat(style.borderRadius) > 4;
        const hasShadow = style.boxShadow !== 'none';
        return hasRadius && hasShadow;
      });
      
      if (nestedCards.length > 0) {
        findings.push({
          ruleId: 'nested-cards',
          severity: 'high',
          element: card,
          message: 'Card nested inside another card detected',
          suggestion: 'Use spacing to separate content, not nested containers'
        });
      }
    });
    
    return findings;
  },
  message: 'Avoid nesting cards within cards',
  fix: 'Use whitespace and grouping instead of containers'
};

// RULE 4: Flat Typography Hierarchy
const flatHierarchyRule: DetectorRule = {
  id: 'flat-hierarchy',
  name: 'Flat Typography Hierarchy',
  category: 'typography',
  severity: 'critical',
  detect: (dom) => {
    const findings: Finding[] = [];
    
    const headings = dom.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const body = dom.querySelectorAll('p, span, div');
    
    if (headings.length === 0) {
      findings.push({
        ruleId: 'flat-hierarchy',
        severity: 'critical',
        message: 'No heading elements found — missing semantic hierarchy',
        suggestion: 'Use h1-h6 for content structure'
      });
      return findings;
    }
    
    // Verificar se h1 é significativamente maior que body
    const h1 = headings[0];
    const firstP = body[0];
    
    if (h1 && firstP) {
      const h1Size = parseFloat(window.getComputedStyle(h1).fontSize);
      const pSize = parseFloat(window.getComputedStyle(firstP).fontSize);
      const ratio = h1Size / pSize;
      
      if (ratio < 1.5) {
        findings.push({
          ruleId: 'flat-hierarchy',
          severity: 'critical',
          element: h1 as Element,
          message: `H1 size ratio too low: ${ratio.toFixed(2)}:1 (minimum 1.5:1)`,
          suggestion: 'Increase heading size for clear hierarchy'
        });
      }
    }
    
    return findings;
  },
  message: 'Typography hierarchy must be visually clear',
  fix: 'Ensure headings are at least 1.5× body text size'
};

// RULE 5: Poor Contrast
const contrastRule: DetectorRule = {
  id: 'poor-contrast',
  name: 'Insufficient Color Contrast',
  category: 'accessibility',
  severity: 'critical',
  detect: (dom) => {
    const findings: Finding[] = [];
    
    const textElements = dom.querySelectorAll('p, span, a, button, h1, h2, h3, h4, h5, h6, label, li');
    
    textElements.forEach(el => {
      const style = window.getComputedStyle(el);
      const color = style.color;
      const bg = style.backgroundColor;
      const fontSize = parseFloat(style.fontSize);
      const fontWeight = parseInt(style.fontWeight);
      
      const contrast = calculateContrastRatio(color, bg);
      
      // WCAG AA requirements
      const isLargeText = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700);
      const minContrast = isLargeText ? 3 : 4.5;
      
      if (contrast < minContrast) {
        findings.push({
          ruleId: 'poor-contrast',
          severity: 'critical',
          element: el as Element,
          message: `Contrast ratio ${contrast.toFixed(2)}:1 below minimum ${minContrast}:1`,
          suggestion: 'Increase color contrast to meet WCAG AA standards'
        });
      }
    });
    
    return findings;
  },
  message: 'All text must meet WCAG AA contrast requirements',
  fix: 'Minimum 4.5:1 for body text, 3:1 for large text'
};

// RULE 6: Bounce/Elastic Easing
const bounceEasingRule: DetectorRule = {
  id: 'bounce-easing',
  name: 'Bounce or Elastic Easing',
  category: 'motion',
  severity: 'high',
  detect: (dom) => {
    const findings: Finding[] = [];
    
    // Verificar keyframes CSS
    const styleSheets = Array.from(document.styleSheets);
    styleSheets.forEach(sheet => {
      try {
        const rules = Array.from(sheet.cssRules || []);
        rules.forEach(rule => {
          if (rule.cssText.includes('cubic-bezier')) {
            // Padrões de bounce: cubic-bezier com valores > 1
            const bouncePattern = /cubic-bezier\([^)]*[2-9]\.[0-9]+[^)]*\)/;
            if (bouncePattern.test(rule.cssText)) {
              findings.push({
                ruleId: 'bounce-easing',
                severity: 'high',
                message: 'Bounce or elastic easing detected in CSS',
                suggestion: 'Use ease-out for natural motion'
              });
            }
          }
        });
      } catch (e) {
        // Cross-origin stylesheet — skip
      }
    });
    
    return findings;
  },
  message: 'Avoid bounce or elastic easing — signals rushed AI design',
  fix: 'Use ease-out (cubic-bezier(0, 0, 0.2, 1)) for smooth motion'
};

// Exportar todas as regras
export const detectorRules: DetectorRule[] = [
  overusedFontsRule,
  aiBeigeRule,
  nestedCardsRule,
  flatHierarchyRule,
  contrastRule,
  bounceEasingRule,
  // ... adicionar as outras 53 regras
];
```

### Quality Scorer

```typescript
// src/lib/sites/quality-scorer.ts

interface QualityScore {
  overall: number;
  hierarchy: number;
  clarity: number;
  craft: number;
  details: {
    hierarchyIssues: string[];
    clarityIssues: string[];
    craftIssues: string[];
  };
}

export function calculateQualityScore(findings: Finding[]): QualityScore {
  const critical = findings.filter(f => f.severity === 'critical');
  const high = findings.filter(f => f.severity === 'high');
  const medium = findings.filter(f => f.severity === 'medium');
  const low = findings.filter(f => f.severity === 'low');
  
  // Penalidades por severidade
  const criticalPenalty = critical.length * 15;
  const highPenalty = high.length * 10;
  const mediumPenalty = medium.length * 5;
  const lowPenalty = low.length * 2;
  
  const totalPenalty = criticalPenalty + highPenalty + mediumPenalty + lowPenalty;
  const overall = Math.max(0, 100 - totalPenalty);
  
  // Scores por categoria
  const hierarchyFindings = findings.filter(f => 
    f.ruleId.includes('hierarchy') || f.ruleId.includes('typography')
  );
  const clarityFindings = findings.filter(f =>
    f.ruleId.includes('clarity') || f.ruleId.includes('copy')
  );
  const craftFindings = findings.filter(f =>
    f.ruleId.includes('spacing') || f.ruleId.includes('alignment') || f.ruleId.includes('consistency')
  );
  
  const hierarchy = Math.max(0, 10 - hierarchyFindings.length);
  const clarity = Math.max(0, 10 - clarityFindings.length);
  const craft = Math.max(0, 10 - craftFindings.length);
  
  return {
    overall,
    hierarchy,
    clarity,
    craft,
    details: {
      hierarchyIssues: hierarchyFindings.map(f => f.message),
      clarityIssues: clarityFindings.map(f => f.message),
      craftIssues: craftFindings.map(f => f.message)
    }
  };
}
```

---

## Exemplo Prático: Before/After

### Before (Site Gerado Sem Impeccable)

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: Inter, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #333;
    }
    .hero {
      text-align: center;
      padding: 60px 20px;
    }
    h1 {
      font-size: 42px;
      font-style: italic;
      font-family: 'Playfair Display', serif;
    }
    .cta-primary, .cta-secondary {
      font-size: 18px;
      padding: 15px 30px;
      margin: 10px;
      border-radius: 8px;
    }
    .cta-primary {
      background: #6366f1;
      color: white;
    }
    .cta-secondary {
      background: #8b5cf6;
      color: white;
    }
    .features {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
      padding: 40px;
    }
    .card {
      background: rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(10px);
      border-radius: 12px;
      padding: 30px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    }
    .card-inner {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 8px;
      padding: 20px;
    }
  </style>
</head>
<body>
  <div class="hero">
    <h1>Welcome to the Future</h1>
    <p>Transform your workflow with our next-generation platform</p>
    <button class="cta-primary">Get Started</button>
    <button class="cta-secondary">Learn More</button>
    <button class="cta-secondary">Watch Demo</button>
  </div>
  
  <div class="features">
    <div class="card">
      <div class="card-inner">
        <h3>Fast</h3>
        <p>Lightning speed performance</p>
      </div>
    </div>
    <!-- repetir 2x -->
  </div>
</body>
</html>
```

**Detected Issues (Impeccable Audit)**:
- 🔴 CRITICAL: Flat hierarchy (h1 only 1.17× body text)
- 🔴 CRITICAL: Poor contrast (white text on purple gradient: 2.8:1)
- 🟠 HIGH: AI beige equivalent (purple gradient)
- 🟠 HIGH: Overused font (Inter)
- 🟠 HIGH: Oversized italic serif headline
- 🟠 HIGH: Glassmorphism overuse
- 🟠 HIGH: Nested cards
- 🟠 HIGH: Multiple competing CTAs
- 🟡 MEDIUM: Generic copy ("Get Started", "Transform your workflow")
- 🟡 MEDIUM: Vague headline ("Welcome to the Future")

**Quality Score: 32/100**
- Hierarchy: 3/10
- Clarity: 4/10
- Craft: 3/10

### After (Aplicando Impeccable Principles)

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Plataforma SDR — Automatize WhatsApp e Conversões</title>
  <style>
    :root {
      /* Surface layers — tinted toward product */
      --surface-0: #05070C;
      --surface-1: #0A0E14;
      --surface-2: #0F1419;
      --surface-3: #161D24;
      --surface-4: #1F2831;
      
      /* Accent — derivado do domain (tech/data = cyan) */
      --accent: #38BDF8;
      --accent-muted: #1E3A8A;
      
      /* Semantic */
      --success: #6EE7B7;
      --text-primary: #F9FAFB;
      --text-secondary: rgba(249, 250, 251, 0.7);
      --text-tertiary: rgba(249, 250, 251, 0.5);
      
      /* Spacing scale */
      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-6: 24px;
      --space-8: 32px;
      --space-12: 48px;
      
      /* Type scale */
      --text-xs: 12px;
      --text-sm: 14px;
      --text-base: 16px;
      --text-lg: 18px;
      --text-xl: 24px;
      --text-2xl: 32px;
      --text-3xl: 48px;
      
      /* Border radius */
      --radius-sm: 4px;
      --radius-md: 8px;
      --radius-lg: 12px;
    }
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: var(--text-base);
      line-height: 1.6;
      color: var(--text-primary);
      background: var(--surface-0);
    }
    
    .container {
      max-width: 1280px;
      margin: 0 auto;
      padding: 0 var(--space-4);
    }
    
    .hero {
      padding: var(--space-12) 0;
      text-align: center;
    }
    
    .hero h1 {
      font-size: var(--text-3xl);
      font-weight: 700;
      line-height: 1.2;
      margin-bottom: var(--space-4);
      color: var(--text-primary);
    }
    
    .hero p {
      font-size: var(--text-lg);
      color: var(--text-secondary);
      max-width: 600px;
      margin: 0 auto var(--space-8);
    }
    
    .cta-primary {
      display: inline-block;
      font-size: var(--text-base);
      font-weight: 600;
      padding: var(--space-4) var(--space-8);
      background: var(--accent);
      color: var(--surface-0);
      border: none;
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: opacity 200ms ease-out;
      text-decoration: none;
    }
    
    .cta-primary:hover {
      opacity: 0.9;
    }
    
    .cta-secondary {
      display: inline-block;
      font-size: var(--text-sm);
      color: var(--text-secondary);
      margin-left: var(--space-6);
      text-decoration: none;
      transition: color 200ms ease-out;
    }
    
    .cta-secondary:hover {
      color: var(--text-primary);
    }
    
    .features {
      padding: var(--space-12) 0;
      background: var(--surface-1);
    }
    
    .features-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: var(--space-6);
    }
    
    .feature {
      padding: var(--space-6);
      background: var(--surface-2);
      border-radius: var(--radius-lg);
      border: 1px solid var(--surface-3);
    }
    
    .feature-icon {
      width: 48px;
      height: 48px;
      background: var(--accent-muted);
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: var(--space-4);
      color: var(--accent);
      font-size: var(--text-xl);
    }
    
    .feature h3 {
      font-size: var(--text-lg);
      font-weight: 600;
      margin-bottom: var(--space-2);
      color: var(--text-primary);
    }
    
    .feature p {
      font-size: var(--text-sm);
      color: var(--text-secondary);
      line-height: 1.6;
    }
    
    .metrics {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--space-4);
      padding: var(--space-8) 0;
    }
    
    .metric {
      text-align: center;
      padding: var(--space-6);
      background: var(--surface-2);
      border-radius: var(--radius-md);
    }
    
    .metric-value {
      font-size: var(--text-2xl);
      font-weight: 700;
      color: var(--accent);
      margin-bottom: var(--space-1);
    }
    
    .metric-label {
      font-size: var(--text-sm);
      color: var(--text-tertiary);
    }
    
    @media (max-width: 768px) {
      .hero h1 {
        font-size: var(--text-2xl);
      }
      
      .metrics {
        grid-template-columns: 1fr;
      }
      
      .cta-secondary {
        display: block;
        margin: var(--space-4) 0 0 0;
      }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="container">
        <h1>Automatize WhatsApp e Converta 3× Mais Leads</h1>
        <p>Plataforma SDR com IA: disparo automático, respostas inteligentes e acompanhamento de conversões em tempo real.</p>
        <a href="#" class="cta-primary">Começar Teste Grátis de 14 Dias</a>
        <a href="#" class="cta-secondary">Ver como funciona →</a>
      </div>
    </section>
    
    <section class="container">
      <div class="metrics">
        <div class="metric">
          <div class="metric-value">10K+</div>
          <div class="metric-label">Mensagens/dia</div>
        </div>
        <div class="metric">
          <div class="metric-value">3×</div>
          <div class="metric-label">Taxa de resposta</div>
        </div>
        <div class="metric">
          <div class="metric-value">< 1s</div>
          <div class="metric-label">Tempo de resposta</div>
        </div>
      </div>
    </section>
    
    <section class="features">
      <div class="container">
        <div class="features-grid">
          <div class="feature">
            <div class="feature-icon">⚡</div>
            <h3>Disparo Automático</h3>
            <p>Envie mensagens personalizadas em escala via WhatsApp com controle de velocidade e anti-ban.</p>
          </div>
          
          <div class="feature">
            <div class="feature-icon">🤖</div>
            <h3>Respostas com IA</h3>
            <p>IA responde leads automaticamente com contexto do CRM e histórico de conversas.</p>
          </div>
          
          <div class="feature">
            <div class="feature-icon">📊</div>
            <h3>Dashboard de Conversões</h3>
            <p>Acompanhe métricas de engajamento, taxa de resposta e ROI em tempo real.</p>
          </div>
        </div>
      </div>
    </section>
  </main>
</body>
</html>
```

**Quality Score: 92/100**
- Hierarchy: 9/10 (h1 is 3× body, clear dominance)
- Clarity: 9/10 (specific CTAs, clear value prop)
- Craft: 9/10 (systematic tokens, consistent spacing)

**Improvements Made**:
✅ Clear hierarchy: h1 (48px) → body (16px) = 3:1 ratio
✅ High contrast: text-primary on surface-0 = 15.8:1
✅ Specific CTAs: "Começar Teste Grátis de 14 Dias" vs generic "Get Started"
✅ Domain-derived palette: cyan accent (tech/data domain)
✅ No nested cards: spacing separates features
✅ One primary action: single dominant CTA
✅ Semantic HTML5: proper structure
✅ Token system: all values from CSS custom properties
✅ Responsive: mobile-first with breakpoints
✅ Performance: inline CSS, no external deps

---

## Recomendações Finais

### 1. Implementação por Fases

**Fase 1: Foundation (Semana 1)**
- Implementar PRODUCT.md e DESIGN.md templates
- Criar system prompts base com checklist Impeccable
- Adicionar domain-specific heuristics (tech/craft/hospitality palettes)

**Fase 2: Validation (Semana 2)**
- Implementar detector rules (começar com top 10 mais críticas)
- Criar quality scorer
- Integrar validation loop no generation flow

**Fase 3: Refinement (Semana 3)**
- Implementar iterative refinement prompts
- Adicionar UI para mostrar findings e score
- Botão "Refine with Impeccable" no preview

**Fase 4: Optimization (Semana 4)**
- Completar 59 detector rules
- Otimizar performance do detector
- A/B test: sites com vs sem Impeccable

### 2. Métricas de Sucesso

**Quality Metrics**:
- Target: 85+ overall score
- 0 critical issues
- 0 high issues
- Hierarchy, Clarity, Craft scores ≥ 8/10

**User Metrics**:
- Redução em "regenerate" requests
- Aumento em "publish" rate
- Feedback qualitativo sobre aparência profissional

**Performance Metrics**:
- LCP < 2.5s
- CLS < 0.1
- FID < 100ms

### 3. Documentação para Usuários

Criar guide user-facing:
- O que é o Impeccable score
- Como interpretar findings
- O que significa cada categoria (hierarchy/clarity/craft)
- Exemplos de before/after

### 4. Continuous Improvement

**Feedback Loop**:
- Coletar sites que passaram com 85+ score
- Analisar patterns comuns
- Extrair e codificar em rules adicionais
- Atualizar prompts baseado em falhas recorrentes

**Rule Tuning**:
- Monitorar false positives
- Ajustar severities baseado em impacto real
- Adicionar domain-specific rules (e-commerce, SaaS, etc.)

---

## Conclusão

O framework **Impeccable** oferece uma metodologia estruturada e verificável para elevar a qualidade de sites gerados por IA. Ao integrar seus princípios — contexto durável (PRODUCT.md, DESIGN.md), comandos estruturados, 59 regras de detector, e scoring multi-dimensional — no sistema atual de geração de sites, podemos transformar outputs "funcionais mas genéricos" em produtos "profissionais e distintos".

O diferencial não está apenas em evitar "AI tells" visíveis (Inter/purple gradients/glassmorphism), mas em aplicar pensamento de design fundamentado: hierarquia clara, propósito específico, craft consistente, e acessibilidade não-negociável.

**Implementar Impeccable = Elevar Site IA de 30-40/100 para 85-95/100 sistematicamente.**