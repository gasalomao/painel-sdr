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
import { cleanShortCompanyName } from "./lead-name-hygiene";

/** Histórico recente por escopo (campanha/instância) para não repetir a mesma estrutura seguida. */
const recentPatternHistory = new Map<string, number[]>();
const MAX_RECENT_HISTORY = 28;

/** Reset apenas para testes unitários. */
export function __resetAntiBanHistoryForTests(): void {
  recentPatternHistory.clear();
}

export function seedAntiBanHistory(entries: Record<string, number[]> | null | undefined): void {
  if (!entries || typeof entries !== "object") return;
  for (const [k, list] of Object.entries(entries)) {
    if (!Array.isArray(list)) continue;
    const valid = list.filter((n) => Number.isInteger(n) && n >= 0).slice(-MAX_RECENT_HISTORY);
    if (valid.length > 0 && !recentPatternHistory.has(k)) {
      recentPatternHistory.set(k, valid);
    }
  }
}

export function exportAntiBanHistory(): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [k, list] of recentPatternHistory.entries()) {
    if (list.length > 0) out[k] = list.slice(-MAX_RECENT_HISTORY);
  }
  return out;
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
  let name = cleanShortCompanyName(rawName);
  if (!name) name = String(rawName).trim();
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
 * Detecta se o template usa o modelo de alta conversão (Elogio Personalizado Google/Instagram
 * + Pergunta Fácil de 1 Palavra sobre site próprio vs Instagram/WhatsApp, sem pitch/link/crítica).
 */
