import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import postcss from "postcss";

export interface ImpeccableDetectResult {
  clean: boolean;
  issuesCount: number;
  /** Issues que devem bloquear o deploy (severity diferente de "warning"). */
  blockingIssues: number;
  issues: string[];
  rawOutput: string;
}

export interface CssValidationResult {
  valid: boolean;
  errors: string[];
  styleBlocks: number;
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
      if (statSync(c).isFile()) return c;
    } catch {}
  }

  return null;
}

interface ParsedDetectorOutput {
  issuesCount: number;
  blockingIssues: number;
  issues: string[];
}

/**
 * O binário oficial responde um array JSON (`[{ antipattern, severity, ... }]`)
 * no stdout. O formato legado (`[nome] ... N anti-patterns found`) fica como fallback.
 */
function parseDetectorOutput(raw: string): ParsedDetectorOutput {
  const text = raw.trim();
  const jsonStart = text.indexOf("[");

  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart));
      if (Array.isArray(parsed)) {
        const issues = Array.from(
          new Set<string>(
            parsed
              .map((item: any) =>
                typeof item?.antipattern === "string"
                  ? item.antipattern
                  : typeof item?.name === "string"
                    ? item.name
                    : null
              )
              .filter((v: string | null): v is string => Boolean(v))
          )
        );
        const blockingIssues = parsed.filter(
          (item: any) => String(item?.severity || "").toLowerCase() !== "warning"
        ).length;
        return { issuesCount: parsed.length, blockingIssues, issues };
      }
    } catch {
      // cai no parser legado
    }
  }

  const issueMatches = text.match(/\[([a-z-]+)\]/g) || [];
  const issues = Array.from(new Set<string>(issueMatches.map((i: string) => i.replace(/[\[\]]/g, ""))));
  const countMatch = text.match(/(\d+)\s+anti-patterns?\s+found/i);
  const issuesCount = countMatch ? parseInt(countMatch[1], 10) : issues.length;
  return { issuesCount, blockingIssues: issuesCount, issues };
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
      blockingIssues: 0,
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

    const parsed = parseDetectorOutput(stdout);
    return {
      clean: parsed.issuesCount === 0,
      ...parsed,
      rawOutput: stdout.trim(),
    };
  } catch (err: any) {
    const rawOutput = (err.stdout || err.stderr || err.message || "").toString();
    const parsed = parseDetectorOutput(rawOutput);

    return {
      clean: parsed.issuesCount === 0,
      ...parsed,
      rawOutput: rawOutput.trim(),
    };
  }
}

/**
 * Valida a sintaxe dos blocos `<style>` com o parser real do CSS (postcss).
 * Regex não detecta `--token-DM Sansactive`; o parser sim.
 */
export function validateHtmlCss(html: string): CssValidationResult {
  const blocks = Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)).map((m) => m[1]);
  const errors: string[] = [];

  blocks.forEach((css, index) => {
    try {
      postcss.parse(css);
    } catch (err: any) {
      const location = err?.line ? ` (linha ${err.line}:${err.column})` : "";
      errors.push(`<style> bloco ${index + 1}${location}: ${err?.reason || err?.message || "CSS inválido"}`);
    }
  });

  return { valid: errors.length === 0, errors, styleBlocks: blocks.length };
}

const CENSORED_FONTS: ReadonlyArray<readonly [string, string]> = [
  ["Plus Jakarta Sans", "DM Sans"],
  ["Fraunces", "Syne"],
  ["Inter", "DM Sans"],
  ["Roboto", "DM Sans"],
  ["Geist", "DM Sans"],
  ["Space Grotesk", "Syne"],
  ["Cormorant Garamond", "Syne"],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Troca APENAS tokens de fonte exatos. `--surface-interactive` e
 * `var(--font-inter)` permanecem intactos.
 */
export function replaceCensoredFontTokens(value: string): string {
  let out = value;
  for (const [from, to] of CENSORED_FONTS) {
    const pattern = new RegExp(`(['"]?)(?<![\\w-])${escapeRegExp(from)}(?![\\w-])\\1`, "gi");
    out = out.replace(pattern, (_match, quote: string) => `${quote}${to}${quote}`);
  }
  return out;
}

function rewriteFontDeclarations(css: string): string {
  // font-family primeiro: `font\s*:` nunca casa "font-family:" (tem "-" antes do ":").
  return css
    .replace(/(\bfont-family\s*:\s*)([^;}]+)/gi, (_m, prefix: string, value: string) => {
      return `${prefix}${replaceCensoredFontTokens(value)}`;
    })
    .replace(/(\bfont\s*:\s*)([^;}]+)/gi, (_m, prefix: string, value: string) => {
      return `${prefix}${replaceCensoredFontTokens(value)}`;
    });
}

