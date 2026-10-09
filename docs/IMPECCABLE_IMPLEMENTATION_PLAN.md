# Impeccable Implementation Plan

## Objetivo

Integrar princípios do framework Impeccable no sistema de geração de sites IA do painel-sdr para elevar qualidade de 30-40/100 → 85-95/100 sistematicamente.

---

## Fase 1: Foundation (Semana 1) — SETUP CRÍTICO

### 1.1 Criar Templates de Contexto

**Arquivo**: `src/lib/sites/context-templates.ts`

```typescript
export interface ProductContext {
  users: string;
  purpose: string;
  accessibility: string[];
  principles: string[];
  taskType: 'persuade' | 'operate' | 'read' | 'experience';
  constraints: string[];
  evidence?: string[];
}

export interface DesignSystem {
  colors: {
    surfaces: string[];
    accent: string;
    accentMuted: string;
    semantic: Record<string, string>;
  };
  typography: {
    fontFamily: string;
    scale: Record<string, string>;
    weights: Record<string, number>;
  };
  spacing: number[];
  radius: Record<string, string>;
}

export function generateProductContext(
  projectType: string,
  businessGoal: string,
  targetAudience: string
): ProductContext {
  // Heurísticas baseadas em project type
  const taskTypeMap: Record<string, ProductContext['taskType']> = {
    'landing-page': 'persuade',
    'saas-app': 'operate',
    'blog': 'read',
    'portfolio': 'experience',
    'ecommerce': 'persuade',
  };

  return {
    users: targetAudience || 'Usuários acessando via desktop e mobile',
    purpose: businessGoal || 'Converter visitantes em clientes',
    accessibility: [
      'Manter legibilidade em telas pequenas',
      'Alto contraste para uso outdoor',
      'Navegação por teclado completa',
    ],
    principles: [
      'Calm by default — sem animações desnecessárias',
      'One action per screen — foco em conversão',
      'Específico > Generic — CTAs claros',
      'Systematic > Arbitrary — valores do design system',
    ],
    taskType: taskTypeMap[projectType] || 'persuade',
    constraints: [
      'Target LCP < 2.5s',
      'Mobile-first design',
      'WCAG AA mínimo',
    ],
  };
}

export function generateDesignSystem(domain: string): DesignSystem {
  // Palette derivada do domínio
  const domainPalettes: Record<string, { accent: string; muted: string }> = {
    tech: { accent: '#38BDF8', muted: '#1E3A8A' }, // cyan
    data: { accent: '#6EE7B7', muted: '#065F46' }, // emerald
    craft: { accent: '#E9A568', muted: '#92400E' }, // amber
    hospitality: { accent: '#F87171', muted: '#991B1B' }, // terracotta
    finance: { accent: '#3B6DFF', muted: '#1E3A8A' }, // blue
    health: { accent: '#6EE7B7', muted: '#047857' }, // green
    default: { accent: '#38BDF8', muted: '#1E3A8A' },
  };

  const palette = domainPalettes[domain] || domainPalettes.default;

  return {
    colors: {
      surfaces: ['#05070C', '#0A0E14', '#0F1419', '#161D24', '#1F2831'],
      accent: palette.accent,
      accentMuted: palette.muted,
      semantic: {
        success: '#6EE7B7',
        warning: '#E9A568',
        error: '#F87171',
      },
    },
    typography: {
      fontFamily: 'Inter',
      scale: {
        xs: '12px',
        sm: '14px',
        base: '16px',
        lg: '18px',
        xl: '24px',
        '2xl': '32px',
        '3xl': '48px',
      },
      weights: {
        normal: 400,
        medium: 500,
        semibold: 600,
        bold: 700,
      },
    },
    spacing: [4, 8, 12, 16, 24, 32, 48, 64],
    radius: {
      sm: '4px',
      md: '8px',
      lg: '12px',
      full: '9999px',
    },
  };
}
```

### 1.2 Atualizar System Prompt

