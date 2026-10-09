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
    html = await refineS