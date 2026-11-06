import postcss from "postcss";
import { validateHtmlCss } from "./impeccable-detector";

export interface QualityViolation {
  code: string;
  message: string;
}

export interface StaticScanOptions {
  /** Ativa a exigência de fotos reais de ./fotos/ (só quando o workspace tem fotos). */
  requirePhotos?: boolean;
}

const BANNED_FONT_TOKENS = ["Inter", "Roboto", "Fraunces", "Geist", "Space Grotesk", "Plus Jakarta Sans"];
const PHOTO_REF = /fotos\/foto-\d+\.(?:jpe?g|png|webp)/gi;
/** Motions obrigatórios pelo pipeline (pedido do produto). */
const REQUIRED_EASING = /cubic-bezier\(\s*0?\.16\s*,\s*1\s*,\s*0?\.3\s*,\s*1\s*\)/i;

function extractStyleCss(html: string): string {
  return Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    .map((m) => m[1])
    .join("\n");
}

function isZeroValue(value: string): boolean {
  return /^0+(?:\.0+)?(?:px|rem|em|%|vh|vw)?$/.test(value.trim());
}

function isUniversalReset(selector: string): boolean {
  return selector
    .split(",")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .some((part) => /^\*(?:::(?:before|after))?$/.test(part));
}

function findBannedFonts(css: string): string[] {
  const found = new Set<string>();
  const declarationRe = /\bfont(?:-family)?\s*:\s*([^;}]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = declarationRe.exec(css)) !== null) {
    const value = match[1];
    for (const font of BANNED_FONT_TOKENS) {
      const tokenRe = new RegExp(`(?<![\\w-])${font.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
      if (tokenRe.test(value)) found.add(font);
    }
  }
  return Array.from(found);
}

/**
 * Camada 2 — scanner estático (sem browser): sintaxe CSS real + regras de
 * movimento e de layout que o detector oficial do Impeccable não cobre.
 */
export function scanHtmlStatic(html: string, options: StaticScanOptions = {}): QualityViolation[] {
  const violations: QualityViolation[] = [];
  const css = extractStyleCss(html);
  const cssValidation = validateHtmlCss(html);

  if (!cssValidation.valid) {
    violations.push({
      code: "css-invalid",
      message: `O CSS interno não parseia e o navegador descarta o stylesheet inteiro: ${cssValidation.errors.join(" | ")}`,
    });
    // Sem CSS válido não há como avaliar as demais regras de estilo com segurança.
    return violations;
  }

  // Reset universal com padding: sintoma exato do sanitizador antigo (`* { padding: 4rem }`).
  try {
    const root = postcss.parse(css);
    root.walkRules((rule) => {
      if (!isUniversalReset(rule.selector)) return;
      rule.walkDecls(/^padding/, (decl) => {
        if (!isZeroValue(decl.value)) {
          violations.push({
            code: "universal-padding",
            message: `Reset universal "${rule.selector.trim()}" com ${decl.prop}: ${decl.value}. Use 0 e aplique espaçamento apenas em containers/seções.`,
          });
        }
      });
    });
  } catch {
    // já foi sinalizado por css-invalid
  }

  const bannedFonts = findBannedFonts(css);
  if (bannedFonts.length > 0) {
    violations.push({
      code: "banned-font",
      message: `Fontes proibidas pelo Craft Floor: ${bannedFonts.join(", ")}. Use DM Sans + Syne/Outfit.`,
    });
  }

  if (!/@keyframes\s+[\w-]+/i.test(css)) {
    violations.push({
      code: "missing-keyframes",
      message: "Nenhum @keyframes no CSS. Exija pelo menos duas animações nomeadas (reveal e microinteração).",
    });
  }

  if (!/IntersectionObserver/.test(html)) {
    violations.push({
      code: "missing-scroll-reveal",
      message: "Sem IntersectionObserver: não há revelação progressiva por scroll. Adicione o observer que aplica a classe de reveal em [data-reveal].",
    });
  }

  if (!REQUIRED_EASING.test(css)) {
    violations.push({
      code: "missing-easing",
      message: "Falta a curva de movimento obrigatória cubic-bezier(0.16, 1, 0.3, 1) nas transições/animações.",
    });
  }

  if (!/@media\s*\([^)]*prefers-reduced-motion/i.test(css)) {
    violations.push({
      code: "missing-reduced-motion",
      message: "Falta @media (prefers-reduced-motion: reduce) desativando animações e transições.",
    });
  }

  if (options.requirePhotos) {
    const refs = new Set((html.match(PHOTO_REF) || []).map((r) => r.toLowerCase()));
    if (refs.size < 3) {
      violations.push({
        code: "missing-real-photos",
        message: `Apenas ${refs.size} foto(s) real(is) de ./fotos/ usadas. Distribua no mínimo 3 fotos distintas entre hero, serviços e galeria.`,
      });
    }
  }

  return violations;
}

/**
 * Extrai os achados element-level do detector oficial (stdout do Impeccable).
 * O stdout traz linhas no formato "[anti-pattern] <seletor> \"motivo\"" seguidas
 * de uma linha "→ ..." com a explicação. Isso vira texto de correção acionável.
 */
export function summarizeDetectorFindings(rawOutput: string, maxItems = 40): string {
  const lines = rawOutput.split(/\r?\n/);
  const groups = new Map<string, { selectors: string[]; explanation: string }>();
  let total = 0;

  for (let i = 0; i < lines.length && total < maxItems; i++) {
    const line = lines[i].trim();
    const match = line.match(/^\[([a-z0-9-]+)\]\s*(.*)$/);
    if (!match) continue;

    const [, code, rest] = match;
    const explanation = (lines[i + 1] || "").trim();
    const selector = rest.split(/[:—]/)[0].trim() || rest.trim();
    const group = groups.get(code) ?? { selectors: [], explanation: "" };
    if (group.selectors.length < 40) group.selectors.push(selector);
    if (!group.explanation && explanation.startsWith("→")) group.explanation = explanation;
    groups.set(code, group);
    total += 1;
  }

  return Array.from(groups.entries())
    .map(([code, group]) => {
      const list = Array.from(new Set(group.selectors)).join(", ");
      return `[${code}] ${group.selectors.length} ocorrência(s): ${list}\n  ${group.explanation}`;
    })
    .join("\n");
}

/**
 * Prompt de correção cirúrgica enviado ao OpenCode quando o gate reprova.
 * Pede correção do arquivo existente — não uma nova geração do zero.
 */
export function buildQualityCorrectionPrompt(
  violations: QualityViolation[],
  attempt: number,
  maxLoops: number
): string {
  return [
    `# CORREÇÃO OBRIGATÓRIA (tentativa ${attempt}/${maxLoops})`,
    "",
    "O 'index.html' que você gerou foi REPROVADO na inspeção automática de layout e movimento.",
    "Edite o 'index.html' EXISTENTE e corrija TODAS as violações listadas abaixo.",
    "Preserve o conteúdo real do negócio, as fotos de ./fotos/ e a identidade visual já criada.",
    "Não recomece do zero e não troque a arquitetura da página.",
    "",
    "## Violações a corrigir",
    ...violations.map((v, i) => `${i + 1}. [${v.code}] ${v.message}`),
    "",
    "## Contrato de movimento inegociável",
    "- Pelo menos 2 blocos `@keyframes` nomeados e realmente usados.",
    "- Revelação por scroll com `IntersectionObserver` aplicando a classe `.is-visible` em `[data-reveal]`.",
    "- Curva padrão `cubic-bezier(0.16, 1, 0.3, 1)` nas transições de entrada.",
    "- `@media (prefers-reduced-motion: reduce)` desativando animações e transições.",
    "- Nada de pulso infinito em bolinhas de status.",
    "",
    "## Contrato de layout",
    "- `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }` — padding zero no reset.",
    "- Padding generoso apenas em containers/seções/cards; nunca em elementos de texto soltos.",
    "- `html, body { overflow-x: hidden; width: 100%; }` e `img { max-width: 100%; height: auto; }`.",
    "- Botões com padding entre 0.75rem e 1.25rem vertical; nada de botões gigantes.",
    "- Nenhum elemento pode passar da largura da viewport em 375px.",
    "",
    "## Anti-patterns do detector oficial que reprovaram a página",
    "- `cramped-padding`: texto encostando em borda/fundo do container. Qualquer container com",
    "  borda, outline ou fundo visível que contenha texto precisa de padding interno de pelo",
    "  menos 12px (16px ideal). Vale para sections, cards, listas, linhas de horário, rodapé e",
    "  blocos com border-bottom. Se a borda é decorativa, remova a borda em vez de encostar o texto.",
    "- `undersized-ui-text`: nenhum texto útil (labels, legendas, badges, meta) abaixo de 12px.",
    "  Texto secundário mínimo 12px, labels 12–13px, corpo 16px.",
    "- `marquee`: nenhum loop horizontal infinito (ticker/marquee). Exiba a faixa de forma estática",
    "  (grid/flex com quebra) ou com animação de entrada pontual, nunca infinita.",
    "",
    "Corrija com edições cirúrgicas no CSS/HTML existente. Não reescreva a página inteira.",
  ].join("\n");
}