**Arquivo**: `src/lib/sites/prompts/impeccable-system-prompt.ts`

```typescript
export function buildImpeccableSystemPrompt(
  context: ProductContext,
  designSystem: DesignSystem
): string {
  return `# Design Quality Standards — Impeccable Framework

You are generating a professional, high-quality website that must pass rigorous design quality checks.

## Product Context

### Users
${context.users}

### Purpose
${context.purpose}

### Task Type: ${context.taskType.toUpperCase()}
${getTaskTypeGuidance(context.taskType)}

### Accessibility Requirements
${context.accessibility.map(req => `- ${req}`).join('\n')}

### Principles
${context.principles.map(p => `- ${p}`).join('\n')}

## Design System

### Color Palette
\`\`\`css
:root {
  /* Surface layers */
  ${designSystem.colors.surfaces.map((s, i) => `--surface-${i}: ${s};`).join('\n  ')}
  
  /* Accent */
  --accent: ${designSystem.colors.accent};
  --accent-muted: ${designSystem.colors.accentMuted};
  
  /* Semantic */
  --success: ${designSystem.colors.semantic.success};
  --warning: ${designSystem.colors.semantic.warning};
  --error: ${designSystem.colors.semantic.error};
}
\`\`\`

### Typography Scale
\`\`\`css
${Object.entries(designSystem.typography.scale).map(([key, val]) => 
  `--text-${key}: ${val};`
).join('\n')}
\`\`\`

### Spacing Scale
\`\`\`css
${designSystem.spacing.map((s, i) => `--space-${i + 1}: ${s}px;`).join('\n')}
\`\`\`

## Quality Requirements (Target: 85+/100)

### 1. HIERARCHY (Must Score 8+/10)
- ONE dominant element per section — never let title and CTA compete
- H1 minimum 1.6× body text size (prefer 2-3× for landing pages)
- Primary CTA must win attention battle (high contrast, large)
- Weight contrast: 700 for dominant, 400-500 for supporting

### 2. CLARITY (Must Score 8+/10)
- Specific CTAs: "Começar Teste Grátis de 14 Dias" NOT "Começar Agora"
- One primary action per screen — secondary actions visually lighter
- States visually distinct (active vs inactive vs disabled)
- Never hide critical information (counts, status, metrics)

### 3. CRAFT (Must Score 8+/10)
- All spacing from system: ${designSystem.spacing.join(', ')}px
- All colors from palette (no ad-hoc hex values)
- Consistent border radius: ${Object.entries(designSystem.radius).map(([k, v]) => `${k}=${v}`).join(', ')}
- Perfect grid alignment — no "close enough"

## MANDATORY AVOIDANCES (AI Tells)

### Typography ❌
- NEVER use Inter/Geist/Arial as default without explicit brand reason
- NEVER use oversized italic serif headlines (AI editorial tell)
- NEVER flat hierarchy (all text same size/weight)

### Color & Visual ❌
- NEVER purple-to-blue gradients (AI default)
- NEVER "AI beige" (#F5F5F0, #FAFAF8, #EEEDE9)
- NEVER glassmorphism as decoration (backdrop-filter without purpose)
- NEVER neon glow on dark backgrounds
- NEVER pure black (#000) or pure gray (#808080) — always tinted

### Layout ❌
- NEVER cards nested in cards
- NEVER even spacing everywhere (blurs content groups)
- NEVER side-tab borders (border only on one side)
- NEVER status-chip soup (multiple badges competing)

### Motion & Interaction ❌
- NEVER bounce or elastic easing (cubic-bezier with values > 1)
- NEVER pulsing dots without real state change
- NEVER auto-scrolling marquees
- ALWAYS ease-out for feedback: cubic-bezier(0, 0, 0.2, 1), 150-200ms

### Copy ❌
- NEVER em-dash abuse ("Rápido—Confiável—Seguro")
- NEVER generic claims ("Turbine seu workflow", "Próxima geração")
- NEVER vague headlines ("Bem-vindo ao futuro")
- ALWAYS specific, measurable benefits

## Accessibility (Non-Negotiable)

- Text contrast minimum: 4.5:1 for body, 3:1 for large text (18px+)
- Touch targets minimum: 44×44px mobile, 24×24px desktop
- Keyboard navigation: all interactive elements accessible
- Focus states: visible and distinct (not just default outline)
- ARIA labels: on all icon buttons
- Heading hierarchy: never skip levels (h1 → h2 → h3)

## Output Requirements

Generate semantic HTML5 with:
1. Proper document structure (header, main, footer, sections)
2. Inline CSS using CSS custom properties for all tokens
3. Responsive design (mobile-first, breakpoints at 640px, 1024px)
4. All tokens defined in :root
5. Complete implementation — no placeholders or TODOs

The generated site MUST score 85+ on quality audit with 0 critical and 0 high issues.
`;
}

