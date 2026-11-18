import { supabaseAdmin as supabase } from "@/lib/supabase_admin";

/**
 * Política de prévia de site por lead.
 *
 * Regra do produto: o módulo de Prospecção de Sites é SOMENTE DISPARO — não
 * gera site. A geração continua liberada para os demais fluxos (Agent com a
 * opção ligada, Site Studio, automações de outros tipos).
 *
 * A decisão é derivada da origem do lead, sem migration e sem backfill:
 * - Lead em campanha `campaign_type = 'prospeccao_sites'` → bloqueado.
 * - Lead em automação com `scrape_filters._source = 'prospeccao-sites'` → bloqueado.
 * - Automação com `site_generation_enabled = false` → bloqueado.
 * - Override explícito em app_settings `site_preview_enabled:<automationId>`
 *   (`true`/`false`) tem precedência sobre a regra derivada.
 * - Lead sem campanha/automação vinculada → liberado (não quebra fluxo manual).
 *
 * Em caso de erro de banco a política falha ABERTA (libera), para nunca
 * derrubar a geração de prévia de quem realmente vende site.
 */

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 2_000;
const _policyCache = new Map<string, { allowed: boolean; at: number }>();

export function __resetSitePreviewPolicyCacheForTests(): void {
  _policyCache.clear();
}

type AutomationPolicyRow = {
  id: string;
  site_generation_enabled?: boolean | null;
  scrape_filters?: Record<string, unknown> | null;
};

function cacheKey(clientId: string, remoteJid: string): string {
  return `${clientId}:${remoteJid}`;
}

function readCache(clientId: string, remoteJid: string, nowMs: number): boolean | undefined {
  const hit = _policyCache.get(cacheKey(clientId, remoteJid));
  if (!hit) return undefined;
  if (nowMs - hit.at > CACHE_TTL_MS) {
    _policyCache.delete(cacheKey(clientId, remoteJid));
    return undefined;
  }
  return hit.allowed;
}

function writeCache(clientId: string, remoteJid: string, allowed: boolean, nowMs: number): void {
  if (_policyCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = _policyCache.keys().next().value;
    if (oldest !== undefined) _policyCache.delete(oldest);
  }
  _policyCache.set(cacheKey(clientId, remoteJid), { allowed, at: nowMs });
}

