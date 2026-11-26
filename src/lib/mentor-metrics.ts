import { supabaseAdmin } from "@/lib/supabase_admin";

export interface MentorMetricLeadRow {
  instance_name?: string | null;
  agent_id?: number | null;
  ramo_negocio?: string | null;
  ab_variant?: string | null;
  sent?: boolean;
  responded?: boolean;
  preview_accepted?: boolean;
  preview_delivered?: boolean;
  closed_won?: boolean;
}

export interface MentorRateBucket {
  key: string;
  sent: number;
  responded: number;
  preview_accepted: number;
  preview_delivered: number;
  closed_won: number;
  taxa_resposta_1a_msg: number;
  taxa_aceite_previa: number;
  taxa_entrega_previa: number;
  taxa_fechamento: number;
}

export interface MentorFunnelMetricsSummary {
  overall: MentorRateBucket;
  by_instance: MentorRateBucket[];
  by_niche: MentorRateBucket[];
  by_ab_variant: MentorRateBucket[];
  by_agent: MentorRateBucket[];
}

function pct(num: number, den: number): number {
  if (!den || den <= 0) return 0;
  return Number(((num / den) * 100).toFixed(1));
}

function finalizeBucket(
  key: string,
  acc: { sent: number; responded: number; preview_accepted: number; preview_delivered: number; closed_won: number }
): MentorRateBucket {
  return {
    key,
    ...acc,
    taxa_resposta_1a_msg: pct(acc.responded, acc.sent),
    taxa_aceite_previa: pct(acc.preview_accepted, acc.responded),
    taxa_entrega_previa: pct(acc.preview_delivered, acc.preview_accepted),
    taxa_fechamento: pct(acc.closed_won, acc.preview_delivered),
  };
}

function aggregateBy(
  rows: MentorMetricLeadRow[],
  selector: (row: MentorMetricLeadRow) => string
): MentorRateBucket[] {
  const map = new Map<
    string,
    { sent: number; responded: number; preview_accepted: number; preview_delivered: number; closed_won: number }
  >();
  for (const r of rows) {
    const key = selector(r);
    const cur = map.get(key) || {
      sent: 0,
      responded: 0,
      preview_accepted: 0,
      preview_delivered: 0,
      closed_won: 0,
    };
    if (r.sent) cur.sent += 1;
    if (r.responded) cur.responded += 1;
    if (r.preview_accepted) cur.preview_accepted += 1;
    if (r.preview_delivered) cur.preview_delivered += 1;
    if (r.closed_won) cur.closed_won += 1;
    map.set(key, cur);
  }
  return Array.from(map.entries())
    .map(([key, acc]) => finalizeBucket(key, acc))
    .sort((a, b) => b.sent - a.sent);
}

/**
 * Calcula as 4 taxas oficiais do Método Mentor:
 * 1. Taxa de resposta à 1ª msg (responded / sent)
 * 2. Taxa de aceite de prévia (preview_accepted / responded)
 * 3. Taxa de entrega de prévia (preview_delivered / preview_accepted)
 * 4. Taxa de fechamento (closed_won / preview_delivered)
 */
export function computeMentorFunnelMetrics(rows: MentorMetricLeadRow[]): MentorFunnelMetricsSummary {
  const totalAcc = { sent: 0, responded: 0, preview_accepted: 0, preview_delivered: 0, closed_won: 0 };
  for (const r of rows) {
    if (r.sent) totalAcc.sent += 1;
    if (r.responded) totalAcc.responded += 1;
    if (r.preview_accepted) totalAcc.preview_accepted += 1;
    if (r.preview_delivered) totalAcc.preview_delivered += 1;
    if (r.closed_won) totalAcc.closed_won += 1;
  }

  return {
    overall: finalizeBucket("geral", totalAcc),
    by_instance: aggregateBy(rows, (r) => String(r.instance_name || "sem_chip")),
    by_niche: aggregateBy(rows, (r) => String(r.ramo_negocio || "sem_nicho")),
    by_ab_variant: aggregateBy(rows, (r) => String(r.ab_variant || "padrao")),
    by_agent: aggregateBy(rows, (r) => (r.agent_id ? `agente_${r.agent_id}` : "sem_agente")),
  };
}

