import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import {
  analyzeKanbanAgentSync,
  inferSemanticStageRank,
  inferStageRole,
  isTerminalColumn,
  type KanbanColLite,
} from "@/lib/organizer-prompt";
import { chunkArray } from "@/lib/organizer-hash";

export const dynamic = "force-dynamic";

type LeadAuditRow = {
  id: number | string;
  remoteJid?: string | null;
  nome_negocio?: string | null;
  status?: string | null;
  justificativa_ia?: string | null;
  resumo_ia?: string | null;
  previa_status?: string | null;
  link_previa?: string | null;
  reuniao_agendada_em?: string | null;
};

type ApptAuditRow = {
  remote_jid?: string | null;
  status?: string | null;
  end_at?: string | null;
};

function normalizeBrazilVariants(raw: unknown): string[] {
  const digits = String(raw || "").replace(/@.*$/, "").replace(/\D/g, "");
  if (digits.length < 8) return [];
  const out = new Set<string>([digits]);
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const rest = digits.length === 13 ? digits.slice(5) : digits.slice(4);
    out.add(`55${ddd}${rest}`);
    out.add(`55${ddd}9${rest}`);
  }
  return Array.from(out);
}

async function runAuditScan(clientId: string) {
  if (!supabaseAdmin) throw new Error("DB indisponível");

  const [
    { data: colsRaw },
    { data: leadsRaw, error: leadsErr },
    { data: apptsRaw },
    { data: connsRaw },
    { data: warmupsRaw },
    { data: clientRow },
    { data: agentRows },
  ] = await Promise.all([
    supabaseAdmin
      .from("kanban_columns")
      .select("status_key, label, order_index, is_terminal")
      .eq("client_id", clientId)
      .order("order_index", { ascending: true }),
    supabaseAdmin
      .from("leads_extraidos")
      .select('id, "remoteJid", nome_negocio, status, justificativa_ia, resumo_ia, previa_status, link_previa, reuniao_agendada_em')
      .eq("client_id", clientId)
      .limit(5000),
    supabaseAdmin
      .from("appointments")
      .select("remote_jid, status, end_at")
      .eq("client_id", clientId)
      .in("status", ["confirmed", "completed"]),
    supabaseAdmin
      .from("channel_connections")
      .select("provider_config")
      .eq("client_id", clientId),
    supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("phone_number")
      .eq("client_id", clientId),
    supabaseAdmin
      .from("clients")
      .select("organizer_prompt, organizer_enabled")
      .eq("id", clientId)
      .maybeSingle(),
    supabaseAdmin
      .from("agent_settings")
      .select("name, main_prompt, options, is_active")
      .eq("client_id", clientId)
      .order("is_active", { ascending: false })
      .order("id", { ascending: false })
      .limit(5),
  ]);

  if (leadsErr) throw new Error(leadsErr.message);

  const cols = (colsRaw || []) as KanbanColLite[];
  const leads = (leadsRaw || []) as LeadAuditRow[];
  const validKeys = new Set(cols.map((c) => c.status_key));
  const terminalKeys = new Set(cols.filter((c) => isTerminalColumn(c)).map((c) => c.status_key));
  const colRoleMap = new Map(cols.map((c) => [c.status_key, inferStageRole(c)]));
  const colRankMap = new Map(cols.map((c, idx) => [c.status_key, inferSemanticStageRank(c, idx, cols.length)]));

  const findByRole = (role: ReturnType<typeof inferStageRole>, fallback: string): string => {
    const match = cols.find((c) => inferStageRole(c) === role);
    if (match) return match.status_key;
    if (validKeys.has(fallback)) return fallback;
    return cols[0]?.status_key || fallback;
  };
  const findOptByRole = (role: ReturnType<typeof inferStageRole>): string | null =>
    cols.find((c) => inferStageRole(c) === role)?.status_key || null;

  const colEntry = findByRole("entry", "novo");
  const colPreviaSolicitada = findOptByRole("waiting_asset");
  const colEmNegociacao = findOptByRole("proposal");
  const colAgendado = findOptByRole("scheduled");
  const colFechado = findOptByRole("won");
  const colDescarte = findByRole("discarded", findByRole("lost", colEntry));

  // Próprios chips conectados / aquecimento
  const ownPhones = new Set<string>();
  for (const c of (connsRaw || []) as Array<{ provider_config?: Record<string, unknown> | null }>) {
    normalizeBrazilVariants(c?.provider_config?.owner_phone).forEach((d) => ownPhones.add(d));
    normalizeBrazilVariants(c?.provider_config?.owner_jid).forEach((d) => ownPhones.add(d));
  }
  for (const w of (warmupsRaw || []) as Array<{ phone_number?: string | null }>) {
    normalizeBrazilVariants(w?.phone_number).forEach((d) => ownPhones.add(d));
  }

  // Agendamentos indexados por JID
  const apptsByJid = new Map<string, ApptAuditRow[]>();
  for (const a of (apptsRaw || []) as ApptAuditRow[]) {
    if (!a.remote_jid) continue;
    if (!apptsByJid.has(a.remote_jid)) apptsByJid.set(a.remote_jid, []);
    apptsByJid.get(a.remote_jid)!.push(a);
  }

  // Checa quais leads sem resumo têm mensagens reais no chats_dashboard
  const missingResumoJids = leads
    .filter((l) => !l.resumo_ia && l.remoteJid)
    .map((l) => l.remoteJid as string);
  const lastMsgByJid = new Map<string, { content: string; isSdr: boolean }>();
  for (const chunk of chunkArray(Array.from(new Set(missingResumoJids)), 80)) {
    const { data: chatRows } = await supabaseAdmin
      .from("chats_dashboard")
      .select("remote_jid, content, sender_type, is_from_me, media_type, created_at")
      .eq("client_id", clientId)
      .in("remote_jid", chunk)
      .order("created_at", { ascending: false });
    for (const r of (chatRows || []) as Array<{
      remote_jid?: string;
      content?: string | null;
      sender_type?: string | null;
      is_from_me?: boolean | null;
      media_type?: string | null;
    }>) {
      if (!r.remote_jid || lastMsgByJid.has(r.remote_jid)) continue;
      const body = String(r.content || "").trim() || (r.media_type ? `[MÍDIA: ${r.media_type}]` : "");
      if (!body) continue;
      const isSdr =
        Boolean(r.is_from_me) ||
        ["ai", "human", "sdr", "bot", "agent", "assistant"].includes(String(r.sender_type || "").toLowerCase());
      lastMsgByJid.set(r.remote_jid, { content: body, isSdr });
    }
  }

  let nullStatusCount = 0;
  let orphanStatusCount = 0;
  let invalidNumberOutOfDiscardCount = 0;
  let nullNomeCount = 0;
  let genericRazaoCount = 0;
  let missingResumoWithChatCount = 0;
  let ownChipsAsLeadsCount = 0;
  let appointmentMisalignedCount = 0;
  let previewMisalignedCount = 0;
  const distribution: Record<string, number> = {};
  const fixCandidates: Array<{ id: number | string; remoteJid?: string | null; patch: Record<string, unknown>; oldStatus: string; newStatus?: string; reason?: string }> = [];
  const nowMs = Date.now();

  for (const lead of leads) {
    const rawStatus = lead.status || "";
    const statusKey = rawStatus || "(null)";
    distribution[statusKey] = (distribution[statusKey] || 0) + 1;

    const jid = lead.remoteJid || "";
    const digits = jid.replace(/@.*$/, "").replace(/\D/g, "");
    const isOwnChip = Boolean(digits && ownPhones.has(digits));
    const isInvalidMarker = rawStatus === "invalid_number" || rawStatus === "sem_contato";
    const isOrphan = Boolean(rawStatus && !isInvalidMarker && validKeys.size > 0 && !validKeys.has(rawStatus));

    const patch: Record<string, unknown> = {};
    let nextStatus = rawStatus;
    let fixReason = "";

    if (!rawStatus) {
      nullStatusCount++;
      nextStatus = colEntry;
      patch.status = colEntry;
      fixReason = "Auto-auditoria: status vazio restaurado para etapa inicial.";
    }
    if (isInvalidMarker && rawStatus !== colDescarte) {
      invalidNumberOutOfDiscardCount++;
      nextStatus = colDescarte;
      patch.status = colDescarte;
      fixReason = `Auto-auditoria: status legado "${rawStatus}" migrado para descarte.`;
    }
    if (isOrphan) {
      orphanStatusCount++;
      nextStatus = colEntry;
      patch.status = colEntry;
      fixReason = `Auto-auditoria: status órfão "${rawStatus}" alinhado com colunas atuais.`;
    }
    if (isOwnChip && rawStatus !== colDescarte) {
      ownChipsAsLeadsCount++;
      nextStatus = colDescarte;
      patch.status = colDescarte;
      if (lead.previa_status) patch.previa_status = null;
      fixReason = "Auto-auditoria: número pertence a chip próprio conectado/aquecimento.";
    }

    if (!lead.nome_negocio) {
      nullNomeCount++;
      patch.nome_negocio = jid ? `Lead (${jid.split("@")[0]})` : `Lead #${lead.id}`;
    }

    if (lead.justificativa_ia === "Avaliado pelo Organizador IA.") {
      genericRazaoCount++;
      patch.justificativa_ia = `Classificado na etapa "${nextStatus || colEntry}".`;
    }

    if (!lead.resumo_ia && jid && lastMsgByJid.has(jid)) {
      missingResumoWithChatCount++;
      const lastMsg = lastMsgByJid.get(jid)!;
      patch.resumo_ia = `Na etapa "${nextStatus || colEntry}". Última msg (${lastMsg.isSdr ? "SDR" : "Cliente"}): "${lastMsg.content.slice(0, 140)}".`;
    }

    // Alinhamento com agenda e prévia (somente se não for chip próprio nem terminal)
    const curRole = colRoleMap.get(nextStatus || colEntry);
    const curRank = colRankMap.get(nextStatus || colEntry) ?? 0;
    const isTerminal = terminalKeys.has(nextStatus);

    if (!isOwnChip && !isTerminal && jid) {
      const appts = apptsByJid.get(jid) || [];
      if (colFechado && nextStatus !== colFechado && appts.some((a) => a.status === "completed")) {
        appointmentMisalignedCount++;
        nextStatus = colFechado;
        patch.status = colFechado;
        fixReason = "Auto-auditoria: agendamento concluído movido para etapa final.";
      } else if (
        colAgendado &&
        nextStatus !== colAgendado &&
        appts.some((a) => a.status === "confirmed" && (!a.end_at || new Date(a.end_at).getTime() >= nowMs))
      ) {
        appointmentMisalignedCount++;
        nextStatus = colAgendado;
        patch.status = colAgendado;
        fixReason = "Auto-auditoria: agendamento confirmado sincronizado.";
      } else if (
        colEmNegociacao &&
        curRole !== "followup" &&
        curRank < (colRankMap.get(colEmNegociacao) ?? 50) &&
        (Boolean(lead.link_previa) || lead.previa_status === "PREVIA_PRONTA")
      ) {
        previewMisalignedCount++;
        nextStatus = colEmNegociacao;
        patch.status = colEmNegociacao;
        fixReason = "Auto-auditoria: prévia pronta sincronizada para negociação.";
      } else if (
        colPreviaSolicitada &&
        curRole !== "followup" &&
        curRank < (colRankMap.get(colPreviaSolicitada) ?? 40) &&
        (lead.previa_status === "PREVIA_SOLICITADA" || lead.previa_status === "GERANDO_WORKSPACE")
      ) {
        previewMisalignedCount++;
        nextStatus = colPreviaSolicitada;
        patch.status = colPreviaSolicitada;
        fixReason = "Auto-auditoria: prévia solicitada sincronizada no funil.";
      }
    }

    if (Object.keys(patch).length > 0) {
      fixCandidates.push({
        id: lead.id,
        remoteJid: jid,
        patch,
        oldStatus: rawStatus || "(null)",
        newStatus: typeof patch.status === "string" ? patch.status : undefined,
        reason: fixReason || undefined,
      });
    }
  }

  const activeAgent =
    ((agentRows || []) as Array<{ main_prompt?: string | null; options?: Record<string, unknown> | null }>)[0] || null;
  const syncDiagnostics = analyzeKanbanAgentSync({
    columns: cols,
    organizerPrompt: (clientRow as { organizer_prompt?: string | null } | null)?.organizer_prompt || null,
    agentPrompt: activeAgent?.main_prompt || null,
    agentOptions: activeAgent?.options || null,
  });

  const totalIssues =
    nullStatusCount +
    orphanStatusCount +
    invalidNumberOutOfDiscardCount +
    nullNomeCount +
    genericRazaoCount +
    missingResumoWithChatCount +
    ownChipsAsLeadsCount +
    appointmentMisalignedCount +
    previewMisalignedCount;

  return {
    report: {
      totalLeads: leads.length,
      healthy: totalIssues === 0 && syncDiagnostics.inSync,
      issuesCount: totalIssues,
      metrics: {
        nullStatusCount,
        orphanStatusCount,
        invalidNumberOutOfDiscardCount,
        nullNomeCount,
        genericRazaoCount,
        missingResumoWithChatCount,
        ownChipsAsLeadsCount,
        appointmentMisalignedCount,
        previewMisalignedCount,
      },
      distribution,
      syncDiagnostics,
    },
    fixCandidates,
  };
}

