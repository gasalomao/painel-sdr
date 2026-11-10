import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import { STAGE_DEFAULTS, type WarmupConfig, type WarmupLog } from "@/lib/warmup/warmup-types";

export const dynamic = "force-dynamic";

/**
 * Lê configurações de aquecimento via whatsapp_warmup_configs com fallback em app_settings.
 */
async function getConfigsFromDbOrSettings(clientId: string): Promise<Record<string, WarmupConfig>> {
  // 1. Tenta ler de whatsapp_warmup_configs
  try {
    const { data, error } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("*")
      .eq("client_id", clientId);

    if (!error && data && data.length > 0) {
      const map: Record<string, WarmupConfig> = {};
      for (const row of data as WarmupConfig[]) {
        map[row.instance_name] = row;
      }
      return map;
    }
  } catch {}

  // 2. Fallback: app_settings (sempre disponível, não depende de migration SQL aplicada)
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `warmup_configs_${clientId}`)
      .maybeSingle();

    if (data?.value) {
      return JSON.parse(data.value);
    }
  } catch {}

  return {};
}

/**
 * Salva configurações de aquecimento tanto em whatsapp_warmup_configs quanto em app_settings.
 */
async function saveConfigToDbAndSettings(clientId: string, cfg: WarmupConfig): Promise<void> {
  const nowIso = new Date().toISOString();

  // 1. Tenta salvar em whatsapp_warmup_configs
  try {
    await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .upsert(
        {
          ...cfg,
          client_id: clientId,
          updated_at: nowIso,
        },
        { onConflict: "client_id,instance_name" }
      );
  } catch {}

  // 2. Persiste em app_settings para garantia e resiliência total
  try {
    const currentMap = await getConfigsFromDbOrSettings(clientId);
    currentMap[cfg.instance_name] = { ...cfg, updated_at: nowIso };

    await supabaseAdmin
      .from("app_settings")
      .upsert(
        {
          key: `warmup_configs_${clientId}`,
          value: JSON.stringify(currentMap),
          updated_at: nowIso,
        },
        { onConflict: "key" }
      );
  } catch {}
}

/**
 * Lê logs de aquecimento do DB ou de app_settings
 */
async function getLogsFromDbOrSettings(clientId: string, limit = 40): Promise<WarmupLog[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("whatsapp_warmup_logs")
      .select("*")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (!error && Array.isArray(data)) {
      return data;
    }
  } catch {}

  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `warmup_logs_${clientId}`)
      .maybeSingle();

    if (data?.value) {
      const parsed = JSON.parse(data.value);
      return Array.isArray(parsed) ? parsed.slice(0, limit) : [];
    }
  } catch {}

  return [];
}

/**
 * Lê as configurações gerais/padrão de aquecimento do tenant
 */