/**
 * Consolida leads e campanhas reais do tenant nas 4 taxas do Método Mentor.
 */
export async function loadMentorFunnelMetricsForClient(clientId: string): Promise<MentorFunnelMetricsSummary> {
  const rows: MentorMetricLeadRow[] = [];

  try {
    const [{ data: camps }, { data: targets }, { data: leads }, { data: contacts }] = await Promise.all([
      supabaseAdmin
        .from("campaigns")
        .select("id, instance_name, agent_id")
        .eq("client_id", clientId)
        .limit(200),
      supabaseAdmin
        .from("campaign_targets")
        .select("campaign_id, remote_jid, ramo_negocio, status")
        .eq("client_id", clientId)
        .in("status", ["sent", "delivered", "replied"])
        .limit(2000),
      supabaseAdmin
        .from("leads_extraidos")
        .select("remoteJid, ramo_negocio, status, previa_status")
        .eq("client_id", clientId)
        .limit(2000),
      supabaseAdmin
        .from("contacts")
        .select("remote_jid, preview_accepted_at, preview_delivered_at, ab_variant")
        .eq("client_id", clientId)
        .limit(2000)
        .then(
          (r) => r,
          () => ({ data: [] as Array<Record<string, unknown>> })
        ),
    ]);

    const campMap = new Map<string, { instance_name?: string | null; agent_id?: number | null }>();
    for (const c of (camps || []) as Array<Record<string, unknown>>) {
      if (c?.id) {
        campMap.set(String(c.id), {
          instance_name: (c.instance_name as string | null) ?? null,
          agent_id: c.agent_id ? Number(c.agent_id) : null,
        });
      }
    }

    const leadByJid = new Map<string, Record<string, unknown>>();
    for (const l of (leads || []) as Array<Record<string, unknown>>) {
      if (l?.remoteJid) leadByJid.set(String(l.remoteJid), l);
    }

    const contactByJid = new Map<string, Record<string, unknown>>();
    for (const c of (contacts || []) as Array<Record<string, unknown>>) {
      if (c?.remote_jid) contactByJid.set(String(c.remote_jid), c);
    }

    for (const t of (targets || []) as Array<Record<string, unknown>>) {
      const jid = String(t.remote_jid || "");
      const camp = campMap.get(String(t.campaign_id || ""));
      const l = leadByJid.get(jid);
      const c = contactByJid.get(jid);

      const leadStatus = String(l?.status || "").toLowerCase();
      const previaStatus = String(l?.previa_status || "").toUpperCase();
      const responded =
        t.status === "replied" ||
        ["em_conversa", "interessado", "previa_aceita", "previa_enviada", "negociacao_x1", "agendado", "fechado"].includes(
          leadStatus
        );
      const previewAccepted =
        Boolean(c?.preview_accepted_at) ||
        ["PREVIA_SOLICITADA", "PRONTO_PARA_ENVIO", "ENVIADA"].includes(previaStatus) ||
        ["previa_aceita", "previa_enviada", "negociacao_x1", "fechado"].includes(leadStatus);
      const previewDelivered =
        Boolean(c?.preview_delivered_at) ||
        previaStatus === "ENVIADA" ||
        ["previa_enviada", "negociacao_x1", "fechado"].includes(leadStatus);
      const closedWon = leadStatus === "fechado";

      rows.push({
        instance_name: camp?.instance_name ?? null,
        agent_id: camp?.agent_id ?? null,
        ramo_negocio: (t.ramo_negocio as string | null) || (l?.ramo_negocio as string | null) || null,
        ab_variant: (c?.ab_variant as string | null) ?? null,
        sent: true,
        responded,
        preview_accepted: previewAccepted,
        preview_delivered: previewDelivered,
        closed_won: closedWon,
      });
    }
  } catch { /* non-fatal */ }

  return computeMentorFunnelMetrics(rows);
}
