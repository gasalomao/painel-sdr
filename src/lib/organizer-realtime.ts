import { supabaseAdmin } from "@/lib/supabase_admin";
import { getInternalSecret, INTERNAL_SECRET_HEADER } from "@/lib/internal-auth";

declare global {
  var organizerRealtimeTimers: Map<string, NodeJS.Timeout> | undefined;
}

const DEBOUNCE_MS = 45_000; // 45s após a última mensagem da conversa estabilizar

function getTimersMap(): Map<string, NodeJS.Timeout> {
  if (!globalThis.organizerRealtimeTimers) {
    globalThis.organizerRealtimeTimers = new Map();
  }
  return globalThis.organizerRealtimeTimers;
}

export type SystemSignalType =
  | "custom_goal_reached"
  | "site_preview_requested"
  | "site_preview_sent"
  | "calendar_scheduled";

/**
 * Camada 0 (0 Tokens): Move o lead instantaneamente no Kanban quando um evento
 * determinístico do sistema acontece (meta atingida, prévia solicitada, prévia enviada,
 * agendamento no Google Calendar), adaptando-se às colunas reais do Kanban do cliente.
 */
export async function promoteLeadBySystemSignal(params: {
  clientId: string;
  remoteJid: string;
  signal: SystemSignalType;
  reason: string;
  summary?: string;
}): Promise<{ moved: boolean; newStatus: string | null }> {
  const { clientId, remoteJid, signal, reason, summary } = params;
  if (!supabaseAdmin || !clientId || !remoteJid) {
    return { moved: false, newStatus: null };
  }

  try {
    const [{ data: cols }, { data: lead }] = await Promise.all([
      supabaseAdmin
        .from("kanban_columns")
        .select("status_key, label, order_index")
        .eq("client_id", clientId)
        .order("order_index", { ascending: true }),
      supabaseAdmin
        .from("leads_extraidos")
        .select('id, "remoteJid", nome_negocio, status')
        .eq("client_id", clientId)
        .eq("remoteJid", remoteJid)
        .maybeSingle(),
    ]);

    const columns = (cols || []) as Array<{ status_key: string; label: string; order_index: number }>;
    const findCol = (regex: RegExp, fallbacks: string[]): string | null => {
      const match = columns.find((c) => regex.test(`${c.status_key} ${c.label}`));
      if (match) return match.status_key;
      for (const fb of fallbacks) {
        if (columns.some((c) => c.status_key === fb)) return fb;
      }
      return fallbacks[0] || null;
    };

    let targetStatus: string | null = null;
    if (signal === "site_preview_requested") {
      targetStatus = findCol(
        /previa_solicitada|previa_pedida|aceitou_previa|orcamento_solicitado|interessado|qualificado/i,
        ["previa_solicitada", "interessado", "em_qualificacao"]
      );
    } else if (signal === "custom_goal_reached") {
      if (/reuni[aã]o|agend|call|consulta|visita/i.test(reason)) {
        targetStatus = findCol(
          /agendad|reuniao|call|consulta|visita/i,
          ["agendado", "interessado"]
        );
      } else {
        targetStatus = findCol(
          /previa_solicitada|previa_pedida|aceitou_previa|orcamento_solicitado|interessado|qualificado|em_negociacao/i,
          ["previa_solicitada", "interessado", "agendado"]
        );
      }
    } else if (signal === "site_preview_sent") {
      targetStatus = findCol(
        /em_negociacao|previa_enviada|previa_pronta|proposta|interessado/i,
        ["em_negociacao", "interessado", "agendado"]
      );
    } else if (signal === "calendar_scheduled") {
      targetStatus = findCol(
        /agendad|reuniao|call|consulta|visita/i,
        ["agendado", "interessado"]
      );
    }

    if (!targetStatus) return { moved: false, newStatus: null };

    const oldStatus = lead?.status || "novo";
    if (oldStatus === targetStatus) {
      return { moved: false, newStatus: targetStatus };
    }

    const nowIso = new Date().toISOString();
    await supabaseAdmin
      .from("leads_extraidos")
      .upsert(
        {
          client_id: clientId,
          remoteJid,
          nome_negocio: lead?.nome_negocio || `Lead (${remoteJid.split("@")[0]})`,
          status: targetStatus,
          justificativa_ia: reason.slice(0, 500),
          resumo_ia: (summary || reason).slice(0, 800),
          ia_last_analyzed_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: "client_id,remoteJid" }
      );

    await supabaseAdmin.from("historico_ia_leads").insert({
      client_id: clientId,
      remote_jid: remoteJid,
      nome_negocio: lead?.nome_negocio || `Lead (${remoteJid.split("@")[0]})`,
      status_antigo: oldStatus,
      status_novo: targetStatus,
      razao: reason.slice(0, 500),
      resumo: (summary || reason).slice(0, 800),
      batch_id: crypto.randomUUID(),
    });

    return { moved: true, newStatus: targetStatus };
  } catch (err: any) {
    console.warn("[organizer-realtime] promoteLeadBySystemSignal erro:", err?.message);
    return { moved: false, newStatus: null };
  }
}

/**
 * Agenda avaliação automática em background (com debounce de 45s por contato)
 * para mover o card no Kanban sozinho logo após a conversa estabilizar.
 */
export function scheduleRealtimeLeadEvaluation(
  clientId: string,
  remoteJid: string,
  delayMs: number = DEBOUNCE_MS
): void {
  if (!clientId || !remoteJid) return;
  const key = `${clientId}:${remoteJid}`;
  const timers = getTimersMap();

  const existing = timers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    timers.delete(key);
    try {
      if (!supabaseAdmin) return;
      const { data: cli } = await supabaseAdmin
        .from("clients")
        .select("organizer_enabled")
        .eq("id", clientId)
        .maybeSingle();

      if (cli?.organizer_enabled === false) return;

      const baseUrl = process.env.INTERNAL_APP_URL || `http://localhost:${process.env.PORT || 3000}`;
      await fetch(`${baseUrl}/api/ai-organize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_SECRET_HEADER]: getInternalSecret(),
        },
        body: JSON.stringify({
          clientId,
          targetJids: [remoteJid],
          triggered_by: "realtime",
        }),
      });
    } catch (err: any) {
      console.warn("[organizer-realtime] falha na avaliação pós-conversa:", err?.message);
    }
  }, delayMs);

  if (typeof (timer as any)?.unref === "function") {
    (timer as any).unref();
  }
  timers.set(key, timer);
}
