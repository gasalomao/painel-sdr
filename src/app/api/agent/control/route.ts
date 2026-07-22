import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { getInternalSecret, INTERNAL_SECRET_HEADER } from "@/lib/internal-auth";
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

    // Busca contato — se não existir, tenta criar ou buscar por telefone
    let { data: contact } = await supabase
      .from("contacts")
      .select("id")
      .eq("remote_jid", remoteJid)
      .maybeSingle();

    if (!contact) {
      const phone = remoteJid.replace(/@.*$/, "").replace(/\D/g, "");
      const { data: newContact } = await supabase
        .from("contacts")
        .insert({ client_id: auth.clientId, remote_jid: remoteJid, phone_number: phone })
        .select("id")
        .maybeSingle();
      contact = newContact;
    }

    if (!contact) {
      return NextResponse.json({ error: "Contato não encontrado" }, { status: 404 });
    }

    // Resolve a instância do atendimento se não foi enviada
    let targetInstance = instanceName;
    if (!targetInstance) {
      const { data: sessByContact } = await supabase
        .from("sessions")
        .select("instance_name")
        .eq("contact_id", contact.id)
        .order("last_message_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      targetInstance = sessByContact?.instance_name;
    }

    if (!targetInstance) {
      const { data: firstConn } = await supabase
        .from("channel_connections")
        .select("instance_name")
        .eq("client_id", auth.clientId)
        .limit(1)
        .maybeSingle();
      targetInstance = firstConn?.instance_name;
    }

    if (!targetInstance) {
      return NextResponse.json({ error: "Instância de envio não especificada e nenhuma ativa encontrada." }, { status: 400 });
    }

    // Busca sessão — se não existir, cria a sessão vinculada
    let { data: session } = await supabase
      .from("sessions")
      .select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at")
      .eq("contact_id", contact.id)
      .eq("instance_name", targetInstance)
      .maybeSingle();

    if (!session) {
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

    if (!session) {
      return NextResponse.json({ error: "Sessão do chat não encontrada" }, { status: 404 });
    }

    switch (action) {
      case "pause": {
        const r = await pauseSession(session.id, "human");
        return NextResponse.json({ success: true, ...r, blocked: true, permanent: true });
      }
      case "snooze": {
        const minutes = Number(durationMinutes) || 60;
        const r = await snoozeSession(session.id, minutes, "human");
        return NextResponse.json({ success: true, ...r, minutes, blocked: true, permanent: false });
      }
      case "resume": {
        const r = await resumeSession(session.id);

        // E se a última mensagem da conversa for do cliente (ainda sem resposta da IA),
        // dispara a IA imediatamente para responder e assumir o atendimento de forma proativa.
        try {
          const { data: lastMsg } = await supabase
            .from("chats_dashboard")
            .select("content, sender_type, created_at")
            .eq("remote_jid", remoteJid)
            .eq("instance_name", instanceName)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (lastMsg && lastMsg.sender_type === "customer") {
            // Anti-double-fire: se a IA já respondeu nos últimos 30s, não dispara de novo.
            // Isso previne mensagens duplicadas por cliques rápidos múltiplos no "Retomar".
            const { data: recentAi } = await supabase
              .from("chats_dashboard")
              .select("id")
              .eq("remote_jid", remoteJid)
              .eq("instance_name", instanceName)
              .eq("sender_type", "ai")
              .gte("created_at", new Date(Date.now() - 30_000).toISOString())
              .limit(1);

            if (recentAi && recentAi.length > 0) {
              console.log("[Agent Control] IA já respondeu nos últimos 30s — skip para evitar duplicata.");
            } else {
              const internalSecretValue = getInternalSecret();
              const INTERNAL_BASE = `http://localhost:${process.env.PORT || 3000}`;
              const agentMod = await import("@/app/api/agent/process/route");

              const fakeReq = new Request(`${INTERNAL_BASE}/api/agent/process`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  [INTERNAL_SECRET_HEADER]: internalSecretValue,
                },
                body: JSON.stringify({
                  instanceName,
                  remoteJid,
                  text: lastMsg.content,
                  sessionId: session.id,
                  forceActive: true, // Bypass pause check during manual resume
                }),
              });

              // CRÍTICO: await. Em Next 16 standalone, fire-and-forget
              // (.then().catch()) é cancelado quando esta função retorna a
              // resposta HTTP — a IA era "disparada" mas o processo morria
              // antes de gerar a resposta. Por isso o "Retomar" não voltava
              // a IA. Bloqueia 3-7s pro agente rodar; o usuário que clicou
              // espera por isso mesmo.
              try {
                const res = await agentMod.POST(fakeReq as any);
                if (!res.ok) {
                  const txt = await res.text().catch(() => "");
                  console.error(`[Agent Control] Falha ao processar IA no resume (Status: ${res.status}):`, txt);
                } else {
                  console.log("[Agent Control] IA disparada e processada com sucesso no resume.");
                }
              } catch (e: any) {
                console.error("[Agent Control] Falha ao processar IA no resume:", e?.message);
              }
            }
          }
        } catch (e: any) {
          console.error("[Agent Control] Falha ao verificar/disparar IA no resume:", e?.message);
        }

        return NextResponse.json({ success: true, ...r, blocked: false, permanent: false });
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
