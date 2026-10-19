import { supabaseAdmin } from "@/lib/supabase_admin";

export type AutomationCaptureRow = {
  id: string;
  client_id: string;
  status: string;
  phase: string;
  scrape_filters: Record<string, unknown>;
  scraped_count: number;
  campaign_id: string | null;
  followup_campaign_id: string | null;
  started_at: string | null;
  updated_at?: string;
  [key: string]: unknown;
};

function positiveIds(value: unknown): number[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0))]
    : [];
}

export function readCaptureIds(filters: unknown): number[] {
  return positiveIds(filters && typeof filters === "object" ? (filters as Record<string, unknown>)._capturedLeadIds : null);
}

export function readRejectedCaptureIds(filters: unknown): number[] {
  return positiveIds(filters && typeof filters === "object" ? (filters as Record<string, unknown>)._rejectedLeadIds : null);
}

/** Retry the mutation against the latest snapshot, never a stale full JSON object. */
export async function updateAutomationCapture(
  clientId: string,
  automationId: string,
  mutate: (current: AutomationCaptureRow) => Partial<AutomationCaptureRow> | null,
): Promise<AutomationCaptureRow | null> {
  if (!clientId.trim()) throw new Error("Cliente obrigatório para atualizar a captura.");
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await supabaseAdmin.from("automations").select("*")
      .eq("id", automationId).eq("client_id", clientId).maybeSingle();
    if (error) throw new Error(`Falha ao ler progresso da captura: ${error.message}`);
    if (!data) return null;
    const current = data as AutomationCaptureRow;
    const patch = mutate(structuredClone({ ...current, scrape_filters: current.scrape_filters || {} }));
    if (!patch) return null;
    let query = supabaseAdmin.from("automations").update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", automationId).eq("client_id", clientId)
      .eq("status", current.status).eq("phase", current.phase);
    query = current.scrape_filters == null
      ? query.is("scrape_filters", null)
      : query.eq("scrape_filters", JSON.stringify(current.scrape_filters));
    // Millisecond timestamps can collide: compare the state used by mutation guards too.
    for (const key of ["campaign_id", "followup_campaign_id", "started_at", "scraped_count"] as const) {
      query = current[key] == null ? query.is(key, null) : query.eq(key, current[key]);
    }
    if (current.updated_at) query = query.eq("updated_at", current.updated_at);
    const result = await query.select("*").maybeSingle();
    if (result.error) throw new Error(`Falha ao salvar progresso da captura: ${result.error.message}`);
    if (result.data) return result.data as AutomationCaptureRow;
  }
  throw new Error("Progresso alterado concorrentemente; tente atualizar a captura novamente.");
}
