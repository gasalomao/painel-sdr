# Impeccable Integration — Exemplos Práticos

**Companion de:** `IMPECCABLE_ANALYSIS.md`  
**Data:** 09/10/2026  
**Status:** Exemplos de implementação e código prático

---

## 1. EXEMPLO: Análise de Contraste (Dimension: Accessibility)

### Código: `src/lib/sites/impeccable-audit.ts`

```typescript
import { parse, type Rule, type Declaration } from 'css-tree';
import { oklch } from 'culori';

interface ContrastCheck {
  selector: string;
  color: string;
  background: string;
  ratio: number;
  passed: boolean;
  file: string;
}

export function analyzeColorContrast(files: WebsiteFiles): ContrastCheck[] {
  const checks: ContrastCheck[] = [];
  
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith('.css')) continue;
    
    try {
      const ast = parse(content);
      const rules = new Map<string, { color?: string; background?: string }>();
      
      ast.children.forEach((node) => {
        if (node.type !== 'Rule') return;
        const rule = node as Rule;
        
        const selectors = rule.prelude.children
          .filter((n) => n.type === 'Selector')
          .map((s) => content.slice(s.loc.start.offset, s.loc.end.offset))
          .join(', ');
        
        const props = rules.get(selectors) || {};
        
        rule.block.children.forEach((child) => {
          if (child.type !== 'Declaration') return;
          const decl = child as Declaration;
          const prop = decl.property.toLowerCase();
          const value = content.slice(decl.value.loc.start.offset, decl.value.loc.end.offset);
          
          if (prop === 'color') props.color = value;
          if (prop === 'background' || prop === 'background-color') props.background = value;
        });
        
        if (props.color || props.background) {
          rules.set(selectors, props);
        }
      });
      
      // Calculate contrast ratios
      for (const [selector, { color, background }] of rules) {
        if (!color || !background) continue;
        
        const ratio = calculateContrastRatio(color, background);
        if (ratio === null) continue;
        
        checks.push({
          selector,
          color,
          background,
          ratio,
          passed: ratio >= 4.5, // WCAG AA for normal text
          file: path
        });
      }
    } catch {
      // Invalid CSS, will be caught by structural validation
    }
  }
  
  return checks;
}

function calculateContrastRatio(color1: string, color2: string): number | null {
  try {
    const c1 = oklch(color1);
    const c2 = oklch(color2);
    if (!c1 || !c2) return null;
    
    const l1 = c1.l * 100; // 0-100
    const l2 = c2.l * 100;
    
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    
    // Simplified WCAG formula (approximation for oklch)
    return (lighter + 5) / (darker + 5);
  } catch {
    return null;
  }
}
```

### Uso na Auditoria

```typescript
export async function auditAccessibility(files: WebsiteFiles): Promise<ImpeccableDimensionScore> {
  const issues: string[] = [];
  let score = 4; // Start at maximum
  
  // Check 1: Contrast ratios
  const contrastChecks = analyzeColorContrast(files);
  const failedContrast = contrastChecks.filter((c) => !c.passed);
  
  if (failedContrast.length > 0) {
    score -= 1;
    issues.push(`${failedContrast.length} contrast violations (WCAG AA 4.5:1 minimum)`);
    failedContrast.slice(0, 3).forEach((check) => {
      issues.push(`  ${check.selector} in ${check.file}: ${check.ratio.toFixed(2)}:1`);
    });
  }
  
  // Check 2: Missing alt text
  const htmlContent = files['index.html'] || '';
  const imgWithoutAlt = (htmlContent.match(/<img(?![^>]*\balt=)/gi) || []).length;
  if (imgWithoutAlt > 0) {
    score -= 1;
    issues.push(`${imgWithoutAlt} images without alt text`);
  }
  
  // Check 3: Semantic HTML
  const hasMain = /<main\b/i.test(htmlContent);
  const hasNav = /<nav\b/i.test(htmlContent);
  const hasHeadings = /<h[1-6]\b/i.test(htmlContent);
  
  if (!hasMain || !hasNav || !hasHeadings) {
    score -= 1;
    issues.push('Missing semantic HTML elements (main, nav, or headings)');
  }
  
  // Check 4: ARIA attributes (basic check)
  const mainTsx = files['src/main.tsx'] || '';
  const appTsx = files['src/App.tsx'] || '';
  const combinedTsx = mainTsx + appTsx;
  
  const hasAriaLabel = /aria-label|aria-labelledby|aria-describedby/i.test(combinedTsx);
  const hasInteractiveElements = /button|<a\b|input|select|textarea/i.test(combinedTsx);
  
  if (hasInteractiveElements && !hasAriaLabel) {
    score = Math.max(0, score - 1);
    issues.push('Interactive elements may need ARIA labels');
  }
  
  return { score: Math.max(0, Math.min(4, score)) as 0 | 1 | 2 | 3 | 4, issues };
}
```

