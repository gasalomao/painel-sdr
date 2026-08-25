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
   CACHE TTL CURTO — settings lidos no hot path do webhook
   ------------------------------------------------------------
   Cada mensagem recebida fazia 4+ SELECTs de settings sem cache
   (getEffectiveStatus×2 chaves + shouldSkipGroupActions +
   getTranscriptionMethod). TTL 30s corta quase tudo. Escritas
   LOCAIS invalidam na hora; escritas pelo painel (browser →
   Supabase direto) ficam stale até 30s — aceitável pra config.
   ============================================================ */
const SETTINGS_TTL_MS = 30_000;
const settingsCache = new Map<string, { v: unknown; at: number }>();

async function cachedSetting<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = settingsCache.get(key);
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.v as T;
  const v = await fn();
  settingsCache.set(key, { v, at: Date.now() });
  return v;
}

function bustSettings(prefix: string) {
  for (const k of [...settingsCache.keys()]) {
    if (k.startsWith(prefix)) settingsCache.delete(k);
  }
}

/* ============================================================
   GRUPOS — helper para identificar e filtrar
   ============================================================ */

/**
 * Identifica se um JID pertence a um grupo do WhatsApp.
 * Grupos usam o sufixo @g.us (Evolution API / Baileys / whatsmeow).
 */
export function isGroupJid(remoteJid: string | null | undefined): boolean {
  return !!remoteJid && remoteJid.endsWith("@g.us");
}

/**
 * Verifica se o agente tem "disable_groups" ativado.
 * Consulta agent_settings.disable_groups (boolean, default false).
 */
export async function isGroupDisabled(agentId: number | string): Promise<boolean> {
  return cachedSetting(`gd:${agentId}`, async () => {
    try {
      const { data } = await supabaseAdmin
        .from("agent_settings")
        .select("disable_groups")
        .eq("id", agentId)
        .maybeSingle();
      return data?.disable_groups === true;
    } catch {
      return false;
    }
  });
}

/**
 * Combina as duas checagens: só retorna true se for grupo E o agente
 * tiver disable_groups ativado. Uso típico nos webhooks antes de
 * transcrever áudio ou disparar a IA.
 */
export async function shouldSkipGroupActions(
  remoteJid: string | null | undefined,
  agentId: number | string | null | undefined,
): Promise<boolean> {
  if (!isGroupJid(remoteJid)) return false;
  if (!agentId) return false;
  return isGroupDisabled(agentId);
}

export type TranscriptionMethod = "auto" | "whisper" | "gemini" | "openrouter" | "disabled";

export async function getTranscriptionMethod(agentId: number | string | null | undefined): Promise<TranscriptionMethod> {
  if (!agentId) return "auto";
  return cachedSetting(`tm:${agentId}`, async () => {
    try {
      const { data } = await supabaseAdmin
        .from("agent_settings")
        .select("transcription_method")
        .eq("id", agentId)
        .maybeSingle();
      const m = data?.transcription_method;
      if (m === "whisper" || m === "gemini" || m === "openrouter" || m === "disabled") return m;
      return "auto";
    } catch {
      return "auto";
    }
  }) as Promise<TranscriptionMethod>;
}

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
    return cachedSetting("gp:legacy", async () => {
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
    }) as Promise<GlobalPauseState>;
  }

  return cachedSetting(`gp:${instance}`, async () => {
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
  }) as Promise<GlobalPauseState>;
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
  bustSettings("gp:");
  if (!value) return { paused: false, until: null, instance: opts.instance };
  if (value === "forever") return { paused: true, until: null, instance: opts.instance };
  return { paused: true, until: value, instance: opts.instance };
}

export async function clearGlobalPause(instance?: string): Promise<GlobalPauseState> {
  if (!instance) {
    // Limpa a chave legada (compat).
    await supabaseAdmin.from("app_settings").upsert({ key: LEGACY_GLOBAL_KEY, value: "", updated_at: new Date().toISOString() }, { onConflict: "key" });
    bustSettings("gp:");
    return { paused: false, until: null, instance: null };
  }
  await supabaseAdmin.from("app_settings").upsert({ key: keyFor(instance), value: "", updated_at: new Date().toISOString() }, { onConflict: "key" });
  bustSettings(`gp:${instance}`);
  return { paused: false, until: null, instance };
}

/* ============================================================
   PAUSA AUTOMÁTICA QUANDO UM HUMANO RESPONDE
   ------------------------------------------------------------
   Config GLOBAL (app_settings). Quando um humano responde o
   cliente — pelo painel OU pelo celular do número conectado —
   a IA é pausada pra não responderem juntos.
     - mode "timed":  pausa por `minutes` e volta sozinha.
     - mode "manual": pausa até o operador reativar na mão.
   `enabled=false` desliga a pausa automática por completo.
   ============================================================ */

export type HumanPauseConfig = {
  enabled: boolean;
  minutes: number;
  mode: "timed" | "manual";
};

const HP_KEYS = ["human_pause_enabled", "human_pause_minutes", "human_pause_mode"];

/** Lê a config da pausa automática. Default: ligada, 30min, volta sozinha. */
export async function getHumanPauseConfig(): Promise<HumanPauseConfig> {
  return cachedSetting("hp", async () => {
    try {
      const { data } = await supabaseAdmin
        .from("app_settings")
        .select("key, value")
        .in("key", HP_KEYS);
      const map = new Map((data || []).map((r: any) => [r.key, r.value]));
      const enabledRaw = map.get("human_pause_enabled");
      return {
        // Sem valor salvo = ligado (mantém o comportamento histórico de
        // auto-pausar quando o operador assume a conversa).
        enabled: enabledRaw == null || enabledRaw === "" ? true : enabledRaw === "true",
        minutes: Math.max(1, Number(map.get("human_pause_minutes")) || 30),
        mode: map.get("human_pause_mode") === "manual" ? "manual" : "timed",
      };
    } catch {
      return { enabled: true, minutes: 30, mode: "timed" };
    }
  }) as Promise<HumanPauseConfig>;
}

/** Grava (parcialmente) a config da pausa automática em app_settings. */
export async function setHumanPauseConfig(cfg: Partial<HumanPauseConfig>): Promise<void> {
  const rows: { key: string; value: string }[] = [];
  if (cfg.enabled !== undefined) rows.push({ key: "human_pause_enabled", value: cfg.enabled ? "true" : "false" });
  if (cfg.minutes !== undefined) rows.push({ key: "human_pause_minutes", value: String(Math.max(1, Math.floor(cfg.minutes))) });
  if (cfg.mode !== undefined) rows.push({ key: "human_pause_mode", value: cfg.mode === "manual" ? "manual" : "timed" });
  for (const r of rows) {
    await supabaseAdmin
      .from("app_settings")
      .upsert({ key: r.key, value: r.value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  }
  bustSettings("hp");
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
