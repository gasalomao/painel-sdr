import { parseGoogleReviewCount } from "./scraper-review-count";

export const MIN_GOOGLE_YEAR = 1900;

export function getMaxGoogleYear(refDate: Date = new Date()): number {
  return refDate.getFullYear() + 1;
}

/**
 * Valida o ano ("Está no Google desde / até").
 * 0 ou ausente significa sem filtro. Anos válidos: 1900..(anoAtual + 1).
 */
export function parseGoogleYear(value: unknown, refDate: Date = new Date()): number | null {
  if (value === undefined || value === null || value === "") return 0;
  const maxYear = getMaxGoogleYear(refDate);
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value === 0) return 0;
    return value >= MIN_GOOGLE_YEAR && value <= maxYear ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (parsed === 0) return 0;
    return Number.isInteger(parsed) && parsed >= MIN_GOOGLE_YEAR && parsed <= maxYear ? parsed : null;
  }
  return null;
}

/** Valida limite máximo de avaliações (0 = sem limite). */
export function parseMaxReviews(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2147483647) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 2147483647 ? parsed : null;
  }
  return null;
}

/** Valida nota mínima ou máxima no Google (0 = sem filtro, ou número entre 0 e 5). */
export function parseRatingBound(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 5) {
    return Math.round(value * 10) / 10;
  }
  if (typeof value === "string" && /^\d+(?:[.,]\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim().replace(",", "."));
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 5 ? Math.round(parsed * 10) / 10 : null;
  }
  return null;
}

export function validateGoogleYearRange(
  fromYear: number,
  toYear: number,
  refDate: Date = new Date(),
): string | null {
  if (fromYear <= 0 && toYear <= 0) return null;
  const currentYear = refDate.getFullYear();
  const effectiveFrom = fromYear > 0 ? fromYear : MIN_GOOGLE_YEAR;
  const effectiveTo = toYear > 0 ? toYear : currentYear;
  if (effectiveFrom > effectiveTo) {
    return `O ano inicial no Google (${effectiveFrom}) não pode ser maior que o ano final (${effectiveTo}).`;
  }
  return null;
}

export function validateRatingRange(minRating: number, maxRating: number): string | null {
  if (minRating > 0 && maxRating > 0 && minRating > maxRating) {
    return `A nota mínima (${minRating}) não pode ser maior que a nota máxima (${maxRating}).`;
  }
  return null;
}

export function validateReviewCountRange(minReviews: number, maxReviews: number): string | null {
  if (minReviews > 0 && maxReviews > 0 && minReviews > maxReviews) {
    return `O mínimo de avaliações (${minReviews}) não pode ser maior que o máximo (${maxReviews}).`;
  }
  return null;
}

/**
 * Converte datas relativas ou explícitas do Google Maps em ano aproximado.
 * Ex.: "há 7 anos" -> currentYear - 7; "há um ano" -> currentYear - 1;
 * "há 6 meses" -> ano de (refDate - 6 meses); "desde 2019" -> 2019.
 */