---

## 2. EXEMPLO: Detecção de Design Tokens (Dimension: Implementation)

### Código: Análise de Centralização

```typescript
export function analyzeDesignTokens(files: WebsiteFiles): {
  tokensCentralized: boolean;
  tokensFile: string | null;
  inlineValuesCount: number;
  examples: string[];
} {
  const tokenFiles = ['src/tokens.css', 'src/styles/tokens.css', 'src/design-tokens.css'];
  const tokensFile = tokenFiles.find((f) => files[f]);
  
  if (!tokensFile) {
    return {
      tokensCentralized: false,
      tokensFile: null,
      inlineValuesCount: 0,
      examples: ['No design tokens file found (expected src/tokens.css)']
    };
  }
  
  // Count inline color/spacing values in CSS files
  let inlineCount = 0;
  const examples: string[] = [];
  
  const colorPattern = /#[0-9a-f]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)|oklch\([^)]+\)/gi;
  const spacingPattern = /(?:padding|margin|gap|width|height):\s*\d+(?:px|rem|em)\b/gi;
  
  for (const [path, content] of Object.entries(files)) {
    if (path === tokensFile || !path.endsWith('.css')) continue;
    
    const colorMatches = content.match(colorPattern) || [];
    const spacingMatches = content.match(spacingPattern) || [];
    
    inlineCount += colorMatches.length + spacingMatches.length;
    
    if (colorMatches.length > 0 && examples.length < 3) {
      examples.push(`${path}: inline color values found (${colorMatches.slice(0, 2).join(', ')})`);
    }
    if (spacingMatches.length > 0 && examples.length < 3) {
      examples.push(`${path}: inline spacing values found (${spacingMatches.slice(0, 2).join(', ')})`);
    }
  }
  
  return {
    tokensCentralized: inlineCount < 10, // Threshold: <10 inline values acceptable
    tokensFile,
    inlineValuesCount: inlineCount,
    examples
  };
}

export async function auditImplementation(files: WebsiteFiles): Promise<ImpeccableDimensionScore> {
  const issues: string[] = [];
  let score = 4;
  
  // Check 1: Design tokens centralized
  const tokensAnalysis = analyzeDesignTokens(files);
  if (!tokensAnalysis.tokensCentralized) {
    score -= 2; // Major issue
    issues.push('Design tokens not centralized');
    issues.push(`  ${tokensAnalysis.inlineValuesCount} inline values found`);
    issues.push(...tokensAnalysis.examples.slice(0, 2));
  }
  
  // Check 2: Component reuse (basic heuristic)
  const tsxFiles = Object.entries(files).filter(([p]) => p.endsWith('.tsx'));
  const duplicatePatterns = findDuplicateJSXPatterns(tsxFiles);
  
  if (duplicatePatterns.length > 0) {
    score -= 1;
    issues.push(`${duplicatePatterns.length} duplicate component patterns (extract to reusable components)`);
  }
  
  // Check 3: Fixed config files intact
  const configFilesIntact = Object.entries(WEBSITE_FIXED_FILES).every(
    ([path, content]) => files[path] === content
  );
  
  if (!configFilesIntact) {
    score -= 2; // Critical
    issues.push('Fixed configuration files were modified');
  }
  
  return { score: Math.max(0, Math.min(4, score)) as 0 | 1 | 2 | 3 | 4, issues };
}

function findDuplicateJSXPatterns(tsxFiles: [string, string][]): string[] {
  const patterns = new Map<string, string[]>();
  
  for (const [path, content] of tsxFiles) {
    // Extract JSX patterns (simplified)
    const jsxBlocks = content.match(/<(?:div|section|button)[^>]*>[\s\S]{20,100}<\/(?:div|section|button)>/gi) || [];
    
    for (const block of jsxBlocks) {
      const normalized = block.replace(/\s+/g, ' ').trim();
      const files = patterns.get(normalized) || [];
      files.push(path);
      patterns.set(normalized, files);
    }
  }
  
  return Array.from(patterns.entries())
    .filter(([_, files]) => files.length > 1)
    .map(([pattern, files]) => `Pattern repeated in: ${files.join(', ')}`);
}
```