function getTaskTypeGuidance(taskType: ProductContext['taskType']): string {
  const guidance = {
    persuade: `Landing page optimized for conversion.
- Hero headline is THE dominant element (48-64px, 700 weight)
- Primary CTA must win attention (high contrast, large touch target)
- Social proof and metrics secondary but visible
- Clear value proposition above fold`,

    operate: `Dashboard for frequent, task-focused use.
- Key metrics are dominant (large, bold numbers)
- Actions accessible but not competing with data
- Dense is OK — power users expect information density
- Clear loading and error states`,

    read: `Content-focused site optimized for reading.
- Body text is priority (16-18px, 1.6 line-height)
- Comfortable line length (45-75 chars, max 680px)
- Generous paragraph spacing
- Clear heading hierarchy for scanning`,

    experience: `Immersive, exploratory interface.
- Visual hierarchy guides discovery
- Motion with purpose and character
- Generous white space
- Focus on visual impact and delight`,
  };

  return guidance[taskType];
}
```

### 1.3 Modificar Generator

**Arquivo**: `src/lib/sites/ai-generator.ts`

```typescript
// Adicionar ao topo
import { generateProductContext, generateDesignSystem } from './context-templates';
import { buildImpeccableSystemPrompt } from './prompts/impeccable-system-prompt';

// Modificar função de geração
export async function generateSiteWithImpeccable(
  userPrompt: string,
  options: {
    projectType: string;
    businessGoal: string;
    targetAudience: string;
    domain: string;
  }
): Promise<{ html: string; context: ProductContext; designSystem: DesignSystem }> {
  // 1. Preparar contexto
  const context = generateProductContext(
    options.projectType,
    options.businessGoal,
    options.targetAudience
  );
  
  const designSystem = generateDesignSystem(options.domain);
  
  // 2. Construir system prompt com Impeccable
  const systemPrompt = buildImpeccableSystemPrompt(context, designSystem);
  
  // 3. Gerar site
  const response = await generateWithAI({
    system: systemPrompt,
    user: userPrompt,
    temperature: 0.7,
  });
  
  return {
    html: response.content,
    context,
    designSystem,
  };
}
```

---

## Fase 2: Validation (Semana 2) — DETECTOR RULES

### 2.1 Implementar Top 10 Detector Rules

**Arquivo**: `src/lib/sites/detector/rules.ts`

```typescript
export interface DetectorRule {
  id: string;
  name: string;
  category: 'typography' | 'color' | 'layout' | 'motion' | 'copy' | 'accessibility';
  severity: 'critical' | 'high' | 'medium' | 'low';
  detect: (html: string) => Promise<Finding[]>;
  message: string;
  fix: string;
}

export interface Finding {
  ruleId: string;
  severity: DetectorRule['severity'];
  message: string;
  suggestion: string;
  element?: string;
}

