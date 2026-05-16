import { NextRequest, NextResponse } from "next/server";
import { evolution } from "@/lib/evolution";
import { verifySession } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase_admin";

export const dynamic = 'force-dynamic';

// Normaliza resposta de /instance/fetchInstances (v2 retorna array com objeto { instance: {...} })
function normalizeFetchInstances(raw: any) {
  const list = Array.isArray(raw) ? raw : (raw?.instances || []);
  
  return list
    .map((item: any) => {
      const inst = item.instance || item;
      const name = inst.instanceName || inst.name || inst.instance_name;
      if (!name) return null; // Ignora se não tiver nome nenhum

      let status = (inst.status || inst.state || inst.connectionStatus || "unknown").toLowerCase();
      if (status === "connected") status = "open";
      if (status === "disconnected") status = "close";

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
  const session = await verifySession(req);
  if (!session) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }

  try {
    // 1) Pega as instâncias que pertencem a este cliente no banco local
    const { data: myConns } = await supabaseAdmin
      .from("channel_connections")
      .select("instance_name")
      .eq("client_id", session.clientId);
    
    const myInstanceNames = new Set((myConns || []).map(c => c.instance_name));

    const listAll = req.nextUrl.searchParams.get("instances");
    if (listAll === "true") {
      const rawInstances = await evolution.fetchInstances();
      const normalized = normalizeFetchInstances(rawInstances || []);
      // Filtra apenas as que pertencem ao cliente
      const filtered = normalized.filter(i => myInstanceNames.has(i.instanceName));
      return NextResponse.json({ success: true, instances: filtered });
    }

    const instanceName = req.nextUrl.searchParams.get("instance");
    if (!instanceName) {
      const rawInstances = await evolution.fetchInstances();
      const normalized = normalizeFetchInstances(rawInstances || []);
      const filtered = normalized.filter(i => myInstanceNames.has(i.instanceName));
      return NextResponse.json({ success: true, instances: filtered });
    }

    // Verifica se a instância solicitada pertence ao cliente
    if (!myInstanceNames.has(instanceName)) {
      return NextResponse.json({ success: false, error: "Instância não pertence a esta conta" }, { status: 403 });
    }

    // Status individual — Cloud não tem QR/estado; reportamos "open" se token+phone_number_id existem.
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
  const session = await verifySession(req);
  if (!session) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }

  try {
    const { action, instanceName } = await req.json();

    // 1) Verifica se a instância pertence ao cliente (exceto na criação, onde o nome é novo)
    if (action !== "connect") {
       const { data: own } = await supabaseAdmin
         .from("channel_connections")
         .select("id")
         .eq("instance_name", instanceName)
         .eq("client_id", session.clientId)
         .maybeSingle();
       if (!own) {
         return NextResponse.json({ success: false, error: "Instância não pertence a esta conta" }, { status: 403 });
       }
    }

    switch (action) {
      case "connect": {
        // Já conectado? Não regera QR — devolve o estado pra UI mostrar "online".
        const pre = await evolution.getStatus(instanceName).catch(() => ({ state: "not_found" as const, data: null }));
        if (pre.state === "open") {
          return NextResponse.json({ success: true, qrCode: null, pairingCode: null, state: "open", data: pre.data });
        }

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

        // Se for criação, garante que o client_id seja salvo na channel_connections
        const { data: existingConn } = await supabaseAdmin
          .from("channel_connections")
          .select("id, client_id")
          .eq("instance_name", instanceName)
          .maybeSingle();
        
        if (!existingConn) {
          await supabaseAdmin.from("channel_connections").insert({
            instance_name: instanceName,
            client_id: session.clientId,
            status: "connecting"
          });
        } else {
            // Se já existe mas é de outro cliente, erro
            if (existingConn.client_id !== session.clientId) {
              return NextResponse.json({ success: false, error: "Este nome de instância já está em uso por outra conta." }, { status: 400 });
            }
        }

        console.log(`[WhatsApp/Connect] Solicitando conexão para: ${instanceName}`);
        const res = await evolution.ensureInstanceConfigured(instanceName, publicUrl);
        console.log(`[WhatsApp/Connect] Resposta Evolution:`, JSON.stringify(res).substring(0, 500));

        // Tenta extrair o QR de vários lugares possíveis (v1 vs v2 vs variações)
        const qrCode = res.qrcode?.base64 || res.base64 || res.qrcode?.code || res.code || null;
        const pairingCode = res.qrcode?.pairingCode || res.pairingCode || null;

        return NextResponse.json({
          success: true,
          qrCode,
          pairingCode,
          fullData: res
        });
      }

      case "logout": {
        await evolution.logout(instanceName);
        return NextResponse.json({ success: true });
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
