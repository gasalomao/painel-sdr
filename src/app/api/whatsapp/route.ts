import { NextRequest, NextResponse } from "next/server";
import { evolution } from "@/lib/evolution";

export const dynamic = 'force-dynamic';

// Normaliza resposta de /instance/fetchInstances (v2 retorna array com objeto { instance: {...} })
function normalizeFetchInstances(raw: any) {
  const list = Array.isArray(raw) ? raw : (raw?.instances || []);
  
  return list
    .map((item: any) => {
      const inst = item.instance || item;
      const name = inst.instanceName || inst.name || inst.instance_name;
      if (!name) return null; // Ignora se não tiver nome nenhum

      const status = inst.status || inst.state || inst.connectionStatus || "unknown";
      const profile = inst.profileName || inst.instanceName || name;
      
      return {
        instanceName: name,
        status: status,
        owner: inst.owner || inst.number || null,
        // Exibe "Nome Real (ID Técnico)" para não confundir o usuário
        profileName: profile && profile !== name ? `${profile} (${name})` : name,
      };
    })
    .filter((i: any) => i !== null);
}

export async function GET(req: NextRequest) {
  try {
    const listAll = req.nextUrl.searchParams.get("instances");
    if (listAll === "true") {
      const rawInstances = await evolution.fetchInstances();
      return NextResponse.json({ success: true, instances: normalizeFetchInstances(rawInstances || []) });
    }

    const instanceName = req.nextUrl.searchParams.get("instance");
    if (!instanceName) {
      // Se nao passou instancia, tenta listar todas
      const rawInstances = await evolution.fetchInstances();
      return NextResponse.json({ success: true, instances: normalizeFetchInstances(rawInstances || []) });
    }

    // Status individual — Cloud não tem QR/estado; reportamos "open" se token+phone_number_id existem.
    const { supabaseAdmin } = await import("@/lib/supabase_admin");
    const { data: ch } = await supabaseAdmin
      .from("channel_connections")
      .select("provider, provider_config")
      .eq("instance_name", instanceName)
      .maybeSingle();
    if (ch?.provider === "whatsapp_cloud") {
      const cfg = ch.provider_config || {};
      const ok = !!(cfg.access_token && cfg.phone_number_id);
      return NextResponse.json({
        success: true,
        state: ok ? "open" : "close",
        provider: "whatsapp_cloud",
        data: { phone_number_id: cfg.phone_number_id || null, business_account_id: cfg.business_account_id || null },
      });
    }

    const statusData = await evolution.getStatus(instanceName);
    return NextResponse.json({ success: true, state: statusData.state, data: statusData.data });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { action, instanceName } = await req.json();

    switch (action) {
      case "connect": {
        // Já conectado? Não regera QR — devolve o estado pra UI mostrar "online".
        const pre = await evolution.getStatus(instanceName).catch(() => ({ state: "not_found" as const, data: null }));
        if (pre.state === "open") {
          return NextResponse.json({ success: true, qrCode: null, pairingCode: null, state: "open", data: pre.data });
        }

        // ensureInstanceConfigured: cria se faltar, (re)aplica settings padrão
        // (rejectCall, groupsIgnore, alwaysOnline, etc) e registra o webhook
        // apontando pra URL pública atual. Garante que cada Conectar deixa a
        // instância em estado consistente, sem depender de mudanças manuais
        // no painel da Evolution.
        const { supabaseAdmin } = await import("@/lib/supabase_admin");
        let publicUrl: string | undefined;
        try {
          const { data } = await supabaseAdmin
            .from("app_settings")
            .select("value")
            .eq("key", "public_url")
            .maybeSingle();
          if (data?.value && !data.value.includes("localhost")) publicUrl = data.value;
        } catch { /* sem URL pública não trava o connect, só o webhook */ }
        if (!publicUrl) {
          const env = process.env.NEXT_PUBLIC_APP_URL;
          if (env && !env.includes("localhost")) publicUrl = env;
        }

        const connectResponse = await evolution.ensureInstanceConfigured(instanceName, publicUrl);

        return NextResponse.json({
          success: true,
          qrCode: connectResponse?.code || connectResponse?.base64 || null,
          pairingCode: connectResponse?.pairingCode || null,
          fullData: connectResponse,
        });
      }

      case "restart": {
        try {
          const data = await evolution.restartInstance(instanceName);
          return NextResponse.json({ success: true, data });
        } catch (e) {
          // Se restart falhar, tenta reconectar via connect
          const data = await evolution.connect(instanceName);
          return NextResponse.json({ success: true, qrCode: data?.code || null, pairingCode: data?.pairingCode || null });
        }
      }

      case "logout": {
        const data = await evolution.logout(instanceName);
        return NextResponse.json({ success: true, data });
      }

      case "delete": {
        try { await evolution.logout(instanceName); } catch { /* ignore */ }
        const data = await evolution.deleteInstance(instanceName);
        return NextResponse.json({ success: true, data });
      }

      case "status": {
        const status = await evolution.getStatus(instanceName);
        return NextResponse.json({ success: true, state: status.state, data: status.data });
      }

      default:
        return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