/**
 * GET /api/organizer/audit
 * Diagnóstico multi-tenant de integridade do CRM + sincronia Agente × Kanban (0 tokens).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  try {
    const { report } = await runAuditScan(ctx.clientId);
    return NextResponse.json({ ok: true, report });
  } catch (err: unknown) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Erro ao auditar CRM" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/organizer/audit { autoFix?: boolean }
 * Corrige automaticamente inconsistências estruturais (0 tokens) dentro do tenant autenticado.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  try {
    const body = (await req.json().catch(() => ({}))) as { autoFix?: boolean };
    const { report, fixCandidates } = await runAuditScan(ctx.clientId);
    if (body.autoFix === false || fixCandidates.length === 0) {
      return NextResponse.json({ ok: true, fixedCount: 0, report });
    }

    const nowIso = new Date().toISOString();
    const batchId = `audit-fix-${Date.now()}`;
    let fixedCount = 0;
    const historyRows: Array<Record<string, unknown>> = [];

    for (const item of fixCandidates) {
      const updPatch: Record<string, unknown> = { ...item.patch, updated_at: nowIso };
      if (item.reason && !updPatch.justificativa_ia) {
        updPatch.justificativa_ia = item.reason;
      }
      const { error } = await supabaseAdmin
        .from("leads_extraidos")
        .update(updPatch)
        .eq("id", item.id)
        .eq("client_id", ctx.clientId);

      if (!error) {
        fixedCount++;
        if (item.newStatus && item.newStatus !== item.oldStatus && item.remoteJid) {
          historyRows.push({
            client_id: ctx.clientId,
            remote_jid: item.remoteJid,
            nome_negocio: typeof updPatch.nome_negocio === "string" ? updPatch.nome_negocio : null,
            status_antigo: item.oldStatus,
            status_novo: item.newStatus,
            razao: item.reason || "Correção automática de integridade CRM.",
            resumo: typeof updPatch.resumo_ia === "string" ? updPatch.resumo_ia : null,
            batch_id: batchId,
          });
        }
      }
    }

    if (historyRows.length > 0) {
      await supabaseAdmin.from("historico_ia_leads").insert(historyRows);
    }

    const fresh = await runAuditScan(ctx.clientId);
    return NextResponse.json({ ok: true, fixedCount, report: fresh.report });
  } catch (err: unknown) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Erro ao corrigir CRM" },
      { status: 500 }
    );
  }
}

