/**
 * Worker de lembrete + auto-promote do kanban pós-agendamento.
 *
 * Roda em duas tarefas (chamadas pelo scheduler em instrumentation.ts):
 *
 *   1. tickReminders()       — Lê appointments com start_at no futuro próximo
 *                              (até 25h) e status='confirmed'. Pra cada um,
 *                              consulta o `scheduler_config.reminders` do
 *                              agente dono e dispara mensagens WhatsApp X min
 *                              antes do start_at, usando o template do reminder
 *                              renderizado com template-vars do lead.
 *                              Idempotente: grava em reminders_sent[] os
 *                              offsets já disparados.
 *
 *   2. tickAutoPromote()    — Lê appointments com end_at no passado (>=
 *                              auto_promote_kanban_after_minutes), status=
 *                              'confirmed' e sem completed_at. Marca como
 *                              'completed' e move o lead vinculado pro estágio
 *                              terminal positivo do kanban do cliente
 *                              (R17 do organizer aplicado de forma estrutural).
 *
 * Claim atômico via UPDATE...RETURNING dentro de transação implícita pra
 * race-condition safe quando 2 workers concorrentes.
 */

import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import * as channel from "@/lib/channel";
import { renderTemplate } from "@/lib/template-vars";
import { findOrCreateContactSession, persistOutgoingMessage } from "@/lib/campaign-worker";
import { registerPendingAutomatedSend } from "@/lib/manual-send-registry";
import { shouldSendReminder, reminderKey } from "@/lib/agenda-logic";

type ReminderSpec = {
  offset_minutes: number;
  message: string;
};

type SchedulerConfig = {
  reminders?: ReminderSpec[];
  notify_owner?: boolean;
  owner_phone?: string | null;
  auto_promote_kanban_after_minutes?: number;
  business_hours?: { tz?: string };
};

type AppointmentRow = {
  id: string;
  client_id: string;
  agent_id: number | null;
  lead_id: number | null;
  remote_jid: string;
  instance_name: string | null;
  title: string;
  service_name: string | null;
  start_at: string;
  end_at: string;
  status: string;
  reminders_sent: string[]; // ["1440min", "60min"]
  google_event_id: string | null;
  metadata: Record<string, any>;
};

function fmtTimeBR(iso: string, tz = "America/Sao_Paulo") {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: tz });
}
function fmtDateBR(iso: string, tz = "America/Sao_Paulo") {
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: tz });
}

/**
 * Variáveis disponíveis no template do reminder, além das padrão de
 * template-vars (renderTemplate suporta `{nome}`, etc se passado em vars).
 */
