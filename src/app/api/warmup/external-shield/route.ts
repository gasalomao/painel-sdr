import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { requireWarmupAdminAccess } from "@/lib/warmup/warmup-admin-guard";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import {
  checkExternalWarmupInbound,
  invalidateExternalShieldCache,
  listExternalQuarantineEntries,
  promoteQuarantineEntryToCrm,
} from "@/lib/warmup/warmup-external-shield";
import {
  readTenantWarmupConfigs,
  saveWarmupConfig,
} from "@/lib/warmup/warmup-config-service";
import { readSelfHealingLog } from "@/lib/warmup/warmup-self-healing";
import type { ExternalWarmupMode } from "@/lib/warmup/warmup-types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  const denied = requireWarmupAdminAccess(auth);
  if (denied) return denied;
  const clientId = auth.clientId;

  const { searchParams } = new URL(req.url);
  const instanceName = searchParams.get("instance_name");
  const limit = Number(searchParams.get("limit") || 50);

  const [entries, { configs }, selfHealingLog] = await Promise.all([
    listExternalQuarantineEntries(clientId, {
      instanceName,
      limit,
    }),
    readTenantWarmupConfigs(clientId).catch(() => ({ configs: {} as Record<string, never> })),
    readSelfHealingLog(clientId).catch(() => []),
  ]);

  // Diagnóstico ao vivo por chip: webhook + eventos recentes + contagem MMZap
  let recentUpsertRows: Array<{ instance_name?: string; created_at?: string }> = [];
  try {
    const { data } = await supabaseAdmin
      .from("webhook_logs")
      .select("instance_name, created_at")
      .eq("client_id", clientId)
      .in("event", ["messages.upsert", "MESSAGES_UPSERT"])
      .order("created_at", { ascending: false })
      .limit(40);
    if (Array.isArray(data)) recentUpsertRows = data;
  } catch {
    /* ignore */
  }

  const diagnostics = await Promise.all(
    Object.values(configs).map(async (cfg) => {
      let webhookOk = false;
      let webhookUrl: string | null = null;
      try {
        if (typeof evolution.findWebhook === "function") {
          const wh = await evolution.findWebhook(cfg.instance_name);
          webhookUrl = wh?.url || null;
          const events = Array.isArray(wh?.events) ? wh.events.map((e) => String(e).toUpperCase()) : [];
          webhookOk = Boolean(
            wh?.enabled &&
              wh?.url?.includes("/api/webhooks/whatsapp") &&
              events.includes("MESSAGES_UPSERT")
          );
        }
      } catch {
        webhookOk = false;
      }

      const lastUpsert = recentUpsertRows.find((r) => r.instance_name === cfg.instance_name);

      return {
        instance_name: cfg.instance_name,
        shield_mode: cfg.external_warmup_mode || "off",
        inbound_today: cfg.external_warmup_inbound_today || 0,
        inbound_total: cfg.external_warmup_inbound_total || 0,
        last_received_at: cfg.external_warmup_last_at || null,
        webhook_ok: webhookOk,
        webhook_url: webhookUrl,
        recent_webhook_upsert_at: lastUpsert?.created_at || null,
      };
    })
  );

  return NextResponse.json({
    ok: true,
    entries,
    diagnostics,
    self_healing_log: selfHealingLog,
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  const denied = requireWarmupAdminAccess(auth);
  if (denied) return denied;
  const clientId = auth.clientId;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Payload JSON inválido" }, { status: 400 });
  }

  const action = String(body.action || "");

  if (action === "set_mode") {
    const instanceName = String(body.instance_name || "").trim();
    const mode = String(body.mode || "off") as ExternalWarmupMode;
    if (!instanceName) {
      return NextResponse.json({ error: "instance_name é obrigatório" }, { status: 400 });
    }
    if (!["off", "receive_only", "hybrid_quarantine"].includes(mode)) {
      return NextResponse.json({ error: "mode inválido" }, { status: 400 });
    }
    const res = await saveWarmupConfig(clientId, instanceName, {
      external_warmup_mode: mode,
    });
    invalidateExternalShieldCache(clientId, instanceName);
    if (!res.ok) {
      return NextResponse.json({ error: res.error || "Falha ao atualizar modo" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, instance_name: instanceName, mode });
  }

  if (action === "promote") {
    const target = String(body.entry_id || body.canonical_sender_phone || "").trim();
    const instanceName = body.instance_name ? String(body.instance_name).trim() : null;
    if (!target) {
      return NextResponse.json({ error: "entry_id ou canonical_sender_phone é obrigatório" }, { status: 400 });
    }
    const res = await promoteQuarantineEntryToCrm(clientId, target, instanceName);
    return NextResponse.json({ ok: res.ok });
  }

  if (action === "simulate_mmzap_inbound") {
    const instanceName = String(body.instance_name || "").trim();
    if (!instanceName) {
      return NextResponse.json({ error: "instance_name é obrigatório" }, { status: 400 });
    }
    const testPhone = "5511900009999";
    invalidateExternalShieldCache(clientId, instanceName);
    const shieldRes = await checkExternalWarmupInbound({
      clientId,
      instanceName,
      remoteJid: `${testPhone}@s.whatsapp.net`,
      senderName: "Teste MMZap Rede",
      messageId: `TEST-MMZAP-${Date.now()}`,
      messageText: "[TESTE MMZAP] Bom dia! Tudo bem por aí?",
      fromMe: false,
    });
    return NextResponse.json({
      ok: true,
      intercepted: shieldRes.blocked,
      classification: shieldRes.classification,
      reason: shieldRes.reason || "external_warmup_mode_off",
      mode: shieldRes.mode || "off",
    });
  }

  return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
}
