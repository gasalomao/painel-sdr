/**
 * BOT STATUS — fonte ÚNICA de verdade: tabela `sessions` + chave global em `app_settings`.
 *
 * Estados em sessions.bot_status:
 *   - 'bot_active'     → IA responde
 *   - 'human_takeover' → snooze; volta sozinha quando resume_at chega
 *   - 'bot_paused'     → pausa indefinida; só sai com resume manual
 *
 * Pausa global em app_settings:
 *   - global_ai_paused_until = ISO timestamp | 'forever' | '' (vazio = não pausada)
 *
 * Mensagens do cliente são SEMPRE salvas no banco. A pausa só impede a IA de RESPONDER.
 * A IA continua tendo o histórico completo quando voltar.
 */

import { supabaseAdmin } from "@/lib/supabase_admin";

export type BotStatus = "bot_active" | "human_takeover" | "bot_paused";

export type SessionRow = {
  id: string;
  contact_id: string;
  instance_name: string;
  bot_status: BotStatus;
  paused_by?: string | null;
  paused_at?: string | null;
  resume_at?: string | null;
};

export type EffectiveStatus = {
  isActive: boolean;
  status: BotStatus;
  reason: "active" | "snoozed" | "paused" | "auto_resumed" | "global_paused";
  resumeAt: string | null;
};

// Chave LEGADA (sem instância) — antes da feature multi-instância pausava tudo.
// Mantida só como fallback de leitura: se alguém ainda tem um valor lá, respeitamos.
// Nunca mais escrevemos nela.
const LEGACY_GLOBAL_KEY = "global_ai_paused_until";

// Chave por instância: `global_ai_paused_until:<instance_name>`.
// Permite pausar IA só de uma instância sem afetar as outras.
const keyFor = (instance: string) => `global_ai_paused_until:${instance}`;

/* ============================================================
   PAUSA "GLOBAL" — agora POR INSTÂNCIA
   ============================================================ */

export type GlobalPauseState = {
  paused: boolean;
  until: string | null; // null = indefinido (forever) quando paused=true
  instance?: string | null;
};

/**
 * Lê o estado de pausa de UMA instância.
 * Sem `instance` (undefined): retorna { paused: false } — "todas as instâncias"
 * não tem pausa coletiva no novo modelo. Cada uma é independente.
 */
export async function getGlobalPause(instance?: string): Promise<GlobalPauseState> {
  if (!instance) {
    // Compat: se NINGUÉM passa instance, ainda lê a chave legada (fallback).
    // Isso só importa pra quem tem um estado antigo persistido.
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", LEGACY_GLOBAL_KEY)
      .maybeSingle();
    const v = data?.value || "";
    if (!v) return { paused: false, until: null, instance: null };
    if (v === "forever") return { paused: true, until: null, instance: null };
    if (new Date(v) > new Date()) return { paused: true, until: v, instance: null };
    await supabaseAdmin.from("app_settings").upsert({ key: LEGACY_GLOBAL_KEY, value: "", updated_at: new Date().toISOString() }, { onConflict: "key" });
    return { paused: false, until: null, instance: null };
  }

  const { data } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", keyFor(instance))
    .maybeSingle();
  const v = data?.value || "";
  if (!v) return { paused: false, until: null, instance };
  if (v === "forever") return { paused: true, until: null, instance };
  if (new Date(v) > new Date()) return { paused: true, until: v, instance };
  // expirou — limpa silenciosamente
  await supabaseAdmin.from("app_settings").upsert({ key: keyFor(instance), value: "", updated_at: new Date().toISOString() }, { onConflict: "key" });
  return { paused: false, until: null, instance };
}