async function buildReminderVars(appt: AppointmentRow, tz: string): Promise<Record<string, string>> {
  // Extrai meet link do conference_data se existir (Google injeta no insert
  // quando createMeet=true). Suporta formato novo (entryPoints) e legado
  // (hangoutLink).
  const conf = (appt as any).conference_data || {};
  const meetLink: string =
    conf?.entryPoints?.find((e: any) => e?.entryPointType === "video")?.uri ||
    conf?.hangoutLink ||
    // Agendamentos criados pela IA guardam o link em metadata.meet_link.
    (appt.metadata as any)?.meet_link ||
    "";

  const vars: Record<string, string> = {
    hora_agendamento: fmtTimeBR(appt.start_at, tz),
    data_agendamento: fmtDateBR(appt.start_at, tz),
    servico: appt.service_name || appt.title || "seu atendimento",
    titulo: appt.title,
    meet_link: meetLink,
    local: (appt as any).location || "",
    google_link: (appt as any).html_link || "",
  };

  // {nome} = nome da PESSOA capturado pelo agente no agendamento ("nome completo"),
  // salvo em metadata.attendee_name no momento do schedule. É a fonte mais correta
  // pro tratamento no lembrete. Só cai pro nome_negocio/push_name se não houver.
  const attendeeName = String((appt.metadata as any)?.attendee_name || "").trim();
  if (attendeeName) vars["nome"] = attendeeName;

  // Enriquecimento com dados do lead vinculado — inclui email/observacoes
  // se a migration 008 tiver rodado; retry sem essas colunas se falhar.
  if (appt.lead_id) {
    let r = await supabase
      .from("leads_extraidos")
      .select("nome_negocio, ramo_negocio, telefone, email, endereco, website, observacoes, instagram, facebook")
      .eq("id", appt.lead_id)
      .maybeSingle();
    if (r.error) {
      // Migration 008 não aplicada — query reduzida
      r = await supabase
        .from("leads_extraidos")
        .select("nome_negocio, ramo_negocio, telefone")
        .eq("id", appt.lead_id)
        .maybeSingle();
    }
    const lead = r.data as any;
    if (lead) {
      // Não sobrescreve o {nome} se já veio do agendamento (attendee_name).
      if (!vars["nome"]) vars["nome"] = lead.nome_negocio || "";
      vars["nome_negocio"] = lead.nome_negocio || "";
      vars["ramo_negocio"] = lead.ramo_negocio || "";
      vars["telefone"] = lead.telefone || appt.remote_jid.replace(/@.*$/, "");
      if (lead.email) vars["email"] = lead.email;
      if (lead.endereco) vars["endereco"] = lead.endereco;
      if (lead.website) vars["website"] = lead.website;
      if (lead.observacoes) vars["observacoes"] = lead.observacoes;
      if (lead.instagram) vars["instagram"] = lead.instagram;
      if (lead.facebook) vars["facebook"] = lead.facebook;
    }
  }
  if (!vars["nome"]) {
    const { data: ct } = await supabase
      .from("contacts")
      .select("push_name")
      .eq("remote_jid", appt.remote_jid)
      .maybeSingle();
    if (ct?.push_name) vars["nome"] = ct.push_name;
  }
  if (!vars["nome"]) vars["nome"] = "";
  if (!vars["telefone"]) vars["telefone"] = appt.remote_jid.replace(/@.*$/, "");
  return vars;
}

/**
 * Tick principal de lembretes. Roda em loop a cada 60s.
 */
