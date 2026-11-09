/**
 * Motor Anti-Ban de Variação Semântica & Sincronização de Saudação por Horário Real.
 *
 * Resolve 3 problemas críticos de disparos no WhatsApp:
 *   1. Saudação sempre sincronizada com a HORA EXATA do envio no WhatsApp (fuso SP),
 *      mesmo que a mensagem tenha sido pré-gerada horas antes (ex: de madrugada).
 *   2. Limpeza de nomes "robóticos" do Google Maps (remove " - ...", " | ...", "LTDA", etc.)
 *      para que a chamada da empresa pareça digitada por um humano.
 *   3. Misturador Anti-Ban: varia a estrutura sintática de "{{saudacao}}! Tudo bem? {{nome_empresa}}?"
 *      em dezenas de combinações humanas equivalentes (sem alterar o sentido e sem parecer
 *      oferta comercial), evitando detecção por hash/similaridade na Meta.
 */

import { greetingFor } from "./template-vars";

/** Histórico recente por escopo (campanha/instância) para não repetir a mesma estrutura seguida. */
const recentPatternHistory = new Map<string, number[]>();
const MAX_RECENT_HISTORY = 12;

/** Reset apenas para testes unitários. */
export function __resetAntiBanHistoryForTests(): void {
  recentPatternHistory.clear();
}

/**
 * Retorna a hora atual (0..23) no fuso de Brasília (America/Sao_Paulo).
 */
export function getSaoPauloHour(date: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      hour12: false,
    }).format(date)
  ) % 24;
}

/**
 * Se a pré-geração estiver rodando fora da janela permitida (ex: 00h30 quando a
 * janela é 8h–18h), retorna uma Date ajustada para o horário de abertura da janela
 * (`allowedStartHour`), garantindo que a pré-geração já use a saudação correta
 * de quando o disparo vai começar.
 */
export function effectiveDateForWindow(
  now: Date = new Date(),
  allowedStartHour?: number | null,
  allowedEndHour?: number | null
): Date {
  if (
    allowedStartHour === undefined ||
    allowedStartHour === null ||
    allowedEndHour === undefined ||
    allowedEndHour === null
  ) {
    return now;
  }

  const currentHour = getSaoPauloHour(now);
  const inWindow =
    allowedStartHour <= allowedEndHour
      ? currentHour >= allowedStartHour && currentHour < allowedEndHour
      : currentHour >= allowedStartHour || currentHour < allowedEndHour;

  if (inWindow) return now;

  // Fora da janela: avança o relógio de referência para `allowedStartHour`
  const diffHours = (allowedStartHour - currentHour + 24) % 24;
  return new Date(now.getTime() + diffHours * 60 * 60 * 1000);
}

/**
 * Sincroniza qualquer saudação presente no texto ("Boa madrugada", "Bom dia",
 * "Boa tarde", "Boa noite" ou a variável "{{saudacao}}") com o horário REAL
 * do momento do disparo, preservando a capitalização original (Maiúscula, minúscula ou CAIXA ALTA).
 */
export function syncGreetingToCurrentHour(text: string, now: Date = new Date()): string {
  if (!text) return text;
  const correctGreeting = greetingFor(now); // Ex: "Bom dia" | "Boa tarde" | "Boa noite" | "Boa madrugada"
  const lowerGreeting = correctGreeting.toLowerCase();
  const upperGreeting = correctGreeting.toUpperCase();

  // 1. Substitui variáveis explícitas caso ainda existam
  let result = text
    .replace(/\{\{\s*saudacao\s*\}\}/gi, correctGreeting)
    .replace(/\{\s*saudacao\s*\}/gi, correctGreeting);

  // 2. Substitui saudações literais já renderizadas na pré-geração ou pela IA
  result = result.replace(
    /\b(boa\s+madrugada|bom\s+dia|boa\s+tarde|boa\s+noite)\b/gi,
    (match) => {
      if (match === match.toUpperCase()) return upperGreeting;
      const firstChar = match.charAt(0);
      if (firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase()) {
        return correctGreeting;
      }
      return lowerGreeting;
    }
  );

  return result;
}

/**
 * Limpa o nome da empresa vindo do Google Maps para uso natural em conversa humana.
 * Ex:
 *   "Vidraçaria Silva - Box, Espelhos e Esquadrias LTDA" -> "Vidraçaria Silva"
 *   "ADVOCACIA MEDEIROS | Advogado Trabalhista" -> "Advocacia Medeiros"
 */
