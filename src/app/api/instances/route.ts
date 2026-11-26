/**
 * /api/instances  GET | POST | PATCH
 *
 * BFF multi-tenant para conexões WhatsApp (channel_connections):
 * - GET: lista instâncias (nunca retorna provider_config sensível como webhook_secret/tokens).
 *   Parâmetros opcionais:
 *     - scope=tenant     → força filtro pelo client_id atual (mesmo quando isAdmin)
 *     - include_agents=1 → inclui { agents: [{ id, name }] } do tenant
 *     - rebind=1         → executa auto-rebind de sessões legadas `phone:<digitos>` no servidor
 * - POST: cria nova instância em channel_connections para o tenant atual (cria agente padrão se 0)
 * - PATCH: atualiza status ("open"|"close") ou vínculo agent_id (validando ownership e invalidando cache)
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { assertTenantCanCreateAgent, assertTenantCanCreateInstance } from "@/lib/saas-limits";
import { invalidateAgentConfigCache } from "@/lib/agent-config-cache";
import {
  buildSafeProxySummary,
  ensureProxyForInstance,
  retireInstanceProxyAsUsed,
} from "@/lib/proxy-pool";

export const dynamic = "force-dynamic";

type ConnectionRow = {
  id?: string;
  instance_name: string;
  client_id?: string | null;
  provider?: string | null;
  status?: string | null;
  agent_id?: number | null;
  created_at?: string | null;
  provider_config?: Record<string, unknown> | null;
};

function sanitizeConnection(row: ConnectionRow) {
  const cfg = row.provider_config && typeof row.provider_config === "object" ? row.provider_config : null;
  const phoneNumberId = cfg && typeof cfg.phone_number_id === "string" ? cfg.phone_number_id : null;
  return {
    ...(row.id ? { id: row.id } : {}),
    instance_name: row.instance_name,
    client_id: row.client_id ?? null,
    provider: row.provider ?? null,
    status: row.status ?? null,
    agent_id: row.agent_id ?? null,
    created_at: row.created_at ?? null,
    proxy_summary: buildSafeProxySummary(cfg),
    ...(phoneNumberId ? { phone_number_id: phoneNumberId } : {}),
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const sp = req.nextUrl.searchParams;
  const forceTenant = sp.get("scope") === "tenant";
  const includeAgents = sp.get("include_agents") === "1";
  const performRebind = sp.get("rebind") === "1";

  let q = supabaseAdmin
    .from("channel_connections")
    .select("id, instance_name, client_id, provider, status, agent_id, created_at, provider_config")
    .order("created_at", { ascending: true });

  if (forceTenant || !auth.isAdmin) {
    q = q.eq("client_id", auth.clientId);
  }

  const agentsPromise = includeAgents
    ? supabaseAdmin
        .from("agent_settings")
        .select("id, name")
        .eq("client_id", auth.clientId)
        .order("id", { ascending: true })
    : null;

  const [{ data, error }, agentsRes] = await Promise.all([q, agentsPromise]);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const rows = (data || []) as ConnectionRow[];

  if (performRebind && rows.length > 0) {
    await Promise.all(
      rows.map(async (inst) => {
        const cfg = inst.provider_config && typeof inst.provider_config === "object" ? inst.provider_config : null;
        const rawPhone =
          (cfg && typeof cfg.owner_phone === "string" ? cfg.owner_phone : null) || inst.instance_name;
        const cleanPhone = rawPhone ? String(rawPhone).replace(/\D/g, "") : "";
        if (cleanPhone.length >= 8) {
          try {
            await supabaseAdmin!
              .from("sessions")
              .update({ instance_name: inst.instance_name })
              .eq("client_id", auth.clientId)
              .eq("instance_name", `phone:${cleanPhone}`);
          } catch {
            // Não-fatal — rebind de sessão legada é best-effort
          }
        }
      }),
    );
  }

  return NextResponse.json({
    ok: true,
    instances: rows.map(sanitizeConnection),
    ...(includeAgents ? { agents: agentsRes?.data || [] } : {}),
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const rawName = typeof body?.raw_name === "string" ? body.raw_name.trim() : "";
  const explicitInstance = typeof body?.instance_name === "string" ? body.instance_name.trim() : "";
  const slug = rawName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .toLowerCase();

  const instanceName = explicitInstance || (slug ? `${auth.clientId.substring(0, 5)}_${slug}` : "");
  if (!instanceName || instanceName.length < 3) {
    return NextResponse.json({ ok: false, error: "Nome de instância inválido" }, { status: 400 });
  }

  const { data: existing } = await supabaseAdmin
    .from("channel_connections")
    .select("id")
    .eq("instance_name", instanceName)
    .eq("client_id", auth.clientId)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ ok: false, error: "Você já tem uma instância com esse nome!" }, { status: 409 });
  }

  const instDenied = await assertTenantCanCreateInstance(auth.clientId, auth.isAdmin);
  if (instDenied) return instDenied;

  const { data: agentsList } = await supabaseAdmin
    .from("agent_settings")
    .select("id")
    .eq("client_id", auth.clientId)
    .order("id", { ascending: true })
    .limit(1);

  let targetAgentId: number | null =
    agentsList && agentsList.length > 0 ? Number(agentsList[0].id) : null;

  if (!targetAgentId) {
    const agDenied = await assertTenantCanCreateAgent(auth.clientId, auth.isAdmin);
    if (agDenied) return agDenied;

    const { data: newAg, error: agErr } = await supabaseAdmin
      .from("agent_settings")
      .insert({
        client_id: auth.clientId,
        name: "Agente Principal",
        main_prompt:
          "Você é o assistente virtual oficial da empresa. Seu objetivo é qualificar leads e agendar reuniões.",
        is_active: true,
      })
      .select("id")
      .single();
    if (!agErr && newAg) {
      targetAgentId = Number(newAg.id);
    }
  }

  const autoProxyRequested = body?.auto_proxy === true;
  const { data: created, error: insErr } = await supabaseAdmin
    .from("channel_connections")
    .insert({
      instance_name: instanceName,
      agent_id: targetAgentId,
      client_id: auth.clientId,
      ...(autoProxyRequested ? { provider_config: { auto_proxy: true } } : {}),
    })
    .select("id, instance_name, client_id, provider, status, agent_id, created_at, provider_config")
    .single();

  if (insErr) {
    return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 });
  }

  if (targetAgentId) invalidateAgentConfigCache(targetAgentId);

  return NextResponse.json({
    ok: true,
    instance: created ? sanitizeConnection(created as ConnectionRow) : { instance_name: instanceName },
  });
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const instanceName = typeof body?.instance_name === "string" ? body.instance_name.trim() : "";
  if (!instanceName) {
    return NextResponse.json({ ok: false, error: "instance_name obrigatório" }, { status: 400 });
  }

  const { data: current, error: curErr } = await supabaseAdmin
    .from("channel_connections")
    .select("id, client_id, agent_id, status, provider, provider_config")
    .eq("instance_name", instanceName)
    .eq("client_id", auth.clientId)
    .maybeSingle();

  if (curErr) {
    return NextResponse.json({ ok: false, error: curErr.message }, { status: 500 });
  }
  if (!current) {
    return NextResponse.json({ ok: false, error: "Instância não encontrada neste cliente" }, { status: 404 });
  }

  const patch: Record<string, unknown> = {};
  const hasAutoProxyPatch = typeof body?.auto_proxy === "boolean";
  const nextAutoProxy = hasAutoProxyPatch ? Boolean(body?.auto_proxy) : undefined;

  if (typeof body?.status === "string" && (body.status === "open" || body.status === "close")) {
    patch.status = body.status;
  }

  if (body?.agent_id !== undefined) {
    const nextAgentId = Number(body.agent_id);
    if (!Number.isInteger(nextAgentId) || nextAgentId <= 0) {
      return NextResponse.json({ ok: false, error: "agent_id inválido" }, { status: 400 });
    }
    const { data: ownedAgent } = await supabaseAdmin
      .from("agent_settings")
      .select("id")
      .eq("id", nextAgentId)
      .eq("client_id", auth.clientId)
      .maybeSingle();
    if (!ownedAgent) {
      return NextResponse.json({ ok: false, error: "Agente não pertence a este cliente" }, { status: 403 });
    }
    patch.agent_id = nextAgentId;
  }

  if (hasAutoProxyPatch) {
    const curCfg =
      (current as { provider_config?: Record<string, unknown> | null }).provider_config || {};
    patch.provider_config = {
      ...curCfg,
      auto_proxy: nextAutoProxy,
      ...(!nextAutoProxy
        ? { proxy_mode: "direct", proxy_pending_rotation: false, proxy_pool_id: null }
        : {}),
    };
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "Nenhum campo válido para atualizar" }, { status: 400 });
  }

  const { error: updErr } = await supabaseAdmin
    .from("channel_connections")
    .update(patch)
    .eq("instance_name", instanceName)
    .eq("client_id", auth.clientId);

  if (updErr) {
    return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });
  }

  if (hasAutoProxyPatch) {
    const prov = typeof (current as { provider?: string }).provider === "string"
      ? (current as { provider?: string }).provider
      : undefined;
    if (nextAutoProxy) {
      await ensureProxyForInstance({
        instanceName,
        clientId: auth.clientId,
        reason: "manual_auto",
        forWarmup: false,
        providerHint: prov,
      }).catch(() => null);
    } else {
      await retireInstanceProxyAsUsed(instanceName, auth.clientId, prov, { forceCleanup: true }).catch(() => {});
    }
  }

  if (patch.agent_id !== undefined) {
    if (current.agent_id) invalidateAgentConfigCache(Number(current.agent_id));
    invalidateAgentConfigCache(Number(patch.agent_id));
  }

  const { provider_config: _hiddenCfg, ...publicPatch } = patch;
  void _hiddenCfg;
  return NextResponse.json({
    ok: true,
    instance_name: instanceName,
    ...publicPatch,
    ...(hasAutoProxyPatch ? { auto_proxy: nextAutoProxy } : {}),
  });
}