export async function tickReminders(): Promise<{ checked: number; sent: number; errors: number }> {
  if (!supabase) return { checked: 0, sent: 0, errors: 0 };

  const nowMs = Date.now();
  // Lê appointments que podem ter algum lembrete disparável nas próximas
  // ~25h (cobre reminders default de até 24h antes + folga).
  const lookahead = new Date(nowMs + 25 * 3600 * 1000).toISOString();

  const { data: appts, error } = await supabase
    .from("appointments")
    .select("id, client_id, agent_id, lead_id, remote_jid, instance_name, title, service_name, start_at, end_at, status, reminders_sent, google_event_id, metadata")
    .eq("status", "confirmed")
    .gt("start_at", new Date(nowMs - 60_000).toISOString()) // ainda no futuro (toler. 1min de relógio)
    .lt("start_at", lookahead);

  if (error) {
    console.error("[appointment-worker] erro lendo appointments:", error.message);
    return { checked: 0, sent: 0, errors: 1 };
  }

  let sent = 0;
  let errors = 0;
  const checked = appts?.length || 0;

  for (const appt of (appts || []) as AppointmentRow[]) {
    // Pula shadow rows do google_sync (não têm remote_jid real)
    if (!appt.remote_jid || appt.remote_jid.startsWith("google:")) continue;
    if (!appt.agent_id) continue;

    // Lê config de reminders do agente
    const { data: ag } = await supabase
      .from("agent_settings")
      .select("scheduler_config")
      .eq("id", appt.agent_id)
      .maybeSingle();
    const cfg: SchedulerConfig = (ag?.scheduler_config || {}) as any;

    // Reminders: prioriza CUSTOM do appointment (override por sessão — quando
    // o dono define "esse agendamento aqui tem lembrete 2h antes + 10min"),
    // depois cai pro default do agente (scheduler_config). Custom vazio
    // (array []) também sobrescreve — usuário pode desativar lembretes pra
    // um agendamento específico.
    const customReminders = (appt.metadata as any)?.custom_reminders;
    const reminders: ReminderSpec[] = Array.isArray(customReminders)
      ? customReminders
      : (cfg.reminders || []);
    if (reminders.length === 0) continue;

    const tz = cfg.business_hours?.tz || "America/Sao_Paulo";
    const sentAlready = new Set(appt.reminders_sent || []);
    const startMs = new Date(appt.start_at).getTime();

    for (const rem of reminders) {
      const key = reminderKey(rem.offset_minutes);
      // Gate de elegibilidade (lógica pura testada em agenda-logic.test.ts):
      // status confirmed + offset ainda não enviado + passou da hora do lembrete
      // + reunião ainda não começou.
      if (!shouldSendReminder({
        status: appt.status,
        startMs,
        nowMs,
        offsetMinutes: rem.offset_minutes,
        alreadySent: sentAlready.has(key),
      })) continue;

      // Claim atômico: tenta adicionar a key em reminders_sent SE ela ainda
      // não está lá. Postgres JSONB array com array_append não tem checagem
      // de unicidade nativa, então usamos UPDATE...WHERE NOT contains.
      const newSent = [...(appt.reminders_sent || []), key];
      const { data: claimed, error: claimErr } = await supabase
        .from("appointments")
        .update({ reminders_sent: newSent })
        .eq("id", appt.id)
        .not("reminders_sent", "cs", JSON.stringify([key])) // skip se já tem
        .select("id")
        .maybeSingle();

      if (claimErr || !claimed) {
        // Outro worker pegou ou row mudou — pula.
        continue;
      }

      // Renderiza + envia
      try {
        const vars = await buildReminderVars(appt, tz);
        // renderTemplate resolve QUALQUER chave passada em `variables` (mapa
        // dinâmico, prioridade máxima). Sem isso, {servico}/{meet_link}/etc
        // saíam literais e {nome} vinha vazio (o worker passava o objeto plano,
        // que o renderTemplate não reconhecia pras vars de agendamento).
        const message = renderTemplate(
          rem.message || "{nome}, lembrete do seu agendamento às {hora_agendamento}.",
          { variables: vars, nome_negocio: vars.nome_negocio, telefone: vars.telefone, push_name: vars.nome }
        );
        if (!appt.instance_name) {
          console.warn(`[appointment-worker] appt ${appt.id} sem instance_name — pulando envio`);
          continue;
        }
        
        // Registra o envio pendente antes de disparar o sendMessage para evitar race conditions com o webhook echo
        registerPendingAutomatedSend(appt.instance_name, appt.remote_jid, message);

        const result = await channel.sendMessage(appt.remote_jid, message, appt.instance_name);
        sent++;
        console.log(`[REMINDER] enviado ${key} pra ${appt.remote_jid} (appt ${appt.id})`);

        // Persiste no histórico (sessions/messages/chats_dashboard) pra que o
        // lembrete apareça no /chat e a IA tenha o contexto — sem isso, se o
        // cliente respondesse ao lembrete a IA não saberia que ele foi enviado.
        // Best-effort: a mensagem JÁ saiu no WhatsApp, então falha aqui não
        // reverte o claim nem conta como erro de envio.
        try {
          const msgId =
            (result as any)?.key?.id ||
            (result as any)?.data?.key?.id ||
            `reminder-${appt.id}-${key}-${Date.now()}`;
          const sess = await findOrCreateContactSession(appt.remote_jid, appt.instance_name);
          await persistOutgoingMessage({
            sessionId: sess?.sessionId || null,
            remoteJid: appt.remote_jid,
            instanceName: appt.instance_name,
            msgId,
            text: message,
          });
        } catch (persistErr: any) {
          console.warn(`[REMINDER] enviado mas falhou ao salvar no histórico (appt ${appt.id}):`, persistErr?.message);
        }
      } catch (e: any) {
        errors++;
        console.error(`[REMINDER] falha enviando ${key} pra ${appt.id}:`, e?.message);
        // Reverte o claim pra tentar de novo no próximo tick
        const reverted = (appt.reminders_sent || []);
        await supabase.from("appointments").update({ reminders_sent: reverted }).eq("id", appt.id);
      }
    }
  }

  return { checked, sent, errors };
}

/**
 * Tick de auto-promote do kanban. Roda a cada 5min.
 * Move leads pra estágio terminal positivo quando o end_at já passou.
 */
