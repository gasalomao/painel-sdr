import { NextRequest, NextResponse } from "next/server";
import { evolution } from "@/lib/evolution";
import { evolutionGo } from "@/lib/providers/evolution-go";
import { requireClientId } from "@/lib/tenant";
import { getTenantSaasLimits } from "@/lib/saas-limits";
import { supabaseAdmin } from "@/lib/supabase_admin";
import * as channel from "@/lib/channel";
import { reconcileWarmupIdentityByPhone } from "@/lib/warmup/warmup-phone-memory";

export const dynamic = 'force-dynamic';

/**
 * Resolve qual provedor usar pra esta instância. Lê channel_connections.
 * - "evolution_go" → usa Evolution GO (Go/whatsmeow)
 * - outros        → usa Evolution API legada (default)
 */
async function resolveProvider(instanceName: string, clientId: string) {
  const { data } = await supabaseAdmin!
    .from("channel_connections")
    .select("provider")
    .eq("instance_name", instanceName)
    .eq("client_id", clientId)
    .maybeSingle();
  return (data?.provider === "evolution_go") ? "evolution_go" : "evolution";
}

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
  const session = await requireClientId(req);
  if (!session.ok) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ success: false, error: "DB indisponível" }, { status: 500 });
  }

  try {
    // 1) Pega as instâncias que pertencem a este cliente no banco local
    const { data: myConns } = await supabaseAdmin
      .from("channel_connections")
      .select("instance_name, provider")
      .eq("client_id", session.clientId);
    
    const myInstanceNames = new Set((myConns || []).map(c => c.instance_name));

    const listAll = req.nextUrl.searchParams.get("instances");
    if (listAll === "true") {
      const rawInstances = await evolution.fetchInstances();
      const normalized = normalizeFetchInstances(rawInstances || []);
      // Filtra apenas as que pertencem ao cliente
      const filtered = normalized.filter((i: { instanceName: string }) => myInstanceNames.has(i.instanceName));

      // PERSISTE o owner (telefone real) em channel_connections.provider_config.
      // Crítico pra agrupamento por número FUNCIONAR mesmo quando Evolution
      // estiver offline depois. Sem isso, dropdown enche de instâncias órfãs.
      // Best-effort, não bloqueia a resposta.
      Promise.all(
        filtered
          .filter((i: any) => i.owner)
          .map(async (i: any) => {
            const phone = String(i.owner).replace(/\D/g, "");
            if (!phone) return;
            // Lê config atual, mescla owner_phone, faz upsert.
            const { data: cur } = await supabaseAdmin
              .from("channel_connections")
              .select("provider_config")
              .eq("instance_name", i.instanceName)
              .eq("client_id", session.clientId)
              .maybeSingle();
            const merged = { ...(cur?.provider_config || {}), owner_phone: phone, owner_jid: i.owner };
            await supabaseAdmin
              .from("channel_connections")
              .update({ provider_config: merged })
              .eq("instance_name", i.instanceName)
              .eq("client_id", session.clientId);

            // Migra qualquer histórico órfão associado a esse telefone de volta para esta instância ativa.
            // Isso garante que reconectar o mesmo número (mesmo com nome de instância diferente) resgate o histórico.
            const phoneInstanceName = `phone:${phone}`;
            await Promise.all([
              supabaseAdmin
                .from("chats_dashboard")
                .update({ instance_name: i.instanceName })
                .eq("instance_name", phoneInstanceName)
                .eq("client_id", session.clientId),
              supabaseAdmin
                .from("sessions")
                .update({ instance_name: i.instanceName })
                .eq("instance_name", phoneInstanceName)
                .eq("client_id", session.clientId),
              supabaseAdmin
                .from("messages")
                .update({ instance_name: i.instanceName })
                .eq("instance_name", phoneInstanceName)
                .eq("client_id", session.clientId),
              reconcileWarmupIdentityByPhone({
                clientId: session.clientId,
                instanceName: i.instanceName,
                phone,
              }).catch(() => {}),
            ]);
          })
      ).catch(() => {});

      return NextResponse.json({ success: true, instances: filtered });
    }

    const instanceName = req.nextUrl.searchParams.get("instance");
    if (!instanceName) {
      // Se TODAS as instâncias são evolution_go, busca do GO. Se mistas, busca de ambos.
      const allConnsData = (myConns || []) as any[];
      const hasGoOnly = allConnsData.length > 0 && allConnsData.every((c: any) => c.provider === "evolution_go");
      if (hasGoOnly) {
        // Busca instâncias do Evolution GO.
        const { data: goCfg } = await supabaseAdmin.from("app_settings").select("key,value").in("key", ["evolution_go_url","evolution_go_key"]);
        const cfgMap: Record<string,string> = {};
        (goCfg||[]).forEach((r:any) => cfgMap[r.key] = r.value);
        const goUrl = cfgMap.evolution_go_url?.replace(/\/+$/,"") || "";
        const goKey = cfgMap.evolution_go_key || "";
        if (goUrl) {
          const goRes = await fetch(`${goUrl}/instance/all`, {
            headers: { "Content-Type": "application/json", apikey: goKey, token: goKey },
            signal: AbortSignal.timeout(10000),
          });
          const goJson = await goRes.json().catch(() => ({}));
          const goList = (goJson?.data || []).map((i:any) => ({
            instanceName: i.name || "",
            status: i.connected ? "open" : "close",
            owner: i.jid || null,
            profileName: i.name || "",
          })).filter((i:any) => i.instanceName && myInstanceNames.has(i.instanceName));
          return NextResponse.json({ success: true, instances: goList });
        }
      }
      // Fallback: busca do Evolution API legado.
      const rawInstances = await evolution.fetchInstances();
      const normalized = normalizeFetchInstances(rawInstances || []);
      const filtered = normalized.filter((i: { instanceName: string }) => myInstanceNames.has(i.instanceName));
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

    const statusData = await channel.getStatus(instanceName);

    // Fallback de auto-vínculo: se a instância está "open" mas o webhook
    // connection.update foi perdido (ex: webhook ainda não estava registrado
    // quando o QR foi escaneado), garante aqui que ela tenha um agente de IA
    // vinculado. Idempotente — não mexe se já estiver ok. Não bloqueia a resposta.
    if (statusData.state === "open") {
      import("@/lib/auto-link-agent")
        .then(({ autoLinkAgentOnConnect }) => autoLinkAgentOnConnect(instanceName))
        .catch(() => {});

      const statusOwner =
        (statusData.data as { owner?: string; instance?: { owner?: string } } | undefined)?.owner ||
        (statusData.data as { owner?: string; instance?: { owner?: string } } | undefined)?.instance?.owner ||
        (ch?.provider_config as { owner_phone?: string } | null)?.owner_phone ||
        null;
      const phone = statusOwner ? String(statusOwner).replace(/\D/g, "") : "";
      if (phone) {
        reconcileWarmupIdentityByPhone({
          clientId: session.clientId,
          instanceName,
          phone,
        }).catch(() => {});
      }
    }

    return NextResponse.json({ success: true, state: statusData.state, data: statusData.data });
  } catch (err) {
    console.error("[WhatsApp/GET] Erro:", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Erro ao consultar instâncias WhatsApp" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await requireClientId(req);
  if (!session.ok) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ success: false, error: "DB indisponível" }, { status: 500 });
  }

  try {
    const body = await req.json();
    const action = typeof body?.action === "string" ? body.action.trim() : "";
    const instanceName = typeof body?.instanceName === "string" ? body.instanceName.trim() : "";

    if (!instanceName) {
      return NextResponse.json({ success: false, error: "instanceName obrigatório" }, { status: 400 });
    }

    // 1) Verifica propriedade ANTES de chamar qualquer provedor (incluindo "connect")
    const { data: existingConn } = await supabaseAdmin
      .from("channel_connections")
      .select("id, client_id, provider")
      .eq("instance_name", instanceName)
      .maybeSingle();

    if (action !== "connect") {
      if (!existingConn || existingConn.client_id !== session.clientId) {
        return NextResponse.json({ success: false, error: "Instância não pertence a esta conta" }, { status: 403 });
      }
    } else if (existingConn && existingConn.client_id !== session.clientId) {
      return NextResponse.json({ success: false, error: "Este nome de instância já está em uso por outra conta." }, { status: 403 });
    }

    const providerType = existingConn?.provider === "evolution_go"
      ? "evolution_go"
      : await resolveProvider(instanceName, session.clientId);

    switch (action) {
      case "connect": {
        if (!existingConn) {
          if (!session.isAdmin) {
            const limits = await getTenantSaasLimits(session.clientId, false);
            if (limits.max_instances !== null) {
              const { count } = await supabaseAdmin
                .from("channel_connections")
                .select("instance_name", { count: "exact", head: true })
                .eq("client_id", session.clientId);
              if ((count ?? 0) >= limits.max_instances) {
                return NextResponse.json(
                  {
                    success: false,
                    error: `Seu plano permite no máximo ${limits.max_instances} conexão(ões) de WhatsApp. Fale com o administrador para ampliar o limite.`,
                  },
                  { status: 403 }
                );
              }
            }
          }
          await supabaseAdmin.from("channel_connections").insert({
            instance_name: instanceName,
            client_id: session.clientId,
            provider: "evolution",
            status: "connecting",
          });
        }

        // Já conectado? Não regera QR — devolve o estado pra UI mostrar "online".
        const pre = await channel.getStatus(instanceName);
        if (pre.state === "open") {
          const preOwner =
            (pre.data as { owner?: string; instance?: { owner?: string } } | undefined)?.owner ||
            (pre.data as { owner?: string; instance?: { owner?: string } } | undefined)?.instance?.owner ||
            null;
          const phone = preOwner ? String(preOwner).replace(/\D/g, "") : "";
          if (phone) {
            reconcileWarmupIdentityByPhone({
              clientId: session.clientId,
              instanceName,
              phone,
            }).catch(() => {});
          }
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
        } catch {}

        console.log(`[WhatsApp/Connect] Solicitando conexão para: ${instanceName} (provider: ${providerType})`);

        let qrCode: string | null = null;
        let pairingCode: string | null = null;

        if (providerType === "evolution_go") {
          // Evolution GO: cria instância + conecta + busca QR.
          try {
            const { supabaseAdmin: sa } = await import("@/lib/supabase_admin");
            const { data: goCfg } = await sa.from("app_settings").select("key,value").in("key", ["evolution_go_url","evolution_go_key"]);
            const cfgMap: Record<string,string> = {};
            (goCfg||[]).forEach((r:any) => cfgMap[r.key] = r.value);
            const goUrl = cfgMap.evolution_go_url?.replace(/\/+$/,"") || process.env.EVOLUTION_GO_URL || "";
            const goKey = cfgMap.evolution_go_key || process.env.EVOLUTION_GO_KEY || "";
            if (!goUrl) throw new Error("Evolution GO não configurado");

            const goHeaders: Record<string,string> = { "Content-Type": "application/json", apikey: goKey, token: goKey };

            // Cria instância (se não existir).
            try {
              await fetch(`${goUrl}/instance/create`, {
                method: "POST", headers: goHeaders,
                body: JSON.stringify({ name: instanceName, token: goKey }),
                signal: AbortSignal.timeout(15000),
              });
            } catch {}

            // Conecta.
            await fetch(`${goUrl}/instance/connect`, {
              method: "POST", headers: goHeaders,
              body: JSON.stringify({}),
              signal: AbortSignal.timeout(30000),
            });

            // Busca QR (até 5 tentativas com 2s de intervalo).
            for (let i = 0; i < 5; i++) {
              await new Promise(r => setTimeout(r, 2000));
              const qrRes = await fetch(`${goUrl}/instance/qr`, { headers: goHeaders, signal: AbortSignal.timeout(10000) });
              const qrJson = await qrRes.json().catch(() => ({}));
              const qrData = qrJson?.data || {};
              const qr = qrData.qrcode || qrData.qr;
              if (qr && qr !== "") {
                qrCode = qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`;
                break;
              }
            }

            // Advanced settings.
            try {
              const allRes = await fetch(`${goUrl}/instance/all`, {
                headers: goHeaders,
                signal: AbortSignal.timeout(10_000),
              });
              const allJson = await allRes.json().catch(() => ({}));
              const list = allJson?.data || [];
              const match = list.find((x:any) => x.name === instanceName);
              if (match?.id) {
                await fetch(`${goUrl}/instance/${match.id}/advanced-settings`, {
                  method: "PUT", headers: goHeaders,
                  body: JSON.stringify({ alwaysOnline: true, readMessages: true, rejectCall: true, ignoreGroups: true, ignoreStatus: true }),
                  signal: AbortSignal.timeout(10_000),
                });
              }
            } catch {}
          } catch (e: any) {
            console.warn("[WhatsApp/Connect] Evolution GO falhou, tentando fallback Evolution API v2:", e.message);
          }
        }

        // Fallback / default: Evolution API v2
        if (!qrCode && !pairingCode) {
          try {
            const res = await evolution.ensureInstanceConfigured(instanceName, publicUrl);
            qrCode = res.qrcode?.base64 || res.base64 || res.qrcode?.code || res.code || null;
            pairingCode = res.qrcode?.pairingCode || res.pairingCode || null;
          } catch (err: any) {
            console.warn("[WhatsApp/Connect] Evolution API v2 falhou:", err.message);
          }
        }

        return NextResponse.json({
          success: true,
          qrCode,
          pairingCode,
        });
      }

      case "logout": {
        if (providerType === "evolution_go") {
          // GO: usa a API de disconnect.
          const { supabaseAdmin: sa } = await import("@/lib/supabase_admin");
          const { data: goCfg } = await sa.from("app_settings").select("key,value").in("key", ["evolution_go_url","evolution_go_key"]);
          const cfgMap: Record<string,string> = {};
          (goCfg||[]).forEach((r:any) => cfgMap[r.key] = r.value);
          const goUrl = cfgMap.evolution_go_url?.replace(/\/+$/,"") || process.env.EVOLUTION_GO_URL || "";
          const goKey = cfgMap.evolution_go_key || process.env.EVOLUTION_GO_KEY || "";
          if (goUrl) {
            await fetch(`${goUrl}/instance/disconnect`, {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: goKey, token: goKey },
              signal: AbortSignal.timeout(10_000),
            }).catch(() => {});
          }
        }
        await evolution.logout(instanceName).catch(() => {});
        return NextResponse.json({ success: true });
      }

      case "delete": {
        if (providerType === "evolution_go") {
          const { supabaseAdmin: sa } = await import("@/lib/supabase_admin");
          const { data: goCfg } = await sa.from("app_settings").select("key,value").in("key", ["evolution_go_url","evolution_go_key"]);
          const cfgMap: Record<string,string> = {};
          (goCfg||[]).forEach((r:any) => cfgMap[r.key] = r.value);
          const goUrl = cfgMap.evolution_go_url?.replace(/\/+$/,"") || process.env.EVOLUTION_GO_URL || "";
          const goKey = cfgMap.evolution_go_key || process.env.EVOLUTION_GO_KEY || "";
          if (goUrl) {
            const allRes = await fetch(`${goUrl}/instance/all`, {
              headers: { "Content-Type": "application/json", apikey: goKey, token: goKey },
              signal: AbortSignal.timeout(10_000),
            });
            const allJson = await allRes.json().catch(() => ({}));
            const list = allJson?.data || [];
            const match = list.find((x:any) => x.name === instanceName);
            if (match?.id) {
              await fetch(`${goUrl}/instance/delete/${match.id}`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json", apikey: goKey, token: goKey },
                signal: AbortSignal.timeout(10_000),
              }).catch(() => {});
            }
          }
        }
        try { await evolution.logout(instanceName); } catch { /* ignore */ }
        await evolution.deleteInstance(instanceName).catch(() => {});
        return NextResponse.json({ success: true });
      }

      case "status": {
        const status = await channel.getStatus(instanceName);
        return NextResponse.json({ success: true, state: status.state, data: status.data });
      }

      default:
        return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
    }
  } catch (err) {
    console.error("[WhatsApp/POST] Erro:", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Erro interno na operação WhatsApp" }, { status: 500 });
  }
}