// RULE 1: Flat Hierarchy (CRITICAL)
export const flatHierarchyRule: DetectorRule = {
  id: 'flat-hierarchy',
  name: 'Flat Typography Hierarchy',
  category: 'typography',
  severity: 'critical',
  detect: async (html) => {
    const findings: Finding[] = [];
    const $ = await parseHTML(html);
    
    const h1 = $('h1').first();
    const body = $('p, span').first();
    
    if (!h1.length) {
      findings.push({
        ruleId: 'flat-hierarchy',
        severity: 'critical',
        message: 'No h1 element found',
        suggestion: 'Add semantic h1 for main heading',
      });
      return findings;
    }
    
    if (!body.length) return findings;
    
    const h1Size = parseFontSize(h1.css('font-size'));
    const bodySize = parseFontSize(body.css('font-size'));
    const ratio = h1Size / bodySize;
    
    if (ratio < 1.6) {
      findings.push({
        ruleId: 'flat-hierarchy',
        severity: 'critical',
        message: `H1 size ratio too low: ${ratio.toFixed(2)}:1 (minimum 1.6:1)`,
        suggestion: `Increase h1 to at least ${(bodySize * 1.6).toFixed(0)}px`,
        element: 'h1',
      });
    }
    
    return findings;
  },
  message: 'Typography hierarchy must be visually clear',
  fix: 'H1 should be minimum 1.6× body text, prefer 2-3× for landing pages',
};

// RULE 2: Poor Contrast (CRITICAL)
export const contrastRule: DetectorRule = {
  id: 'poor-contrast',
  name: 'Insufficient Color Contrast',
  category: 'accessibility',
  severity: 'critical',
  detect: async (html) => {
    const findings: Finding[] = [];
    const $ = await parseHTML(html);
    
    const textElements = $('p, span, a, button, h1, h2, h3, h4, h5, h6, label, li');
    
    for (const el of textElements.toArray()) {
      const $el = $(el);
      const color = $el.css('color');
      const bg = $el.css('background-color') || $('body').css('background-color');
      const fontSize = parseFontSize($el.css('font-size'));
      const fontWeight = parseInt($el.css('font-weight') || '400');
      
      const contrast = calculateContrastRatio(color, bg);
      
      const isLargeText = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700);
      const minContrast = isLargeText ? 3 : 4.5;
      
      if (contrast < minContrast) {
        findings.push({
          ruleId: 'poor-contrast',
          severity: 'critical',
          message: `Contrast ${contrast.toFixed(2)}:1 below ${minContrast}:1 minimum`,
          suggestion: `Increase contrast between ${color} and ${bg}`,
          element: el.tagName.toLowerCase(),
        });
      }
    }
    
    return findings;
  },
  message: 'All text must meet WCAG AA contrast requirements',
  fix: 'Minimum 4.5:1 for body, 3:1 for large text (18px+ or 14px/700)',
};

// RULE 3: AI Beige (HIGH)
export const aiBeigeRule: DetectorRule = {
  id: 'ai-beige',
  name: 'AI Beige Background',
  category: 'color',
  severity: 'high',
  detect: async (html) => {
    const findings: Finding[] = [];
    const beigeColors = ['#F5F5F0', '#FAFAF8', '#EEEDE9', '#F8F8F6'];
    
    const $ = await parseHTML(html);
    const elements = $('*');
    
    for (const el of elements.toArray()) {
      const $el = $(el);
      const bg = $el.css('background-color');
      const hex = rgbToHex(bg);
      
      if (beigeColors.some(beige => 
        colorDistance(hex, beige) < 10
      )) {
        findings.push({
          ruleId: 'ai-beige',
          severity: 'high',
          message: `AI beige color detected: ${hex}`,
          suggestion: 'Use background derived from product domain',
          element: el.tagName.toLowerCase(),
        });
      }
    }
    
    return findings;
  },
  message: 'Avoid generic AI beige backgrounds',
  fix: 'Choose tinted backgrounds that reflect product character',
};