export async function tickAutoPromote(): Promise<{ promoted: number; errors: number }> {
  if (!supabase) return { promoted: 0, errors: 0 };

  const nowMs = Date.now();
  // Janela: appointments cujo end_at já passou há pelo menos 30min mas no
  // máximo 24h (evita re-processar histórico antigo).
  const minPast = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  const maxPast = new Date(nowMs - 30 * 60_000).toISOString();

  const { data: appts } = await supabase
    .from("appointments")
    .select("id, client_id, agent_id, lead_id, status, end_at")
    .eq("status", "confirmed")
    .gte("end_at", minPast)
    .lte("end_at", maxPast);

  let promoted = 0;
  let errors = 0;

  for (const appt of appts || []) {
    try {
      // Lê config do agente: offset + colunas de origem/destino do kanban.
      let sched: any = {};
      if (appt.agent_id) {
        const { data: ag } = await supabase
          .from("agent_settings")
          .select("scheduler_config")
          .eq("id", appt.agent_id)
          .maybeSingle();
        sched = (ag?.scheduler_config || {}) as any;
      }
      const promoteAfterMin = sched.auto_promote_kanban_after_minutes ?? 30;
      const dueAt = new Date(appt.end_at).getTime() + promoteAfterMin * 60_000;
      if (nowMs < dueAt) continue;

      // Marca appointment como completed (claim atômico via .eq("status","confirmed"))
      const { data: claimedAppt } = await supabase
        .from("appointments")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", appt.id)
        .eq("status", "confirmed")
        .select("id")
        .maybeSingle();
      if (!claimedAppt) continue;

      // Move o lead no kanban. Dois modos:
      //  1. CONFIGURADO — o dono escolheu De [coluna] → Para [coluna] no
      //     painel (scheduler_config.auto_promote_to_status / _from_status).
      //     Cada nicho tem nomes de coluna próprios (comercial ≠ clínica),
      //     por isso é escolha explícita, não nome fixo.
      //  2. AUTOMÁTICO — sem config, cai na heurística: estágio terminal
      //     positivo (atendido/fechado/concluído...).
      if (appt.lead_id) {
        const { data: cols } = await supabase
          .from("kanban_columns")
          .select("status_key, label, order_index")
          .eq("client_id", appt.client_id)
          .order("order_index", { ascending: true });

        let targetKey: string | null = null;
        const configuredTo   = String(sched.auto_promote_to_status   || "").trim();
        const configuredFrom = String(sched.auto_promote_from_status || "").trim();

        if (configuredTo) {
          // Modo configurado — valida que a coluna destino existe no tenant.
          const toCol = (cols || []).find(c => c.status_key === configuredTo);
          if (!toCol) {
            console.warn(`[auto-promote] coluna destino "${configuredTo}" não existe no kanban do cliente ${appt.client_id}`);
          } else if (configuredFrom) {
            // Dono fixou a coluna de ORIGEM → só move se o lead estiver nela.
            const { data: leadNow } = await supabase
              .from("leads_extraidos")
              .select("status")
              .eq("id", appt.lead_id)
              .maybeSingle();
            if ((leadNow?.status || "") === configuredFrom) targetKey = configuredTo;
          } else {
            targetKey = configuredTo;
          }
        } else {
          // Modo automático — heurística do estágio terminal positivo.
          const positiveRegex = /atendido|fechado|concluido|realizado|comprou|completed|contratado|ganho/i;
          const negativeRegex = /sem_interesse|descartado|perdido|cancelado|recusou|no_show/i;
          const positives = (cols || []).filter(c =>
            positiveRegex.test(c.status_key) && !negativeRegex.test(c.status_key)
          );
          const target = positives.sort((a, b) => b.order_index - a.order_index)[0];
          targetKey = target?.status_key || null;
        }

        if (targetKey) {
          await supabase
            .from("leads_extraidos")
            .update({ status: targetKey })
            .eq("id", appt.lead_id)
            .eq("client_id", appt.client_id);

          await supabase.from("historico_ia_leads").insert({
            client_id: appt.client_id,
            remote_jid: null,
            status_antigo: configuredFrom || null,
            status_novo: targetKey,
            justificativa: `Auto-movido pós-atendimento (appointment ${appt.id} concluído ${promoteAfterMin}min após end_at).`,
            origin: "appointment_auto_promote",
          }).then(({ error }) => {
            if (error) console.warn("[auto-promote] hist insert falhou:", error.message);
          });
        }
      }

      promoted++;
    } catch (e: any) {
      errors++;
      console.error(`[auto-promote] falha em appt ${appt.id}:`, e?.message);
    }
  }

  return { promoted, errors };
}
