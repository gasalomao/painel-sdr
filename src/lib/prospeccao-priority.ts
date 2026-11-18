/**
 * Computa prioridade de disparo por lead.
 * Maior priority = enviado primeiro pelo worker (campaign-worker.ts ordena priority DESC).
 *
 * order_by:
 *   - "reviews"    → score = parseInt(reviews) || 0
 *   - "rating"     → score = parseFloat(avaliacao) || 0
 *   - "created_at" → score = -timestamp (mais novo primeiro quando order_dir=desc)
 *
 * order_dir:
 *   - "desc" → maior score vence (priority = score)
 *   - "asc"  → menor score vence (priority = -score)
 *
 * Empate permanece (worker desempata por created_at ASC).
 */
export type ProspecOrderBy = "reviews" | "rating" | "created_at" | "qualification";
export type ProspecOrderDir = "asc" | "desc";

export type ProspecLeadInput = {
  avaliacao?: string | number | null;
  reviews?: string | number | null;
  created_at?: string | null;
  business_details?: Record<string, unknown> | null;
};

export function computePriority(
  lead: ProspecLeadInput,
  order_by: ProspecOrderBy = "reviews",
  order_dir: ProspecOrderDir = "desc"
): number {
  let score = 0;
  if (order_by === "qualification") {
    const enr = lead.business_details?.enrichment as Record<string, unknown> | undefined;
    const rawScore = Number(enr?.qualificationScore);
    const baseScore =
      Number.isFinite(rawScore) && rawScore > 0
        ? Math.round(rawScore)
        : (() => {
            const rv = parseInt(String(lead.reviews ?? "0"), 10) || 0;
            const rt = parseFloat(String(lead.avaliacao ?? "0")) || 0;
            return Math.min(100, Math.round((rv >= 50 ? 20 : rv >= 10 ? 10 : 0) + rt * 10));
          })();
    let priority = baseScore * 10;
    const siteHealth = typeof enr?.siteHealth === "string" ? enr.siteHealth : "";
    const siteQuality = Number(enr?.siteQualityScore);
    if (siteHealth === "broken_site" || siteHealth === "weak_site" || siteHealth === "no_site") {
      priority += 5;
    } else if (siteHealth === "active_site" && Number.isFinite(siteQuality) && siteQuality >= 80) {
      priority -= 4;
    }
    const channelType = typeof enr?.whatsappChannelType === "string" ? enr.whatsappChannelType : "";
    if (channelType === "socio_direto") priority += 3;
    else if (channelType === "provavel_socio") priority += 2;
    if (enr?.hasPaidTrafficTag === true) priority += 1;
    if (Array.isArray(enr?.managementTools) && enr.managementTools.length > 0) priority += 1;
    score = priority;
  } else if (order_by === "reviews") {
    score = parseInt(String(lead.reviews ?? "0"), 10) || 0;
  } else if (order_by === "rating") {
    score = Math.round((parseFloat(String(lead.avaliacao ?? "0")) || 0) * 100); // 2 casas Precisão int
  } else {
    const t = lead.created_at ? Date.parse(lead.created_at) : 0;
    score = Number.isFinite(t) ? -t : 0;
  }
  return order_dir === "desc" ? score : -score;
}

/**
 * Filtra leads por min_reviews/min_rating.
 * Coluna real em leads_extraidos é `avaliacao` (numeric), NÃO `rating`.
 */
export function passesFilters(
  lead: ProspecLeadInput,
  min_reviews = 0,
  min_rating = 0
): boolean {
  if (min_reviews > 0) {
    const rv = parseInt(String(lead.reviews ?? "0"), 10) || 0;
    if (rv < min_reviews) return false;
  }
  if (min_rating > 0) {
    const r = parseFloat(String(lead.avaliacao ?? "0")) || 0;
    if (r < min_rating) return false;
  }
  return true;
}