// RULE 4: Nested Cards (HIGH)
export const nestedCardsRule: DetectorRule = {
  id: 'nested-cards',
  name: 'Nested Card Components',
  category: 'layout',
  severity: 'high',
  detect: async (html) => {
    const findings: Finding[] = [];
    const $ = await parseHTML(html);
    
    // Detectar elementos que parecem cards
    const cards = $('*').filter((_, el) => {
      const $el = $(el);
      const radius = parseFloat($el.css('border-radius') || '0');
      const shadow = $el.css('box-shadow') !== 'none';
      const border = parseFloat($el.css('border-width') || '0') > 0;
      
      return radius > 4 && (shadow || border);
    });
    
    for (const card of cards.toArray()) {
      const $card = $(card);
      const nestedCards = $card.find('*').filter((_, child) => {
        const $child = $(child);
        const radius = parseFloat($child.css('border-radius') || '0');
        const shadow = $child.css('box-shadow') !== 'none';
        
        return radius > 4 && shadow;
      });
      
      if (nestedCards.length > 0) {
        findings.push({
          ruleId: 'nested-cards',
          severity: 'high',
          message: 'Card nested inside another card detected',
          suggestion: 'Use spacing to separate content, not nested containers',
          element: card.tagName.toLowerCase(),
        });
      }
    }
    
    return findings;
  },
  message: 'Avoid nesting cards within cards',
  fix: 'Use whitespace and grouping instead of containers',
};

// RULE 5: Overused Fonts (MEDIUM)
export const overusedFontsRule: DetectorRule = {
  id: 'overused-font',
  name: 'Generic Font Family',
  category: 'typography',
  severity: 'medium',
  detect: async (html) => {
    const findings: Finding[] = [];
    const genericFonts = ['Inter', 'Geist', 'Arial', 'Helvetica'];
    
    const $ = await parseHTML(html);
    const bodyFont = $('body').css('font-family');
    
    for (const font of genericFonts) {
      if (bodyFont?.includes(font)) {
        findings.push({
          ruleId: 'overused-font',
          severity: 'medium',
          message: `Generic font "${font}" detected`,
          suggestion: 'Choose a font that reflects product character',
          element: 'body',
        });
      }
    }
    
    return findings;
  },
  message: 'Avoid overused default fonts without reason',
  fix: 'Select typeface based on product context',
};

// Continuar com mais 5 rules...
// RULE 6: Bounce Easing
// RULE 7: Multiple CTAs
// RULE 8: Generic Copy
// RULE 9: Small Touch Targets
// RULE 10: Skip Heading Level

export const detectorRules: DetectorRule[] = [
  flatHierarchyRule,
  contrastRule,
  aiBeigeRule,
  nestedCardsRule,
  overusedFontsRule,
  // ... adicionar as outras 5
];
```

### 2.2 Quality Scorer

**Arquivo**: `src/lib/sites/detector/scorer.ts`

```typescript
export interface QualityScore {
  overall: number;
  hierarchy: number;
  clarity: number;
  craft: number;
  passed: boolean;
  findings: {
    critical: Finding[];
    high: Finding[];
    medium: Finding[];
    low: Finding[];
  };
}

export function calculateQualityScore(findings: Finding[]): QualityScore {
  const critical = findings.filter(f => f.severity === 'critical');
  const high = findings.filter(f => f.severity === 'high');
  const medium = findings.filter(f => f.severity === 'medium');
  const low = findings.filter(f => f.severity === 'low');
  
  // Penalidades
  const criticalPenalty = critical.length * 15;
  const highPenalty = high.length * 10;
  const mediumPenalty = medium.length * 5;
  const lowPenalty = low.length * 2;
  
  const totalPenalty = criticalPenalty + highPenalty + mediumPenalty + lowPenalty;
  const overall = Math.max(0, 100 - totalPenalty);
  
  // Categoria scores
  const hierarchyIssues = findings.filter(f =>
    f.ruleId.includes('hierarchy') || f.ruleId.includes('typography')
  );
  const clarityIssues = findings.filter(f =>
    f.ruleId.includes('clarity') || f.ruleId.includes('copy') || f.ruleId.includes('cta')
  );
  const craftIssues = findings.filter(f =>
    f.ruleId.includes('spacing') || f.ruleId.includes('color') || f.ruleId.includes('radius')
  );
  
  const hierarchy = Math.max(0, 10 - hierarchyIssues.length);
  const clarity = Math.max(0, 10 - clarityIssues.length);
  const craft = Math.max(0, 10 - craftIssues.length);
  
  return {
    overall,
    hierarchy,
    clarity,
    craft,
    passed: critical.length === 0 && high.length === 0 && overall >= 85,
    findings: { critical, high, medium, low },
  };
}
```

### 2.3 Validation Runner

**Arquivo**: `src/lib/sites/validator.ts`

```typescript
import { detectorRules } from './detector/rules';
import { calculateQualityScore, type QualityScore } from './detector/scorer';