export async function setGlobalPause(opts: { forever?: boolean; durationMinutes?: number; instance?: string }): Promise<GlobalPauseState> {
  if (!opts.instance) {
    // Por segurança, recusamos pausar sem instance — antes isso pausava tudo,
    // o que não é mais o comportamento desejado.
    throw new Error("instance é obrigatório em setGlobalPause (pausa por instância).");
  }
  let value = "";
  if (opts.forever) value = "forever";
  else if (opts.durationMinutes && opts.durationMinutes > 0) {
    value = new Date(Date.now() + opts.durationMinutes * 60 * 1000).toISOString();
  }
  await supabaseAdmin.from("app_settings").upsert({ key: keyFor(opts.instance), value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (!value) return { paused: false, until: null, instance: opts.instance };
  if (value === "forever") return { paused: true, until: null, instance: opts.instance };
  return { paused: true, until: value, instance: opts.instance };
}

export async function clearGlobalPause(instance?: string): Promise<GlobalPauseState> {
  if (!instance) {
    // Limpa a chave legada (compat).
    await supabaseAdmin.from("app_settings").upsert({ key: LEGACY_GLOBAL_KEY, value: "", updated_at: new Date().toISOString() }, { onConflict: "key" });
    return { paused: false, until: null, instance: null };
  }
  await supabaseAdmin.from("app_settings").upsert({ key: keyFor(instance), value: "", updated_at: new Date().toISOString() }, { onConflict: "key" });
  return { paused: false, until: null, instance };
}

/* ============================================================
   STATUS POR SESSÃO
   ============================================================ */

/**
 * Decide se a IA deve responder dada a sessão atual.
 * Considera pausa global + sessão. Se snooze venceu, faz auto-resume e retorna ativa.
 */
export async function getEffectiveStatus(session: SessionRow): Promise<EffectiveStatus> {
  // 1. Pausa por INSTÂNCIA tem prioridade. A pausa só vale pra instância da sessão —
  //    pausar a IA na instância A não silencia a IA da instância B.
  //    Também checa a chave legada (compat com pausas globais antigas).
  const [perInst, legacy] = await Promise.all([
    getGlobalPause(session.instance_name),
    getGlobalPause(undefined),
  ]);
  const g = perInst.paused ? perInst : legacy;
  if (g.paused) {
    return { isActive: false, status: session.bot_status, reason: "global_paused", resumeAt: g.until };
  }

  const status = session.bot_status;
  if (status === "bot_active") {
    return { isActive: true, status, reason: "active", resumeAt: null };
  }

  if (status === "human_takeover" && session.resume_at) {
    if (new Date(session.resume_at) <= new Date()) {
      // Snooze venceu — auto-resume
      await supabaseAdmin
        .from("sessions")
        .update({ bot_status: "bot_active", paused_by: null, paused_at: null, resume_at: null })
        .eq("id", session.id);
      return { isActive: true, status: "bot_active", reason: "auto_resumed", resumeAt: null };
    }
    return { isActive: false, status, reason: "snoozed", resumeAt: session.resume_at };
  }

  // bot_paused (indefinido) ou human_takeover sem resume_at
  return { isActive: false, status, reason: "paused", resumeAt: session.resume_at || null };
}

/**
 * Pausa permanente. Só sai com resume manual.
 */
export async function pauseSession(sessionId: string, pausedBy: "human" | "system" = "human") {
  const now = new Date().toISOString();
  await supabaseAdmin
    .from("sessions")
    .update({ bot_status: "bot_paused", paused_by: pausedBy, paused_at: now, resume_at: null })
    .eq("id", sessionId);
  return { bot_status: "bot_paused" as BotStatus, resume_at: null };
}

/**
 * Snooze temporário. Volta automaticamente quando resume_at chegar.
 */
export async function snoozeSession(sessionId: string, durationMinutes: number, pausedBy: "human" | "system" = "human") {
  const seconds = Math.max(1, Math.floor(durationMinutes * 60));
  const now = new Date();
  const resumeAt = new Date(now.getTime() + seconds * 1000).toISOString();
  await supabaseAdmin
    .from("sessions")
    .update({
      bot_status: "human_takeover",
      paused_by: pausedBy,
      paused_at: now.toISOString(),
      resume_at: resumeAt,
    })
    .eq("id", sessionId);
  return { bot_status: "human_takeover" as BotStatus, resume_at: resumeAt };
}

/**
 * Resume imediato.
 */
export async function resumeSession(sessionId: string) {
  await supabaseAdmin
    .from("sessions")
    .update({ bot_status: "bot_active", paused_by: null, paused_at: null, resume_at: null })
    .eq("id", sessionId);
  return { bot_status: "bot_active" as BotStatus, resume_at: null };
}