export function isPersonalizedPraiseOpenerTemplate(template: string): boolean {
  const raw = String(template || "").trim();
  if (!raw) return false;
  const norm = raw.toLowerCase().replace(/\s+/g, " ");

  // Templates com URL ou oferta agressiva explícita não são aberturas de elogio limpo
  if (/https?:\/\/|www\.|wa\.me\//i.test(norm)) return false;

  const hasRatingOrReviewsVar =
    /\{\{?\s*(nota|avaliacao|avalia[cç][aã]o|nota_google|rating|estrelas|avaliacoes|avalia[cç][õo]es|reviews|qtd_avaliacoes|total_avaliacoes)\s*\}?\}/i.test(
      raw
    );
  const hasSiteQuestion =
    /\b(site\s+pr[oó]prio|t[eê]m\s+site|tem\s+site|possuem\s+site|usam\s+site|usando\s+site)\b/i.test(
      norm
    );
  const hasSocialChannel = /\b(instagram|insta|whatsapp|redes\s+sociais)\b/i.test(norm);

  if (hasSiteQuestion && hasSocialChannel) return true;
  if (
    hasRatingOrReviewsVar &&
    norm.length <= 360 &&
    (hasSiteQuestion || hasSocialChannel || /\b(google|parab[eé]ns|elogio|avalia[cç][õo]es|estrelas|perfil)\b/i.test(norm))
  ) {
    return true;
  }
  return false;
}

/**
 * Detecta se o template é o modelo curto de abordagem inicial (quebra-gelo sem oferta)
 * ou equivalente a "{{saudacao}}! Tudo bem? {{nome_empresa}}?".
 */
export function isShortIcebreakerTemplate(template: string): boolean {
  if (isPersonalizedPraiseOpenerTemplate(template)) return false;
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
 * 48 estruturas sintáticas humanas que mantêm 100% o mesmo sentido de
 * "{{saudacao}}! Tudo bem? {{nome_empresa}}?" sem parecer oferta comercial
 * (Estratégia Two-Step Handshake: força a 1ª resposta do lead para remover o botão Denunciar da Meta).
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
  (_G, g, c) => `Oi, ${g}! Tudo joia? É o contato da ${c}?`,
  (_G, g, c) => `Olá, ${g}! Tudo certo por aí? É da ${c}?`,
  (G, _g, c) => `${G}! Tudo bem? Esse é o número da ${c}?`,
  (_G, g, c) => `Oi, ${g}, tudo tranquilo? Aí é da ${c}?`,
  (_G, g, c) => `Opa, ${g}! Tudo joia por aí? Falo com a ${c}?`,
  (G, _g, c) => `${G}, tudo certo? É do atendimento da ${c}?`,
  (_G, g, c) => `Oi, ${g}! Tudo bem? Falo no WhatsApp da ${c}?`,
  (_G, g, c) => `Olá, ${g}! Como estão as coisas? É da ${c}?`,

  // Ordem 2: Saudação + Confirmação da Empresa -> Tudo bem
  (G, _g, c) => `${G}! É da ${c}? Tudo bem?`,
  (G, _g, c) => `${G}, falo com a ${c}? Tudo certo?`,
  (_G, g, c) => `Oi, ${g}! É da ${c}? Tudo bem?`,
  (_G, g, c) => `Olá, ${g}! Falo com a ${c}? Tudo bem por aí?`,
  (G, _g, c) => `${G}! ${c}? Tudo bem?`,
  (_G, g, c) => `Opa, ${g}! Aí é da ${c}? Tudo joia?`,
  (G, _g, c) => `${G}, é o pessoal da ${c}? Tudo tranquilo?`,
  (_G, g, c) => `Oi, ${g}, falo com a ${c}? Tudo bem?`,
  (_G, g, c) => `Olá, ${g}! É o contato da ${c}? Tudo certo?`,
  (G, _g, c) => `${G}! Aí é da ${c}? Tudo bem com vocês?`,
  (_G, g, c) => `Opa, ${g}, é da ${c}? Tudo tranquilo por aí?`,
  (_G, g, c) => `Oi, ${g}! Pessoal da ${c}? Tudo joia?`,

  // Ordem 3: Duas linhas naturais (quebra humana de balão/parágrafo)
  (G, _g, c) => `${G}! Tudo bem?\n\nÉ da ${c}?`,
  (_G, g, c) => `Oi, ${g}, tudo certo?\n\nFalo com a ${c}?`,
  (_G, g, c) => `Olá, ${g}! Tudo bem?\n\nAí é da ${c}?`,
  (G, _g, c) => `${G}, tudo joia?\n\nÉ o WhatsApp da ${c}?`,
  (_G, g, c) => `Opa, ${g}! Tudo tranquilo?\n\nFalo com o pessoal da ${c}?`,
  (G, _g, c) => `${G}! Tudo certo por aí?\n\nÉ da ${c}?`,
  (_G, g, c) => `Oi, ${g}! Tudo bem?\n\n${c}?`,
  (_G, g, c) => `Olá, ${g}, tudo tranquilo?\n\nÉ do atendimento da ${c}?`,

  // Ordem 4: Abordagem direta humanizada (pergunta de confirmação sutil)
  (G, _g, c) => `Oi! ${G}, tudo bem? É da ${c}?`,
  (G, _g, c) => `Olá! ${G}, tudo certo? Falo com a ${c}?`,
  (G, _g, c) => `Opa! ${G}, tudo joia? Aí é da ${c}?`,
  (G, _g, c) => `${G}, pessoal da ${c}! Tudo bem por aí?`,
];

const WITHOUT_COMPANY_PATTERNS: Array<(gCap: string, gLow: string) => string> = [
  (G) => `${G}! Tudo bem?`,
  (G) => `${G}, tudo bem por aí?`,
  (_G, g) => `Oi, ${g}! Tudo bem?`,
  (_G, g) => `Olá, ${g}! Tudo certo?`,
  (_G, g) => `Opa, ${g}, tudo tranquilo?`,
  (G) => `${G}! Tudo joia?`,
  (_G, g) => `Oi, ${g}, tudo bem por aí?`,
  (_G, g) => `Olá, ${g}! Tudo bem com vocês?`,
  (G) => `${G}, tudo certo por aí?`,
  (_G, g) => `Opa, ${g}! Tudo bem?`,
  (G) => `${G}! Como vai, tudo bem?`,
  (_G, g) => `Oi, ${g}! Tudo tranquilo por aí?`,
];

type PraiseWithRatingPattern = (
  gCap: string,
  gLow: string,
  company: string,
  ratingLabel: string,
  reviewsCount: number | null
) => string;

type PraiseWithoutRatingPattern = (gCap: string, gLow: string, company: string) => string;

/**
 * 16 estruturas sintáticas de alta conversão com elogio à nota/avaliações do Google
 * + pergunta fácil de 1 palavra (site próprio vs Instagram/WhatsApp).
 * Regras: máx 2 linhas, ZERO pitch, ZERO links, ZERO crítica.
 */
const PRAISE_WITH_RATING_PATTERNS: PraiseWithRatingPattern[] = [
  (G, _g, c, r, rev) =>
    `${G}! Vi a ${c} aqui no Google com nota ${r}${rev ? ` e ${rev} avaliações` : ""} — parabéns pelo trabalho!\nHoje vocês têm site próprio ou atendem mais pelo Instagram e WhatsApp?`,
  (_G, g, c, r, rev) =>
    `Oi, ${g}! Passei pelo perfil da ${c} no Google (${r} estrelas${rev ? `, ${rev} avaliações` : ""}) e achei bem elogiado.\nVocês já usam site próprio hoje ou focam mais no Instagram e WhatsApp?`,
  (_G, g, c, r, rev) =>
    `Olá, ${g}! Tudo bem? Vi as avaliações da ${c} no Google (nota ${r}${rev ? ` com ${rev} opiniões` : ""}), pessoal elogia bastante.\nHoje vocês têm site próprio ou usam mais Instagram e WhatsApp?`,
  (_G, g, c, r, rev) =>
    `Opa, ${g}! Encontrei a ${c} no Google com ${r} de nota${rev ? ` em ${rev} avaliações` : ""}, muito bom ver um negócio tão bem avaliado.\nPor aí vocês têm site próprio ou o movimento vem mais do Instagram e WhatsApp?`,
  (G, _g, c, r, rev) =>
    `${G}, pessoal da ${c}! Vi no Google que vocês estão com nota ${r}${rev ? ` (${rev} avaliações)` : ""} — trabalho caprichado.\nHoje vocês trabalham com site próprio ou usam mais Instagram e WhatsApp?`,
  (_G, g, c, r, rev) =>
    `Oi, ${g}! Estava olhando a ${c} no Google e chamou atenção a nota ${r}${rev ? ` com ${rev} avaliações` : ""}.\nUma dúvida rápida: vocês têm site próprio hoje ou usam mais Instagram e WhatsApp?`,
  (_G, g, c, r, rev) =>
    `Olá, ${g}! Tudo certo? Vi o perfil da ${c} no Google com ${r} estrelas${rev ? ` e ${rev} avaliações` : ""}, super bem recomendado.\nAtualmente vocês têm site próprio ou atendem mais via Instagram e WhatsApp?`,
  (G, _g, c, r, rev) =>
    `${G}! Tudo tranquilo? Acompanhei as avaliações da ${c} no Google (${r}${rev ? ` · ${rev} avaliações` : ""}), parabéns pelo atendimento!\nVocês mantêm site próprio ou concentram mais no Instagram e WhatsApp?`,
  (_G, g, c, r, rev) =>
    `Opa, ${g}, tudo bem? Vi a reputação da ${c} no Google com nota ${r}${rev ? ` e ${rev} avaliações` : ""} — destaque total.\nHoje a divulgação de vocês usa site próprio ou fica mais no Instagram e WhatsApp?`,
  (G, _g, c, r, rev) =>
    `Oi! ${G}! Dei uma olhada na ${c} no Google e vi ${r} estrelas${rev ? ` (${rev} avaliações)` : ""}, pessoal fala super bem.\nVocês têm site próprio hoje ou tocam tudo pelo Instagram e WhatsApp?`,
  (G, _g, c, r, rev) =>
    `${G}, tudo certo? Acabei de ver a ${c} no Google Maps com nota ${r}${rev ? ` em ${rev} avaliações` : ""}, excelente reputação!\nSó por curiosidade: vocês usam site próprio ou mais Instagram e WhatsApp?`,
  (G, _g, c, r, rev) =>
    `Olá! ${G}, tudo bem? Vi os elogios para a ${c} no Google (nota ${r}${rev ? ` · ${rev} avaliações` : ""}).\nHoje vocês têm site próprio no ar ou usam mais o Instagram e o WhatsApp?`,
  (_G, g, c, r, rev) =>
    `Oi, ${g}, tudo joia? Notei a ${c} super bem avaliada no Google com ${r} estrelas${rev ? ` e ${rev} avaliações` : ""}.\nPor aí vocês têm site próprio ou preferem trabalhar só com Instagram e WhatsApp?`,
  (G, _g, c, r, rev) =>
    `${G}! Vi a ficha da ${c} no Google com ${r} de avaliação${rev ? ` (${rev} comentários)` : ""} — parabéns pela constância!\nHoje o atendimento de vocês conta com site próprio ou é mais Instagram e WhatsApp?`,
  (_G, g, c, r, rev) =>
    `Opa, ${g}! Tudo certo por aí? Vi a ${c} bem recomendada no Google (${r} estrelas${rev ? `, ${rev} avaliações` : ""}).\nVocês já têm site próprio ou usam mais Instagram e WhatsApp no dia a dia?`,
  (_G, g, c, r, rev) =>
    `Olá, ${g}! Encontrei a ${c} no Google com ótima nota (${r}${rev ? ` e ${rev} avaliações` : ""}) e vim mandar um oi.\nHoje vocês têm site próprio ou focam o contato no Instagram e WhatsApp?`,
];

/**
 * 14 estruturas sintáticas de alta conversão sem menção à nota (quando nota ausente ou < 4.0):
 * elogia presença/trabalho da empresa + pergunta fácil de 1 palavra (site próprio vs Instagram/WhatsApp).
 * Regras: máx 2 linhas, ZERO pitch, ZERO links, ZERO crítica.
 */
const PRAISE_WITHOUT_RATING_PATTERNS: PraiseWithoutRatingPattern[] = [
  (G, _g, c) =>
    `${G}! Vi o trabalho da ${c} por aqui e curti bastante a presença de vocês.\nHoje vocês têm site próprio ou usam mais Instagram e WhatsApp?`,
  (_G, g, c) =>
    `Oi, ${g}! Tudo bem? Encontrei a ${c} aqui no Google e achei bem legal a estrutura de vocês.\nVocês já usam site próprio hoje ou focam mais no Instagram e WhatsApp?`,
  (_G, g, c) =>
    `Olá, ${g}! Passei pelo perfil da ${c} agora há pouco — parabéns pelo trabalho!\nHoje vocês têm site próprio ou atendem mais pelo Instagram e WhatsApp?`,
  (_G, g, c) =>
    `Opa, ${g}, tudo certo? Vi a ${c} aqui nas buscas do Google e vim tirar uma dúvida rápida.\nVocês têm site próprio hoje ou o contato fica mais no Instagram e WhatsApp?`,
  (G, _g, c) =>
    `${G}, pessoal da ${c}! Vi vocês aqui no Google e gostei bastante do que vocês fazem.\nAtualmente vocês mantêm site próprio ou usam mais Instagram e WhatsApp?`,
  (_G, g, c) =>
    `Oi, ${g}, tudo tranquilo? Acabei de ver o perfil da ${c} por aqui.\nUma pergunta rápida: hoje vocês têm site próprio ou trabalham mais com Instagram e WhatsApp?`,
  (_G, g, c) =>
    `Olá, ${g}! Tudo bem por aí? Encontrei a ${c} pesquisando empresas da região e curti o perfil.\nVocês têm site próprio no ar ou focam mais no Instagram e WhatsApp?`,
  (G, _g, c) =>
    `${G}! Tudo joia? Dei uma olhada no perfil da ${c} aqui no Google.\nHoje a divulgação de vocês usa site próprio ou vai mais pelo Instagram e WhatsApp?`,
  (_G, g, c) =>
    `Opa, ${g}! Vi a ${c} aqui no Google Maps e achei bem bacana o posicionamento de vocês.\nVocês têm site próprio hoje ou tocam tudo pelo Instagram e WhatsApp?`,
  (G, _g, c) =>
    `Oi! ${G}, tudo certo? Estava vendo o perfil da ${c} aqui no Google.\nSó pra saber: vocês já têm site próprio ou usam mais o Instagram e o WhatsApp?`,
  (G, _g, c) =>
    `${G}, tudo bem? Vi a ficha da ${c} aqui nas buscas e achei bem organizada.\nHoje vocês trabalham com site próprio ou atendem mais via Instagram e WhatsApp?`,
  (G, _g, c) =>
    `Olá! ${G}! Encontrei a ${c} no Google agora há pouco e vim dar um alô.\nVocês usam site próprio hoje ou concentram o atendimento no Instagram e WhatsApp?`,
  (_G, g, c) =>
    `Oi, ${g}! Tudo bem com vocês? Vi a ${c} aqui no Google e gostei da proposta.\nPor aí vocês têm site próprio ou preferem focar no Instagram e WhatsApp?`,
  (_G, g, c) =>
    `Opa, ${g}, tudo tranquilo? Vi o perfil da ${c} por aqui e bateu uma curiosidade rápida.\nHoje vocês têm site próprio ou usam mais Instagram e WhatsApp no dia a dia?`,
];

const PRAISE_NO_COMPANY_PATTERNS: Array<(gCap: string, gLow: string) => string> = [
  (G) => `${G}! Tudo bem? Vi o perfil de vocês aqui no Google.\nHoje vocês têm site próprio ou usam mais Instagram e WhatsApp?`,
  (_G, g) => `Oi, ${g}! Passei pelo perfil de vocês agora há pouco.\nVocês já usam site próprio hoje ou focam mais no Instagram e WhatsApp?`,
  (_G, g) => `Olá, ${g}! Tudo certo? Encontrei vocês aqui nas buscas do Google.\nHoje o atendimento de vocês conta com site próprio ou é mais Instagram e WhatsApp?`,
  (_G, g) => `Opa, ${g}, tudo tranquilo? Vi vocês aqui no Google Maps.\nSó por curiosidade: vocês têm site próprio ou usam mais Instagram e WhatsApp?`,
  (G) => `${G}! Tudo joia? Dei uma olhada no perfil de vocês no Google.\nAtualmente vocês mantêm site próprio ou atendem mais pelo Instagram e WhatsApp?`,
  (_G, g) => `Oi, ${g}! Tudo bem por aí? Achei o perfil de vocês no Google.\nHoje vocês trabalham com site próprio ou ficam mais no Instagram e WhatsApp?`,
];

export const PRAISE_OPENER_PATTERN_COUNTS = {
  withRating: PRAISE_WITH_RATING_PATTERNS.length,
  withoutRating: PRAISE_WITHOUT_RATING_PATTERNS.length,
  total: PRAISE_WITH_RATING_PATTERNS.length + PRAISE_WITHOUT_RATING_PATTERNS.length,
} as const;

function parsePositiveGoogleRating(
  explicitRating?: number | string | null,
  renderedText?: string
): string | null {
  const tryParse = (raw: unknown): number | null => {
    if (raw === null || raw === undefined || raw === "") return null;
    const normalized = String(raw).trim().replace(",", ".");
    const num = Number(normalized);
    if (!Number.isFinite(num) || num < 4.0 || num > 5.0) return null;
    return num;
  };

  let num = tryParse(explicitRating);
  if (num === null && renderedText) {
    const m =
      renderedText.match(/(?:nota|avalia[cç][aã]o|google)[^0-9]{0,16}([45](?:[.,]\d)?)\b/i) ||
      renderedText.match(/\b([45][.,]\d)\s*(?:estrelas?|★|no\s+google)/i);
    if (m?.[1]) {
      num = tryParse(m[1]);
    }
  }
  if (num === null) return null;
  return num.toFixed(1).replace(".", ",");
}

function parsePositiveReviewsCount(
  explicitReviews?: number | string | null,
  renderedText?: string
): number | null {
  const tryParse = (raw: unknown): number | null => {
    if (raw === null || raw === undefined || raw === "") return null;
    const digits = String(raw).replace(/\D/g, "");
    if (!digits) return null;
    const num = Number(digits);
    if (!Number.isFinite(num) || num < 5) return null;
    return Math.floor(num);
  };

  let count = tryParse(explicitReviews);
  if (count === null && renderedText) {
    const m = renderedText.match(/\b(\d{1,5})\s*(?:avalia[cç][õo]es|reviews?|opini[õo]es|coment[aá]rios)\b/i);
    if (m?.[1]) {
      count = tryParse(m[1]);
    }
  }
  return count;
}

/**
 * Gera uma abertura personalizada de alta conversão (elogio Google/presença + pergunta fácil de 1 palavra),
 * com 30 variações sintáticas (16 com nota >= 4.0 + 14 sem nota), sempre <= 2 linhas e sem pitch/links/crítica.
 */
export function generatePersonalizedPraiseOpener(params: {
  companyName?: string | null;
  rating?: number | string | null;
  reviews?: number | string | null;
  renderedText?: string;
  now?: Date;
  scopeKey?: string;
  deterministicIndex?: number;
}): string {
  const now = params.now || new Date();
  const scopeKey = params.scopeKey || "default";
  const gCap = greetingFor(now);
  const gLow = gCap.toLowerCase();
  const cleanCompany = cleanCompanyNameForApproach(params.companyName);
  const ratingLabel = parsePositiveGoogleRating(params.rating, params.renderedText);
  const reviewsCount = parsePositiveReviewsCount(params.reviews, params.renderedText);

  if (!cleanCompany) {
    const idx = pickNonRepeatingIndex(
      `${scopeKey}:praise_nocomp`,
      PRAISE_NO_COMPANY_PATTERNS.length,
      params.deterministicIndex
    );
    return PRAISE_NO_COMPANY_PATTERNS[idx](gCap, gLow);
  }

  if (ratingLabel) {
    const idx = pickNonRepeatingIndex(
      `${scopeKey}:praise_rated`,
      PRAISE_WITH_RATING_PATTERNS.length,
      params.deterministicIndex
    );
    return PRAISE_WITH_RATING_PATTERNS[idx](gCap, gLow, cleanCompany, ratingLabel, reviewsCount);
  }

  const idx = pickNonRepeatingIndex(
    `${scopeKey}:praise_norating`,
    PRAISE_WITHOUT_RATING_PATTERNS.length,
    params.deterministicIndex
  );
  return PRAISE_WITHOUT_RATING_PATTERNS[idx](gCap, gLow, cleanCompany);
}

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
 * - Se for o template de Elogio Personalizado Google/Instagram + Pergunta Fácil (1 palavra),
 *   sorteia uma das 30 variações sintáticas humanas (16 com nota >= 4.0 + 14 sem nota),
 *   sem pitch, sem links e sem crítica.
 * - Se for o template base curto ("{{saudacao}}! Tudo bem? {{nome_empresa}}?"),
 *   sorteia uma das 48 variações semânticas humanas (sem repetir em sequência)
 *   com o nome da empresa limpo e a saudação da hora exata.
 * - Se for um template customizado maior, varia de forma inteligente a saudação/cumprimento
 *   inicial e sincroniza o horário.
 */
export function applyAntiBanMixer(params: {
  template: string;
  renderedText?: string;
  renderedFallback?: string;
  companyName?: string | null;
  rating?: number | string | null;
  reviews?: number | string | null;
  ramo?: string | null;
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

  if (isPersonalizedPraiseOpenerTemplate(params.template)) {
    return generatePersonalizedPraiseOpener({
      companyName: cleanCompany || params.companyName,
      rating: params.rating,
      reviews: params.reviews,
      renderedText: baseText,
      now,
      scopeKey,
      deterministicIndex: params.deterministicIndex,
    });
  }

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

/**
 * Blindagem de 1º Contato Frio (Two-Step Handshake & Elogio Personalizado):
 * - Em template curto de quebra-gelo ("{{saudacao}}! Tudo bem? {{nome_empresa}}?"),
 *   impede URLs, pitch comercial ou textos > 140 chars.
 * - Em template de Elogio Google/Instagram + Pergunta Fácil ("site próprio ou Instagram e WhatsApp"),
 *   impede URLs, pitch comercial, críticas negativas ao negócio e textos > 2 linhas / > 280 chars.
 */
export function enforceShortHandshakeGuard(params: {
  template: string;
  candidateText: string;
  companyName?: string | null;
  rating?: number | string | null;
  reviews?: number | string | null;
  ramo?: string | null;
  now?: Date;
  scopeKey?: string;
}): string {
  const now = params.now || new Date();
  const candidate = String(params.candidateText || "").trim();

  const hasUrl = /https?:\/\/|www\.|wa\.me\//i.test(candidate);
  const hasSalesBuzzwords =
    /\b(promo[cç][aã]o|desconto|or[cç]amento\s+gr[aá]tis|compre\s+agora|clique\s+no\s+link|oferta\s+especial|cria[cç][aã]o\s+de\s+sites?|nossa\s+ag[eê]ncia|fechar\s+contrato|valores\s+a\s+partir)\b/i.test(
      candidate
    );

  if (isPersonalizedPraiseOpenerTemplate(params.template)) {
    const nonEmptyLines = candidate
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const isTooLongForPraise = candidate.length > 280 || nonEmptyLines.length > 2;
    const hasCriticism =
      /\b(n[aã]o\s+t[eê]m\s+site|sem\s+site|site\s+(?:desatualizado|ruim|amador|fraco|antigo)|perdendo\s+(?:clientes|vendas)|perfil\s+(?:fraco|incompleto))\b/i.test(
        candidate
      );

    if (!candidate || hasUrl || isTooLongForPraise || hasSalesBuzzwords || hasCriticism) {
      return applyAntiBanMixer({
        template: params.template,
        renderedText: candidate,
        companyName: params.companyName,
        rating: params.rating,
        reviews: params.reviews,
        ramo: params.ramo,
        enabled: true,
        now,
        scopeKey: params.scopeKey,
      });
    }
    return syncGreetingToCurrentHour(candidate, now);
  }

  if (!isShortIcebreakerTemplate(params.template)) {
    return syncGreetingToCurrentHour(candidate, now);
  }

  const isTooLongForHandshake = candidate.length > 140;

  if (!candidate || hasUrl || isTooLongForHandshake || hasSalesBuzzwords) {
    return applyAntiBanMixer({
      template: params.template,
      renderedText: candidate,
      companyName: params.companyName,
      enabled: true,
      now,
      scopeKey: params.scopeKey,
    });
  }

  return syncGreetingToCurrentHour(candidate, now);
}

/**
 * Variação leve e segura para mensagens de follow-up sem IA:
 * sincroniza saudação ao horário real e alterna cumprimentos triviais
 * ("Tudo bem?" -> "Tudo certo?"/"Tudo joia?") sem reescrever o sentido do step.
 */
export function applyFollowupTextVariation(
  renderedText: string,
  now: Date = new Date(),
  scopeKey: string = "followup"
): string {
  if (!renderedText) return renderedText;
  let text = syncGreetingToCurrentHour(renderedText, now);
  const greetingsPool = ["Tudo bem?", "Tudo certo?", "Tudo joia?", "Tudo tranquilo?", "Tudo bem por aí?"];
  if (/\bTudo bem\?/i.test(text)) {
    const gIdx = pickNonRepeatingIndex(`${scopeKey}:fu_greet`, greetingsPool.length);
    text = text.replace(/\bTudo bem\?/i, greetingsPool[gIdx]);
  }
  return text;
}