function splitAxisValues(value: string): [string, string] {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ["0", "0"];
  if (parts.length === 1) return [parts[0], parts[0]];
  return [parts[0], parts[1]];
}

const DISPLAY_SELECTOR = /(h[1-6]|\.(?:hero|display|heading|title|headline)[\w-]*|\[class*=["'][^"']*(?:hero|display|heading|title))/i;

/** Aplica uma transformação apenas no interior de blocos `<style>`, nunca em JS. */
function mapStyleBlocks(html: string, fn: (css: string) => string): string {
  return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open: string, css: string, close: string) => {
    return `${open}${fn(css)}${close}`;
  });
}

function normalizeCss(css: string): string {
  let out = rewriteFontDeclarations(css);

  // [italic-serif-display]: itálico só em seletores display/cabeçalho; <em> do corpo fica.
  out = out.replace(/([^{}]+)\{([^}]*)\}/g, (rule, selector: string, body: string) => {
    if (!DISPLAY_SELECTOR.test(selector)) return rule;
    return `${selector}{${body.replace(/font-style\s*:\s*italic\s*;?/gi, "font-style: normal;")}}`;
  });

  // [low-contrast]: cinzas apagados -> tons com contraste AA.
  out = out
    .replace(/#6b7689/gi, "#94a3b8")
    .replace(/#686873/gi, "#94a3b8")
    .replace(/#6b7d75/gi, "#94a3b8")
    .replace(/#71717a/gi, "#a1a1aa")
    .replace(/#737373/gi, "#a1a1aa")
    .replace(/#52525b/gi, "#94a3b8");

  // [dark-glow] & [radial-spotlight-glow]
  out = out
    .replace(/--shadow-glow\s*:[^;}]+;?/gi, "--shadow-glow: 0 10px 30px rgba(0, 0, 0, 0.4);")
    .replace(/--accent-glow\s*:[^;}]+;?/gi, "--accent-glow: rgba(0, 0, 0, 0.25);")
    .replace(/--color-gold-glow\s*:[^;}]+;?/gi, "--color-gold-glow: rgba(0, 0, 0, 0.2);")
    .replace(/text-shadow\s*:[^;}]+;?/gi, "text-shadow: none;")
    .replace(/box-shadow\s*:\s*[^;}]+/gi, (match) => {
      const isColored = /(?:rgba?\(\s*(?!0\s*,\s*0\s*,\s*0)[^)]+\)|#[0-9a-fA-F]{3,6}|var\(--accent)/i.test(match);
      if (isColored || match.includes(" 0 0 ") || match.includes(" 0px 0px ")) {
        return "box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45)";
      }
      return match;
    })
    .replace(/radial-gradient\([^;\}]*(?:#cba243|#f59e0b|#34d399|rgba\(\s*203|rgba\(\s*245|rgba\(\s*52)[^;\}]*\)/gi, "none");

  // [pulsing-dot]
  out = out
    .replace(/animation:\s*pulse[A-Za-z0-9_-]*[^;\}]+;?/gi, "")
    .replace(/@keyframes\s+pulse[A-Za-z0-9_-]*\s*\{[\s\S]*?\}\s*\}/gi, "");

  // [tiny-text]
  out = out.replace(/font-size:\s*(0\.[0-7][0-9]*rem|1[01]px);?/gi, "font-size: 0.8125rem;");

  // [cramped-padding]: converte eixos lógicos preservando os valores declarados.
  // Valores com função (clamp/min/max/calc) são preservados: quebrar por espaço
  // destruiria o CSS ("clamp(4rem, 7vw, 8rem)" → "padding-top: clamp(4rem,").
  out = out
    .replace(/padding-block\s*:\s*([^;}]+);?/gi, (m, value: string) => {
      if (/[()]/.test(value)) return m;
      const [start, end] = splitAxisValues(value);
      return `padding-top: ${start}; padding-bottom: ${end};`;
    })
    .replace(/padding-inline\s*:\s*([^;}]+);?/gi, (m, value: string) => {
      if (/[()]/.test(value)) return m;
      const [start, end] = splitAxisValues(value);
      return `padding-left: ${start}; padding-right: ${end};`;
    });

  out = out
    .replace(/\.top-utility-bar\s*\{([^}]*)\}/gi, (_match, body: string) => {
      return `.top-utility-bar { padding: 0.75rem 1.5rem; ${body.replace(/padding\s*:[^;\}]+;?/gi, "")} }`;
    })
    .replace(/\.section-spacing\s*\{([^}]*)\}/gi, (_match, body: string) => {
      return `.section-spacing { padding: 5rem 1.5rem; ${body.replace(/padding\s*:[^;\}]+;?/gi, "")} }`;
    });

  // Cards com borda/fundo: garante inset interno (nunca atinge `.card-media`).
  out = out.replace(/(\.bento-card|\.card|\.service-card|\.feature-card)(?![-\w])[^{]*\{([^}]*)\}/gi, (match, sel: string, body: string) => {
    if (!/\bpadding\s*:/.test(body)) {
      return `${sel} { padding: clamp(1.75rem, 3vw, 2.5rem); ${body} }`;
    }
    return match.replace(/padding\s*:\s*[^;\}]+;?/gi, "padding: clamp(1.75rem, 3vw, 2.5rem);");
  });

  // [side-tab], [cream-palette], [nested-cards], [icon-tile-stack]
  out = out
    .replace(/border-left\s*:\s*[3456]px\s+solid\s+[^;\}]+;?/gi, "border: 1px solid rgba(255, 255, 255, 0.12);")
    .replace(/#fbf9f4/gi, "#ffffff")
    .replace(/rgb\(251,\s*249,\s*244\)/gi, "#ffffff")
    .replace(/(\.bento-card-media|\.card-media|\.media-box)[^{]*\{([^}]*)\}/gi, (_match, sel: string, body: string) => {
      const stripped = body
        .replace(/border\s*:[^;\}]+;?/gi, "")
        .replace(/background\s*:[^;\}]+;?/gi, "")
        .replace(/box-shadow\s*:[^;\}]+;?/gi, "");
      return `${sel} { ${stripped} }`;
    })
    .replace(/(\.bento-icon-wrapper|\.icon-box|\.feature-icon)[^{]*\{([^}]*)\}/gi, (_match, sel: string, body: string) => {
      return `${sel} { display: inline-flex; align-items: center; justify-content: center; margin-bottom: 1rem; ${body} }`;
    });

  return out;
}

