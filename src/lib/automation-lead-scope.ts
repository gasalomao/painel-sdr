/**
 * Resolução do ESCOPO de leads de uma captação da Automação.
 *
 * Função pura, sem I/O — isolada num arquivo próprio pra ser testável sem
 * arrastar supabase/puppeteer junto (ver automation-lead-scope.test.ts).
 *
 * ── Contexto do bug que isto corrige ──────────────────────────────────────
 * O disparo da automação (startDispatchPhase) selecionava os leads colhidos
 * com `.gt("id", _baselineCount)`. Só que `_baselineCount` é a CONTAGEM de
 * linhas da tabela — não um id. Como `id` é sequência auto-incremento (chega
 * facilmente aos milhares num CRM com histórico), comparar `id > contagem`
 * não filtra nada útil: o disparo acabava pegando o CRM INTEIRO — sintoma
 * real "Captação concluída · 232 leads" quando o scraper captou só 5.
 *
 * Correção: o worker passa a gravar `_baselineMaxId` = o MAIOR id existente
 * ANTES do scrape começar. Todo lead inserido depois tem id estritamente
 * maior que isso → filtro exato e à prova de id não-contíguo.
 * ──────────────────────────────────────────────────────────────────────────
 */

export type CapturedLeadScope =
  | { ok: true; baselineMaxId: number | null; startedAt: string | null }
  | { ok: false; reason: string };

/**
 * @param scrapeFilters    coluna `automations.scrape_filters` (JSONB) — guarda
 *                         config do usuário + marcadores de runtime (`_*`).
 * @param startedAtFallback `automations.started_at` — fallback se o marcador
 *                          `_scrapeStartedAt` tiver se perdido.
 */
export function resolveCapturedLeadScope(
  scrapeFilters: Record<string, any> | null | undefined,
  startedAtFallback?: string | null,
): CapturedLeadScope {
  const rawMaxId = scrapeFilters?._baselineMaxId;
  // 0 é um maxId válido (CRM vazio antes do scrape). Por isso o teste é
  // Number.isFinite, e não um simples `if (rawMaxId)`.
  const baselineMaxId =
    rawMaxId !== undefined && rawMaxId !== null && Number.isFinite(Number(rawMaxId))
      ? Number(rawMaxId)
      : null;

  const startedAtRaw = scrapeFilters?._scrapeStartedAt || startedAtFallback;
  const startedAt =
    typeof startedAtRaw === "string" && startedAtRaw.trim() && startedAtRaw !== "undefined"
      ? startedAtRaw
      : null;

  // Sem NENHUM marcador confiável não dá pra saber quais leads são desta
  // captação. Disparar pro CRM inteiro spammaria os clientes e queimaria o
  // número do WhatsApp — então aborta com erro claro em vez de adivinhar.
  if (baselineMaxId === null && !startedAt) {
    return {
      ok: false,
      reason:
        "Não foi possível identificar os leads desta captação (marcadores de baseline perdidos — " +
        "provavelmente a automação foi salva enquanto rodava). Clique em Iniciar de novo pra recomeçar.",
    };
  }

  return { ok: true, baselineMaxId, startedAt };
}
