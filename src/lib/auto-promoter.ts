/**
 * Promoções automáticas de status no CRM.
 *
 * Regra atual: leads que entraram em "primeiro_contato" via disparo em massa
 * e ficam mais de 2 dias nesse estado (sem resposta que mudasse o status)
 * são movidos automaticamente para "follow-up", prontos pra entrarem numa
 * campanha de follow-up.
 *
 * Só mexe em leads cuja origem é EXPLICITAMENTE 'disparo'. Leads colocados
 * em primeiro_contato por outro caminho (IA, manual) não são afetados.
 */

import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { inferStageRole, type KanbanColLite } from "@/lib/organizer-prompt";

const STALE_HOURS = 48; // 2 dias

/**
 * Detecta se a mensagem de erro do supabase-js é, na verdade, uma página HTML
 * (Easypanel "Service is not reachable", Cloudflare 5xx, etc). Quando isso
 * acontece, dar retry curto não adianta — o container pode levar minutos pra
 * voltar — e o erro original despeja KB de HTML no log. Detectamos pra logar
 * compacto e simplesmente pular o ciclo (o próximo tick em 2 min cobre).
 */
function looksLikeHtml(message: string | undefined | null): boolean {
  if (!message) return false;
  const trimmed = message.trim().toLowerCase();
  return trimmed.startsWith("<!doctype") || trimmed.startsWith("<html");
}

export async function promoteStalePrimeiroContato(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000).toISOString();

  // 1. Busca quem precisa promover (com 1 retry para cobrir boot lento do Supabase)
  let stale: any[] | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { data, error } = await supabase
      .from("leads_extraidos")
      .select("id, client_id, remoteJid, nome_negocio, status, primeiro_contato_at")
      .eq("primeiro_contato_source", "disparo")
      .lte("primeiro_contato_at", cutoff)
      .limit(500);

    if (!error) {
      stale = data;
      break;
    }

    if (looksLikeHtml(error.message)) {
      console.warn("[AUTO-PROMOTER] Supabase indisponível (host respondeu HTML — provavelmente container reiniciando). Pulando este ciclo.");
      return 0;
    }

    const cause = (error as any).cause ? ` (cause: ${(error as any).cause?.message || (error as any).cause})` : "";
    console.error(`[AUTO-PROMOTER] erro na query (tentativa ${attempt}/2): ${error.message}${cause}`);
    if (attempt < 2) {
      console.log("[AUTO-PROMOTER] aguardando 5s para retry...");
      await new Promise(r => setTimeout(r, 5000));
    } else {
      return 0;
    }
  }
  if (!stale || stale.length === 0) return 0;

  // Resolve colunas reais por tenant (suporta qualquer nicho que renomeie primeiro_contato/follow-up)
  const clientIds = Array.from(
    new Set(stale.map((l) => l.client_id).filter((id): id is string => typeof id === "string" && id.length > 0))
  );
  const colsByClient = new Map<string, KanbanColLite[]>();
  if (clientIds.length > 0) {
    try {
      const { data: colRows } = await supabase
        .from("kanban_columns")
        .select("client_id, status_key, label, order_index, is_terminal")
        .in("client_id", clientIds)
        .order("order_index", { ascending: true });
      for (const c of (colRows || []) as Array<KanbanColLite & { client_id?: string }>) {
        if (!c.client_id) continue;
        if (!colsByClient.has(c.client_id)) colsByClient.set(c.client_id, []);
        colsByClient.get(c.client_id)!.push(c);
      }
    } catch {
      // fallback seguro abaixo se kanban_columns estiver indisponível
    }
  }

  const eligible: Array<{ lead: any; fromStatus: string; targetStatus: string }> = [];
  for (const lead of stale) {
    const cid = String(lead.client_id || "");
    const statusAtual = String(lead.status || "").trim();
    const clientCols = cid ? (colsByClient.get(cid) || []) : [];

    const isContactedLead =
      statusAtual === "primeiro_contato" ||
      clientCols.some((c) => c.status_key === statusAtual && inferStageRole(c) === "contacted");
    if (!isContactedLead) continue;

    let targetStatus: string | null = null;
    if (clientCols.length > 0) {
      const followupCol = clientCols.find((c) => inferStageRole(c) === "followup");
      if (!followupCol) continue; // Cliente removeu explicitamente etapa de follow-up
      targetStatus = followupCol.status_key;
    } else {
      targetStatus = "follow-up";
    }

    if (!targetStatus || targetStatus === statusAtual) continue;
    eligible.push({ lead, fromStatus: statusAtual, targetStatus });
  }

  if (eligible.length === 0) return 0;

  const nowIso = new Date().toISOString();
  const byTarget = new Map<string, Array<{ lead: any; fromStatus: string; targetStatus: string }>>();
  for (const item of eligible) {
    const k = `${item.lead.client_id || "none"}::${item.targetStatus}`;
    if (!byTarget.has(k)) byTarget.set(k, []);
    byTarget.get(k)!.push(item);
  }

  let totalPromoted = 0;
  for (const group of byTarget.values()) {
    const targetStatus = group[0].targetStatus;
    const motivo = `Promoção automática: ${Math.round(STALE_HOURS / 24)} dias em "${group[0].fromStatus}" (origem: disparo em massa) sem resposta do cliente.`;
    const resumoIA = `Disparo feito há ${Math.round(STALE_HOURS / 24)} dias. Cliente não respondeu. Lead auto-promovido para "${targetStatus}" — pronto para cadência de retomada.`;
    const ids = group.map((g) => g.lead.id);

    const { error: upErr } = await supabase
      .from("leads_extraidos")
      .update({
        status: targetStatus,
        justificativa_ia: motivo,
        resumo_ia: resumoIA,
        ia_last_analyzed_at: nowIso,
        updated_at: nowIso,
      })
      .in("id", ids);

    if (upErr) {
      if (looksLikeHtml(upErr.message)) {
        console.warn("[AUTO-PROMOTER] Supabase indisponível durante update — pulando grupo.");
      } else {
        console.error("[AUTO-PROMOTER] erro no update:", upErr.message);
      }
      continue;
    }

    const historyRows = group.map((g) => ({
      client_id: g.lead.client_id || null,
      remote_jid: g.lead.remoteJid,
      nome_negocio: g.lead.nome_negocio,
      status_antigo: g.fromStatus,
      status_novo: targetStatus,
      razao: motivo,
      resumo: resumoIA,
      batch_id: `auto-promoter-${Date.now()}`,
    }));
    const { error: histErr } = await supabase.from("historico_ia_leads").insert(historyRows);
    if (histErr) {
      const msg = looksLikeHtml(histErr.message) ? "Supabase indisponível ao gravar histórico" : histErr.message;
      console.warn("[AUTO-PROMOTER] histórico:", msg);
    }

    totalPromoted += group.length;
  }

  if (totalPromoted > 0) {
    console.log(`[AUTO-PROMOTER] ${totalPromoted} lead(s) promovidos automaticamente para etapa de follow-up.`);
  }
  return totalPromoted;
}
