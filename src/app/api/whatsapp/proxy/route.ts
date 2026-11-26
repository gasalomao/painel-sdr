import { NextRequest, NextResponse } from "next/server";
import { evolution } from "@/lib/evolution";
import { setEvolutionGoProxy, removeEvolutionGoProxy } from "@/lib/providers/evolution-go";
import { blacklistInstanceProxy } from "@/lib/proxy-pool";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

async function requireAdmin(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!ctx.isAdmin || ctx.impersonating) {
    return NextResponse.json({ success: false, error: "Apenas admin pode configurar proxy" }, { status: 403 });
  }
  return null;
}

async function resolveInstanceConn(instanceName: string): Promise<{
  provider: string;
  clientId: string | null;
  providerConfig: Record<string, unknown>;
} | null> {
  if (!supabaseAdmin || typeof supabaseAdmin.from !== "function") return null;
  try {
    const { data } = await supabaseAdmin
      .from("channel_connections")
      .select("client_id, provider, provider_config")
      .eq("instance_name", instanceName)
      .maybeSingle();
    if (!data) return null;
    return {
      provider: String((data as { provider?: string }).provider || "evolution"),
      clientId: (data as { client_id?: string | null }).client_id || null,
      providerConfig: ((data as { provider_config?: Record<string, unknown> }).provider_config || {}) as Record<
        string,
        unknown
      >,
    };
  } catch {
    return null;
  }
}

/**
 * Proxy por instância na Evolution API v2 e Evolution GO.
 *
 *  GET    /api/whatsapp/proxy?instance=sdr        → lê o proxy atual
 *  POST   /api/whatsapp/proxy                     → aplica/atualiza o proxy manual
 *    body: { instanceName, host, port, protocol, username?, password? }
 *  DELETE /api/whatsapp/proxy?instance=sdr        → remove o proxy
 */

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req); if (denied) return denied;
  try {
    const instance = req.nextUrl.searchParams.get("instance");
    if (!instance) return NextResponse.json({ success: false, error: "instance é obrigatória" }, { status: 400 });

    const conn = await resolveInstanceConn(instance);
    if (conn?.provider === "evolution_go" && supabaseAdmin) {
      const { data: poolRow } = await supabaseAdmin
        .from("proxy_pool")
        .select("host, port, protocol, username")
        .eq("assigned_instance", instance)
        .eq("status", "assigned")
        .maybeSingle();
      if (poolRow) {
        return NextResponse.json({
          success: true,
          proxy: {
            enabled: true,
            host: poolRow.host,
            port: String(poolRow.port),
            protocol: poolRow.protocol,
            username: poolRow.username || "",
          },
        });
      }
      return NextResponse.json({ success: true, proxy: { enabled: false } });
    }

    const proxy = await evolution.findProxy(instance);
    return NextResponse.json({ success: true, proxy });
  } catch (err: unknown) {
    // Se a Evolution retornar 404/não configurado, é "sem proxy" — normal.
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|404|n[aã]o configurado/i.test(msg)) {
      return NextResponse.json({ success: true, proxy: { enabled: false } });
    }
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req); if (denied) return denied;
  try {
    const { instanceName, host, port, protocol, username, password } = await req.json();
    if (!instanceName) return NextResponse.json({ success: false, error: "instanceName é obrigatório" }, { status: 400 });
    if (!host || !port) return NextResponse.json({ success: false, error: "host e port são obrigatórios" }, { status: 400 });

    // SSRF guard: recusa hosts privados/localhost em produção.
    if (process.env.NODE_ENV === "production") {
      const { isPrivateOrLocalHost } = await import("@/lib/url-guard");
      if (isPrivateOrLocalHost(String(host))) {
        return NextResponse.json({ success: false, error: "Host privado/localhost não permitido em produção." }, { status: 400 });
      }
    }

    const validProtocols = ["http", "https", "socks4", "socks5"] as const;
    const proto = validProtocols.includes(protocol) ? (protocol as (typeof validProtocols)[number]) : "http";

    // Se a instância usava proxy do pool automático, aposenta esse IP antigo na Lista Negra (`used`).
    await blacklistInstanceProxy(instanceName, "used", "Substituído por proxy manual").catch(() => null);

    const conn = await resolveInstanceConn(instanceName);
    const payload = {
      enabled: true,
      host: String(host).trim(),
      port: String(port).trim(),
      protocol: proto,
      username: username ? String(username) : "",
      password: password ? String(password) : "",
    };

    const result =
      conn?.provider === "evolution_go"
        ? await setEvolutionGoProxy(instanceName, payload)
        : await evolution.setProxy(instanceName, payload);

    if (conn && supabaseAdmin) {
      await supabaseAdmin
        .from("channel_connections")
        .update({
          provider_config: {
            ...conn.providerConfig,
            auto_proxy: false,
            proxy_mode: "manual",
            proxy_pending_rotation: false,
            proxy_pool_id: null,
          },
        })
        .eq("instance_name", instanceName);
    }

    return NextResponse.json({ success: true, result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin(req); if (denied) return denied;
  try {
    const instance = req.nextUrl.searchParams.get("instance");
    if (!instance) return NextResponse.json({ success: false, error: "instance é obrigatória" }, { status: 400 });

    await blacklistInstanceProxy(instance, "used", "Proxy removido manualmente pelo Admin").catch(() => null);

    const conn = await resolveInstanceConn(instance);
    const result =
      conn?.provider === "evolution_go"
        ? await removeEvolutionGoProxy(instance)
        : await evolution.removeProxy(instance);

    if (conn && supabaseAdmin) {
      await supabaseAdmin
        .from("channel_connections")
        .update({
          provider_config: {
            ...conn.providerConfig,
            auto_proxy: false,
            proxy_mode: "direct",
            proxy_pending_rotation: false,
            proxy_pool_id: null,
          },
        })
        .eq("instance_name", instance);
    }

    return NextResponse.json({ success: true, result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
