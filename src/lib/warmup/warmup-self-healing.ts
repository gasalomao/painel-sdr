import { supabaseAdmin } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import {
  ensureProxyForInstance,
  fallbackInstanceToVps,
  getProxyPoolOverviewCache,
  testProxyEndpointConnectivity,
  type ProxyConnectivityProbe,
} from "@/lib/proxy-pool";
import { isTenantWarmupAdmin } from "./warmup-admin-guard";
import {
  ensureWarmupConfigsForTenant,
  isConnectedStatus,
  readTenantWarmupConfigs,
} from "./warmup-config-service";
import { logWarmupAction } from "./warmup-engine";
import { cleanupDeadWarmupGroups, hydrateChipProfile } from "./warmup-groups";
import { pruneMapToLimit } from "./warmup-phone-memory";

const SELF_HEALING_LOG_PREFIX = "warmup_self_healing_log_";
const SELF_HEALING_INTERVAL_MS = 10 * 60 * 1000;
const STUCK_RESTART_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_SELF_HEALING_ENTRIES = 30;

export interface SelfHealingActionRecord {
  id: string;
  instance_name: string;
  issue: string;
  resolution: string;
  status: "fixed" | "needs_attention";
  created_at: string;
}

export interface SelfHealingReport {
  skipped?: boolean;
  checkedChips: number;
  fixedCount: number;
  needsAttentionCount: number;
  actions: SelfHealingActionRecord[];
}

const _lastSelfHealingAt = new Map<string, number>();
const _lastRestartAttemptAt = new Map<string, number>();

export function resetSelfHealingForTests(): void {
  _lastSelfHealingAt.clear();
  _lastRestartAttemptAt.clear();
}

export async function readSelfHealingLog(clientId: string): Promise<SelfHealingActionRecord[]> {
  if (!clientId) return [];
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `${SELF_HEALING_LOG_PREFIX}${clientId}`)
      .maybeSingle();
    if (!data?.value) return [];
    const parsed = JSON.parse(String(data.value));
    return Array.isArray(parsed) ? (parsed as SelfHealingActionRecord[]) : [];
  } catch {
    return [];
  }
}

