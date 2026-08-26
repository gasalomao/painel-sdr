import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import {
  pauseSession,
  snoozeSession,
  resumeSession,
  getEffectiveStatus,
  getGlobalPause,
  setGlobalPause,
  clearGlobalPause,
  type SessionRow,
} from "@/lib/bot-status";

async function ensureInstanceOwnership(instanceName: string, clientId: string): Promise<boolean> {
  const { data } = await supabase
    .from("channel_connections")
    .select("client_id")
    .eq("instance_name", instanceName)
    .maybeSingle();
  return data?.client_id === clientId;
}

/**
 * Agent Control — controla pausa/resume da IA.
 *
 * Ações por contato:
 *   pause   → bot_paused (indefinido)
 *   snooze  → human_takeover por durationMinutes (default 60)
 *   resume  → bot_active
 *   check   → estado efetivo atual (com auto-resume se snooze venceu)
 *
 * Ações globais:
 *   global_pause   → pausa TODAS conversas; opcional durationMinutes (default forever)
 *   global_resume  → libera global
 *   global_check   → estado da pausa global
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;
    const { action, remoteJid, instanceName, durationMinutes } = await req.json();
    if (instanceName && !(await ensureInstanceOwnership(instanceName, auth.clientId))) {
      return NextResponse.json({ error: "Instância não pertence a este cliente" }, { status: 403 });
    }

    // ===== AÇÕES "GLOBAIS" — agora SEMPRE ESCOPADAS POR INSTÂNCIA =====
    // Para pausar/retomar a IA, é OBRIGATÓRIO enviar instanceName. Pausar uma
    // instância NÃO silencia outras. Antes uma chave única afetava todas.
    if (action === "global_pause" || action === "global_resume" || action === "global_check") {
      if (!instanceName) {
        return NextResponse.json(
          { error: "instanceName é obrigatório nos comandos global_*. A pausa agora é por instância." },
          { status: 400 }
        );
      }
      if (action === "global_pause") {
        const r = await setGlobalPause({
          forever: !durationMinutes,
          durationMinutes: durationMinutes ? Number(durationMinutes) : undefined,
          instance: instanceName,
        });
        return NextResponse.json({ success: true, scope: "instance", ...r });
      }
      if (action === "global_resume") {
        const r = await clearGlobalPause(instanceName);
        return NextResponse.json({ success: true, scope: "instance", ...r });
      }
      // global_check
      const r = await getGlobalPause(instanceName);
      return NextResponse.json({ success: true, scope: "instance", ...r });
    }

    // ===== AÇÕES POR CONTATO =====
    if (!remoteJid) {
      return NextResponse.json({ error: "remoteJid é obrigatório" }, { status: 400 });
    }

    // 1. Extrai variações do JID / telefone
    const cleanPhone = remoteJid.replace(/@.*$/, "").replace(/\D/g, "");
    const jids = Array.from(
      new Set([
        remoteJid,
        cleanPhone ? `${cleanPhone}@s.whatsapp.net` : "",
        cleanPhone ? `${cleanPhone}@c.us` : "",
        cleanPhone,
        cleanPhone ? `phone:${cleanPhone}` : "",
      ])
    ).filter(Boolean);

    // 2. Busca contato por remote_jid (em jids) OU por phone_number
    let contactQuery = supabase
      .from("contacts")
      .select("id, remote_jid, phone_number")
      .eq("client_id", auth.clientId);

    if (cleanPhone) {
      contactQuery = contactQuery.or(`remote_jid.in.(${jids.map((j) => `"${j}"`).join(",")}),phone_number.eq.${cleanPhone}`);
    } else {
      contactQuery = contactQuery.in("remote_jid", jids);
    }

    const { data: contactsList } = await contactQuery.limit(1);
    let contact = contactsList && contactsList.length > 0 ? contactsList[0] : null;

    // Se não encontrou contato existente, tenta criar um novo com tratamento de erro
    if (!contact) {
      const { data: newContact } = await supabase
        .from("contacts")
        .insert({ client_id: auth.clientId, remote_jid: remoteJid, phone_number: cleanPhone || remoteJid })
        .select("id, remote_jid, phone_number")
        .maybeSingle();
      contact = newContact;
    }

    // Resolve a instância do atendimento se não foi enviada
    let targetInstance = instanceName;
    if (!targetInstance && contact) {
      const { data: sessByContact } = await supabase
        .from("sessions")
        .select("instance_name")
        .eq("client_id", auth.clientId)
        .eq("contact_id", contact.id)
        .order("last_message_at", { ascending: false })
        .limit(1);
      targetInstance = sessByContact?.[0]?.instance_name;
    }

    if (!targetInstance) {
      const { data: firstConn } = await supabase
        .from("channel_connections")
        .select("instance_name")
        .eq("client_id", auth.clientId)
        .limit(1);
      targetInstance = firstConn?.[0]?.instance_name;
    }

    if (!targetInstance) {
      targetInstance = "default";
    }

    // Busca sessões SOMENTE por contact_id.
    // FIX crítico: sessions NÃO tem coluna remote_jid (migration 005) — o
    // .or("contact_id..., remote_jid.in....") retornava erro do PostgREST
    // (silencioso no supabase-js) e sessionRows vinha SEMPRE vazio. Resultado:
    // pausar uma conversa que nunca recebeu mensagem era um no-op silencioso
    // (IA respondia mesmo pausada) e o insert com remote_jid falhava PGRST204.
    let sessionRows: any[] = [];
    if (contact) {
      const { data } = await supabase
        .from("sessions")
        .select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at")
        .eq("client_id", auth.clientId)
        .eq("contact_id", contact.id)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(5);
      if (data) sessionRows = data;
    }

    let session = sessionRows && sessionRows.length > 0 ? sessionRows[0] : null;

    if (!session && contact) {
      const { data: newSession } = await supabase
        .from("sessions")
        .insert({
          client_id: auth.clientId,
          contact_id: contact.id,
          instance_name: targetInstance,
          bot_status: "bot_active",
        })
        .select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at")
        .maybeSingle();
      session = newSession;
    }

    const contactId = contact?.id;
    const sessionIds = sessionRows.map((s) => s.id);
    if (session && !sessionIds.includes(session.id)) sessionIds.push(session.id);

    switch (action) {
      case "pause": {
        const now = new Date().toISOString();
        const patch = { bot_status: "bot_paused", paused_by: "human", paused_at: now, resume_at: null };
        
        if (sessionIds.length > 0) {
          await supabase.from("sessions").update(patch).eq("client_id", auth.clientId).in("id", sessionIds);
        }
        if (contactId) {
          await supabase.from("sessions").update(patch).eq("client_id", auth.clientId).eq("contact_id", contactId);
        }

        return NextResponse.json({ success: true, bot_status: "bot_paused", resume_at: null, blocked: true, permanent: true });
      }
      case "snooze": {
        const minutes = Number(durationMinutes) || 60;
        const now = new Date();
        const resumeAt = new Date(now.getTime() + minutes * 60 * 1000).toISOString();
        const patch = {
          bot_status: "human_takeover",
          paused_by: "human",
          paused_at: now.toISOString(),
          resume_at: resumeAt,
        };

        if (sessionIds.length > 0) {
          await supabase.from("sessions").update(patch).eq("client_id", auth.clientId).in("id", sessionIds);
        }
        if (contactId) {
          await supabase.from("sessions").update(patch).eq("client_id", auth.clientId).eq("contact_id", contactId);
        }

        return NextResponse.json({ success: true, bot_status: "human_takeover", resume_at: resumeAt, minutes, blocked: true, permanent: false });
      }
      case "resume": {
        const patch = {
          bot_status: "bot_active",
          paused_by: null,
          paused_at: null,
          resume_at: null,
        };

        if (sessionIds.length > 0) {
          await supabase.from("sessions").update(patch).eq("client_id", auth.clientId).in("id", sessionIds);
        }
        if (contactId) {
          await supabase.from("sessions").update(patch).eq("client_id", auth.clientId).eq("contact_id", contactId);
        }

        return NextResponse.json({ success: true, bot_status: "bot_active", resume_at: null, blocked: false, permanent: false });
      }
      case "check": {
        const eff = await getEffectiveStatus(session as SessionRow);
        // Reporta a pausa por instância (chave nova) — é o que a UI do chat
        // mostra agora. A chave legada já é considerada dentro de getEffectiveStatus.
        const g = await getGlobalPause(instanceName);
        return NextResponse.json({
          success: true,
          bot_status: eff.status,
          resume_at: eff.resumeAt,
          blocked: !eff.isActive,
          permanent: eff.status === "bot_paused",
          reason: eff.reason,
          global_paused: g.paused,
          global_paused_until: g.until,
        });
      }
      default:
        return NextResponse.json({ error: "Ação inválida: " + action }, { status: 400 });
    }
  } catch (err: any) {
    console.error("[Agent Control] Erro:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
