import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

type RawEndpoint = { id: string; label: string; base_url: string; api_key: string | null };

/**
 * Sanitiza a lista de conexões vinda da UI e PRESERVA as chaves secretas: como
 * o GET mascara as chaves (só manda `has_api_key`), quando a UI reenvia uma
 * conexão SEM chave nós mantemos a que já está salva, casando por `id`. Conexões
 * sem base_url são descartadas; ids ausentes/duplicados ganham um id novo.
 */
function sanitizeEndpoints(
  incoming: any[],
  storedById: Map<string, { apiKey: string | null }>
): RawEndpoint[] {
  const out: RawEndpoint[] = [];
  const usedIds = new Set<string>();
  for (let i = 0; i < incoming.length; i++) {
    const e = incoming[i] || {};
    const base_url = String(e.base_url ?? e.baseUrl ?? "").trim();
    if (!base_url) continue; // sem URL não é conexão
    let id = String(e.id ?? "").trim();
    if (!id || usedIds.has(id)) {
      id = (globalThis as any).crypto?.randomUUID?.() || `g_${Date.now()}_${i}`;
    }
    usedIds.add(id);
    const label = String(e.label ?? "").trim() || base_url;
    const typedKey = (
      typeof e.api_key === "string" ? e.api_key : typeof e.apiKey === "string" ? e.apiKey : ""
    ).trim();
    // Chave digitada agora vence; senão preserva a salva; senão null.
    const api_key = typedKey || storedById.get(id)?.apiKey || null;
    out.push({ id, label, base_url, api_key });
  }
  return out;
}

