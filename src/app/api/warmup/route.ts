import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import { STAGE_DEFAULTS, type WarmupConfig, type WarmupLog, type WarmupStage } from "@/lib/warmup/warmup-types";
import {
  ensureWarmupConfigsForTenant,
  getGlobalWarmupSettings,
  isConnectedStatus,
  readTenantConnections,
  readTenantWarmupConfigs,
  saveGlobalWarmupSettings,
  saveWarmupConfig,
  setWarmupEnabledForAll,
  type GlobalWarmupSettings,
} from "@/lib/warmup/warmup-config-service";

export const dynamic = "force-dynamic";

/**
 * Lê logs de aquecimento do DB ou de app_settings.
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
 * Mescla config existente com defaults globais para exibição.
 */
function buildDisplayConfig(params: {
  clientId: string;
  instanceName: string;
  phoneNumber: string | null;
  existing?: WarmupConfig;
  globalSettings: GlobalWarmupSettings;
  enabledFallback?: boolean;
}): WarmupConfig {
  const { clientId, instanceName, phoneNumber, existing, globalSettings, enabledFallback } = params;
  const stage = (existing?.stage || 1) as WarmupStage;
  const stageDefaults = STAGE_DEFAULTS[stage] || STAGE_DEFAULTS[1];

  return {
    id: existing?.id,
    client_id: clientId,
    instance_name: instanceName,
    phone_number: phoneNumber || existing?.phone_number || null,
    enabled: existing?.enabled ?? enabledFallback ?? false,
    stage,
    stage_auto_progress: existing?.stage_auto_progress ?? globalSettings.stage_auto_progress,
    days_active: existing?.days_active || 1,
    consecutive_successful_days: existing?.consecutive_successful_days || 0,
    health_score: existing?.health_score ?? 100,
    is_quarantined: existing?.is_quarantined ?? false,
    quarantine_reason: existing?.quarantine_reason || null,
    quarantine_until: existing?.quarantine_until || null,
    daily_target: existing?.daily_target ?? stageDefaults.dailyTarget,
    sent_today: existing?.sent_today ?? 0,
    received_today: existing?.received_today ?? 0,
    error_count_today: existing?.error_count_today ?? 0,
    last_activity_at: existing?.last_activity_at || null,
    last_status_post_at: existing?.last_status_post_at || null,
    vcard_exchanged_peers: existing?.vcard_exchanged_peers || [],
    min_interval_seconds: existing?.min_interval_seconds ?? stageDefaults.minInterval,
    max_interval_seconds: existing?.max_interval_seconds ?? stageDefaults.maxInterval,
    min_typing_seconds: existing?.min_typing_seconds ?? globalSettings.min_typing_seconds,
    max_typing_seconds: existing?.max_typing_seconds ?? globalSettings.max_typing_seconds,
    allowed_start_hour: existing?.allowed_start_hour ?? globalSettings.allowed_start_hour,
    allowed_end_hour: existing?.allowed_end_hour ?? globalSettings.allowed_end_hour,
    ai_model: existing?.ai_model || globalSettings.ai_model,
    ai_theme: existing?.ai_theme || globalSettings.ai_theme,
    enable_typing: existing?.enable_typing ?? globalSettings.enable_typing,
    enable_blue_ticks: existing?.enable_blue_ticks ?? globalSettings.enable_blue_ticks,
    enable_reactions: existing?.enable_reactions ?? globalSettings.enable_reactions,
    enable_audio: existing?.enable_audio ?? globalSettings.enable_audio,
    enable_vcard: existing?.enable_vcard ?? globalSettings.enable_vcard,
    enable_status_posts: existing?.enable_status_posts ?? globalSettings.enable_status_posts,
    continuous_warmup: existing?.continuous_warmup ?? globalSettings.continuous_warmup,
    custom_prompt: existing?.custom_prompt || globalSettings.custom_prompt,
    purpose: existing?.purpose || "contingency",
    profile_hydrated: existing?.profile_hydrated ?? false,
    group_auto_join: existing?.group_auto_join ?? true,
    swarm_active: existing?.swarm_active ?? true,
    max_groups_per_chip: existing?.max_groups_per_chip ?? 10,
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  const clientId = auth.clientId;

  try {
    // 1. Cadastra automaticamente chips conectados que ainda não têm config.
    const ensured = await ensureWarmupConfigsForTenant(clientId);

    // 2. Lê conexões e configs (tabela é fonte única quando disponível).
    const connections = ensured.connections.length
      ? ensured.connections
      : await readTenantConnections(clientId);
    const { configs: cfgMap } = await readTenantWarmupConfigs(clientId);
    const globalSettings = await getGlobalWarmupSettings(clientId);

    // 3. Enriquece telefones com dados ao vivo da Evolution API.
    const phoneByInstance = new Map<string, string>();
    for (const c of connections) {
      if (c.phone_number) phoneByInstance.set(c.instance_name, c.phone_number);
    }

    const orphanNames = new Set<string>();
    try {
      const evoRaw: any = await evolution.fetchInstances();
      const evoList = Array.isArray(evoRaw) ? evoRaw : (evoRaw?.instances || evoRaw?.data || []);
      const knownNames = new Set(connections.map((c) => c.instance_name));

      for (const item of evoList) {
        const name = item.instance?.instanceName || item.instance?.name || item.name || item.instanceName;
        if (!name) continue;
        const owner = item.ownerJid || item.instance?.ownerJid || item.owner || item.instance?.owner;
        if (owner) {
          const clean = String(owner).replace(/@.*$/, "").replace(/\D/g, "");
          if (clean.length >= 10 && !phoneByInstance.has(name)) {
            phoneByInstance.set(name, clean);
          }
        }
        if (!knownNames.has(name)) orphanNames.add(name);
      }
    } catch {}

    const instancesList = connections.map((connection) => {
      const existingCfg = cfgMap[connection.instance_name];
      const config = buildDisplayConfig({
        clientId,
        instanceName: connection.instance_name,
        phoneNumber: phoneByInstance.get(connection.instance_name) || connection.phone_number,
        existing: existingCfg,
        globalSettings,
        enabledFallback: false,
      });

      return {
        instance_name: connection.instance_name,
        connection_status: connection.status || "unknown",
        phone_number: config.phone_number,
        orphan: false,
        config,
        proxy: { enabled: false, host: null, port: null, protocol: "http" },
      };
    });

    // Instâncias que existem na Evolution mas não pertencem a nenhum tenant
    // cadastrado não podem ser aquecidas (não há como atribuir com segurança).
    for (const orphanName of orphanNames) {
      instancesList.push({
        instance_name: orphanName,
        connection_status: "orphan",
        phone_number: phoneByInstance.get(orphanName) || null,
        orphan: true,
        config: buildDisplayConfig({
          clientId,
          instanceName: orphanName,
          phoneNumber: phoneByInstance.get(orphanName) || null,
          globalSettings,
          enabledFallback: false,
        }),
        proxy: { enabled: false, host: null, port: null, protocol: "http" },
      });
    }

    // 4. Logs e estatísticas
    const logs = await getLogsFromDbOrSettings(clientId);

    const warmable = instancesList.filter((i) => !i.orphan);
    const totalChips = warmable.length;
    const activeWarmup = warmable.filter((i) => i.config.enabled).length;
    const totalSentToday = warmable.reduce((acc, i) => acc + (i.config.sent_today || 0), 0);
    const totalReceivedToday = warmable.reduce((acc, i) => acc + (i.config.received_today || 0), 0);
    const connectedChips = warmable.filter((i) => isConnectedStatus(i.connection_status)).length;

    let totalGroups = 0;
    try {
      const { count } = await supabaseAdmin
        .from("whatsapp_warmup_groups")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId);
      totalGroups = count || 0;
    } catch {}

    return NextResponse.json({
      success: true,
      data: {
        instances: instancesList,
        global_settings: globalSettings,
        logs,
        stats: {
          totalChips,
          activeWarmup,
          connectedChips,
          orphanChips: instancesList.length - totalChips,
          totalSentToday,
          totalReceivedToday,
          totalGroups,
        },
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

async function saveSingleConfig(
  clientId: string,
  body: Record<string, unknown>
): Promise<NextResponse> {
  const instanceName = body?.instance_name;

  if (!instanceName || typeof instanceName !== "string") {
    return NextResponse.json(
      { success: false, error: "instance_name é obrigatório" },
      { status: 400 }
    );
  }

  const { instance_name: _ignored, ...updates } = body;
  void _ignored;

  const result = await saveWarmupConfig(clientId, instanceName, updates);

  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: result.config });
}

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  const clientId = auth.clientId;

  try {
    const body = await req.json();

    // Ação em massa (ativar/pausar todos, incluindo chips recém-conectados)
    if (body.action === "enable_all" || body.action === "pause_all") {
      const enabled = body.action === "enable_all";
      const result = await setWarmupEnabledForAll(clientId, enabled);
      return NextResponse.json({ success: true, enabled, updated: result.updated });
    }

    // Configurações globais do tenant
    if (body.type === "global_settings") {
      const { type: _unused, applyToAll, ...settings } = body;
      void _unused;
      const merged = await saveGlobalWarmupSettings(
        clientId,
        settings as Partial<GlobalWarmupSettings>,
        Boolean(applyToAll)
      );
      return NextResponse.json({ success: true, settings: merged });
    }

    return saveSingleConfig(clientId, body);
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/**
 * PUT: mesma semântica do salvamento de chip único (a UI usa PUT).
 */
export async function PUT(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  try {
    const body = await req.json();
    return saveSingleConfig(auth.clientId, body);
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
    const result = await setWarmupEnabledForAll(clientId, enabled);

    return NextResponse.json({ success: true, enabled, updated: result.updated });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