---

## 3. EXEMPLO: Touch Target Validation (Dimension: Responsive)

### Código: Análise via Screenshots

```typescript
import type { Page } from 'playwright';

export async function analyzeTouchTargets(
  page: Page,
  screenshots: { desktop?: string; mobile?: string }
): Promise<{ passed: boolean; issues: string[] }> {
  const issues: string[] = [];
  
  // Navigate to mobile viewport
  await page.setViewportSize({ width: 390, height: 844 });
  
  // Find all interactive elements
  const interactiveElements = await page.locator('button, a, input, select, [role="button"]').all();
  
  const MIN_TOUCH_TARGET = 44; // iOS guideline
  
  for (const element of interactiveElements) {
    const box = await element.boundingBox();
    if (!box) continue;
    
    if (box.width < MIN_TOUCH_TARGET || box.height < MIN_TOUCH_TARGET) {
      const text = await element.textContent();
      const selector = await element.evaluate((el) => {
        if (el.id) return `#${el.id}`;
        if (el.className) return `.${el.className.split(' ')[0]}`;
        return el.tagName.toLowerCase();
      });
      
      issues.push(
        `Touch target too small: ${selector} (${Math.round(box.width)}×${Math.round(box.height)}px) ` +
        `${text ? `"${text.slice(0, 30)}"` : ''}`
      );
    }
  }
  
  return {
    passed: issues.length === 0,
    issues: issues.slice(0, 10) // Limit to 10 examples
  };
}