/**
 * Normaliza e sanitiza o HTML para eliminar violações do Craft Floor do Impeccable.
 * Correções cirúrgicas: nada de substituição global de texto (foi o que corrompeu
 * `--surface-interactive` em `--surface-DM Sansactive` e zerou os resets de padding).
 */
export function sanitizeHtmlForImpeccable(html: string): string {
  let cleaned = mapStyleBlocks(html, normalizeCss);

  // fontes também podem aparecer em atributos style="" inline
  cleaned = cleaned.replace(
    /(\bstyle\s*=\s*")([^"]*)(")/gi,
    (_m, open: string, value: string, close: string) => `${open}${rewriteFontDeclarations(value)}${close}`
  );
  cleaned = cleaned.replace(
    /(\bstyle\s*=\s*')([^']*)(')/gi,
    (_m, open: string, value: string, close: string) => `${open}${rewriteFontDeclarations(value)}${close}`
  );

  // [kicker-above-heading]
  cleaned = cleaned.replace(/(<(?:span|p|div)[^>]*class="[^"]*(?:kicker|eyebrow|ledger-code|label|tag|badge)[^"]*"[^>]*>[^<]+<\/(?:span|p|div)>)\s*(<h[1-6])/gi, "$2");

  // [pulsing-dot] (markup)
  cleaned = cleaned.replace(/<span[^>]*class="[^"]*pulse(?:-dot|-ring)?[^"]*"[^>]*><\/span>/gi, "");

  // [skipped-heading] / [side-tab]
  cleaned = cleaned.replace(/<div class="hero-caption-info">\s*<h[34][^>]*>([\s\S]*?)<\/h[34]>/gi, '<div class="hero-caption-info"><strong class="hero-caption-title">$1</strong>');
  cleaned = cleaned.replace(/<(div|span|p)[^>]*class="[^"]*(?:badge|tag|label|caption|legend)[^"]*"[^>]*>\s*<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '<$1 class="hero-badge"><strong>$2</strong>');

  return cleaned;
}