function overrideAllowsPreview(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function automationAllowsPreview(auto: AutomationPolicyRow, override?: string): boolean {
  const explicit = overrideAllowsPreview(override);
  if (explicit !== undefined) return explicit;

  const source = auto?.scrape_filters?._source;
  if (source === "prospeccao-sites") return false;

  return auto?.site_generation_enabled !== false;
}

/**
 * Resolve a política para um lote de leads do mesmo tenant.
 * Retorna mapa remoteJid → liberado (true) / bloqueado (false).
 */
export async function resolveSitePreviewPolicyForLeads(
  clientId: string,
  remoteJids: string[],
  nowMs = Date.now()
): Promise<Map<string, boolean>> {
  const allowedByJid = new Map<string, boolean>();
  const unique = Array.from(new Set(remoteJids.map((j) => String(j || "").trim()).filter(Boolean)));
  const missing: string[] = [];

  for (const jid of unique) {
    const cached = readCache(clientId, jid, nowMs);
    if (cached === undefined) missing.push(jid);
    else allowedByJid.set(jid, cached);
  }
  if (missing.length === 0) return allowedByJid;

  const failOpen = (jids: string[]) => {
    for (const jid of jids) {
      allowedByJid.set(jid, true);
      writeCache(clientId, jid, true, nowMs);
    }
  };

  if (!clientId || !supabase) {
    failOpen(missing);
    return allowedByJid;
  }

  try {
    const { data: targets, error: targetErr } = await supabase
      .from("campaign_targets")
      .select("remote_jid, campaign_id")
      .eq("client_id", clientId)
      .in("remote_jid", missing);
    if (targetErr) throw targetErr;

    const campaignIds = Array.from(
      new Set(
        (targets || [])
          .map((t: any) => String(t?.campaign_id || ""))
          .filter(Boolean),
      ),
    );

    let campaigns: Array<{ id: string; campaign_type?: string | null; automation_id?: string | null }> = [];
    if (campaignIds.length > 0) {
      const first = await supabase
        .from("campaigns")
        .select("id, campaign_type, automation_id")
        .eq("client_id", clientId)
        .in("id", campaignIds);
      if (first.error) {
        const retry = await supabase
          .from("campaigns")
          .select("id, automation_id")
          .eq("client_id", clientId)
          .in("id", campaignIds);
        if (retry.error) throw retry.error;
        campaigns = (retry.data || []) as typeof campaigns;
      } else {
        campaigns = (first.data || []) as typeof campaigns;
      }
    }

    const automationIds = Array.from(
      new Set(campaigns.map((c) => String(c?.automation_id || "")).filter(Boolean)),
    );

    let automations: AutomationPolicyRow[] = [];
    if (automationIds.length > 0) {
      const first = await supabase
        .from("automations")
        .select("id, site_generation_enabled, scrape_filters")
        .in("id", automationIds);
      if (first.error) {
        const retry = await supabase
          .from("automations")
          .select("id, scrape_filters")
          .in("id", automationIds);
        if (retry.error) throw retry.error;
        automations = (retry.data || []) as AutomationPolicyRow[];
      } else {
        automations = (first.data || []) as AutomationPolicyRow[];
      }
    }

    const overrides = new Map<string, string>();
    if (automationIds.length > 0) {
      const { data: rows } = await supabase
        .from("app_settings")
        .select("key, value")
        .in("key", automationIds.map((id) => `site_preview_enabled:${id}`));
      for (const row of rows || []) {
        if (row?.key) overrides.set(String(row.key), String(row.value ?? ""));
      }
    }

    const campaignById = new Map(campaigns.map((c) => [String(c.id), c]));
    const automationById = new Map(automations.map((a) => [String(a.id), a]));
    const campaignsByJid = new Map<string, string[]>();
    for (const target of targets || []) {
      const jid = String((target as any)?.remote_jid || "");
      const campaignId = String((target as any)?.campaign_id || "");
      if (!jid || !campaignId) continue;
      const list = campaignsByJid.get(jid) || [];
      list.push(campaignId);
      campaignsByJid.set(jid, list);
    }

    for (const jid of missing) {
      const jidCampaigns = campaignsByJid.get(jid) || [];
      let allowed = true;

      for (const campaignId of jidCampaigns) {
        const campaign = campaignById.get(campaignId);
        if (!campaign) continue;
        if (campaign.campaign_type === "prospeccao_sites") {
          allowed = false;
          break;
        }
        const automationId = String(campaign.automation_id || "");
        if (!automationId) continue;
        const automation = automationById.get(automationId);
        if (!automation) continue;
        if (!automationAllowsPreview(automation, overrides.get(`site_preview_enabled:${automationId}`))) {
          allowed = false;
          break;
        }
      }

      allowedByJid.set(jid, allowed);
      writeCache(clientId, jid, allowed, nowMs);
    }

    return allowedByJid;
  } catch (err) {
    console.warn("[preview-policy] Falha ao resolver política; liberando prévia:", (err as Error)?.message);
    failOpen(missing);
    return allowedByJid;
  }
}

/** Atalho para um único lead. */
export async function isSitePreviewAllowedForLead(
  clientId: string,
  remoteJid: string,
  nowMs = Date.now()
): Promise<boolean> {
  const map = await resolveSitePreviewPolicyForLeads(clientId, [remoteJid], nowMs);
  return map.get(String(remoteJid || "").trim()) !== false;
}

/**
 * Legado: mantém a leitura da coluna `automations.site_generation_enabled`
 * coerente com a política derivada (usado nas rotas de criação).
 */
export function automationSourceBlocksPreview(source?: string | null): boolean {
  return source === "prospeccao-sites";
}
