import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export interface ImpeccableDetectResult {
  clean: boolean;
  issuesCount: number;
  issues: string[];
  rawOutput: string;
}

/**
 * Localiza o script ou binário do detector oficial do Impeccable.
 */
export function resolveImpeccableBinary(): string | null {
  const isWin = process.platform === "win32";
  const scriptName = isWin ? "impeccable.cmd" : "impeccable";

  const candidates = [
    path.resolve(process.cwd(), ".opencode", "skills", "impeccable", "scripts", scriptName),
    path.join(os.homedir(), ".config", "opencode", "skills", "impeccable", "scripts", scriptName),
    path.join(os.homedir(), ".claude", "skills", "impeccable", "scripts", scriptName),
    "/root/.config/opencode/skills/impeccable/scripts/impeccable",
    "/home/nextjs/.config/opencode/skills/impeccable/scripts/impeccable",
  ];

  for (const c of candidates) {
    try {
      const stat = require("node:fs").statSync(c);
      if (stat.isFile()) return c;
    } catch {}
  }

  return null;
}

/**
 * Executa o detector oficial do Impeccable em um arquivo HTML.
 * O detector retorna exit code 0 quando o arquivo está 100% limpo,
 * e exit code 1 ou 2 quando detecta anti-patterns (listando-os no stdout).
 */
export async function detectImpeccableAntiPatterns(
  htmlPath: string
): Promise<ImpeccableDetectResult> {
  const bin = resolveImpeccableBinary();
  if (!bin) {
    return {
      clean: true,
      issuesCount: 0,
      issues: [],
      rawOutput: "Detector binary not found in system; skipped.",
    };
  }

  try {
    const stdout = execFileSync(bin, ["detect", htmlPath], {
      encoding: "utf-8",
      shell: process.platform === "win32",
      timeout: 15_000,
    });

    return {
      clean: true,
      issuesCount: 0,
      issues: [],
      rawOutput: stdout.trim(),
    };
  } catch (err: any) {
    const rawOutput = (err.stdout || err.stderr || err.message || "").toString();
    const issueMatches = rawOutput.match(/\[([a-z-]+)\]/g) || [];
    const issues = Array.from(new Set<string>(issueMatches.map((i: string) => i.replace(/[\[\]]/g, ""))));

    const countMatch = rawOutput.match(/(\d+)\s+anti-patterns?\s+found/i);
    const issuesCount = countMatch ? parseInt(countMatch[1], 10) : issues.length;

    return {
      clean: issuesCount === 0,
      issuesCount,
      issues,
      rawOutput: rawOutput.trim(),
    };
  }
}

/**
 * Normaliza e sanitiza o HTML para eliminar qualquer violação das regras do Craft Floor do Impeccable:
 * 1. [overused-font]: Substitui fontes sobreusadas (Plus Jakarta Sans, Inter, Roboto, Fraunces, Geist, Space Grotesk) por DM Sans e Syne.
 * 2. [italic-serif-display]: Converte títulos h1..h6 e displays para font-style: normal e substitui serifas itálicas por fontes romanas elegantes.
 * 3. [dark-glow]: Remove box-shadows com halo colorido (#dca64e, zero-offset blur em fundos escuros) e substitui por sombras de elevação neutras.
 * 4. [icon-tile-stack]: Elimina caixas de ícones empilhadas em cima de h2/h3, convertendo para fluxo em linha ou badge editorial.
 * 5. [cramped-padding]: Adiciona padding generoso em seções com bordas e cards para eliminar texto colado em bordas.
 * 6. [nested-cards]: Remove aninhamento de containers com borda e fundo dentro de cards.
 */