export async function validateSite(html: string): Promise<QualityScore> {
  const allFindings: Finding[] = [];
  
  // Rodar todas as regras
  for (const rule of detectorRules) {
    try {
      const findings = await rule.detect(html);
      allFindings.push(...findings);
    } catch (error) {
      console.error(`Rule ${rule.id} failed:`, error);
    }
  }
  
  return calculateQualityScore(allFindings);
}
```

---

## Fase 3: Refinement Loop (Semana 3)

### 3.1 Refinement Prompt Builder

**Arquivo**: `src/lib/sites/prompts/refinement-prompts.ts`

```typescript
export function buildRefinementPrompt(
  score: QualityScore,
  html: string
): string {
  const sections: string[] = [];
  
  // Hierarchy issues
  if (score.hierarchy < 8) {
    sections.push(`## Fix Hierarchy Issues (Current: ${score.hierarchy}/10)

${score.findings.critical
  .filter(f => f.ruleId.includes('hierarchy'))
  .map(f => `- ${f.message}\n  Fix: ${f.suggestion}`)
  .join('\n')}

Actions:
1. Increase h1 to minimum 1.6× body text (prefer 2-3×)
2. Make primary CTA visually dominant (large, high contrast)
3. Reduce weight of secondary elements
4. Verify ONE element wins attention per section`);
  }
  
  // Clarity issues
  if (score.clarity < 8) {
    sections.push(`## Fix Clarity Issues (Current: ${score.clarity}/10)

${score.findings.high
  .filter(f => f.ruleId.includes('cta') || f.ruleId.includes('copy'))
  .map(f => `- ${f.message}\n  Fix: ${f.suggestion}`)
  .join('\n')}

Actions:
1. Replace generic CTAs with specific actions
2. Limit to ONE primary CTA per screen
3. Make secondary CTAs visually lighter
4. Clarify vague headlines with specific value`);
  }
  
  // Craft issues
  if (score.craft < 8) {
    sections.push(`## Fix Craft Issues (Current: ${score.craft}/10)

${score.findings.medium
  .filter(f => f.ruleId.includes('spacing') || f.ruleId.includes('color'))
  .map(f => `- ${f.message}\n  Fix: ${f.suggestion}`)
  .join('\n')}

Actions:
1. Replace arbitrary spacing with system values
2. Use colors only from design system palette
3. Ensure consistent border radius
4. Perfect grid alignment`);
  }
  
  return `# Refinement Required (Score: ${score.overall}/100)

Current Issues: ${score.findings.critical.length} critical, ${score.findings.high.length} high

${sections.join('\n\n')}

## Target
- Overall score: 85+ (current: ${score.overall})
- 0 critical issues (current: ${score.findings.critical.length})
- 0 high issues (current: ${score.findings.high.length})

Refine the HTML to fix these issues while maintaining existing structure and content.`;
}
```

### 3.2 Generation with Refinement Loop

**Arquivo**: `src/lib/sites/generator-with-refinement.ts`

```typescript
export async function generateSiteWithQuality(
  userPrompt: string,
  options: GenerationOptions,
  maxIterations: number = 3
): Promise<{
  html: string;
  score: QualityScore;
  iterations: number;
}> {
  // Gerar inicial
  let { html, context, designSystem } = await generateSiteWithImpeccable(
    userPrompt,
    options
  );
  
  let iteration = 0;
  let score = await validateSite(html);
  
  while (iteration < maxIterations && !score.passed) {
    console.log(`Iteration ${iteration + 1}: Score ${score.overall}/100`);
    
    // Build refinement prompt
    const refinementPrompt = buildRefinementPrompt(score, html);
    
    // Refinar
    const refined = await refineWithAI({
      system: buildImpeccableSystemPrompt(context, designSystem),
      user: refinementPrompt,
      html: html,
    });
    
    html = refined.content;
    score = await validateSite(html);
    iteration++;
    
    // Se passou, parar
    if (score.passed) break;
  }
  
  return { html, score, iterations: iteration };
}
```

---

## Fase 4: UI Integration (Semana 3-4)

### 4.1 Preview Component com Score

**Arquivo**: `src/components/sites/preview-with-quality.tsx`

```typescript
'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { QualityScore } from '@/lib/sites/detector/scorer';