async function getGlobalWarmupSettings(clientId: string) {
  const defaults = {
    ai_model: "fallback",
    ai_theme: "dia_a_dia",
    allowed_start_hour: 8,
    allowed_end_hour: 21,
    min_interval_seconds: 90,
    max_interval_seconds: 300,
    min_typing_seconds: 3,
    max_typing_seconds: 8,
    enable_typing: true,
    enable_blue_ticks: true,
    enable_reactions: true,
    enable_audio: true,
    enable_vcard: true,
    enable_status_posts: true,
    stage_auto_progress: true,
    continuous_warmup: true,
    custom_prompt: "",
  };

  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `warmup_global_${clientId}`)
      .maybeSingle();

    if (data?.value) {
      return { ...defaults, ...JSON.parse(data.value) };
    }
  } catch {}

  return defaults;
}

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  const clientId = auth.clientId;

  try {
    // 1. Busca instâncias no channel_connections (banco local)
    let connsQuery = supabaseAdmin
      .from("channel_connections")
      .select("instance_name, status, provider_config, client_id");

    if (!auth.isAdmin || auth.impersonating) {
      connsQuery = connsQuery.eq("client_id", clientId);
    }
    const { data: connsDb } = await connsQuery;

    // 2. Busca também instâncias ao vivo da Evolution API para garantir que NENHUM chip fique de fora
    const instancesMap = new Map<string, {
      instance_name: string;
      status: string;
      phone_number: string | null;
      profile_name?: string;
    }>();

    for (const c of (connsDb || [])) {
      const pConfig = c.provider_config as Record<string, any> | undefined;
      const phone = pConfig?.owner_phone || pConfig?.owner_jid || null;
      instancesMap.set(c.instance_name, {
        instance_name: c.instance_name,
        status: c.status || "open",
        phone_number: phone ? String(phone).replace(/\D/g, "") : null,
      });
    }

    // Enriquece com dados ao vivo da Evolution API (ownerJid, telefone real do chip)
    try {
      const evoRaw: any = await evolution.fetchInstances();
      const evoList = Array.isArray(evoRaw) ? evoRaw : (evoRaw?.instances || evoRaw?.data || []);
      for (const item of evoList) {
        const name = item.instance?.instanceName || item.instance?.name || item.name || item.instanceName;
        const owner = item.ownerJid || item.instance?.ownerJid || item.owner || item.instance?.owner;
        if (name && instancesMap.has(name) && owner) {
          const clean = String(owner).replace(/\D/g, "");
          const current = instancesMap.get(name)!;
          if (!current.phone_number && clean.length >= 10) {
            current.phone_number = clean;
          }
        }
      }
    } catch {}

    // 2. Lê configurações de aquecimento salvas
    const cfgMap = await getConfigsFromDbOrSettings(clientId);
    const globalSettings = await getGlobalWarmupSettings(clientId);

    // 4. Monta a lista completa com defaults
    const instancesList = Array.from(instancesMap.values()).map((c) => {
      const instName = c.instance_name;
      const existingCfg = cfgMap[instName];
      const stage = existingCfg?.stage || 1;
      const stageDefaults = STAGE_DEFAULTS[stage as 1 | 2 | 3 | 4];

      const fullConfig: WarmupConfig = {
        id: existingCfg?.id,
        client_id: clientId,
        instance_name: instName,
        phone_number: c.phone_number,
        enabled: existingCfg?.enabled ?? false,
        stage: stage as any,
        stage_auto_progress: existingCfg?.stage_auto_progress ?? globalSettings.stage_auto_progress,
        days_active: existingCfg?.days_active || 1,
        consecutive_successful_days: existingCfg?.consecutive_successful_days || 0,
        health_score: existingCfg?.health_score ?? 100,
        is_quarantined: existingCfg?.is_quarantined ?? false,
        quarantine_reason: existingCfg?.quarantine_reason || null,
        quarantine_until: existingCfg?.quarantine_until || null,
        daily_target: existingCfg?.daily_target ?? stageDefaults.dailyTarget,
        sent_today: existingCfg?.sent_today ?? 0,
        received_today: existingCfg?.received_today ?? 0,
        error_count_today: existingCfg?.error_count_today ?? 0,
        last_activity_at: existingCfg?.last_activity_at || null,
        last_status_post_at: existingCfg?.last_status_post_at || null,
        vcard_exchanged_peers: existingCfg?.vcard_exchanged_peers || [],
        min_interval_seconds: existingCfg?.min_interval_seconds ?? stageDefaults.minInterval,
        max_interval_seconds: existingCfg?.max_interval_seconds ?? stageDefaults.maxInterval,
        min_typing_seconds: existingCfg?.min_typing_seconds ?? globalSettings.min_typing_seconds,
        max_typing_seconds: existingCfg?.max_typing_seconds ?? globalSettings.max_typing_seconds,
        allowed_start_hour: existingCfg?.allowed_start_hour ?? globalSettings.allowed_start_hour,
        allowed_end_hour: existingCfg?.allowed_end_hour ?? globalSettings.allowed_end_hour,
        ai_model: existingCfg?.ai_model || globalSettings.ai_model,
        ai_theme: existingCfg?.ai_theme || globalSettings.ai_theme,
        enable_typing: existingCfg?.enable_typing ?? globalSettings.enable_typing,
        enable_blue_ticks: existingCfg?.enable_blue_ticks ?? globalSettings.enable_blue_ticks,
        enable_reactions: existingCfg?.enable_reactions ?? globalSettings.enable_reactions,
        enable_audio: existingCfg?.enable_audio ?? globalSettings.enable_audio,
        enable_vcard: existingCfg?.enable_vcard ?? globalSettings.enable_vcard,
        enable_status_posts: existingCfg?.enable_status_posts ?? globalSettings.enable_status_posts,
        continuous_warmup: existingCfg?.continuous_warmup ?? globalSettings.continuous_warmup,
        custom_prompt: existingCfg?.custom_prompt || globalSettings.custom_prompt,
      };

      return {
        instance_name: instName,
        connection_status: c.status,
        phone_number: c.phone_number,
        config: fullConfig,
        proxy: {
          enabled: false,
          host: null,
          port: null,
          protocol: "http",
        },
      };
    });

    // 5. Busca logs
    const logs = await getLogsFromDbOrSettings(clientId);

    // 6. Estatísticas
    const totalChips = instancesList.length;
    const activeWarmup = instancesList.filter((i) => i.config.enabled).length;
    const totalSentToday = instancesList.reduce((acc, i) => acc + (i.config.sent_today || 0), 0);
    const totalReceivedToday = instancesList.reduce((acc, i) => acc + (i.config.received_today || 0), 0);

    return NextResponse.json({
      success: true,
      data: {
        instances: instancesList,
        global_settings: globalSettings,
        logs,
        stats: {
          totalChips,
          activeWarmup,
          totalSentToday,
          totalReceivedToday,
        },
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  const clientId = auth.clientId;

  try {
    const body = await req.json();

    // Se for salvamento de configurações globais
    if (body.type === "global_settings") {
      const { type: _discardType, ...settings } = body;
      await supabaseAdmin
        .from("app_settings")
        .upsert(
          {
            key: `warmup_global_${clientId}`,
            value: JSON.stringify(settings),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "key" }
        );

      return NextResponse.json({ success: true, settings });
    }

    const { instance_name, ...updates } = body;

    if (!instance_name) {
      return NextResponse.json({ success: false, error: "instance_name é obrigatório" }, { status: 400 });
    }

    const payload: WarmupConfig = {
      client_id: clientId,
      instance_name,
      ...updates,
    };

    await saveConfigToDbAndSettings(clientId, payload);

    return NextResponse.json({ success: true, data: payload });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  const clientId = auth.clientId;

  try {
    const { action } = await req.json();
    const enabled = action === "enable_all";

    const cfgMap = await getConfigsFromDbOrSettings(clientId);
    for (const key of Object.keys(cfgMap)) {
      cfgMap[key].enabled = enabled;
      await saveConfigToDbAndSettings(clientId, cfgMap[key]);
    }

    return NextResponse.json({ success: true, enabled });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
