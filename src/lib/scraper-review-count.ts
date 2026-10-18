/** O banco guarda reviews como INT; ausência mantém capturas antigas sem filtro. */
export function parseMinReviews(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2147483647
    ? value : null;
}

const compactCount = /^(\d+(?:[.,]\d+)?)\s*(mil|k|m)$/i;
const countToken = String.raw`(\d+(?:[.,]\d+)?\s*(?:mil|k|m)|\d{1,3}(?:\.\d{3})+|\d{1,3}(?:,\d{3})+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)`;
// O ARIA do cartão chama o total de votos de "comentários", mesmo sem texto escrito.
const labelledCount = new RegExp(`(?<![\\d.,])${countToken}\\s*(?:avalia[çc][õo]es|avalia[çc][ãa]o|reviews?|ratings?|coment[áa]rios?)\\b`, "i");
const parenthesizedCount = new RegExp(`(?:^\\s*|(?:^|[^\\d.,])[0-5](?:[.,]\\d{1,2})?\\s*(?:estrelas?|stars?)?\\s*[·•]?\\s*)\\(\\s*${countToken}\\s*\\)`, "i");

/** Total agregado do Google, nunca a média de estrelas ou o tamanho da amostra. */
export function parseGoogleReviewCount(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const compact = raw.match(compactCount);
  let count: number;
  if (compact) {
    count = Math.round(Number(compact[1].replace(",", ".")) * (compact[2].toLowerCase() === "m" ? 1000000 : 1000));
  } else if (/^\d+$/.test(raw) || /^\d{1,3}(?:([.,\s])\d{3})(?:\1\d{3})*$/.test(raw)) {
    count = Number(raw.replace(/[.,\s]/g, ""));
  } else {
    return null;
  }
  return Number.isSafeInteger(count) && count >= 0 && count <= 2147483647 ? count : null;
}

/** Lê apenas textos associados ao total (rótulo ou parênteses junto da nota). */
export function extractGoogleReviewCount(sources: string[], previous = ""): string {
  // Prefere exatidão também entre cartão e painel; o painel exato é mais recente.
  let approximate = "";
  for (const source of sources) {
    const match = source.match(labelledCount) || source.match(parenthesizedCount);
    const raw = match?.[1]?.trim() || "";
    if (parseGoogleReviewCount(raw) === null) continue;
    if (!compactCount.test(raw)) return raw;
    approximate ||= raw;
  }
  if (parseGoogleReviewCount(previous) === null) return approximate;
  return compactCount.test(previous.trim()) ? approximate || previous : previous;
}

/** No cartão, desconhecido/aproximado aguarda o painel já previsto na captura. */
export function reviewCountFilterReason(raw: string, minimum = 0, cardStage = false): string {
  if (minimum === 0) return "";
  const count = parseGoogleReviewCount(raw);
  if (count === null) return cardStage ? "" : "Quantidade de avaliações não informada";
  const compact = raw.trim().match(compactCount);
  // ponytail: abreviações são arredondadas; perto do limiar, exigir total exato no painel.
  const decimals = compact?.[1].split(/[.,]/)[1]?.length || 0;
  const margin = compact ? (compact[2].toLowerCase() === "m" ? 1000000 : 1000) / 10 ** decimals : 0;
  // Cartão só descarta se até o teto aproximado fica abaixo do mínimo.
  if (cardStage && compact && count + margin >= minimum) return "";
  return Math.max(0, count - margin) >= minimum ? "" : `Menos de ${minimum} avaliações confirmadas no Google`;
}
