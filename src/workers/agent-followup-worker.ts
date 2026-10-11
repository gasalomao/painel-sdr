import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { renderTemplate } from "@/lib/template-vars";
import { getEvolutionConfig } from "@/lib/evolution";

interface ClaimedFollowUp {
  id: number;
  client_id: string;
  agent_id: number;
  remote_jid: string;
  instance_name: string;
  current_step: number;
  claim_id: string;
  lead_id: number | null;
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!supabaseAdmin) throw new Error("Banco de follow-up não configurado.");
  const { data, error } = await supabaseAdmin.rpc(name, args);
  if (error) throw new Error("Operação persistida de follow-up não confirmada.");
  return data;
}

function ownership(row: ClaimedFollowUp): Record<string, unknown> {
  return { p_id: row.id, p_client: row.client_id, p_agent: row.agent_id, p_step: row.current_step, p_claim: row.claim_id };
}

async function messageFor(row: ClaimedFollowUp): Promise<string> {
  if (!supabaseAdmin) throw new Error("Banco de follow-up não configurado.");
  const { data: agent, error } = await supabaseAdmin.from("agent_settings").select("options").eq("id", row.agent_id).eq("client_id", row.client_id).maybeSingle();
  if (error || !agent) throw new Error("Configuração de follow-up indisponível.");
  const options = agent.options?.follow_up as Record<string, unknown> | undefined;
  const key = ["", "1h", "4h", "24h", "48h"][row.current_step];
  const template = options?.[`follow_up_${key}_template`];
  if (options?.[`follow_up_${key}_enabled`] === false) return "";
  if (typeof template !== "string" || !template.trim() || template.length > 4000) throw new Error("Template de follow-up inválido.");
  let lead: Record<string, unknown> | null = null;
  if (row.lead_id) {
    const result = await supabaseAdmin.from("leads_extraidos").select("nome_negocio,ramo_negocio,categoria,endereco,telefone").eq("id", row.lead_id).eq("client_id", row.client_id).maybeSingle();
    if (result.error) throw new Error("Dados de follow-up indisponíveis.");
    lead = result.data;
  }
  return renderTemplate(template, {
    remoteJid: row.remote_jid, nome_negocio: String(lead?.nome_negocio || "sua empresa"),
    ramo_negocio: String(lead?.ramo_negocio || lead?.categoria || "seu ramo"), categoria: String(lead?.categoria || ""),
    endereco: String(lead?.endereco || ""), telefone: String(lead?.telefone || row.remote_jid.split("@")[0]),
  });
}

async function processClaim(row: ClaimedFollowUp): Promise<void> {
  let hasIntent = false;
  try {
    if (!/^[1-9]\d{5,19}@s\.whatsapp\.net$/.test(row.remote_jid) || !row.instance_name) throw new Error("Destino de follow-up inválido.");
    const message = await messageFor(row);
    const config = await getEvolutionConfig();
    const endpoint = new URL(`${config.url.replace(/\/$/, "")}/message/sendText/${encodeURIComponent(row.instance_name)}`);
    if (!["http:", "https:"].includes(endpoint.protocol) || !config.apiKey) throw new Error("Transporte de follow-up inválido.");
    const attempt = randomUUID();
    // Após tentar persistir intenção, uma resposta perdida também é ambígua.
    hasIntent = true;
    const prepared = await rpc("prepare_agent_followup", { ...ownership(row), p_attempt: attempt, p_content: message }) as { action?: string } | null;
    if (prepared?.action === "cancelled" || prepared?.action === "skipped") return;
    if (prepared?.action !== "send") throw new Error("Intenção de follow-up não confirmada.");
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", apikey: config.apiKey }, body: JSON.stringify({ number: row.remote_jid, text: message }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("Resultado de follow-up não confirmado pelo provider.");
    const result: unknown = await response.json();
    const providerId = result && typeof result === "object" && "key" in result && result.key && typeof result.key === "object" && "id" in result.key ? result.key.id : null;
    if (typeof providerId !== "string" || !providerId.trim() || providerId.length > 500) throw new Error("Envio de follow-up sem identificação confirmada.");
    const finalized = await rpc("finish_agent_followup", { ...ownership(row), p_attempt: attempt, p_provider_id: providerId });
    if (!finalized) throw new Error("Conclusão de follow-up não confirmada.");
  } catch {
    try {
      await rpc("release_agent_followup", { ...ownership(row), p_status: hasIntent ? "ambiguous" : "failed", p_error: hasIntent ? "Resultado do envio não confirmado; reconciliação necessária antes de qualquer repetição." : "Preparação de follow-up falhou; nenhum envio iniciado." });
    } catch { console.error("[FOLLOWUP WORKER] Não foi possível registrar o bloqueio; claim/intenção permanecem protegidos no banco."); }
    console.error("[FOLLOWUP WORKER] Execução não confirmada. Nenhum retry de envio realizado.");
  }
}

export async function runFollowUpWorker(): Promise<void> {
  if (process.env.AGENT_FOLLOWUP_WORKER_ENABLED !== "true") return;
  for (let count = 0; count < 50; count++) {
    let data: unknown;
    try { data = await rpc("claim_agent_followup", { p_claim: randomUUID(), p_lease_seconds: 120 }); }
    catch { console.error("[FOLLOWUP WORKER] Claim indisponível. Verifique a migration 021 antes de habilitar."); return; }
    const row = Array.isArray(data) ? data[0] as ClaimedFollowUp | undefined : undefined;
    if (!row) return;
    await processClaim(row);
  }
}
