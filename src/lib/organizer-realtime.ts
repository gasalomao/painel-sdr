import { supabaseAdmin } from "@/lib/supabase_admin";
import { getInternalSecret, INTERNAL_SECRET_HEADER } from "@/lib/internal-auth";
import { inferStageRole, type KanbanColLite } from "@/lib/organizer-prompt";

declare global {
  var organizerRealtimeTimers: Map<string, NodeJS.Timeout> | undefined;
  var organizerRealtimePending: Map<string, { clientId: string; remoteJid: string }> | undefined;
  var organizerRealtimeInFlight: Set<string> | undefined;
  var organizerRealtimeShutdownHooked: boolean | undefined;
}

const DEBOUNCE_MS = 45_000; // 45s após a última mensagem da conversa estabilizar

function getTimersMap(): Map<string, NodeJS.Timeout> {
  if (!globalThis.organizerRealtimeTimers) {
    globalThis.organizerRealtimeTimers = new Map();
  }
  return globalThis.organizerRealtimeTimers;
}

function getPendingMap(): Map<string, { clientId: string; remoteJid: string }> {
  if (!globalThis.organizerRealtimePending) {
    globalThis.organizerRealtimePending = new Map();
  }
  return globalThis.organizerRealtimePending;
}

function getInFlightSet(): Set<string> {
  if (!globalThis.organizerRealtimeInFlight) {
    globalThis.organizerRealtimeInFlight = new Set();
  }
  return globalThis.organizerRealtimeInFlight;
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
        .select('id, "remoteJid", nome_negocio, status, previa_status, reuniao_agendada_em')
        .eq("client_id", clientId)
        .eq("remoteJid", remoteJid)
        .maybeSingle(),
    ]);

    const columns = (cols || []) as KanbanColLite[];
    const findCol = (regex: RegExp, fallbacks: string[]): string | null => {
      const match = columns.find((c) => regex.test(`${c.status_key} ${c.label}`));
      if (match) return match.status_key;
      for (const fb of fallbacks) {
        if (columns.some((c) => c.status_key === fb)) return fb;
      }
      return fallbacks[0] || null;
    };
    const findByRole = (role: ReturnType<typeof inferStageRole>, regex: RegExp, fallbacks: string[]): string | null => {
      const byRole = columns.find((c) => inferStageRole(c) === role);
      if (byRole) return byRole.status_key;
      return findCol(regex, fallbacks);
    };

    let targetStatus: string | null = null;
    if (signal === "site_preview_requested") {
      targetStatus = findByRole(
        "waiting_asset",
        /previa_solicitada|previa_pedida|aceitou_previa|orcamento_solicitado|interessado|qualificado/i,
        ["previa_solicitada", "interessado", "em_qualificacao"]
      );
    } else if (signal === "custom_goal_reached") {
      const currentStatus = String(lead?.status || "").toLowerCase();
      const currentCol = columns.find((c) => c.status_key === lead?.status);
      const currentRole = currentCol ? inferStageRole(currentCol) : null;
      if (
        (currentRole && ["waiting_asset", "proposal", "scheduled", "won", "lost", "discarded"].includes(currentRole)) ||
        /previa|negociac|agend|fechad|sem_interesse|descart|perdid/i.test(currentStatus)
      ) {
        return { moved: false, newStatus: lead?.status || null };
      }
      if (Boolean((lead as { reuniao_agendada_em?: unknown })?.reuniao_agendada_em) || (lead as { previa_status?: unknown })?.previa_status === "REUNIAO_AGENDADA") {
        targetStatus = findByRole(
          "scheduled",
          /agendad|reuniao|call|consulta|visita/i,
          ["agendado", "interessado"]
        );
      } else {
        targetStatus = findCol(
          /interessado|qualificado|em_qualificacao|previa_solicitada|em_negociacao/i,
          ["interessado", "em_qualificacao", "previa_solicitada"]
        );
      }
    } else if (signal === "site_preview_sent") {
      targetStatus = findByRole(
        "proposal",
        /em_negociacao|previa_enviada|previa_pronta|proposta|interessado/i,
        ["em_negociacao", "interessado", "agendado"]
      );
    } else if (signal === "calendar_scheduled") {
      targetStatus = findByRole(
        "scheduled",
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

async function executeRealtimeEvaluation(clientId: string, remoteJid: string): Promise<void> {
  const key = `${clientId}:${remoteJid}`;
  const inFlight = getInFlightSet();
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    if (!supabaseAdmin) return;
    const { data: cli } = await supabaseAdmin
      .from("clients")
      .select("organizer_enabled")
      .eq("id", clientId)
      .maybeSingle();

    if (cli?.organizer_enabled === false) return;

    const { NextRequest } = await import("next/server");
    const { POST: runAiOrganize } = await import("@/app/api/ai-organize/route");
    const internalReq = new NextRequest("http://internal/api/ai-organize", {
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
    await runAiOrganize(internalReq);
  } catch (err: unknown) {
    console.warn("[organizer-realtime] falha na avaliação pós-conversa:", err instanceof Error ? err.message : err);
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Despacha imediatamente avaliações em debounce pendentes (chamado em shutdown gracioso).
 */
export async function flushPendingRealtimeEvaluations(): Promise<number> {
  const timers = getTimersMap();
  const pending = getPendingMap();
  const entries = Array.from(pending.entries());
  for (const [key] of entries) {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.delete(key);
    pending.delete(key);
  }
  await Promise.allSettled(
    entries.map(([, item]) => executeRealtimeEvaluation(item.clientId, item.remoteJid))
  );
  return entries.length;
}

function ensureShutdownHook(): void {
  if (globalThis.organizerRealtimeShutdownHooked) return;
  globalThis.organizerRealtimeShutdownHooked = true;
  if (typeof process !== "undefined" && typeof process.once === "function") {
    process.once("beforeExit", () => {
      void flushPendingRealtimeEvaluations();
    });
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
  ensureShutdownHook();
  const key = `${clientId}:${remoteJid}`;
  const timers = getTimersMap();
  const pending = getPendingMap();

  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  pending.set(key, { clientId, remoteJid });

  const timer = setTimeout(async () => {
    timers.delete(key);
    pending.delete(key);
    await executeRealtimeEvaluation(clientId, remoteJid);
  }, delayMs);

  if (typeof (timer as { unref?: () => void })?.unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  timers.set(key, timer);
}