export async function auditResponsive(
  files: WebsiteFiles,
  screenshots: { desktop?: string; mobile?: string },
  page?: Page
): Promise<ImpeccableDimensionScore> {
  const issues: string[] = [];
  let score = 4;
  
  // Check 1: Viewport meta tag
  const html = files['index.html'] || '';
  if (!/name=["']viewport["']/.test(html)) {
    score -= 2;
    issues.push('Missing viewport meta tag');
  }
  
  // Check 2: Fixed widths in CSS
  const cssContent = Object.entries(files)
    .filter(([p]) => p.endsWith('.css'))
    .map(([_, c]) => c)
    .join('\n');
  
  const fixedWidths = cssContent.match(/width:\s*\d{4,}px/gi) || [];
  if (fixedWidths.length > 0) {
    score -= 1;
    issues.push(`${fixedWidths.length} fixed-width constraints found (may break on mobile)`);
  }
  
  // Check 3: Media queries present
  const hasMediaQueries = /@media/.test(cssContent);
  if (!hasMediaQueries) {
    score -= 1;
    issues.push('No responsive media queries found');
  }
  
  // Check 4: Touch targets (if page available)
  if (page) {
    const touchTargets = await analyzeTouchTargets(page, screenshots);
    if (!touchTargets.passed) {
      score -= 1;
      issues.push(`${touchTargets.issues.length} touch targets below 44×44px`);
      issues.push(...touchTargets.issues.slice(0, 2));
    }
  }
  
  return { score: Math.max(0, Math.min(4, score)) as 0 | 1 | 2 | 3 | 4, issues };
}
```

---

## 4. EXEMPLO: Integração Completa no Agent

### Código: `src/lib/sites/agent.ts` (modificações)

```typescript
import { auditWebsiteWithImpeccable, type ImpeccableAuditResult } from './impeccable-audit';

// Dentro de executeWebsiteAgent(), após build bem-sucedido:

async function runQualityGates(
  files: WebsiteFiles,
  build: WebsiteBuildResult,
  settings: WebsiteSettings,
  activeSkills: WebsiteSkill[]
): Promise<{ passed: boolean; report: WebsiteQaReport }> {
  
  // Gate 1: Structural validation (já existe)
  const structural = validateWebsiteContent(files);
  if (structural.errors.length > 0) {
    return {
      passed: false,
      report: {
        status: 'failed',
        stage: 'validation',
        classification: 'source',
        structural,
        duration_ms: 0,
        model_id: null,
        logs: [],
        errors: structural.errors,
        warnings: structural.warnings,
        diagnostics: [],
        workspace_hash: createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16)
      }
    };
  }
  
  // Gate 2: Build (já existe)
  if (!build.success) {
    return {
      passed: false,
      report: {
        status: 'failed',
        stage: 'build',
        classification: 'source',
        structural,
        build_success: false,
        duration_ms: build.duration_ms,
        model_id: null,
        logs: build.logs || [],
        errors: build.errors || [],
        warnings: build.warnings || [],
        diagnostics: [],
        workspace_hash: createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16)
      }
    };
  }
  
  // Gate 3: Impeccable Audit (NOVO)
  const impeccableEnabled = isImpeccableSkill(activeSkills);
  let impeccableAudit: ImpeccableAuditResult | undefined;
  
  if (impeccableEnabled) {
    try {
      impeccableAudit = await auditWebsiteWithImpeccable(files, {
        desktop: build.screenshots?.desktop,
        mobile: build.screenshots?.mobile
      });
      
      // Se score muito baixo, bloqueia imediatamente
      if (impeccableAudit.score < 10) { // Below Fair
        const p0p1 = impeccableAudit.findings.filter(f => f.severity === 'P0' || f.severity === 'P1');
        
        return {
          passed: false,
          report: {
            status: 'failed',
            stage: 'quality_audit',
            classification: 'source',
            structural,
            build_success: true,
            impeccableAudit,
            impeccableVersion: IMPECCABLE_REVISION,
            duration_ms: build.duration_ms,
            model_id: null,
            logs: [],
            errors: p0p1.map(f => `[${f.severity}] ${f.category}: ${f.message}`),
            warnings: [],
            diagnostics: [],
            workspace_hash: createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16)
          }
        };
      }
    } catch (error) {
      // Audit failure não bloqueia, apenas avisa
      console.warn('Impeccable audit failed:', error);
    }
  }
  
  // Gate 4: Visual Critique (já existe, mas com merge de issues Impeccable)
  const critiqueIssues: string[] = [];
  
  if (impeccableAudit && !impeccableAudit.passed) {
    const p1Issues = impeccableAudit.findings
      .filter(f => f.severity === 'P1')
      .map(f => `[Impeccable P1] ${f.category}: ${f.message}`);
    critiqueIssues.push(...p1Issues);
  }
  
  // ... resto da lógica de criticQa existente
  
  return { passed: true, report: finalReport };
}
```

---

## 5. EXEMPLO: Prompt Enhancement para Guidance Visual

### Código: `src/lib/sites/prompts.ts` (adições)

```typescript
export const IMPECCABLE_CREATIVE_GUIDANCE = `
QUALIDADE VISUAL — PRINCÍPIOS IMPECCABLE

1. SUPERFÍCIES E PALETA
   - Construa ladder tonal de 5-7 níveis: #05070C (deep) → #0F131C → #1E2636 (raised)
   - Tinte toda superfície escura em direção ao domínio:
     * Craft/artesanal: brass/amber (oklch hue ~80)
     * Tecnologia/dados: cyan/emerald (oklch hue ~180-160)
     * Hospitalidade: terracotta/warm (oklch hue ~30)
   - Escolha UM acento luminoso high-saturation: oklch(84% 0.19 [hue])
   - Um tint muted de suporte: oklch(70% 0.12 [hue+offset])
   - NUNCA: preto puro #000, branco puro #FFF, indigo-on-white, purple gradients

2. TIPOGRAFIA
   - Escala fluida com clamp(): clamp(2.5rem, 5vw, 4rem) para display
   - Declare famílias em :root como --font-display, --font-body
   - Consuma apenas via var(--font-display)
   - Tracking: negativo em display (-0.01em), normal/positivo em body
   - Line-height: 1.65-1.8 para body em superfícies escuras
   - Max-width: 65-75ch para conforto de leitura
   - EVITE: Arial, Inter genérico, system defaults óbvios

3. LAYOUT E GEOMETRIA
   - CSS Grid para page frame e section rhythm
   - Flexbox APENAS dentro de componentes
   - Raios tokenizados: --radius-sm: 4px, --radius-lg: 8px, --radius-pill: 999px
   - Botões sempre --radius-pill (fully rounded)
   - Avatares sempre border-radius: 50%
   - EVITE: nested cards, containers excessivos

4. COMPONENTES E TOKENS
   - Centralize em src/tokens.css: cores, tipografia, espaçamentos, raios, sombras
   - Consuma SOMENTE via var(), NUNCA valores literais
   - Spacing scale: 8px (xs), 16px (sm), 24px (md), 32px (lg), 48px (xl)
   - Shadows usados com parcimônia: borders e background shifts primeiro

5. MATERIAIS E CONTEÚDO
   - Assets autorais > gradientes decorativos
   - Conteúdo real > lorem ipsum / placeholder.com
   - Primeiro viewport DEVE demonstrar o mecanismo, não apenas mood
   - Componentes devem usar vocabulário da forma escolhida (coesão)

6. PERFORMANCE
   - Animar APENAS: transform, opacity, filter
   - NUNCA animar: width, height, padding, margin (causa layout thrashing)
   - renderGroup(true) para animações complexas com múltiplos elementos

7. ACESSIBILIDADE
   - Contraste WCAG AA: 4.5:1 texto normal, 3:1 texto large/UI
   - Touch targets: mínimo 44×44px (iOS), 48×48dp (Android)
   - ARIA roles onde HTML semântico não basta
   - Focus keyboard sempre visível (outline ou ring)
   - Não transmitir significado apenas por cor

COMPROMISSO TOTAL: Cada elemento (navegação, botões, inputs, cards) deve usar
o vocabulário da forma escolhida. "Stock components inside committed form" é
falha de execução. A direção visual deve ser material, não decorativa.
`;

