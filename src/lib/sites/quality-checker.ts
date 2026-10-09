import type { WebsiteFiles } from "./types";

export interface QualityCheck {
  id: string;
  category: "palette" | "typography" | "layout" | "cta" | "tokens" | "content";
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
 *
 * Esta função implementa o quality gate que previne sites com "cara de IA".
 * Verifica padrões proibidos (gradientes genéricos, CTAs vazios, etc) e
 * padrões obrigatórios (tokens, tipografia fluida, grid-first layout).
 *
 * @param files - Arquivos virtuais do site gerado
 * @returns Relatório de qualidade com score e checks detalhados
 */
export function checkAntiAIQuality(files: WebsiteFiles): QualityReport {
  const checks: QualityCheck[] = [];

  // 1. Verificar gradientes proibidos (CRITICAL)
  checks.push(checkForbiddenGradients(files));

  // 2. Verificar escala tipográfica fluida (HIGH)
  checks.push(checkFluidTypography(files));

  // 3. Verificar uso de tokens (HIGH)
  checks.push(checkTokenUsage(files));

  // 4. Verificar CTAs genéricos (HIGH)
  checks.push(checkGenericCTAs(files));

  // 5. Verificar grid-first layout (MEDIUM)
  checks.push(checkGridFirstLayout(files));

  // 6. Verificar conteúdo em português (MEDIUM)
  checks.push(checkPortugueseContent(files));

  // Calcular score ponderado
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
  const failedHigh = checks.filter(c => !c.passed && c.severity === "high");

  let summary: string;
  if (passed) {
    summary = `✅ Site aprovado com score ${score}/100 - qualidade anti-IA garantida`;
  } else if (failedCritical.length > 0) {
    summary = `❌ Site BLOQUEADO (score ${score}/100). ${failedCritical.length} checks CRÍTICOS falharam - site tem cara de IA.`;
  } else {
    summary = `⚠️ Site precisa de melhorias (score ${score}/100). ${failedHigh.length} checks HIGH falharam.`;
  }

  return { score, passed, checks, summary };
}

/**
 * Verifica se há gradientes decorativos proibidos (roxo-azul, rosa-laranja, etc)
 */
function checkForbiddenGradients(files: WebsiteFiles): QualityCheck {
  const forbiddenPatterns = [
    { pattern: /#667eea.*#764ba2/i, name: "gradiente roxo → azul" },
    { pattern: /#4facfe.*#00f2fe/i, name: "gradiente azul → verde" },
    { pattern: /#fa709a.*#fee140/i, name: "gradiente rosa → laranja" },
    { pattern: /linear-gradient.*purple.*blue/i, name: "gradiente purple-blue" },
    { pattern: /linear-gradient.*pink.*orange/i, name: "gradiente pink-orange" },
  ];

  const cssFiles = Object.entries(files).filter(([path]) => path.endsWith(".css"));

  for (const [path, content] of cssFiles) {
    for (const { pattern, name } of forbiddenPatterns) {
      if (pattern.test(content)) {
        return {
          id: "no-generic-gradients",
          category: "palette",
          severity: "critical",
          passed: false,
          message: `${name} detectado em ${path} - padrão proibido de template genérico`,
          suggestion: "Use paleta sólida derivada do domínio do negócio, não gradientes decorativos"
        };
      }
    }
  }

  return {
    id: "no-generic-gradients",
    category: "palette",
    severity: "critical",
    passed: true,
    message: "✓ Nenhum gradiente genérico detectado"
  };
}

/**
 * Verifica se a tipografia usa escala fluida com clamp() ao invés de tamanhos fixos
 */
function checkFluidTypography(files: WebsiteFiles): QualityCheck {
  const cssFiles = Object.entries(files).filter(([path]) => path.endsWith(".css"));

  let hasClamp = false;
  let hasFixedSizes = false;
  const fixedSizeMatches: string[] = [];

  for (const [path, content] of cssFiles) {
    if (/font-size:\s*clamp\(/i.test(content)) {
      hasClamp = true;
    }

    // Buscar font-size fixos (mas ignorar resets e utilitários)
    const fixedMatches = content.match(/font-size:\s*(\d+px)/gi);
    if (fixedMatches && !path.includes("reset") && !path.includes("normalize")) {
      hasFixedSizes = true;
      fixedSizeMatches.push(...fixedMatches.slice(0, 3)); // primeiros 3
    }
  }

  if (!hasClamp && hasFixedSizes) {
    return {
      id: "fluid-typography",
      category: "typography",
      severity: "high",
      passed: false,
      message: `Tipografia usa tamanhos fixos (${fixedSizeMatches.join(", ")}) ao invés de escala fluida`,
      suggestion: "Use clamp(min, base, max) para todos os tamanhos de fonte (ex: clamp(1rem, 2vw, 1.5rem))"
    };
  }

  if (!hasClamp) {
    return {
      id: "fluid-typography",
      category: "typography",
      severity: "high",
      passed: false,
      message: "Nenhuma escala tipográfica fluida detectada",
      suggestion: "Defina escala com clamp() em tokens.css"
    };
  }

  return {
    id: "fluid-typography",
    category: "typography",
    severity: "high",
    passed: true,
    message: "✓ Tipografia usa escala fluida com clamp()"
  };
}

/**
 * Verifica se tokens CSS estão centralizados e completos
 */
function checkTokenUsage(files: WebsiteFiles): QualityCheck {
  const tokensFile = files["src/tokens.css"];

  if (!tokensFile) {
    return {
      id: "css-tokens",
      category: "tokens",
      severity: "high",
      passed: false,
      message: "Arquivo src/tokens.css não encontrado",
      suggestion: "Centralize design tokens em src/tokens.css (cores, fontes, espaçamentos)"
    };
  }

  const hasColorTokens = /--color-/i.test(tokensFile);
  const hasFontTokens = /--font-/i.test(tokensFile);
  const hasSpaceTokens = /--space-/i.test(tokensFile);

  const missing: string[] = [];
  if (!hasColorTokens) missing.push("cores (--color-*)");
  if (!hasFontTokens) missing.push("fontes (--font-*)");
  if (!hasSpaceTokens) missing.push("espaçamentos (--space-*)");

  if (missing.length > 0) {
    return {
      id: "css-tokens",
      category: "tokens",
      severity: "high",
      passed: false,
      message: `tokens.css incompleto - faltam: ${missing.join(", ")}`,
      suggestion: "Defina todos os tokens de design em tokens.css para manter consistência"
    };
  }

  // Verificar se tokens estão sendo consumidos (pelo menos alguns usos de var())
  const cssFiles = Object.entries(files).filter(([path]) =>
    path.endsWith(".css") && path !== "src/tokens.css"
  );

  let varUsageCount = 0;
  for (const [, content] of cssFiles) {
    const matches = content.match(/var\(--/g);
    if (matches) varUsageCount += matches.length;
  }

  if (varUsageCount < 5) {
    return {
      id: "css-tokens",
      category: "tokens",
      severity: "high",
      passed: false,
      message: "Tokens definidos mas pouco usados (menos de 5 var() no CSS)",
      suggestion: "Consuma tokens via var() ao invés de valores inline"
    };
  }

  return {
    id: "css-tokens",
    category: "tokens",
    severity: "high",
    passed: true,
    message: `✓ Design tokens centralizados e consumidos (${varUsageCount} usos)`
  };
}

/**
 * Verifica se há CTAs genéricos ("Saiba Mais", "Começar Agora", etc)
 */
function checkGenericCTAs(files: WebsiteFiles): QualityCheck {
  const genericCTAs = [
    { pattern: />\s*Saiba\s+Mais\s*</i, text: "Saiba Mais" },
    { pattern: />\s*Começar\s+Agora\s*</i, text: "Começar Agora" },
    { pattern: />\s*Entre\s+em\s+Contato\s*</i, text: "Entre em Contato" },
    { pattern: />\s*Learn\s+More\s*</i, text: "Learn More" },
    { pattern: />\s*Get\s+Started\s*</i, text: "Get Started" },
    { pattern: />\s*Contact\s+Us\s*</i, text: "Contact Us" },
  ];

  const tsxFiles = Object.entries(files).filter(([path]) => path.endsWith(".tsx"));

  for (const [path, content] of tsxFiles) {
    for (const { pattern, text } of genericCTAs) {
      if (pattern.test(content)) {
        return {
          id: "specific-ctas",
          category: "cta",
          severity: "high",
          passed: false,
          message: `CTA genérico "${text}" encontrado em ${path}`,
          suggestion: 'Use copy específico do negócio (ex: "Reserve Sua Mesa", "Calcular Frete", "Ver Cardápio")'
        };
      }
    }
  }

  return {
    id: "specific-ctas",
    category: "cta",
    severity: "high",
    passed: true,
    message: "✓ CTAs usam copy específico do negócio"
  };
}

/**
 * Verifica se o layout usa CSS Grid para estrutura principal
 */
function checkGridFirstLayout(files: WebsiteFiles): QualityCheck {
  const cssFiles = Object.entries(files).filter(([path]) => path.endsWith(".css"));

  let hasGridForStructure = false;
  let gridUsageCount = 0;

  for (const [, content] of cssFiles) {
    const matches = content.match(/display:\s*grid/gi);
    if (matches) {
      hasGridForStructure = true;
      gridUsageCount += matches.length;
    }
  }

  if (!hasGridForStructure) {
    return {
      id: "grid-first-layout",
      category: "layout",
      severity: "medium",
      passed: false,
      message: "Layout não usa CSS Grid para estrutura principal",
      suggestion: "Use CSS Grid para layout de página e seções; reserve flex para componentes internos"
    };
  }

  return {
    id: "grid-first-layout",
    category: "layout",
    severity: "medium",
    passed: true,
    message: `✓ Layout usa CSS Grid (${gridUsageCount} ocorrências)`
  };
}

/**
 * Verifica se o conteúdo está em português (não lorem ipsum ou inglês)
 */
function checkPortugueseContent(files: WebsiteFiles): QualityCheck {
  const tsxFiles = Object.entries(files).filter(([path]) => path.endsWith(".tsx"));

  // Detectar lorem ipsum
  for (const [path, content] of tsxFiles) {
    if (/lorem\s+ipsum/i.test(content)) {
      return {
        id: "portuguese-content",
        category: "content",
        severity: "medium",
        passed: false,
        message: `Lorem ipsum detectado em ${path}`,
        suggestion: "Use conteúdo real em português baseado no briefing do cliente"
      };
    }
  }

  // Detectar textos longos em inglês (mais de 10 palavras seguidas)
  const englishPattern = />\s*[A-Z][a-z]+(?:\s+[a-z]+){9,}\s*</;
  for (const [path, content] of tsxFiles) {
    if (englishPattern.test(content)) {
      return {
        id: "portuguese-content",
        category: "content",
        severity: "medium",
        passed: false,
        message: `Textos em inglês detectados em ${path}`,
        suggestion: "Todo conteúdo deve estar em português, não traduza literalmente do inglês"
      };
    }
  }

  return {
    id: "portuguese-content",
    category: "content",
    severity: "medium",
    passed: true,
    message: "✓ Conteúdo em português sem lorem ipsum"
  };
}

/**
 * Gera relatório formatado para exibição no terminal
 */
export function formatQualityReport(report: QualityReport): string {
  const lines: string[] = [];

  lines.push("═══════════════════════════════════════════════════════════");
  lines.push(`           RELATÓRIO DE QUALIDADE ANTI-IA`);
  lines.push(`                   Score: ${report.score}/100`);
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push("");

  lines.push(report.summary);
  lines.push("");

  const critical = report.checks.filter(c => c.severity === "critical");
  const high = report.checks.filter(c => c.severity === "high");
  const medium = report.checks.filter(c => c.severity === "medium");

  if (critical.length > 0) {
    lines.push("🔴 CHECKS CRÍTICOS:");
    for (const check of critical) {
      lines.push(`  ${check.passed ? "✓" : "✗"} ${check.message}`);
      if (!check.passed && check.suggestion) {
        lines.push(`    → ${check.suggestion}`);
      }
    }
    lines.push("");
  }

  if (high.length > 0) {
    lines.push("🟡 CHECKS HIGH:");
    for (const check of high) {
      lines.push(`  ${check.passed ? "✓" : "✗"} ${check.message}`);
      if (!check.passed && check.suggestion) {
        lines.push(`    → ${check.suggestion}`);
      }
    }
    lines.push("");
  }

  if (medium.length > 0) {
    lines.push("🔵 CHECKS MEDIUM:");
    for (const check of medium) {
      lines.push(`  ${check.passed ? "✓" : "✗"} ${check.message}`);
      if (!check.passed && check.suggestion) {
        lines.push(`    → ${check.suggestion}`);
      }
    }
    lines.push("");
  }

  lines.push("═══════════════════════════════════════════════════════════");

  return lines.join("\n");
}
