import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { requireWarmupAdminAccess } from "@/lib/warmup/warmup-admin-guard";
import {
  getMmzapWorkerHealth,
  getMmzapWorkerPairingQr,
  getMmzapWorkerScreenshot,
  getMmzapWorkerSessionStatus,
  isMmzapWorkerConfigured,
  logoutMmzapWorkerSession,
  markMmzapWorkerSetupDone,
  openMmzapWorkerSetupWindow,
  sendMmzapWorkerInput,
  startMmzapWorkerPairing,
  startMmzapWorkerShift,
  uploadMmzapExtensionZip,
} from "@/lib/warmup/mmzap-browser-client";
import {
  resolveMmzapProxyForInstance,
  stopMmzapSessionForChip,
  updateMmzapConfigFields,
} from "@/lib/warmup/mmzap-browser-orchestrator";
import {
  getMmzapGovernorSettings,
  saveMmzapGovernorSettings,
} from "@/lib/warmup/warmup-config-service";
import { invalidateExternalShieldCache } from "@/lib/warmup/warmup-external-shield";
import { clearPhonePostBanRehab } from "@/lib/warmup/warmup-phone-memory";
import { logWarmupAction } from "@/lib/warmup/warmup-engine";
import type { MmzapBrowserStatus } from "@/lib/warmup/warmup-types";

export const dynamic = "force-dynamic";

const QR_REQUIRED_ERROR_MSG =
  "Sessão do WhatsApp Web no MMZap foi deslogada. Escaneie o QR Code novamente para reconectar.";

async function readInstanceWarmupRow(
  clientId: string,
  instanceName: string
): Promise<{
  external_warmup_mode?: string;
  mmzap_shifts_today?: number;
  mmzap_browser_status?: string;
  mmzap_last_error?: string | null;
} | null> {
  try {
    const { data } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("external_warmup_mode, mmzap_shifts_today, mmzap_browser_status, mmzap_last_error")
      .eq("client_id", clientId)
      .eq("instance_name", instanceName)
      .maybeSingle();
    return (data as {
      external_warmup_mode?: string;
      mmzap_shifts_today?: number;
      mmzap_browser_status?: string;
      mmzap_last_error?: string | null;
    } | null) ?? null;
  } catch {
    return null;
  }
}