export function composeSystemPrompt(
  project: WebsiteProject,
  settings: WebsiteSettings,
  activeSkills: WebsiteSkill[]
): string {
  let prompt = WEBSITE_SECURITY_PROMPT;
  
  // Creative guidance do settings
  if (settings.creative_prompt.trim()) {
    prompt += '\n\n' + settings.creative_prompt;
  }
  
  // Impeccable guidance se skill ativo
  if (isImpeccableSkill(activeSkills)) {
    prompt += '\n\n' + IMPECCABLE_CREATIVE_GUIDANCE;
  }
  
  // Contexto de negócio confirmado
  if (project.client_context) {
    prompt += '\n\nCONTEXTO DO NEGÓCIO CONFIRMADO:\n';
    const ctx = project.client_context;
    if (ctx.name) prompt += `Nome: ${ctx.name}\n`;
    if (ctx.segment) prompt += `Segmento: ${ctx.segment}\n`;
    if (ctx.services) prompt += `Serviços: ${ctx.services}\n`;
    if (ctx.city) prompt += `Cidade: ${ctx.city}\n`;
    if (ctx.description) prompt += `Descrição: ${ctx.description}\n`;
  }
  
  return prompt;
}
```

---

## 6. EXEMPLO: UI de Qualidade Score

### Código: `src/components/sites/site-quality-panel.tsx`

```tsx
import type { ImpeccableAuditResult } from '@/lib/sites/impeccable-audit';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';

interface QualityPanelProps {
  audit: ImpeccableAuditResult;
}

