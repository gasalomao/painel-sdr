import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
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
    const { action, remoteJid, instanceName, durationMinutes } = await req.json();

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
    if (!remoteJid || !instanceName) {
      return NextResponse.json({ error: "remoteJid e instanceName são obrigatórios" }, { status: 400 });
    }

    const { data: contact } = await supabase
      .from("contacts")
      .select("id")
      .eq("remote_jid", remoteJid)
      .single();
    if (!contact) {
      return NextResponse.json({ error: "Contato não encontrado" }, { status: 404 });
    }

    const { data: session } = await supabase
      .from("sessions")
      .select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at")
      .eq("contact_id", contact.id)
      .eq("instance_name", instanceName)
      .single();
    if (!session) {
      return NextResponse.json({ error: "Sessão não encontrada" }, { status: 404 });
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