export function cleanCompanyNameForApproach(rawName: string | null | undefined): string {
  if (!rawName) return "";
  let name = String(rawName).trim();
  if (!name) return "";

  // 1. Corta slogans/caudas de SEO após separadores comuns (" - ", " | ", " — ", " – ", " • ")
  const separators = [" - ", " – ", " — ", " | ", " • ", " :: ", ": "];
  for (const sep of separators) {
    const idx = name.indexOf(sep);
    if (idx >= 3) {
      name = name.slice(0, idx).trim();
    }
  }

  // 2. Remove sufixos societários formais que nenhum humano fala no WhatsApp
  name = name
    .replace(/\b(LTDA\.?|MEI|EIRELI|EPP|S\/A|S\.A\.|CIA\.?)\b/gi, "")
    .replace(/\s+-\s*ME\s*$/i, "")
    .replace(/[.,;:\-|/]+\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // 3. Se o nome inteiro estiver em CAIXA ALTA (e tiver > 4 letras), converte para Title Case natural
  const lettersOnly = name.replace(/[^a-zA-ZÀ-ÿ]/g, "");
  if (lettersOnly.length > 4 && name === name.toUpperCase()) {
    const lowerWords = new Set(["de", "da", "do", "das", "dos", "e", "em", "para", "com"]);
    name = name
      .toLowerCase()
      .split(" ")
      .map((word, index) => {
        if (index > 0 && lowerWords.has(word)) return word;
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(" ");
  }

  return name;
}

/**
 * Detecta se o template é o modelo curto de abordagem inicial (quebra-gelo sem oferta)
 * ou equivalente a "{{saudacao}}! Tudo bem? {{nome_empresa}}?".
 */
export function isShortIcebreakerTemplate(template: string): boolean {
  const norm = String(template || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!norm) return false;
  // Se for curto (até 90 chars) e contiver saudacao/tudo bem/nome_empresa
  if (norm.length <= 95 && (norm.includes("tudo bem") || norm.includes("tudo certo") || norm.includes("saudacao"))) {
    return true;
  }
  return false;
}

export const isDefaultApproachTemplate = isShortIcebreakerTemplate;

type ApproachPattern = (gCap: string, gLow: string, company: string) => string;

/**
 * 24 estruturas sintáticas humanas que mantêm 100% o mesmo sentido de
 * "{{saudacao}}! Tudo bem? {{nome_empresa}}?" sem parecer oferta comercial.
 */
const WITH_COMPANY_PATTERNS: ApproachPattern[] = [
  // Ordem 1: Saudação -> Tudo bem -> Empresa (pontuações e conectivos variados)
  (G, _g, c) => `${G}! Tudo bem? ${c}?`,
  (G, _g, c) => `${G}! Tudo bem? É da ${c}?`,
  (G, _g, c) => `${G}, tudo bem? É da ${c}?`,
  (G, _g, c) => `${G}! Tudo certo? Falo com a ${c}?`,
  (G, _g, c) => `${G}, tudo joia? Aí é da ${c}?`,
  (G, _g, c) => `${G}! Tudo tranquilo? É o WhatsApp da ${c}?`,
  (_G, g, c) => `Oi, ${g}! Tudo bem? ${c}?`,
  (_G, g, c) => `Oi, ${g}! Tudo bem? É da ${c}?`,
  (_G, g, c) => `Oi, ${g}, tudo certo? Falo com a ${c}?`,
  (_G, g, c) => `Olá, ${g}! Tudo bem? É da ${c}?`,
  (_G, g, c) => `Olá, ${g}, tudo bem por aí? ${c}?`,
  (_G, g, c) => `Opa, ${g}! Tudo bem? Aí é da ${c}?`,
  (_G, g, c) => `Opa, ${g}, tudo certo? É da ${c}?`,
  (G, _g, c) => `${G}! Como vai? É da ${c}?`,
  (G, _g, c) => `${G}, tudo bem por aí? Falo com o pessoal da ${c}?`,
  (_G, g, c) => `Olá, ${g}! Tudo tranquilo? Falo com a ${c}?`,

  // Ordem 2: Saudação + Confirmação da Empresa -> Tudo bem
  (G, _g, c) => `${G}! É da ${c}? Tudo bem?`,
  (G, _g, c) => `${G}, falo com a ${c}? Tudo certo?`,
  (_G, g, c) => `Oi, ${g}! É da ${c}? Tudo bem?`,
  (_G, g, c) => `Olá, ${g}! Falo com a ${c}? Tudo bem por aí?`,
  (G, _g, c) => `${G}! ${c}? Tudo bem?`,
  (_G, g, c) => `Opa, ${g}! Aí é da ${c}? Tudo joia?`,

  // Ordem 3: Duas linhas naturais (quebra humana de balão/parágrafo)
  (G, _g, c) => `${G}! Tudo bem?\n\nÉ da ${c}?`,
  (_G, g, c) => `Oi, ${g}, tudo certo?\n\nFalo com a ${c}?`,
];

const WITHOUT_COMPANY_PATTERNS: Array<(gCap: string, gLow: string) => string> = [
  (G) => `${G}! Tudo bem?`,
  (G) => `${G}, tudo bem por aí?`,
  (_G, g) => `Oi, ${g}! Tudo bem?`,
  (_G, g) => `Olá, ${g}! Tudo certo?`,
  (_G, g) => `Opa, ${g}, tudo tranquilo?`,
  (G) => `${G}! Tudo joia?`,
];

function pickNonRepeatingIndex(scopeKey: string, total: number, deterministicIndex?: number): number {
  if (typeof deterministicIndex === "number" && deterministicIndex >= 0) {
    return deterministicIndex % total;
  }
  const history = recentPatternHistory.get(scopeKey) || [];
  const candidates: number[] = [];
  for (let i = 0; i < total; i++) {
    if (!history.includes(i)) candidates.push(i);
  }
  const pool = candidates.length > 0 ? candidates : Array.from({ length: total }, (_, i) => i);
  const chosen = pool[Math.floor(Math.random() * pool.length)];

  const updated = [...history, chosen].slice(-Math.min(MAX_RECENT_HISTORY, Math.max(1, total - 2)));
  recentPatternHistory.set(scopeKey, updated);
  return chosen;
}

/**
 * Aplica o Misturador Anti-Ban na mensagem.
 * - Se for o template base curto ("{{saudacao}}! Tudo bem? {{nome_empresa}}?"),
 *   sorteia uma das 24 variações semânticas humanas (sem repetir em sequência)
 *   com o nome da empresa limpo e a saudação da hora exata.
 * - Se for um template customizado maior, varia de forma inteligente a saudação/cumprimento
 *   inicial e sincroniza o horário.
 */
export function applyAntiBanMixer(params: {
  template: string;
  renderedText?: string;
  renderedFallback?: string;
  companyName?: string | null;
  enabled?: boolean;
  now?: Date;
  scopeKey?: string;
  deterministicIndex?: number;
}): string {
  const now = params.now || new Date();
  const baseText = params.renderedText ?? params.renderedFallback ?? params.template;
  if (params.enabled === false) {
    return syncGreetingToCurrentHour(baseText, now);
  }
  const scopeKey = params.scopeKey || "default";
  const gCap = greetingFor(now);
  const gLow = gCap.toLowerCase();
  const cleanCompany = cleanCompanyNameForApproach(params.companyName);

  if (isShortIcebreakerTemplate(params.template)) {
    if (cleanCompany) {
      const idx = pickNonRepeatingIndex(scopeKey, WITH_COMPANY_PATTERNS.length, params.deterministicIndex);
      return WITH_COMPANY_PATTERNS[idx](gCap, gLow, cleanCompany);
    } else {
      const idx = pickNonRepeatingIndex(`${scopeKey}:nocomp`, WITHOUT_COMPANY_PATTERNS.length, params.deterministicIndex);
      return WITHOUT_COMPANY_PATTERNS[idx](gCap, gLow);
    }
  }

  // Para templates longos/customizados: sincroniza saudação + varia cumprimento "Tudo bem?"
  let text = syncGreetingToCurrentHour(baseText, now);
  const greetingsPool = ["Tudo bem?", "Tudo certo?", "Tudo joia?", "Tudo tranquilo?", "Tudo bem por aí?"];
  const gIdx = pickNonRepeatingIndex(`${scopeKey}:long`, greetingsPool.length, params.deterministicIndex);
  text = text.replace(/\bTudo bem\?/i, greetingsPool[gIdx]);
  return text;
}