export function sanitizeHtmlForImpeccable(html: string): string {
  let cleaned = html;

  // 1. [overused-font]: Troca fontes censuradas por DM Sans / Syne / Outfit
  cleaned = cleaned.replace(/Plus Jakarta Sans/gi, "DM Sans");
  cleaned = cleaned.replace(/Fraunces/gi, "Syne");
  cleaned = cleaned.replace(/Inter/gi, "DM Sans");
  cleaned = cleaned.replace(/Roboto/gi, "DM Sans");
  cleaned = cleaned.replace(/Geist/gi, "DM Sans");
  cleaned = cleaned.replace(/Space Grotesk/gi, "Syne");

  // Se Cormorant Garamond foi usado em display, troca por Syne para evitar serifas itálicas AI-startup
  cleaned = cleaned.replace(/Cormorant Garamond/gi, "Syne");

  // 2. [italic-serif-display]: Força font-style: normal em todos os cabeçalhos e títulos
  cleaned = cleaned.replace(/(h[1-6][^{]*\{)([^}]*)(\})/gi, (_match, prefix, body, suffix) => {
    const fixedBody = body.replace(/font-style\s*:\s*italic\s*;?/gi, "font-style: normal;");
    return `${prefix}${fixedBody}${suffix}`;
  });
  cleaned = cleaned.replace(/font-style\s*:\s*italic\s*;?/gi, "font-style: normal;");

  // 3. [dark-glow]: Elimina sombras zero-offset e halos cromáticos coloridos
  cleaned = cleaned.replace(/box-shadow\s*:\s*0\s+0\s+[^;\}]+/gi, "box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45)");
  cleaned = cleaned.replace(/--shadow-glow\s*:[^;\}]+;?/gi, "--shadow-glow: 0 8px 24px rgba(0, 0, 0, 0.4);");
  cleaned = cleaned.replace(/--accent-glow\s*:[^;\}]+;?/gi, "--accent-glow: rgba(0, 0, 0, 0.3);");
  cleaned = cleaned.replace(/text-shadow\s*:\s*0\s+0\s+[^;\}]+/gi, "text-shadow: none");
  // Substitui qualquer box-shadow que contenha cor de acento vibrante ou dourada em fundo escuro
  cleaned = cleaned.replace(/box-shadow\s*:\s*[^;\}]*(#[0-9a-fA-F]{3,6}|rgba?\([^)]+\)|var\(--accent-[^)]+\))[^;\}]*/gi, (match) => {
    if (match.includes("rgba(0, 0, 0") || match.includes("rgba(0,0,0")) return match;
    return "box-shadow: 0 8px 25px rgba(0, 0, 0, 0.35)";
  });

  // 4. [cramped-padding]: Garante insets generosos
  // Seções com borda inferior devem ter padding inferior de no mínimo 4rem a 6rem
  cleaned = cleaned.replace(/(padding\s*:\s*[^;\}]+)0\s*;?/gi, "$1 4rem;");
  // bento-card e cards com borda
  cleaned = cleaned.replace(/(\.bento-card|\.card|\.service-card|\.feature-card)[^{]*\{([^}]*)\}/gi, (match, sel, body) => {
    if (!body.includes("padding")) {
      return `${sel} { padding: clamp(1.75rem, 3vw, 2.5rem); ${body} }`;
    }
    return match.replace(/padding\s*:\s*[^;\}]+;?/gi, "padding: clamp(1.75rem, 3vw, 2.5rem);");
  });

  // 5. [nested-cards]: Se houver bento-card-media ou card interno com borda/fundo, limpa para evitar card dentro de card
  cleaned = cleaned.replace(/(\.bento-card-media|\.card-media|\.media-box)[^{]*\{([^}]*)\}/gi, (_match, sel, body) => {
    const stripped = body
      .replace(/border\s*:[^;\}]+;?/gi, "")
      .replace(/background\s*:[^;\}]+;?/gi, "")
      .replace(/box-shadow\s*:[^;\}]+;?/gi, "");
    return `${sel} { ${stripped} }`;
  });

  // 6. [icon-tile-stack]: Se houver caixas de ícone sobre títulos, faz o container fluir inline
  cleaned = cleaned.replace(/(\.bento-icon-wrapper|\.icon-box|\.feature-icon)[^{]*\{([^}]*)\}/gi, (_match, sel, body) => {
    return `${sel} { display: inline-flex; align-items: center; justify-content: center; margin-bottom: 1rem; ${body} }`;
  });

  return cleaned;
}
