/**
 * Configuração de conexões WhatsApp Cloud API (Meta).
 *
 * POST   { action: "save",   instanceName, agent_id?, config: { phone_number_id, access_token, business_account_id?, verify_token?, app_secret?, graph_version? } }
 * POST   { action: "test",   instanceName }                           → bate na Graph API e devolve display_phone_number/verified_name
 * POST   { action: "send",   instanceName, to, text }                  → envio rápido pra debug
 * POST   { action: "delete", instanceName }
 * GET    ?instance=<name>                                              → devolve config (com access_token MASCARADO)
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { whatsappCloud } from "@/lib/whatsapp-cloud";
import { resolveChannel, invalidateChannelCache, sendMessage as sendViaChannel } from "@/lib/channel";

export const dynamic = "force-dynamic";

function maskToken(t?: string | null): string {
  if (!t) return "";
  if (t.length <= 12) return "••••";
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

export async function GET(req: NextRequest) {
  const instance = req.nextUrl.searchParams.get("instance");
  if (!instance) return NextResponse.json({ success: false, error: "instance é obrigatório" }, { status: 400 });

  const { data } = await supabase
    .from("channel_connections")
    .select("instance_name, provider, agent_id, status, provider_config")
    .eq("instance_name", instance)
    .maybeSingle();

  if (!data) return NextResponse.json({ success: false, error: "Conexão não encontrada" }, { status: 404 });

  const cfg = data.provider_config || {};
  return NextResponse.json({
    success: true,
    connection: {
      instance_name: data.instance_name,
      provider: data.provider,
      agent_id: data.agent_id,
      status: data.status,
      config: {
        phone_number_id: cfg.phone_number_id || "",
        business_account_id: cfg.business_account_id || "",
        verify_token: cfg.verify_token || "",
        graph_version: cfg.graph_version || "v21.0",
        access_token_preview: maskToken(cfg.access_token),
        app_secret_preview: maskToken(cfg.app_secret),
        has_access_token: !!cfg.access_token,
        has_app_secret: !!cfg.app_secret,
      },
    },
  });
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "JSON inválido" }, { status: 400 });
  }

  const { action, instanceName } = body || {};
  if (!instanceName) return NextResponse.json({ success: false, error: "instanceName é obrigatório" }, { status: 400 });

  // SAVE
  if (action === "save") {
    const cfgIn = body.config || {};
    if (!cfgIn.phone_number_id || !cfgIn.access_token) {
      return NextResponse.json(
        { success: false, error: "phone_number_id e access_token são obrigatórios." },
        { status: 400 }
      );
    }

    // Preserva access_token/app_secret se vieram mascarados (front pode reenviar formulário sem mexer)
    const { data: existing } = await supabase
      .from("channel_connections")
      .select("provider_config")
      .eq("instance_name", instanceName)
      .maybeSingle();
    const prev = existing?.provider_config || {};

    const provider_config = {
      phone_number_id:     String(cfgIn.phone_number_id).trim(),
      access_token:        cfgIn.access_token && !cfgIn.access_token.includes("…") ? String(cfgIn.access_token).trim() : prev.access_token,
      business_account_id: cfgIn.business_account_id ? String(cfgIn.business_account_id).trim() : (prev.business_account_id || null),
      verify_token:        cfgIn.verify_token ? String(cfgIn.verify_token).trim() : (prev.verify_token || null),
      app_secret:          cfgIn.app_secret && !cfgIn.app_secret.includes("…") ? String(cfgIn.app_secret).trim() : prev.app_secret,
      graph_version:       cfgIn.graph_version ? String(cfgIn.graph_version).trim() : (prev.graph_version || "v21.0"),
    };

    const upsertPayload: any = {
      instance_name: instanceName,
      provider: "whatsapp_cloud",
      provider_config,
      status: "open",
    };
    if (typeof body.agent_id === "number") upsertPayload.agent_id = body.agent_id;
    else if (existing) {
      // mantém agent_id existente
    } else {
      upsertPayload.agent_id = 1;
    }

    const { error } = await supabase
      .from("channel_connections")
      .upsert(upsertPayload, { onConflict: "instance_name" });

    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

    invalidateChannelCache(instanceName);
    return NextResponse.json({ success: true });
  }

  // TEST
  if (action === "test") {
    try {
      const ch = await resolveChannel(instanceName, { fresh: true });
      if (ch.provider !== "whatsapp_cloud" || !ch.cloud) {
        return NextResponse.json({ success: false, error: "Conexão não é WhatsApp Cloud." });
      }
      const info = await whatsappCloud.getPhoneInfo(ch.cloud);
      return NextResponse.json({ success: true, info });
    } catch (err: any) {
      return NextResponse.json({ success: false, error: err.message }, { status: 200 });
    }
  }

  // SEND (debug)
  if (action === "send") {
    const { to, text } = body;
    if (!to || !text) return NextResponse.json({ success: false, error: "to e text obrigatórios" }, { status: 400 });
    try {
      const res = await sendViaChannel(`${String(to).replace(/\D/g, "")}@s.whatsapp.net`, String(text), instanceName);
      return NextResponse.json({ success: true, result: res });
    } catch (err: any) {
      return NextResponse.json({ success: false, error: err.message }, { status: 200 });
    }
  }

  // DELETE
  if (action === "delete") {
    const { error } = await supabase.from("channel_connections").delete().eq("instance_name", instanceName);
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    invalidateChannelCache(instanceName);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ success: false, error: "action inválida (use save|test|send|delete)" }, { status: 400 });
}
