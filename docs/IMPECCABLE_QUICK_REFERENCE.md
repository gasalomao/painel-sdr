# Impeccable Quick Reference

## 🎯 Resumo Executivo

**O que é**: Framework de qualidade de design para IA
**Objetivo**: Eliminar "AI slop" e criar sites profissionais
**Target Score**: 85+/100 (0 critical, 0 high issues)

## 🚫 Top 10 AI Tells para EVITAR

1. **Inter/Geist/Arial** sem razão específica → Escolher fonte com caráter
2. **Purple-blue gradients** → Palette derivada do domínio
3. **"AI beige" (#F5F5F0, #FAFAF8)** → Backgrounds com propósito
4. **Glassmorphism decorativo** → Sólido com shadows sutis
5. **Nested cards** → Spacing para separar
6. **Italic serif oversized** → Serif apenas intencional
7. **Bounce/elastic easing** → Ease-out (cubic-bezier(0,0,0.2,1))
8. **Multiple CTAs competing** → Um CTA primário dominante
9. **Generic copy** ("Get Started") → Específico ("Start 14-Day Trial")
10. **Vague headlines** ("Welcome to Future") → Específico sobre valor

## ✅ Golden Rules

### Hierarquia (8+/10)
- **ONE** elemento dominante por seção
- H1 mínimo **1.6×** body text
- Primary CTA deve "vencer" batalha de atenção
- Weight contrast: 700 dominant, 400-500 supporting

### Clarity (8+/10)
- CTAs específicos com ação clara
- One primary action per screen
- States visualmente distintos
- Critical info sempre visível

### Craft (8+/10)
- Spacing from system (4, 8, 12, 16, 24, 32, 48)
- Colors from palette (não hex ad-hoc)
- Consistent radius (8px fields, 12px cards)
- Perfect alignment (grid, não "quase")

### Accessibility (Non-Negotiable)
- Text contrast: **4.5:1** body, **3:1** large
- Touch targets: **44×44px** mobile, **24×24px** desktop
- Keyboard navigation complete
- Focus states visible

## 🎨 Design System Template

### Colors
```css
:root {
  /* Surface layers (5-7 levels, tinted) */
  --surface-0: #05070C;  /* 3-6% lightness */
  --surface-1: #0A0E14;
  --surface-2: #0F1419;
  --surface-3: #161D24;
  --surface-4: #1F2831;
  
  /* Accent (ONE luminous, high saturation) */
  --accent: #38BDF8;      /* cyan for tech/data */
  --accent-muted: #1E3A8A;
  
  /* Semantic */
  --success: #6EE7B7;
  --warning: #E9A568;
  --error: #F87171;
  
  /* Text */
  --text-primary: #F9FAFB;
  --text-secondary: rgba(249,250,251,0.7);
  --text-tertiary: rgba(249,250,251,0.5);
}
```

### Typography Scale
```css
:root {
  --text-xs: 12px;    /* Metadata */
  --text-sm: 14px;    /* Secondary */
  --text-base: 16px;  /* Body */
  --text-lg: 18px;    /* Subtitle */
  --text-xl: 24px;    /* Title */
  --text-2xl: 32px;   /* Section heading */
  --text-3xl: 48px;   /* Hero headline */
}
```

### Spacing Scale (Base-8)
```css
:root {
  --space-1: 4px;   /* Tight coupling */
  --space-2: 8px;   /* Component internal */
  --space-3: 12px;
  --space-4: 16px;  /* Between related */
  --space-6: 24px;  /* Between sections */
  --space-8: 32px;
  --space-12: 48px; /* Major divisions */
}
```

### Border Radius
```css
:root {
  --radius-sm: 4px;   /* Badges */
  --radius-md: 8px;   /* Inputs, buttons */
  --radius-lg: 12px;  /* Cards */
  --radius-full: 9999px; /* Pills */
}
```

## 📋 Pre-Flight Checklist

Antes de gerar site:

- [ ] PRODUCT.md criado (users, purpose, principles)
- [ ] DESIGN.md template preparado (color, type, spacing)
- [ ] Task type definido (persuade/operate/read/experience)
- [ ] Domain-specific palette escolhida

## 🔍 Quality Audit Checklist

### Critical (Must Fix)
- [ ] H1 é 1.6×+ body text
- [ ] Text contrast ≥ 4.5:1
- [ ] No heading hierarchy skips
- [ ] Touch targets ≥ 44×44px mobile
- [ ] No critical accessibility failures

### High Priority (Should Fix)
- [ ] Removed overused fonts
- [ ] Eliminated AI beige/gradients
- [ ] No nested cards
- [ ] One primary CTA per screen
- [ ] Specific CTAs (não generic)

### Medium Priority (Consider)
- [ ] Spacing from system
- [ ] Colors from palette
- [ ] Consistent radius
- [ ] Motion with purpose
- [ ] Copy specific (não vague)

## 🎭 Task-Specific Patterns

### Landing Page (PERSUADE)
```
Hero: Problem + Promise (above fold)
  ├─ Headline: 48-64px, 700 weight, DOMINANT
  ├─ Subheadline: 18-20px, 400 weight, 60% opacity
  └─ CTA: High contrast, large touch target

Social Proof: Logos, metrics, testimonials
Features: Icon + Title + 1-2 sentences
CTA Repeat: Same primary CTA at bottom
Footer: Trust signals
```

### Dashboard (OPERATE)
```
Header: Logo + Nav + User
Metrics Row: 3-4 key numbers with trend
Data Viz: Chart OR table (not both)
Action Panel: Grouped, accessible
Dense is OK: Power users expect density
```

### Documentation (READ)
```
Body text: 16-18px, 1.6 line-height
Line length: 45-75 chars (max 680px)
Sidebar: TOC on desktop
Generous spacing: paragraph separation
High contrast: 7:1+ for reading comfort
```

## 🛠️ Detector Rules (Top 20)

1. **overused-font** — Inter/Geist/Arial without reason
2. **ai-beige** — #F5F5F0, #FAFAF8, #EEEDE9
3. **purple-gradient** — Purple-to-blue gradients
4. **nested-cards** — Cards inside cards
5. **flat-hierarchy** — H1 < 1.5× body text
6. **poor-contrast** — Text < 4.5:1 ratio
7. **bounce-easing** — cubic-bezier with >1 values
8. **glassmorphism** — backdrop-filter without purpose
9. **italic-serif-oversized** — Italic serif > 36px
10. **multiple-ctas** — 3+ CTAs with same weight
11. **generic-cta** — "Learn More", "Get Started"
12. **vague-headline** — "Welcome to Future", "Transform Workflow"
13. **status-chip-soup** — 4+ badges competing
14. **side-tab-border** — Border only on one side
15. **pulsing-without-state** — Pulse animation without real state change
16. **thin-border-wide-shadow** — 1px border + 8px+ shadow
17. **even-spacing-everywhere** — Same gap between all elements
18. **skip-heading-level** — h1 → h3 (missing h2)
19. **small-touch-target** — Interactive < 44×44px mobile
20. **no-focus-state** — Missing :focus styles

## 📊 Scoring System

### Overall Score Calculation
```
Base: 100
- Critical issues: -15 each
- High issues: -10 each
- Medium issues: -5 each
- Low issues: -2 each

Target: 85+ (publish threshold)
```

### Category Scores (out of 10)
```
Hierarchy:
  10: Perfect visual weight progression
  8: Clear dominant element, minor issues
  6: Some competing elements
  4: Flat hierarchy
  2: No clear structure
  
Clarity:
  10: Specific CTAs, clear purpose
  8: Mostly clear, some generic copy
  6: Multiple generic CTAs
  4: Vague headlines, unclear actions
  2: Confusing purpose
  
Craft:
  10: Systematic tokens, perfect alignment
  8: Mostly consistent, minor drift
  6: Some ad-hoc values
  4: Inconsistent spacing/colors
  2: No system evident
```

## 🔧 Quick Fixes

### Low Hierarchy Score
```diff
- h1 { font-size: 24px; } /* 1.5× body */
+ h1 { font-size: 48px; font-weight: 700; } /* 3× body */

- Button with same size as title
+ Title 32px/700, Button 16px/600
```

### Low Clarity Score
```diff
- <button>Learn More</button>
+ <button>Start 14-Day Free Trial</button>

- Multiple CTAs with same weight
+ One primary (high contrast) + secondary (text link)
```

### Low Craft Score
```diff
- margin: 15px; /* arbitrary */
+ margin: var(--space-4); /* 16px from system */

- color: #3B82F6; /* ad-hoc */
+ color: var(--accent); /* from palette */
```

## 🚀 Integration Points

### 1. System Prompt
```markdown
Include PRODUCT.md + DESIGN.md context
Add Impeccable checklist
Set quality target: 85+ score
```

### 2. Generation Loop
```typescript
generate() → validate() → score < 85?
  → refine(findings) → validate() → repeat
```

### 3. UI Display
```typescript
Show score: 92/100 ⭐
List findings by severity
"Refine" button if score < 85
```

## 📚 Resources

- **Full Guide**: `/docs/IMPECCABLE_FRAMEWORK_GUIDE.md`
- **Repository**: https://github.com/pbakaus/impeccable
- **Website**: https://impeccable.style
- **CLI**: `npx impeccable detect src/`

## 💡 Remember

> "Only one should win" — One dominant element per section
> "Calm by default" — Motion and color with purpose
> "Systematic > Arbitrary" — Every value from design system
> "Specific > Generic" — CTAs and headlines state value clearly

**Target: Transform AI sites from 30-40/100 → 85-95/100 systematically.**