export function extractYearFromRelativeDate(dateText: string, refDate: Date = new Date()): number | null {
  if (!dateText || typeof dateText !== "string") return null;
  const text = dateText.replace(/[\u00a0\u202f\s]+/g, " ").trim().toLowerCase();
  if (!text) return null;

  const currentYear = refDate.getFullYear();
  const maxYear = getMaxGoogleYear(refDate);

  const explicitYearMatch = text.match(/\b(19\d{2}|20\d{2})\b/);
  if (explicitYearMatch) {
    const yr = Number(explicitYearMatch[1]);
    if (yr >= MIN_GOOGLE_YEAR && yr <= maxYear) return yr;
  }

  const yearsAgoMatch =
    text.match(/(?:h[áa]\s+|faz\s+)?(\d{1,3})\s*anos?(?:\s+atr[áa]s)?\b/i) ||
    text.match(/(\d{1,3})\s*years?\s+ago\b/i);
  if (yearsAgoMatch) {
    const years = Number(yearsAgoMatch[1]);
    const yr = currentYear - years;
    if (yr >= MIN_GOOGLE_YEAR && yr <= maxYear) return yr;
  }

  if (/\b(?:h[áa]\s+(?:um|uma)\s+ano|(?:um|uma)\s+ano\s+atr[áa]s|a\s+year\s+ago|one\s+year\s+ago)\b/i.test(text)) {
    return currentYear - 1;
  }

  const monthsAgoMatch =
    text.match(/(?:h[áa]\s+|faz\s+)?(\d{1,2})\s*m(?:e|ê)s(?:es)?(?:\s+atr[áa]s)?\b/i) ||
    text.match(/(\d{1,2})\s*months?\s+ago\b/i);
  if (monthsAgoMatch) {
    const months = Number(monthsAgoMatch[1]);
    const d = new Date(refDate.getTime());
    d.setMonth(d.getMonth() - months);
    return d.getFullYear();
  }

  if (/\b(?:h[áa]\s+um\s+m[êe]s|um\s+m[êe]s\s+atr[áa]s|a\s+month\s+ago|one\s+month\s+ago)\b/i.test(text)) {
    const d = new Date(refDate.getTime());
    d.setMonth(d.getMonth() - 1);
    return d.getFullYear();
  }

  const weeksOrDaysMatch =
    /\b(?:h[áa]\s+(?:\d+|um|uma)\s*(?:semanas?|dias?|horas?|minutos?)|(?:\d+|um|uma|a|one)\s*(?:semanas?|dias?|horas?|minutos?)\s+atr[áa]s|(?:\d+|a|one)\s*(?:weeks?|days?|hours?|minutes?)\s+ago|ontem|hoje|yesterday|today)\b/i.test(
      text,
    );
  if (weeksOrDaysMatch) {
    return currentYear;
  }

  return null;
}

/**
 * Determina o ano em que o negócio está no Google / foi estabelecido, combinando:
 * 1) Campo explícito `yearEstablished`
 * 2) Texto do painel ("no Google desde 2019", "desde 2019", "fundado em 2019", "7+ anos no mercado", "7 years in business")
 * 3) Avaliação mais antiga encontrada no Google Maps (`reviews`)
 */
export function resolveLeadGoogleYear(input: {
  yearEstablished?: string | number | null;
  bodyText?: string | null;
  reviews?: Array<{ data?: string; texto?: string }> | null;
  refDate?: Date;
}): number | null {
  const refDate = input.refDate ?? new Date();
  const currentYear = refDate.getFullYear();
  const maxYear = getMaxGoogleYear(refDate);
  const candidates: number[] = [];

  if (input.yearEstablished !== undefined && input.yearEstablished !== null && input.yearEstablished !== "") {
    const rawStr = String(input.yearEstablished).trim();
    const directYear = rawStr.match(/\b(19\d{2}|20\d{2})\b/);
    if (directYear) {
      const yr = Number(directYear[1]);
      if (yr >= MIN_GOOGLE_YEAR && yr <= maxYear) candidates.push(yr);
    } else {
      const rel = extractYearFromRelativeDate(rawStr, refDate);
      if (rel !== null) candidates.push(rel);
    }
  }

  if (input.bodyText && typeof input.bodyText === "string") {
    const body = input.bodyText;
    const explicitPatterns = [
      /(?:no\s+google\s+desde|fundad[oa]\s+em|abert[oa]\s+em|inaugurad[oa]\s+em|desde|since|established(?:\s+in)?)\s+(19\d{2}|20\d{2})\b/gi,
    ];
    for (const pattern of explicitPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(body)) !== null) {
        const yr = Number(match[1]);
        if (yr >= MIN_GOOGLE_YEAR && yr <= maxYear) candidates.push(yr);
      }
    }

    const yearsInBusinessPatterns = [
      /(?:h[áa]\s+)?(\d{1,3})\+?\s*(?:anos?\s+no\s+mercado|anos?\s+de\s+atividade|anos?\s+de\s+experi[êe]ncia|years?\s+in\s+business)\b/gi,
    ];
    for (const pattern of yearsInBusinessPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(body)) !== null) {
        const years = Number(match[1]);
        const yr = currentYear - years;
        if (yr >= MIN_GOOGLE_YEAR && yr <= maxYear) candidates.push(yr);
      }
    }
  }

  if (Array.isArray(input.reviews)) {
    for (const rev of input.reviews) {
      if (rev?.data) {
        const yr = extractYearFromRelativeDate(rev.data, refDate);
        if (yr !== null) candidates.push(yr);
      }
    }
  }

  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