export async function GET() {
  try {
    // Lê em 3 camadas pra retrocompat: (1) com gateway_endpoints; se a coluna
    // não existir, (2) com as colunas single do gateway; se nem essas, (3) só o
    // básico. Assim bancos em qualquer estágio de migração funcionam.
    let data: Record<string, any> | null = null;
    const full = await supabase
      .from("ai_organizer_config")
      .select("enabled, model, provider, execution_hour, last_run, api_key, openrouter_api_key, gateway_base_url, gateway_api_key, gateway_fallback_model, gateway_endpoints")
      .eq("id", 1)
      .maybeSingle();
    if (full.error) {
      const mid = await supabase
        .from("ai_organizer_config")
        .select("enabled, model, provider, execution_hour, last_run, api_key, openrouter_api_key, gateway_base_url, gateway_api_key, gateway_fallback_model")
        .eq("id", 1)
        .maybeSingle();
      if (mid.error) {
        const base = await supabase
          .from("ai_organizer_config")
          .select("enabled, model, provider, execution_hour, last_run, api_key, openrouter_api_key")
          .eq("id", 1)
          .maybeSingle();
        data = (base.data as any) || null;
      } else {
        data = (mid.data as any) || null;
      }
    } else {
      data = (full.data as any) || null;
    }

    // Lista UNIFICADA de conexões (várias contas). Inclui o legado sintetizado
    // quando a lista está vazia. As chaves são secretas → mascara, expondo só
    // `has_api_key` por conexão (a UI mostra •••• e não reenvia a chave).
    const { parseGatewayEndpoints } = await import("@/lib/ai-keys");
    const endpoints = parseGatewayEndpoints(
      data?.gateway_endpoints,
      data?.gateway_base_url || null,
      data?.gateway_api_key || null,
    ).map((e) => ({ id: e.id, label: e.label, base_url: e.baseUrl, has_api_key: !!e.apiKey }));

    return NextResponse.json({
      success: true,
      config: {
        enabled: !!data?.enabled,
        model: data?.model || null,
        provider: data?.provider || "Gemini",
        execution_hour: typeof data?.execution_hour === "number" ? data.execution_hour : 20,
        last_run: data?.last_run || null,
        has_api_key: !!(data?.api_key && String(data.api_key).trim().length > 0),
        has_openrouter_key: !!(data?.openrouter_api_key && String(data.openrouter_api_key).trim().length > 0),
        // Gateway de Assinatura. base_url e fallback NÃO são segredo (URL local +
        // nome de modelo) → devolve o valor pra UI popular o form. A chave do
        // gateway é secreta → só devolve um booleano.
        gateway_base_url: data?.gateway_base_url || null,
        gateway_fallback_model: data?.gateway_fallback_model || null,
        has_gateway_key: !!(data?.gateway_api_key && String(data.gateway_api_key).trim().length > 0),
        // "Configurado" agora = existe ao menos UMA conexão (legada ou na lista).
        gateway_configured: endpoints.length > 0,
        // TODAS as conexões (Gemini + Claude + ChatGPT ao mesmo tempo, etc.).
        gateway_endpoints: endpoints,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;

    const body = await req.json();
    const update: Record<string, any> = { id: 1, updated_at: new Date().toISOString() };

    // Campos sensíveis (modelo/provedor/api_key/enabled global/gateway) — APENAS
    // admin. Cliente comum não pode trocar nada disso, pra evitar inflar custo.
    // Pro gateway usamos `typeof === "string"` (mesmo vazio) como gatilho, pra
    // que tentar LIMPAR (desconectar) também caia na trava de admin.
    const wantsModelChange = (typeof body.model === "string" && body.model.trim())
      || (typeof body.provider === "string" && body.provider.trim())
      || (typeof body.api_key === "string" && body.api_key.trim())
      || (typeof body.openrouter_api_key === "string" && body.openrouter_api_key.trim())
      || (typeof body.gateway_base_url === "string")
      || (typeof body.gateway_api_key === "string")
      || (typeof body.gateway_fallback_model === "string")
      || Array.isArray(body.gateway_endpoints)
      || (typeof body.enabled === "boolean");
    if (wantsModelChange && !ctx.isAdmin) {
      return NextResponse.json(
        { success: false, error: "Apenas admin pode alterar modelo, provedor, API key, gateway ou ligar/desligar global." },
        { status: 403 }
      );
    }

    if (typeof body.enabled === "boolean") update.enabled = body.enabled;
    if (typeof body.model === "string" && body.model.trim()) update.model = body.model.trim();
    if (typeof body.provider === "string" && body.provider.trim()) update.provider = body.provider.trim();
    if (typeof body.api_key === "string" && body.api_key.trim()) update.api_key = body.api_key.trim();
    if (typeof body.openrouter_api_key === "string" && body.openrouter_api_key.trim()) update.openrouter_api_key = body.openrouter_api_key.trim();
    // Gateway de Assinatura — diferente das chaves acima, aceita string vazia
    // pra LIMPAR (desconectar). Vazio → null no banco.
    let gatewayChanged = false;
    if (typeof body.gateway_base_url === "string") {
      update.gateway_base_url = body.gateway_base_url.trim() || null;
      gatewayChanged = true;
    }
    if (typeof body.gateway_api_key === "string") {
      update.gateway_api_key = body.gateway_api_key.trim() || null;
      gatewayChanged = true;
    }
    if (typeof body.gateway_fallback_model === "string") {
      update.gateway_fallback_model = body.gateway_fallback_model.trim() || null;
      gatewayChanged = true;
    }
    // Lista de conexões (várias contas). Vira a FONTE DA VERDADE: ao recebê-la,
    // mesclamos preservando chaves mascaradas e zeramos as colunas single legadas
    // (a menos que o caller também as tenha mandado explicitamente), pra que a
    // lista represente tudo e "remover todas" realmente desconecte.
    if (Array.isArray(body.gateway_endpoints)) {
      gatewayChanged = true;
      const storedById = new Map<string, { apiKey: string | null }>();
      try {
        const cur = await supabase
          .from("ai_organizer_config")
          .select("gateway_endpoints, gateway_base_url, gateway_api_key")
          .eq("id", 1)
          .maybeSingle();
        if (!cur.error) {
          const { parseGatewayEndpoints } = await import("@/lib/ai-keys");
          for (const e of parseGatewayEndpoints(
            (cur.data as any)?.gateway_endpoints,
            (cur.data as any)?.gateway_base_url || null,
            (cur.data as any)?.gateway_api_key || null,
          )) {
            storedById.set(e.id, { apiKey: e.apiKey });
          }
        }
      } catch { /* sem conexões salvas — chaves novas terão que ser digitadas */ }
      update.gateway_endpoints = sanitizeEndpoints(body.gateway_endpoints, storedById);
      if (typeof body.gateway_base_url !== "string") update.gateway_base_url = null;
      if (typeof body.gateway_api_key !== "string") update.gateway_api_key = null;
    }
    if (body.execution_hour !== undefined) {
      const h = Number(body.execution_hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        return NextResponse.json(
          { success: false, error: "execution_hour deve ser inteiro entre 0 e 23." },
          { status: 400 }
        );
      }
      update.execution_hour = h;
    }

    let warning: string | undefined;
    const { error } = await supabase
      .from("ai_organizer_config")
      .upsert(update, { onConflict: "id" });
    if (error) {
      // Banco ainda sem as colunas do gateway? Salva o resto e avisa pra rodar
      // a atualização de schema — não quebra o save dos demais campos.
      if (gatewayChanged && /gateway_(base_url|api_key|fallback_model|endpoints)|column .* does not exist/i.test(error.message || "")) {
        // Remove TODAS as colunas de gateway (inclui os nulls legados que só
        // setamos por causa da lista) — assim não apagamos o gateway legado de um
        // banco que ainda não tem gateway_endpoints. Salva o resto e avisa.
        const { gateway_base_url, gateway_api_key, gateway_fallback_model, gateway_endpoints, ...rest } = update;
        const retry = await supabase.from("ai_organizer_config").upsert(rest, { onConflict: "id" });
        if (retry.error) throw retry.error;
        warning = "Config salva, mas as colunas do Gateway/Assinatura ainda não existem no banco. Rode a atualização de schema (Configurações → Banco de dados) e salve de novo.";
        gatewayChanged = false; // não invalida cache de gateway: nada persistiu
      } else {
        throw error;
      }
    }

    // Invalida cache (60s) pra próxima leitura pegar o novo valor sem esperar.
    const { invalidateOrganizerConfigCache } = await import("@/lib/organizer-config-cache");
    invalidateOrganizerConfigCache();
    // Se a chave OpenRouter mudou, invalida o cache de chaves e o de modelos
    // pra a lista do seletor recarregar com a nova chave imediatamente.
    if (typeof body.openrouter_api_key === "string" && body.openrouter_api_key.trim()) {
      try {
        const { invalidateAiKeysCache } = await import("@/lib/ai-keys");
        invalidateAiKeysCache();
        const { invalidateOpenRouterModelsCache } = await import("@/lib/openrouter-model-discovery");
        invalidateOpenRouterModelsCache();
      } catch { /* não-fatal */ }
    }
    if (typeof body.api_key === "string" && body.api_key.trim()) {
      try {
        const { invalidateAiKeysCache } = await import("@/lib/ai-keys");
        invalidateAiKeysCache();
      } catch { /* não-fatal */ }
    }
    // Gateway mudou → recarrega chaves (ai-keys) e a lista de modelos do gateway.
    if (gatewayChanged) {
      try {
        const { invalidateAiKeysCache } = await import("@/lib/ai-keys");
        invalidateAiKeysCache();
        const { invalidateGatewayModelsCache } = await import("@/lib/gateway-model-discovery");
        invalidateGatewayModelsCache();
      } catch { /* não-fatal */ }
    }

    return NextResponse.json({ success: true, ...(warning ? { warning } : {}) });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