interface Props {
  html: string;
  score: QualityScore;
  onRefine: () => Promise<void>;
}

export function PreviewWithQuality({ html, score, onRefine }: Props) {
  const [isRefining, setIsRefining] = useState(false);
  
  const scoreColor =
    score.overall >= 85 ? 'bg-green-500' :
    score.overall >= 70 ? 'bg-yellow-500' :
    'bg-red-500';
  
  return (
    <div className="space-y-4">
      {/* Score Card */}
      <div className="bg-surface-1 border border-surface-3 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold">Quality Score</h3>
            <p className="text-sm text-muted-foreground">
              Based on Impeccable Framework
            </p>
          </div>
          
          <div className="text-right">
            <div className="flex items-baseline gap-1">
              <span className="text-4xl font-bold">{score.overall}</span>
              <span className="text-xl text-muted-foreground">/100</span>
            </div>
            <div className={`h-2 w-24 rounded-full ${scoreColor} mt-2`}>
              <div 
                className="h-full bg-white/30 rounded-full"
                style={{ width: `${score.overall}%` }}
              />
            </div>
          </div>
        </div>
        
        {/* Category Scores */}
        <div className="grid grid-cols-3 gap-4 mt-4">
          <ScorePill label="Hierarchy" score={score.hierarchy} />
          <ScorePill label="Clarity" score={score.clarity} />
          <ScorePill label="Craft" score={score.craft} />
        </div>
        
        {/* Findings */}
        {!score.passed && (
          <div className="mt-4 space-y-2">
            {score.findings.critical.length > 0 && (
              <FindingsList 
                title="Critical Issues"
                findings={score.findings.critical}
                severity="critical"
              />
            )}
            {score.findings.high.length > 0 && (
              <FindingsList 
                title="High Priority"
                findings={score.findings.high}
                severity="high"
              />
            )}
          </div>
        )}
        
        {/* Refine Button */}
        {!score.passed && (
          <Button
            className="w-full mt-4"
            onClick={async () => {
              setIsRefining(true);
              await onRefine();
              setIsRefining(false);
            }}
            disabled={isRefining}
          >
            {isRefining ? 'Refining...' : 'Refine with Impeccable'}
          </Button>
        )}
        
        {score.passed && (
          <div className="mt-4 p-3 bg-green-500/10 border border-green-500/20 rounded-md">
            <p className="text-sm text-green-400 text-center">
              ✅ Ready to publish — passed quality checks
            </p>
          </div>
        )}
      </div>
      
      {/* Preview */}
      <div className="border border-surface-3 rounded-lg overflow-hidden">
        <iframe
          srcDoc={html}
          className="w-full h-[600px] bg-white"
          title="Site Preview"
        />
      </div>
    </div>
  );
}