async function ensureReceiveOnlyIfOff(
  clientId: string,
  instanceName: string,
  currentMode?: string
): Promise<boolean> {
  if (currentMode && currentMode !== "off") {
    return false;
  }
  await supabaseAdmin
    .from("whatsapp_warmup_configs")
    .update({ external_warmup_mode: "receive_only", updated_at: new Date().toISOString() })
    .eq("client_id", clientId)
    .eq("instance_name", instanceName);
  invalidateExternalShieldCache(clientId, instanceName);
  return true;
}

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  const denied = requireWarmupAdminAccess(auth);
  if (denied) return denied;
  const clientId = auth.clientId;

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "status";
  const instanceName = searchParams.get("instance") || "";

  if (action === "qr") {
    if (!instanceName) {
      return NextResponse.json(
        { success: false, error: "Parâmetro 'instance' obrigatório." },
        { status: 400 }
      );
    }
    const res = await getMmzapWorkerPairingQr(instanceName);
    if (!res.ok || !res.data) {
      return NextResponse.json(
        { success: false, error: res.error || "Falha ao consultar QR Code." },
        { status: res.statusCode || 502 }
      );
    }

    const nextStatus = res.data.status as MmzapBrowserStatus;
    const nowIso = new Date().toISOString();

    if (nextStatus === "running") {
      const row = await readInstanceWarmupRow(clientId, instanceName);
      const fields: Record<string, unknown> = {
        mmzap_browser_status: "running",
        mmzap_browser_enabled: true,
        mmzap_shift_started_at: nowIso,
        mmzap_last_error: null,
        updated_at: nowIso,
      };
      if (res.data.proxyIp) {
        fields.mmzap_proxy_endpoint = res.data.proxyIp;
      }
      if (!row?.external_warmup_mode || row.external_warmup_mode === "off") {
        fields.external_warmup_mode = "receive_only";
      }
      if (row?.mmzap_browser_status !== "running") {
        fields.mmzap_shifts_today = Number(row?.mmzap_shifts_today || 0) + 1;
      }
      await updateMmzapConfigFields(clientId, instanceName, fields);
    } else if (nextStatus === "idle" || nextStatus === "needs_extension_setup") {
      const row = await readInstanceWarmupRow(clientId, instanceName);
      const fields: Record<string, unknown> = {
        mmzap_browser_status: nextStatus,
        mmzap_browser_enabled: true,
        mmzap_last_error: null,
        updated_at: nowIso,
      };
      if (!row?.external_warmup_mode || row.external_warmup_mode === "off") {
        fields.external_warmup_mode = "receive_only";
      }
      await updateMmzapConfigFields(clientId, instanceName, fields);
    } else if (nextStatus === "qr_pending" && res.data.sessionLoggedOut) {
      await updateMmzapConfigFields(clientId, instanceName, {
        mmzap_browser_status: "qr_pending",
        mmzap_last_error: res.data.lastError || "qr_required",
        mmzap_shift_started_at: null,
        updated_at: nowIso,
      });
    }

    return NextResponse.json({ success: true, data: res.data });
  }

  if (action === "session_status") {
    if (!instanceName) {
      return NextResponse.json(
        { success: false, error: "Parâmetro 'instance' obrigatório." },
        { status: 400 }
      );
    }
    const res = await getMmzapWorkerSessionStatus(instanceName);
    if (!res.ok || !res.data) {
      return NextResponse.json(
        { success: false, error: res.error || "Falha ao consultar status da sessão MMZap." },
        { status: res.statusCode || 502 }
      );
    }
    return NextResponse.json({ success: true, data: res.data });
  }

  if (action === "screenshot") {
    if (!instanceName) {
      return NextResponse.json(
        { success: false, error: "Parâmetro 'instance' obrigatório." },
        { status: 400 }
      );
    }
    const res = await getMmzapWorkerScreenshot(instanceName);
    if (!res.ok || !res.data) {
      return NextResponse.json(
        { success: false, error: res.error || "Falha ao capturar tela do worker." },
        { status: res.statusCode || 502 }
      );
    }
    return NextResponse.json({ success: true, data: res.data });
  }

  const [worker, governor] = await Promise.all([
    getMmzapWorkerHealth(),
    getMmzapGovernorSettings(clientId),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      configured: isMmzapWorkerConfigured(),
      worker,
      governor,
    },
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  const denied = requireWarmupAdminAccess(auth);
  if (denied) return denied;
  const clientId = auth.clientId;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action || "").trim();
  const instanceName = String(body.instance_name || "").trim();

  if (action === "save_governor") {
    const patch = (body.governor && typeof body.governor === "object"
      ? body.governor
      : body) as Record<string, unknown>;
    const governor = await saveMmzapGovernorSettings(clientId, patch);
    return NextResponse.json({ success: true, governor });
  }

  if (action === "upload_extension") {
    const zipBase64 = String(body.zipBase64 || "").trim();
    if (!zipBase64) {
      return NextResponse.json(
        { success: false, error: "Arquivo .zip da extensão obrigatório." },
        { status: 400 }
      );
    }
    const res = await uploadMmzapExtensionZip(zipBase64);
    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: res.error || "Falha ao instalar extensão no worker." },
        { status: res.statusCode || 502 }
      );
    }
    return NextResponse.json({ success: true, data: res.data });
  }

  if (!instanceName) {
    return NextResponse.json(
      { success: false, error: "Campo 'instance_name' obrigatório." },
      { status: 400 }
    );
  }

  if (action === "pair") {
    const [governor, row, proxy] = await Promise.all([
      getMmzapGovernorSettings(clientId),
      readInstanceWarmupRow(clientId, instanceName),
      resolveMmzapProxyForInstance(clientId, instanceName),
    ]);
    const shouldResetProfile = Boolean(
      body.resetProfile === true ||
        row?.mmzap_browser_status === "error" ||
        row?.mmzap_browser_status === "qr_pending" ||
        row?.mmzap_last_error === "qr_required"
    );
    const res = await startMmzapWorkerPairing({
      instanceName,
      clientId,
      proxy,
      shiftDurationMinutes: governor.shift_duration_minutes,
      resetProfile: shouldResetProfile,
    });
    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: res.error || "Falha ao abrir pareamento no worker." },
        { status: res.statusCode || 502 }
      );
    }
    const status = (res.data?.status || "qr_pending") as MmzapBrowserStatus;
    const nowIso = new Date().toISOString();
    const fields: Record<string, unknown> = {
      mmzap_browser_status: status,
      mmzap_browser_enabled: true,
      mmzap_proxy_endpoint: proxy?.sourceHost || res.data?.proxyIp || null,
      mmzap_last_error: null,
      updated_at: nowIso,
    };
    if (!row?.external_warmup_mode || row.external_warmup_mode === "off") {
      fields.external_warmup_mode = "receive_only";
    }
    if (status === "running") {
      fields.mmzap_shift_started_at = nowIso;
      if (row?.mmzap_browser_status !== "running") {
        fields.mmzap_shifts_today = Number(row?.mmzap_shifts_today || 0) + 1;
      }
    }
    await updateMmzapConfigFields(clientId, instanceName, fields);
    return NextResponse.json({ success: true, data: res.data });
  }

  if (action === "setup") {
    const proxy = await resolveMmzapProxyForInstance(clientId, instanceName);
    const setupUrl = typeof body.setupUrl === "string" ? body.setupUrl : undefined;
    const res = await openMmzapWorkerSetupWindow({
      instanceName,
      clientId,
      proxy,
      setupUrl,
    });
    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: res.error || "Falha ao abrir janela de configuração." },
        { status: res.statusCode || 502 }
      );
    }
    return NextResponse.json({ success: true, data: res.data });
  }

  if (action === "setup_input") {
    const input = (body.input || {}) as {
      type: "click" | "text" | "key" | "goto";
      x?: number;
      y?: number;
      text?: string;
      key?: string;
      url?: string;
    };
    const res = await sendMmzapWorkerInput(instanceName, input);
    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: res.error || "Falha ao enviar entrada ao worker." },
        { status: res.statusCode || 502 }
      );
    }
    return NextResponse.json({ success: true, data: res.data });
  }

  if (action === "setup_complete") {
    const res = await markMmzapWorkerSetupDone(instanceName);
    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: res.error || "Falha ao concluir configuração." },
        { status: res.statusCode || 502 }
      );
    }
    await updateMmzapConfigFields(clientId, instanceName, {
      mmzap_browser_status: "idle",
      mmzap_last_error: null,
      updated_at: new Date().toISOString(),
    });
    return NextResponse.json({ success: true, data: res.data });
  }

  if (action === "start_shift") {
    const [governor, row, proxy] = await Promise.all([
      getMmzapGovernorSettings(clientId),
      readInstanceWarmupRow(clientId, instanceName),
      resolveMmzapProxyForInstance(clientId, instanceName),
    ]);

    // Garante Escudo Receive-Only ativo antes de abrir turno MMZap
    await ensureReceiveOnlyIfOff(clientId, instanceName, row?.external_warmup_mode);

    // Reseta limpo estados travados de pausa preventiva ou erro anterior ao iniciar turno
    if (
      row?.mmzap_browser_status === "paused_safety" ||
      row?.mmzap_browser_status === "error"
    ) {
      await updateMmzapConfigFields(clientId, instanceName, {
        mmzap_browser_status: "idle",
        mmzap_last_error: null,
        updated_at: new Date().toISOString(),
      });
    }

    const res = await startMmzapWorkerShift({
      instanceName,
      clientId,
      proxy,
      shiftDurationMinutes: governor.shift_duration_minutes,
      slowMode: true,
    });

    const isQrRequired = Boolean(
      res.data?.sessionLoggedOut ||
        res.data?.lastError === "qr_required" ||
        res.data?.status === "qr_pending" ||
        (!res.ok && !res.data?.needsExtensionSetup && res.statusCode === 409) ||
        (!res.ok && /qr_required|qr code|desconectada/i.test(String(res.error || "")))
    );

    if (!res.ok || isQrRequired) {
      const nowIso = new Date().toISOString();

      if (res.data?.needsExtensionSetup) {
        await updateMmzapConfigFields(clientId, instanceName, {
          mmzap_browser_status: "needs_extension_setup",
          mmzap_last_error: "needs_extension_setup",
          updated_at: nowIso,
        });
        return NextResponse.json(
          {
            success: false,
            code: "needs_extension_setup",
            error:
              res.error ||
              "Configure a extensão MMZap pela 1ª vez antes de iniciar o turno.",
            data: res.data,
          },
          { status: 409 }
        );
      }

      if (isQrRequired) {
        await updateMmzapConfigFields(clientId, instanceName, {
          mmzap_browser_status: "qr_pending",
          mmzap_last_error: "qr_required",
          mmzap_shift_started_at: null,
          updated_at: nowIso,
        });
        return NextResponse.json(
          {
            success: false,
            code: "qr_required",
            error: res.error || QR_REQUIRED_ERROR_MSG,
            data: {
              ...(res.data || {}),
              instanceName,
              status: "qr_pending",
              sessionLoggedOut: true,
              lastError: "qr_required",
            },
          },
          { status: 409 }
        );
      }

      if (res.statusCode === 429) {
        return NextResponse.json(
          {
            success: false,
            code: "max_concurrent_browsers",
            error:
              res.error ||
              "Limite de browsers simultâneos na VPS atingido. Aguarde um turno encerrar.",
            data: res.data,
          },
          { status: 429 }
        );
      }

      await updateMmzapConfigFields(clientId, instanceName, {
        mmzap_browser_status: "error",
        mmzap_last_error: res.error || "worker_start_error",
        updated_at: nowIso,
      });
      return NextResponse.json(
        {
          success: false,
          error: res.error || "Falha ao iniciar turno MMZap.",
          data: res.data,
        },
        { status: res.statusCode || 502 }
      );
    }

    const nowIso = new Date().toISOString();
    const nextShifts =
      row?.mmzap_browser_status === "running"
        ? Number(row?.mmzap_shifts_today || 0)
        : Number(row?.mmzap_shifts_today || 0) + 1;

    await updateMmzapConfigFields(clientId, instanceName, {
      mmzap_browser_status: "running",
      mmzap_browser_enabled: true,
      mmzap_shift_started_at: nowIso,
      mmzap_shifts_today: nextShifts,
      mmzap_last_error: null,
      mmzap_proxy_endpoint: proxy?.sourceHost || res.data?.proxyIp || null,
      updated_at: nowIso,
    });

    return NextResponse.json({ success: true, data: res.data });
  }

  if (action === "stop_shift") {
    const stopped = await stopMmzapSessionForChip(clientId, instanceName, "manual_stop");
    return NextResponse.json({ success: true, data: stopped });
  }

  if (action === "toggle_enabled") {
    const enabled = Boolean(body.enabled);
    const row = await readInstanceWarmupRow(clientId, instanceName);
    const nowIso = new Date().toISOString();
    const fields: Record<string, unknown> = {
      mmzap_browser_enabled: enabled,
      updated_at: nowIso,
    };
    if (body.mmzap_max_sends_override !== undefined) {
      fields.mmzap_max_sends_override =
        body.mmzap_max_sends_override === null || body.mmzap_max_sends_override === ""
          ? null
          : Math.max(0, Math.min(100, Math.round(Number(body.mmzap_max_sends_override))));
    }
    if (enabled && (!row?.external_warmup_mode || row.external_warmup_mode === "off")) {
      fields.external_warmup_mode = "receive_only";
    }
    await updateMmzapConfigFields(clientId, instanceName, fields);
    return NextResponse.json({ success: true, enabled });
  }

  if (action === "logout" || action === "reset_profile") {
    const ownedRow = await readInstanceWarmupRow(clientId, instanceName);
    if (!ownedRow) {
      return NextResponse.json(
        { success: false, error: "Instância não encontrada para esta conta." },
        { status: 404 }
      );
    }

    const workerRes = await logoutMmzapWorkerSession(instanceName).catch(() => null);
    const nowIso = new Date().toISOString();

    await updateMmzapConfigFields(clientId, instanceName, {
      mmzap_browser_status: "unpaired",
      mmzap_browser_enabled: false,
      mmzap_shift_started_at: null,
      mmzap_last_error: null,
      mmzap_proxy_endpoint: null,
      updated_at: nowIso,
    });

    invalidateExternalShieldCache(clientId, instanceName);

    await logWarmupAction({
      client_id: clientId,
      sender_instance: instanceName,
      receiver_instance: "mmzap_browser",
      message_text: "🚪 Sessão MMZap desconectada e perfil apagado automaticamente",
      action_type: "system",
      details: {
        action,
        logged_out_from_whatsapp: Boolean(workerRes?.data?.loggedOutFromWhatsApp),
        profile_wiped: Boolean(workerRes?.data?.profileWiped),
        used_fallback_delete: Boolean(workerRes?.data?.usedFallbackDelete),
      },
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      data: {
        instanceName,
        status: "unpaired",
        loggedOutFromWhatsApp: Boolean(workerRes?.data?.loggedOutFromWhatsApp),
        profileWiped: workerRes?.configured ? Boolean(workerRes?.data?.profileWiped) : false,
        profileDirExisted: workerRes?.data?.profileDirExisted ?? false,
        usedFallbackDelete: Boolean(workerRes?.data?.usedFallbackDelete),
        workerOk: Boolean(workerRes?.ok),
        workerError: workerRes?.ok ? null : workerRes?.error || null,
      },
    });
  }

  if (action === "release_quarantine") {
    const nowIso = new Date().toISOString();
    let existingHealth = 0;
    let existingPhone: string | null = null;
    try {
      const { data: row } = await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .select("health_score, phone_number")
        .eq("client_id", clientId)
        .eq("instance_name", instanceName)
        .maybeSingle();
      existingHealth = Number((row as { health_score?: number } | null)?.health_score || 0);
      existingPhone = (row as { phone_number?: string | null } | null)?.phone_number || null;
    } catch {
      /* ignore */
    }
    const nextHealth = Math.max(65, existingHealth);
    const fullUpdate = {
      is_quarantined: false,
      quarantine_reason: null,
      quarantine_until: null,
      health_score: nextHealth,
      error_count_today: 0,
      career_mode: "maturing",
      rehab_until: null,
      cold_outreach_locked_until: null,
      updated_at: nowIso,
    };

    const updRes = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .update(fullUpdate)
      .eq("client_id", clientId)
      .eq("instance_name", instanceName);

    const updCode = String((updRes?.error as { code?: string } | null)?.code || "");
    const updMsg = String((updRes?.error as { message?: string } | null)?.message || "");
    if (
      updRes?.error &&
      (updCode === "42703" || updCode === "PGRST204" || /career_mode|rehab_until|cold_outreach_locked_until/i.test(updMsg))
    ) {
      await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .update({
          is_quarantined: false,
          quarantine_reason: null,
          quarantine_until: null,
          health_score: nextHealth,
          error_count_today: 0,
          updated_at: nowIso,
        })
        .eq("client_id", clientId)
        .eq("instance_name", instanceName);
    }

    await clearPhonePostBanRehab({
      clientId,
      instanceName,
      phone: existingPhone,
    }).catch(() => null);

    invalidateExternalShieldCache(clientId, instanceName);

    await logWarmupAction({
      client_id: clientId,
      sender_instance: instanceName,
      receiver_instance: "admin_override",
      message_text: `🔓 Quarentena e reabilitação liberadas manualmente pelo Admin para ${instanceName} (saúde ajustada para ${nextHealth}%).`,
      action_type: "system",
    }).catch(() => {});

    return NextResponse.json({ success: true, health_score: nextHealth, rehab_cleared: true });
  }

  return NextResponse.json(
    { success: false, error: `Ação desconhecida: ${action}` },
    { status: 400 }
  );
}
