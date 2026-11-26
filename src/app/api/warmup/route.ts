import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { requireFeatureAccess } from "@/lib/saas-limits";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import { isChatRowInbound, isChatRowOutbound } from "@/lib/chat-direction";
import {
  analyzeChipClusterHealth,
  auditChipDay0Hygiene,
  checkProxyIpIntel,
  extractDay0WarningsByInstance,
  type ProxyIpIntel,
} from "@/lib/warmup/warmup-groups";
import {
  mapWithConcurrency,
  readPhoneMemoryMap,
} from "@/lib/warmup/warmup-phone-memory";
import { getProxyPoolOverviewCache } from "@/lib/proxy-pool";
import {
  STAGE_DEFAULTS,
  type WarmupConfig,
  type WarmupLog,
  type WarmupStage,
} from "@/lib/warmup/warmup-types";
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

type ChipDeliveryMetrics = {
  outbound: number;
  deliveredRate: number;
  readRate: number;
  replyRate: number;
  failed: number;
};

async function getChipDeliveryMetricsMap(clientId: string): Promise<Map<string, ChipDeliveryMetrics>> {
  const result = new Map<string, ChipDeliveryMetrics>();
  try {
    const { data, error } = await supabaseAdmin
      .from("chats_dashboard")
      .select("instance_name, sender_type, status_envio")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(400);

    if (error || !Array.isArray(data) || data.length === 0) return result;

    const buckets = new Map<
      string,
      { outbound: number; delivered: number; read: number; failed: number; inbound: number }
    >();

    for (const row of data as Array<Record<string, unknown>>) {
      const inst = String(row.instance_name || "").trim();
      if (!inst || inst === "__all__") continue;
      let acc = buckets.get(inst);
      if (!acc) {
        acc = { outbound: 0, delivered: 0, read: 0, failed: 0, inbound: 0 };
        buckets.set(inst, acc);
      }
      if (isChatRowOutbound(row)) {
        acc.outbound++;
        const st = String(row.status_envio || "").toLowerCase();
        if (st === "delivered" || st === "read" || st === "played") acc.delivered++;
        if (st === "read" || st === "played") acc.read++;
        if (st === "error" || st === "failed") acc.failed++;
      } else if (isChatRowInbound(row)) {
        acc.inbound++;
      }
    }

    for (const [inst, acc] of buckets.entries()) {
      if (acc.outbound === 0 && acc.inbound === 0) continue;
      const denom = Math.max(1, acc.outbound);
      result.set(inst, {
        outbound: acc.outbound,
        deliveredRate: acc.outbound > 0 ? Math.min(100, Math.round((acc.delivered / denom) * 100)) : 0,
        readRate: acc.outbound > 0 ? Math.min(100, Math.round((acc.read / denom) * 100)) : 0,
        replyRate: acc.outbound > 0 ? Math.min(100, Math.round((acc.inbound / denom) * 100)) : 0,
        failed: acc.failed,
      });
    }
  } catch {}
  return result;
}

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
  const denied = requireFeatureAccess(auth, "aquecer_chips");
  if (denied) return denied;

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

    // 3. Enriquece telefones, status ao vivo e proxy da Evolution API.
    const phoneByInstance = new Map<string, string>();
    const liveStatusByInstance = new Map<string, string>();
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
        const rawLiveStatus = String(
          item.connectionStatus || item.instance?.connectionStatus || item.instance?.state || item.state || ""
        ).toLowerCase();
        if (rawLiveStatus === "open" || rawLiveStatus === "connected") {
          liveStatusByInstance.set(name, "open");
        } else if (rawLiveStatus === "close" || rawLiveStatus === "disconnected") {
          liveStatusByInstance.set(name, "close");
        } else if (rawLiveStatus) {
          liveStatusByInstance.set(name, rawLiveStatus);
        }

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

    const proxyByInstance = new Map<
      string,
      { enabled: boolean; host: string | null; port: string | null; protocol: string }
    >();
    if (typeof (evolution as { findProxy?: unknown }).findProxy === "function") {
      await mapWithConcurrency(connections, 4, async (c) => {
        try {
          const p: any = await evolution.findProxy(c.instance_name);
          if (p && typeof p === "object") {
            proxyByInstance.set(c.instance_name, {
              enabled: Boolean(p.enabled),
              host: p.host ? String(p.host) : null,
              port: p.port ? String(p.port) : null,
              protocol: p.protocol ? String(p.protocol) : "http",
            });
          }
        } catch {}
      });
    }

    // Resolve inteligência ASN/país dos proxies únicos (com cache 6h e limite de concorrência)
    const uniqueProxyHosts = Array.from(
      new Set(
        Array.from(proxyByInstance.values())
          .filter((p) => p.enabled && p.host)
          .map((p) => p.host!.trim().toLowerCase())
      )
    );
    const proxyIntelByHost = new Map<string, ProxyIpIntel | null>();
    if (uniqueProxyHosts.length > 0) {
      await mapWithConcurrency(uniqueProxyHosts, 3, async (host) => {
        const intel = await checkProxyIpIntel(host);
        proxyIntelByHost.set(host, intel);
      });
    }

    const phoneMemoryMap = await readPhoneMemoryMap(clientId).catch(() => ({}));
    const nowMs = Date.now();

    const logs = await getLogsFromDbOrSettings(clientId);
    const day0WarningsByInstance = extractDay0WarningsByInstance(logs);
    const deliveryMetricsByInstance = await getChipDeliveryMetricsMap(clientId);

    const poolOverview = await getProxyPoolOverviewCache().catch(() => ({
      hasPool: false,
      brHosts: new Set<string>(),
    }));

    const instancesList = connections.map((connection) => {
      const existingCfg = cfgMap[connection.instance_name];
      const liveState = liveStatusByInstance.get(connection.instance_name);
      const effectiveConnStatus =
        connection.status === "connecting" && liveState === "open"
          ? "open"
          : connection.status || liveState || "unknown";

      if (connection.status === "connecting" && liveState === "open") {
        supabaseAdmin
          .from("channel_connections")
          .update({ status: "open" })
          .eq("client_id", clientId)
          .eq("instance_name", connection.instance_name)
          .then(() => {}, () => {});
      }

      const config = buildDisplayConfig({
        clientId,
        instanceName: connection.instance_name,
        phoneNumber: phoneByInstance.get(connection.instance_name) || connection.phone_number,
        existing: existingCfg,
        globalSettings,
        enabledFallback: false,
      });

      const hasDay0Record = day0WarningsByInstance.has(connection.instance_name);
      const day0Warnings = day0WarningsByInstance.get(connection.instance_name) || [];
      const day0Status: "pending" | "warning" | "ok" = !hasDay0Record
        ? "pending"
        : day0Warnings.length > 0
          ? "warning"
          : "ok";

      const netHealth = analyzeChipClusterHealth({
        clientId,
        instanceName: connection.instance_name,
        config,
        proxyByInstance,
        proxyIntelByHost,
        managedBrPoolHosts: poolOverview.brHosts,
        phoneMemoryMap,
        nowMs,
      });

      return {
        instance_name: connection.instance_name,
        connection_status: effectiveConnStatus,
        phone_number: config.phone_number,
        orphan: false,
        config,
        day0_warnings: day0Warnings,
        day0_status: day0Status,
        network_warnings: netHealth.warnings,
        flaps_24h: netHealth.flaps24h,
        soft_recovery: netHealth.softRecovery,
        metrics: deliveryMetricsByInstance.get(connection.instance_name) || null,
        proxy: proxyByInstance.get(connection.instance_name) || {
          enabled: false,
          host: null,
          port: null,
          protocol: "http",
        },
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
        day0_warnings: [],
        day0_status: "pending",
        network_warnings: [],
        flaps_24h: 0,
        soft_recovery: false,
        metrics: null,
        proxy: { enabled: false, host: null, port: null, protocol: "http" },
      });
    }

    // 4. Estatísticas
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
  const denied = requireFeatureAccess(auth, "aquecer_chips");
  if (denied) return denied;

  const clientId = auth.clientId;

  try {
    const body = await req.json();

    // Ação em massa (ativar/pausar todos, incluindo chips recém-conectados)
    if (body.action === "enable_all" || body.action === "pause_all") {
      const enabled = body.action === "enable_all";
      const result = await setWarmupEnabledForAll(clientId, enabled);
      return NextResponse.json({ success: true, enabled, updated: result.updated });
    }

    // Reauditoria Dia-0 sob demanda (limpa alertas assim que foto/proxy estiverem OK)
    if (body.action === "reaudit_day0") {
      const instanceName = typeof body.instance_name === "string" ? body.instance_name.trim() : "";
      if (!instanceName) {
        return NextResponse.json(
          { success: false, error: "instance_name é obrigatório" },
          { status: 400 }
        );
      }
      const [conns, configsResult] = await Promise.all([
        readTenantConnections(clientId),
        readTenantWarmupConfigs(clientId),
      ]);
      const owned =
        conns.some((c) => c.instance_name === instanceName) ||
        Boolean(configsResult?.configs?.[instanceName]) ||
        Object.values(configsResult?.configs || {}).some((c) => c.instance_name === instanceName);
      if (!owned) {
        return NextResponse.json(
          { success: false, error: "Instância não pertence a este cliente" },
          { status: 403 }
        );
      }
      const audit = await auditChipDay0Hygiene(clientId, instanceName, { forceInTests: true });
      return NextResponse.json({ success: true, ok: audit.ok, warnings: audit.warnings });
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
  const denied = requireFeatureAccess(auth, "aquecer_chips");
  if (denied) return denied;

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
  const denied = requireFeatureAccess(auth, "aquecer_chips");
  if (denied) return denied;

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