async function appendSelfHealingLog(
  clientId: string,
  newActions: SelfHealingActionRecord[]
): Promise<void> {
  if (!clientId || newActions.length === 0) return;
  try {
    const existing = await readSelfHealingLog(clientId);
    const merged = [...newActions, ...existing].slice(0, MAX_SELF_HEALING_ENTRIES);
    await supabaseAdmin
      .from("app_settings")
      .upsert(
        {
          key: `${SELF_HEALING_LOG_PREFIX}${clientId}`,
          value: JSON.stringify(merged),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );
  } catch {
    /* persistência best-effort */
  }
}

function resolveExpectedWebhookUrl(explicitBaseUrl?: string): string {
  const base = String(
    explicitBaseUrl ||
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.APP_URL ||
      "https://sistema-sdr.ridnii.easypanel.host"
  )
    .trim()
    .replace(/\/$/, "");
  return `${base}/api/webhooks/whatsapp`;
}

function makeAction(
  instanceName: string,
  issue: string,
  resolution: string,
  status: "fixed" | "needs_attention",
  nowIso: string
): SelfHealingActionRecord {
  return {
    id: `heal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    instance_name: instanceName,
    issue,
    resolution,
    status,
    created_at: nowIso,
  };
}

/**
 * Motor Autônomo de Auto-Cura do Aquecedor (exclusivo ADM):
 * Detecta e resolve sozinho problemas comuns sem intervenção manual:
 * 1. Sincroniza status real na Evolution API vs banco + auto-cadastra chips recém-escaneados;
 * 2. Verifica e repara webhook desconectado ou sem eventos críticos na Evolution;
 * 3. Detecta proxy morto/offline (rotacionando ou voltando para IP limpo da VPS) e colisão de proxy entre 2+ chips;
 * 4. Reinicia sessão presa em `connecting` (com cooldown anti-loop);
 * 5. Libera quarentena expirada, hidrata perfil faltante e limpa grupos inativos.
 */
export async function runWarmupSelfHealingForTenant(
  clientId: string,
  opts?: {
    force?: boolean;
    nowMs?: number;
    appBaseUrl?: string;
    proxyProbeFn?: ProxyConnectivityProbe;
  }
): Promise<SelfHealingReport> {
  const nowMs = opts?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (!(await isTenantWarmupAdmin(clientId))) {
    return { skipped: true, checkedChips: 0, fixedCount: 0, needsAttentionCount: 0, actions: [] };
  }

  if (!opts?.force) {
    const last = _lastSelfHealingAt.get(clientId) || 0;
    if (nowMs - last < SELF_HEALING_INTERVAL_MS) {
      return { skipped: true, checkedChips: 0, fixedCount: 0, needsAttentionCount: 0, actions: [] };
    }
  }
  pruneMapToLimit(_lastSelfHealingAt, 500);
  _lastSelfHealingAt.set(clientId, nowMs);

  const actions: SelfHealingActionRecord[] = [];
  const probeFn = opts?.proxyProbeFn ?? testProxyEndpointConnectivity;
  const expectedWebhookUrl = resolveExpectedWebhookUrl(opts?.appBaseUrl);

  // 1. Garante auto-cadastro dos chips ADM conectados e leitura das configs atuais
  const ensured = await ensureWarmupConfigsForTenant(clientId);
  const { configs } = await readTenantWarmupConfigs(clientId);

  if (ensured.created.length > 0) {
    actions.push(
      makeAction(
        ensured.created.join(", "),
        "Novo chip ADM detectado",
        `Cadastrado e protegido com Escudo MMZap (${ensured.created.join(", ")}).`,
        "fixed",
        nowIso
      )
    );
  }

  // 2. Consulta status ao vivo na Evolution API para reconciliar status preso e detectar sessões travadas
  const liveStatusByInst = new Map<string, string>();
  try {
    if (typeof evolution.fetchInstances === "function") {
      const evoRaw = (await evolution.fetchInstances()) as
        | Array<Record<string, unknown>>
        | { instances?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> };
      const evoList = Array.isArray(evoRaw)
        ? evoRaw
        : evoRaw?.instances || evoRaw?.data || [];
      for (const item of evoList) {
        const instObj = (item.instance as Record<string, unknown> | undefined) || {};
        const name = String(instObj.instanceName || instObj.name || item.name || item.instanceName || "").trim();
        if (!name) continue;
        const st = String(
          item.connectionStatus || instObj.connectionStatus || instObj.state || item.state || ""
        ).toLowerCase();
        if (st) liveStatusByInst.set(name, st);
      }
    }
  } catch {
    /* Evolution momentaneamente indisponível */
  }

  const connInstances = new Set<string>([
    ...ensured.connections.map((c) => c.instance_name),
    ...Object.keys(configs),
  ]);
  const instanceList = Array.from(connInstances).filter(Boolean);
  if (instanceList.length === 0) {
    return { checkedChips: 0, fixedCount: 0, needsAttentionCount: 0, actions: [] };
  }

  // Lê provider_config de channel_connections para preservar webhook_secret existente ao reparar
  const webhookSecretByInst = new Map<string, string>();
  try {
    const { data: connRows } = await supabaseAdmin
      .from("channel_connections")
      .select("instance_name, status, provider_config")
      .eq("client_id", clientId);
    for (const row of (connRows || []) as Array<{
      instance_name?: string;
      status?: string;
      provider_config?: Record<string, unknown> | null;
    }>) {
      if (!row?.instance_name) continue;
      const secret = row.provider_config?.webhook_secret;
      if (typeof secret === "string" && secret.trim()) {
        webhookSecretByInst.set(row.instance_name, secret.trim());
      }
      const live = liveStatusByInst.get(row.instance_name);
      if (live && isConnectedStatus(live) && !isConnectedStatus(row.status)) {
        await supabaseAdmin
          .from("channel_connections")
          .update({ status: "open" })
          .eq("client_id", clientId)
          .eq("instance_name", row.instance_name);
        actions.push(
          makeAction(
            row.instance_name,
            "Status preso como desconectado no painel",
            "Sincronizado automaticamente para conectado com base na Evolution.",
            "fixed",
            nowIso
          )
        );
      }
    }
  } catch {
    /* ignore */
  }

  // 3. Verifica e auto-repara Webhooks na Evolution + coleta proxies ao vivo para checar colisão/saúde
  const proxyHolders = new Map<string, string[]>();
  const proxyDetailsByInst = new Map<
    string,
    { enabled: boolean; host: string; port: number; protocol: "http" | "https" | "socks4" | "socks5"; username: string; password: string }
  >();

  const poolOverview = await getProxyPoolOverviewCache().catch(() => ({ hasPool: false, brHosts: new Set<string>() }));

  for (const inst of instanceList) {
    const cfg = configs[inst];
    const connRow = ensured.connections.find((c) => c.instance_name === inst);
    const live = liveStatusByInst.get(inst) || connRow?.status || "";

    // 3a. Sessão travada em `connecting` fora de quarentena/reabilitação
    if (
      live === "connecting" &&
      cfg &&
      !cfg.is_quarantined &&
      cfg.career_mode !== "rehab"
    ) {
      const lastRestart = _lastRestartAttemptAt.get(inst) || 0;
      if (nowMs - lastRestart >= STUCK_RESTART_COOLDOWN_MS && typeof evolution.restartInstance === "function") {
        _lastRestartAttemptAt.set(inst, nowMs);
        pruneMapToLimit(_lastRestartAttemptAt, 500);
        try {
          await evolution.restartInstance(inst);
          actions.push(
            makeAction(
              inst,
              "Sessão presa em 'conectando'",
              "Instância reiniciada automaticamente para restabelecer conexão.",
              "fixed",
              nowIso
            )
          );
        } catch {
          actions.push(
            makeAction(
              inst,
              "Sessão desconectada/aguardando leitura de QR",
              "Escaneie novamente o QR Code em WhatsApp para religar este chip.",
              "needs_attention",
              nowIso
            )
          );
        }
      }
    }

    // 3b. Verificação e reparo automático do Webhook (essencial para MMZap e grupos)
    if (typeof evolution.findWebhook === "function" && typeof evolution.setWebhook === "function") {
      try {
        const wh = await evolution.findWebhook(inst);
        const events = Array.isArray(wh?.events) ? wh.events.map((e) => String(e).toUpperCase()) : [];
        const hasUpsert = events.includes("MESSAGES_UPSERT");
        const hasConn = events.includes("CONNECTION_UPDATE");
        const urlOk = Boolean(wh?.url && wh.url.includes("/api/webhooks/whatsapp"));
        if (!wh?.enabled || !urlOk || !hasUpsert || !hasConn) {
          await evolution.setWebhook(expectedWebhookUrl, inst, webhookSecretByInst.get(inst) || null);
          actions.push(
            makeAction(
              inst,
              "Webhook ausente ou sem eventos críticos na Evolution",
              "Webhook reconfigurado automaticamente (MESSAGES_UPSERT + CONNECTION_UPDATE).",
              "fixed",
              nowIso
            )
          );
        }
      } catch {
        /* ignora se Evolution não responder */
      }
    }

    // 3c. Coleta proxy ao vivo do chip
    if (typeof evolution.findProxy === "function") {
      try {
        const px = (await evolution.findProxy(inst)) as {
          enabled?: boolean;
          host?: string;
          port?: string | number;
          protocol?: string;
          username?: string;
          password?: string;
        } | null;
        if (px?.enabled && px.host && px.port) {
          const endpoint = `${px.host}:${px.port}`;
          const holders = proxyHolders.get(endpoint) || [];
          holders.push(inst);
          proxyHolders.set(endpoint, holders);
          const protocol = (["http", "https", "socks4", "socks5"].includes(String(px.protocol || ""))
            ? px.protocol
            : "http") as "http" | "https" | "socks4" | "socks5";
          proxyDetailsByInst.set(inst, {
            enabled: true,
            host: String(px.host),
            port: Number(px.port),
            protocol,
            username: String(px.username || ""),
            password: String(px.password || ""),
          });
        }
      } catch {
        /* ignore */
      }
    }

    // 3d. Libera quarentena expirada e hidrata perfil faltante
    if (cfg?.is_quarantined && cfg.quarantine_until && new Date(cfg.quarantine_until).getTime() <= nowMs) {
      await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .update({
          is_quarantined: false,
          quarantine_reason: null,
          health_score: Math.max(60, cfg.health_score || 60),
          error_count_today: 0,
          updated_at: nowIso,
        })
        .eq("client_id", clientId)
        .eq("instance_name", inst);
      actions.push(
        makeAction(
          inst,
          "Quarentena preventiva de 24h concluída",
          "Chip liberado automaticamente para retomar aquecimento suave.",
          "fixed",
          nowIso
        )
      );
    }

    if (cfg && !cfg.profile_hydrated && isConnectedStatus(live)) {
      void hydrateChipProfile(clientId, inst).catch(() => {});
    }
  }

  // 4. Resolve proxies mortos e colisões de IP entre chips ADM
  for (const [inst, px] of proxyDetailsByInst.entries()) {
    const probe = await probeFn(
      {
        host: px.host,
        port: px.port,
        protocol: px.protocol,
        username: px.username,
        password: px.password,
      },
      2500
    ).catch((err: unknown) => ({
      ok: false,
      error: err instanceof Error ? err.message : "Timeout no proxy",
    }));

    if (!probe.ok) {
      if (poolOverview.hasPool) {
        const res = await ensureProxyForInstance({
          instanceName: inst,
          clientId,
          reason: "rotation",
          forWarmup: true,
          probeFn,
        });
        actions.push(
          makeAction(
            inst,
            `Proxy ${px.host}:${px.port} offline (${probe.error || "falha"})`,
            res.mode === "pool_assigned"
              ? `Proxy trocado automaticamente para ${res.host || "novo IP limpo do pool"}.`
              : "Pool sem reservas no momento — chip migrado com segurança para o IP padrão da VPS.",
            "fixed",
            nowIso
          )
        );
      } else {
        await fallbackInstanceToVps(inst, clientId, `Auto-cura: proxy ${px.host}:${px.port} offline`);
        actions.push(
          makeAction(
            inst,
            `Proxy ${px.host}:${px.port} falhou no teste`,
            "Proxy defeituoso removido automaticamente para proteger a conexão (operando no IP da VPS).",
            "fixed",
            nowIso
          )
        );
      }
    }
  }

  for (const [endpoint, holders] of proxyHolders.entries()) {
    if (holders.length <= 1) continue;
    if (poolOverview.hasPool) {
      for (const secondaryInst of holders.slice(1)) {
        const rot = await ensureProxyForInstance({
          instanceName: secondaryInst,
          clientId,
          reason: "rotation",
          forWarmup: true,
          probeFn,
        });
        actions.push(
          makeAction(
            secondaryInst,
            `Colisão de IP detectada (${holders.join(" e ")} em ${endpoint})`,
            rot.mode === "pool_assigned"
              ? `Isolado automaticamente para proxy exclusivo (${rot.host || "pool BR"}).`
              : "Pool esgotado ao isolar — movido temporariamente para IP da VPS até importar novos proxies.",
            rot.mode === "pool_assigned" ? "fixed" : "needs_attention",
            nowIso
          )
        );
      }
    } else {
      actions.push(
        makeAction(
          holders.join(", "),
          `Mesmo proxy (${endpoint}) usado em ${holders.length} chips ADM`,
          "Importe um arquivo .txt de proxies BR em Configurações/WhatsApp para o sistema isolar 1 IP por chip automaticamente.",
          "needs_attention",
          nowIso
        )
      );
    }
  }

  // 5. Auto-limpeza de grupos mortos (>5 dias silenciosos)
  try {
    const cleanup = await cleanupDeadWarmupGroups(clientId, nowMs, 120);
    if (cleanup.leftGroups > 0) {
      actions.push(
        makeAction(
          "grupos",
          `${cleanup.leftGroups} grupo(s) silencioso(s) há mais de 5 dias`,
          "Chips removidos automaticamente dos grupos mortos para manter higiene da conta.",
          "fixed",
          nowIso
        )
      );
    }
  } catch {
    /* ignore */
  }

  await appendSelfHealingLog(clientId, actions);

  for (const act of actions.filter((a) => a.status === "fixed").slice(0, 3)) {
    await logWarmupAction({
      client_id: clientId,
      sender_instance: act.instance_name,
      receiver_instance: "self_healing",
      message_text: `🛠️ Auto-Cura: ${act.issue} → ${act.resolution}`,
      action_type: "system",
    }).catch(() => {});
  }

  return {
    skipped: false,
    checkedChips: instanceList.length,
    fixedCount: actions.filter((a) => a.status === "fixed").length,
    needsAttentionCount: actions.filter((a) => a.status === "needs_attention").length,
    actions,
  };
}