export function SiteQualityPanel({ audit }: QualityPanelProps) {
  const ratingColor = {
    excellent: 'text-green-600 dark:text-green-400',
    good: 'text-blue-600 dark:text-blue-400',
    fair: 'text-yellow-600 dark:text-yellow-400',
    poor: 'text-orange-600 dark:text-orange-400',
    critical: 'text-red-600 dark:text-red-400'
  }[audit.rating];
  
  const ratingLabel = {
    excellent: 'Excelente',
    good: 'Bom',
    fair: 'Aceitável',
    poor: 'Insuficiente',
    critical: 'Crítico'
  }[audit.rating];
  
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Qualidade Impeccable</span>
          <div className="flex items-center gap-2">
            <span className={`text-2xl font-bold ${ratingColor}`}>
              {audit.score}/20
            </span>
            <Badge variant={audit.passed ? 'default' : 'destructive'}>
              {ratingLabel}
            </Badge>
          </div>
        </CardTitle>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {/* Dimensions Grid */}
        <div className="grid grid-cols-5 gap-2">
          <DimensionBadge 
            label="A11y" 
            score={audit.dimensions.accessibility.score} 
            issues={audit.dimensions.accessibility.issues}
          />
          <DimensionBadge 
            label="Perf" 
            score={audit.dimensions.performance.score}
            issues={audit.dimensions.performance.issues}
          />
          <DimensionBadge 
            label="Theme" 
            score={audit.dimensions.theming.score}
            issues={audit.dimensions.theming.issues}
          />
          <DimensionBadge 
            label="Resp" 
            score={audit.dimensions.responsive.score}
            issues={audit.dimensions.responsive.issues}
          />
          <DimensionBadge 
            label="System" 
            score={audit.dimensions.implementation.score}
            issues={audit.dimensions.implementation.issues}
          />
        </div>
        
        {/* Findings List */}
        {audit.findings.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Issues Encontrados</h4>
            <div className="space-y-1">
              {audit.findings.map((finding, i) => (
                <FindingItem key={i} finding={finding} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DimensionBadge({ 
  label, 
  score, 
  issues 
}: { 
  label: string; 
  score: number; 
  issues: string[];
}) {
  const color = score >= 4 ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
    : score >= 3 ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
    : score >= 2 ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
    : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
  
  return (
    <div 
      className={`flex flex-col items-center p-2 rounded-lg ${color}`}
      title={issues.join('\n')}
    >
      <span className="text-xs font-medium">{label}</span>
      <span className="text-lg font-bold">{score}/4</span>
    </div>
  );
}

function FindingItem({ finding }: { finding: ImpeccableFinding }) {
  const Icon = finding.severity === 'P0' ? XCircle
    : finding.severity === 'P1' ? AlertTriangle
    : CheckCircle2;
  
  const color = finding.severity === 'P0' ? 'text-red-600'
    : finding.severity === 'P1' ? 'text-orange-600'
    : 'text-yellow-600';
  
  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon className={`h-4 w-4 ${color} mt-0.5 flex-shrink-0`} />
      <div>
        <Badge variant="outline" className="mr-2">{finding.severity}</Badge>
        <span className="font-medium">{finding.category}:</span>{' '}
        <span className="text-muted-foreground">{finding.message}</span>
        {finding.file && (
          <span className="text-xs text-muted-foreground block mt-1">
            {finding.file}
          </span>
        )}
      </div>
    </div>
  );
}
```

---

## 7. EXEMPLO: Teste Unitário de Contraste

### Código: `src/lib/sites/__tests__/impeccable-audit.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { analyzeColorContrast, auditAccessibility } from '../impeccable-audit';
import type { WebsiteFiles } from '../types';

describe('Impeccable Audit', () => {
  describe('analyzeColorContrast', () => {
    it('should detect passing contrast ratios', () => {
      const files: WebsiteFiles = {
        'src/App.css': `
          .text {
            color: oklch(90% 0 0); /* near white */
            background: oklch(10% 0 0); /* near black */
          }
        `,
        ...WEBSITE_FIXED_FILES
      };
      
      const checks = analyzeColorContrast(files);
      expect(checks).toHaveLength(1);
      expect(checks[0].passed).toBe(true);
      expect(checks[0].ratio).toBeGreaterThanOrEqual(4.5);
    });
    
    it('should detect failing contrast ratios', () => {
      const files: WebsiteFiles = {
        'src/App.css': `
          .text {
            color: oklch(60% 0 0); /* gray */
            background: oklch(50% 0 0); /* slightly darker gray */
          }
        `,
        ...WEBSITE_FIXED_FILES
      };
      
      const checks = analyzeColorContrast(files);
      expect(checks).toHaveLength(1);
      expect(checks[0].passed).toBe(false);
      expect(checks[0].ratio).toBeLessThan(4.5);
    });
    
    it('should handle multiple selectors', () => {
      const files: WebsiteFiles = {
        'src/App.css': `
          body { color: #333; background: #fff; }
          .header { color: #000; background: #f0f0f0; }
          button { color: #fff; background: #007bff; }
        `,
        ...WEBSITE_FIXED_FILES
      };
      
      const checks = analyzeColorContrast(files);
      expect(checks.length).toBeGreaterThanOrEqual(2);
    });
  });
  
  describe('auditAccessibility', () => {
    it('should pass with good accessibility', async () => {
      const files: WebsiteFiles = {
        'index.html': `
          <!DOCTYPE html>
          <html lang="pt-BR">
            <head><meta name="viewport" content="width=device-width"></head>
            <body>
              <main><h1>Title</h1></main>
              <nav><a href="/">Home</a></nav>
            </body>
          </html>
        `,
        'src/App.css': `
          body { color: oklch(90% 0 0); background: oklch(10% 0 0); }
        `,
        ...WEBSITE_FIXED_FILES
      };
      
      const result = await auditAccessibility(files);
      expect(result.score).toBeGreaterThanOrEqual(3);
      expect(result.issues.length).toBeLessThanOrEqual(1);
    });
    
    it('should fail with missing semantic HTML', async () => {
      const files: WebsiteFiles = {
        'index.html': `
          <!DOCTYPE html>
          <html>
            <head></head>
            <body><div>Content</div></body>
          </html>
        `,
        ...WEBSITE_FIXED_FILES
      };
      
      const result = await auditAccessibility(files);
      expect(result.score).toBeLessThan(4);
      expect(result.issues.some(i => i.includes('semantic'))).toBe(true);
      expect(result.issues.some(i => i.includes('viewport'))).toBe(true);
      expect(result.issues.some(i => i.includes('lang'))).toBe(true);
    });
    
    it('should detect images without alt text', async () => {
      const files: WebsiteFiles = {
        'index.html': `
          <!DOCTYPE html>
          <html lang="pt">
            <head><meta name="viewport" content="width=device-width"></head>
            <body>
              <main>
                <h1>Test</h1>
                <img src="logo.png">
                <img src="hero.jpg">
              </main>
            </body>
          </html>
        `,
        ...WEBSITE_FIXED_FILES
      };
      
      const result = await auditAccessibility(files);
      expect(result.issues.some(i => i.includes('alt'))).toBe(true);
    });
  });
});
```

---

## 8. CHECKLIST DE IMPLEMENTAÇÃO

### Fase 1: Foundation ✓
- [ ] Criar `src/lib/sites/impeccable-audit.ts`
- [ ] Implementar `analyzeColorContrast()`
- [ ] Implementar `analyzeDesignTokens()`
- [ ] Implementar `auditAccessibility()`
- [ ] Implementar `auditPerformance()`
- [ ] Implementar `auditTheming()`
- [ ] Implementar `auditResponsive()`
- [ ] Implementar `auditImplementation()`
- [ ] Implementar `auditWebsiteWithImpeccable()` orchestrator
- [ ] Testes unitários >80% coverage

### Fase 2: Integration ✓
- [ ] Modificar `agent.ts` para chamar audit
- [ ] Modificar `qa-report.ts` para incluir `impeccableAudit`
- [ ] Implementar `decideFinalQa()` com 4 gates
- [ ] Testes de integração end-to-end

### Fase 3: Prompts ✓
- [ ] Criar `impeccable-prompts.ts`
- [ ] Adicionar `IMPECCABLE_CREATIVE_GUIDANCE`
- [ ] Adicionar `IMPECCABLE_VISUAL_CRITIQUE`
- [ ] Integrar no `composeSystemPrompt()`
- [ ] Testar com modelo quality gratuito

### Fase 4: UI ✓
- [ ] Criar `site-quality-panel.tsx`
- [ ] Criar componentes `DimensionBadge`, `FindingItem`
- [ ] Integrar no `/sites/[projectId]`
- [ ] Tokens de design para scoring

### Fase 5: Validation ✓
- [ ] Suite completa `npm test` >80%
- [ ] TypeScript `npx tsc --noEmit`
- [ ] Lint `npm run lint` focado
- [ ] Build `npm run build`
- [ ] Diffcheck `git diff --check`

---

## 9. COMANDOS DE TESTE

```bash
# Testes unitários do audit
npm test -- src/lib/sites/__tests__/impeccable-audit.test.ts

# Testes de integração
npm test -- src/lib/sites/__tests__/agent.test.ts

# Coverage do módulo
npm test -- --coverage src/lib/sites/impeccable-audit.ts

# TypeScript check
npx tsc --noEmit --incremental false

# Build
npm run build

# Lint focado
npm run lint -- src/lib/sites/impeccable-*.ts
```

---

**Próximo passo:** Aguardar aprovação do usuário para iniciar implementação da Fase 1.