function ScorePill({ label, score }: { label: string; score: number }) {
  const color =
    score >= 8 ? 'text-green-400 bg-green-500/10' :
    score >= 6 ? 'text-yellow-400 bg-yellow-500/10' :
    'text-red-400 bg-red-500/10';
    
  return (
    <div className={`${color} rounded-lg p-3 text-center`}>
      <div className="text-2xl font-bold">{score}</div>
      <div className="text-xs opacity-70">{label}</div>
    </div>
  );
}

function FindingsList({ 
  title, 
  findings, 
  severity 
}: { 
  title: string; 
  findings: Finding[]; 
  severity: string;
}) {
  const icon = severity === 'critical' ? '🔴' : '🟠';
  
  return (
    <div>
      <h4 className="text-sm font-medium mb-2">{icon} {title}</h4>
      <ul className="space-y-1">
        {findings.map((f, i) => (
          <li key={i} className="text-sm text-muted-foreground pl-4">
            • {f.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### 4.2 API Route Update

**Arquivo**: `src/app/api/sites/generate/route.ts`

```typescript
import { generateSiteWithQuality } from '@/lib/sites/generator-with-refinement';

export async function POST(req: Request) {
  const { prompt, projectType, businessGoal, targetAudience, domain } = await req.json();
  
  try {
    // Gerar com quality loop
    const result = await generateSiteWithQuality(
      prompt,
      { projectType, businessGoal, targetAudience, domain },
      3 // max iterations
    );
    
    return Response.json({
      success: true,
      html: result.html,
      score: result.score,
      iterations: result.iterations,
    });
    
  } catch (error) {
    console.error('Generation failed:', error);
    return Response.json(
      { success: false, error: 'Failed to generate site' },
      { status: 500 }
    );
  }
}
```

---

## Métricas de Sucesso

### Quality Metrics (Target)
- Overall Score: **85+**/100
- Critical Issues: **0**
- High Issues: **0**
- Hierarchy Score: **8+**/10
- Clarity Score: **8+**/10
- Craft Score: **8+**/10

### User Metrics
- Redução em "re-generate" requests: **-50%**
- Aumento em "publish" rate: **+40%**
- User satisfaction: **4.5+**/5

### Performance Metrics
- LCP: **< 2.5s**
- CLS: **< 0.1**
- FID: **< 100ms**

---

## Timeline

**Semana 1**: Foundation — Context templates, system prompts
**Semana 2**: Validation — Top 10 detector rules, scorer
**Semana 3**: Refinement — Loop implementation, refinement prompts
**Semana 4**: UI Integration — Preview component, API updates, testing

**Total**: 4 semanas para implementação completa

---

## Riscos e Mitigações

### Risco 1: Detector Rules Complexas
**Mitigação**: Começar com top 10 mais críticas, expandir gradualmente

### Risco 2: Refinement Loop Lento
**Mitigação**: Limitar a 3 iterações, otimizar prompts para convergência rápida

### Risco 3: False Positives em Rules
**Mitigação**: Tuning baseado em feedback real, allow-list de exceções

### Risco 4: Context Window Overflow
**Mitigação**: Compact refinement prompts, focus only on failing categories

---

## Next Steps

1. ✅ **Aprovar plano** com stakeholders
2. 🔨 **Implementar Fase 1** (Foundation)
3. ✅ **Validar com 10 sites de teste**
4. 🔨 **Implementar Fase 2** (Validation)
5. ✅ **A/B test com vs sem Impeccable**
6. 🔨 **Implementar Fase 3-4** (Refinement + UI)
7. 🚀 **Deploy em produção**

---

## Recursos Adicionais

- **Full Guide**: `/docs/IMPECCABLE_FRAMEWORK_GUIDE.md`
- **Quick Reference**: `/docs/IMPECCABLE_QUICK_REFERENCE.md`
- **Repository**: https://github.com/pbakaus/impeccable
- **Website**: https://impeccable.style
