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
      .select("id, remoteJid, nome_negocio, status, primeiro_contato_at")
      .eq("status", "primeiro_contato")
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

  const motivo = `Promoção automática: ${Math.round(STALE_HOURS / 24)} dias em primeiro_contato (origem: disparo em massa) sem resposta do cliente.`;
  const nowIso = new Date().toISOString();
  const resumoIA = `Disparo feito há ${Math.round(STALE_HOURS / 24)} dias. Cliente não respondeu. Lead auto-promovido para follow-up — pronto pra entrar numa cadência de retomada.`;

  const ids = stale.map((l) => l.id);
  const { error: upErr } = await supabase
    .from("leads_extraidos")
    .update({
      status: "follow-up",
      justificativa_ia: motivo,
      resumo_ia: resumoIA,
      ia_last_analyzed_at: nowIso,
      updated_at: nowIso,
    })
    .in("id", ids);

  if (upErr) {
    if (looksLikeHtml(upErr.message)) {
      console.warn("[AUTO-PROMOTER] Supabase indisponível durante update — pulando ciclo.");
    } else {
      console.error("[AUTO-PROMOTER] erro no update:", upErr.message);
    }
    return 0;
  }

  // Registra no histórico pra ficar auditável
  const historyRows = stale.map((l) => ({
    remote_jid: l.remoteJid,
    nome_negocio: l.nome_negocio,
    status_antigo: "primeiro_contato",
    status_novo: "follow-up",
    razao: motivo,
    resumo: resumoIA,
    batch_id: `auto-promoter-${Date.now()}`,
  }));
  const { error: histErr } = await supabase.from("historico_ia_leads").insert(historyRows);
  if (histErr) {
    const msg = looksLikeHtml(histErr.message) ? "Supabase indisponível ao gravar histórico" : histErr.message;
    console.warn("[AUTO-PROMOTER] histórico:", msg);
  }

  console.log(`[AUTO-PROMOTER] ${stale.length} lead(s) promovidos primeiro_contato → follow-up.`);
  return stale.length;
}