export function parseLeadRating(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 5) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const m = raw.trim().match(/^([0-5](?:[.,]\d{1,2})?)$/);
    if (m) {
      const parsed = Number(m[1].replace(",", "."));
      return Number.isFinite(parsed) && parsed > 0 && parsed <= 5 ? parsed : null;
    }
  }
  return null;
}

export interface LeadExtraFilterEvalParams {
  yearEstablished?: string | number | null;
  reviewCount?: string | number | null;
  averageRating?: string | number | null;
  googleYearFrom?: number;
  googleYearTo?: number;
  maxReviews?: number;
  minRating?: number;
  maxRating?: number;
  /** Em estágio de cartão (pré-painel), não descartar por falta de ano ou falta de nota. */
  cardStage?: boolean;
  refDate?: Date;
}

/**
 * Avalia os filtros extras de qualificação de lead:
 * - `maxReviews`: máximo de avaliações no Google
 * - `minRating` / `maxRating`: faixa de nota média (estrelas)
 * - `googleYearFrom` / `googleYearTo`: está no Google desde [ano inicial] até [ano final / atual]
 */
export function leadExtraFilterReason(params: LeadExtraFilterEvalParams): string | null {
  const refDate = params.refDate ?? new Date();
  const currentYear = refDate.getFullYear();
  const cardStage = Boolean(params.cardStage);

  const maxReviews = params.maxReviews && params.maxReviews > 0 ? params.maxReviews : 0;
  if (maxReviews > 0) {
    const rawCount =
      typeof params.reviewCount === "number"
        ? String(params.reviewCount)
        : typeof params.reviewCount === "string"
          ? params.reviewCount
          : "";
    const count = parseGoogleReviewCount(rawCount);
    if (count !== null && count > maxReviews) {
      return `Mais de ${maxReviews} avaliações no Google (${count})`;
    }
  }

  const minRating = params.minRating && params.minRating > 0 ? params.minRating : 0;
  const maxRating = params.maxRating && params.maxRating > 0 ? params.maxRating : 0;
  if (minRating > 0 || maxRating > 0) {
    const rating = parseLeadRating(params.averageRating);
    if (rating === null) {
      if (!cardStage && minRating > 0) {
        return "Sem avaliação (nota) no Google";
      }
    } else {
      if (minRating > 0 && rating < minRating) {
        return `Nota ${rating} abaixo do mínimo (${minRating})`;
      }
      if (maxRating > 0 && rating > maxRating) {
        return `Nota ${rating} acima do máximo (${maxRating})`;
      }
    }
  }

  const yearFrom = params.googleYearFrom && params.googleYearFrom > 0 ? params.googleYearFrom : 0;
  const yearTo = params.googleYearTo && params.googleYearTo > 0 ? params.googleYearTo : 0;
  if (yearFrom > 0 || yearTo > 0) {
    const effectiveFrom = yearFrom > 0 ? yearFrom : MIN_GOOGLE_YEAR;
    const effectiveTo = yearTo > 0 ? yearTo : currentYear;
    const resolvedYear = resolveLeadGoogleYear({
      yearEstablished: params.yearEstablished,
      refDate,
    });
    if (resolvedYear === null) {
      if (!cardStage) {
        return `Ano no Google não identificado (filtro: ${effectiveFrom} até ${effectiveTo})`;
      }
    } else {
      if (resolvedYear < effectiveFrom) {
        return `No Google desde ${resolvedYear} (anterior a ${effectiveFrom})`;
      }
      if (resolvedYear > effectiveTo) {
        return `No Google desde ${resolvedYear} (posterior a ${effectiveTo})`;
      }
    }
  }

  return null;
}

