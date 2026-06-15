import { NextRequest, NextResponse } from "next/server";
import { supabase, supabaseAdmin } from "@/lib/supabase";
import { requireClientId } from "@/lib/tenant";
import { listAvailableOpenRouterModels } from "@/lib/openrouter-model-discovery";
import { listAvailableGatewayModels } from "@/lib/gateway-model-discovery";
import { formatModelRef } from "@/lib/ai-provider";

// Lê com service role pra contornar RLS (mesmo motivo que ai-organize).
const adminClient = supabaseAdmin || supabase;

/**
 * Modelo unificado exibido nos seletores. `id` é o valor STORABLE (com prefixo
 * de provedor pro OpenRouter/Gateway; "bare" pro Gemini — retrocompatível).
 * `rawId` é o id puro do provedor (pra exibição). `provider` permite agrupar.
 */
export type UnifiedModel = {
  id: string;          // valor salvo no banco (ex: "gemini-2.5-flash", "openrouter:...", "gateway:gpt-5")
  rawId: string;       // id puro do provedor (ex: "anthropic/claude-3.5-sonnet", "gpt-5")
  name: string;
  description?: string;
  provider: "gemini" | "openrouter" | "gateway";
  supportsTools: boolean;
};

async function listGemini(apiKey: string): Promise<UnifiedModel[]> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { signal: AbortSignal.timeout(12000) }
    );
    const json = await res.json();
    if (!res.ok || !Array.isArray(json?.models)) return [];
    return json.models
      .filter((m: any) =>
        m.name?.includes("gemini") &&
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes("generateContent"))
      .map((m: any) => {
        const rawId = String(m.name).replace("models/", "");
        return {
          id: rawId,                 // Gemini fica "bare" (retrocompatível).
          rawId,
          name: m.displayName || rawId,
          description: m.description,
          provider: "gemini" as const,
          supportsTools: true,       // todos os Gemini generateContent suportam tools.
        };
      });
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    // Lê em 3 camadas pra retrocompat: (1) com gateway_endpoints; se a coluna não
    // existir, (2) com a coluna single legada; se nem essa, (3) só o básico.
    let cfg: Record<string, any> | null = null;
    const full = await adminClient
      .from("ai_organizer_config")
      .select("api_key, openrouter_api_key, gateway_base_url, gateway_api_key, gateway_endpoints")
      .eq("id", 1)
      .maybeSingle();
    if (full.error) {
      const mid = await adminClient
        .from("ai_organizer_config")
        .select("api_key, openrouter_api_key, gateway_base_url")
        .eq("id", 1)
        .maybeSingle();
      if (mid.error) {
        const base = await adminClient
          .from("ai_organizer_config")
          .select("api_key, openrouter_api_key")
          .eq("id", 1)
          .maybeSingle();
        if (base.error) console.warn("[AI-MODELS] Falha ao ler config:", base.error.message);
        cfg = (base.data as any) || null;
      } else {
        cfg = (mid.data as any) || null;
      }
    } else {
      cfg = (full.data as any) || null;
    }

    const geminiKey = cfg?.api_key && String(cfg.api_key).trim() ? String(cfg.api_key).trim() : null;
    const openrouterKey = cfg?.openrouter_api_key && String(cfg.openrouter_api_key).trim()
      ? String(cfg.openrouter_api_key).trim() : null;
    // "Configurado" = existe ao menos UMA conexão (lista nova OU legado single).
    const { parseGatewayEndpoints } = await import("@/lib/ai-keys");
    const gatewayConfigured = parseGatewayEndpoints(
      cfg?.gateway_endpoints,
      cfg?.gateway_base_url || null,
      cfg?.gateway_api_key || null,
    ).length > 0;

    if (!geminiKey && !openrouterKey && !gatewayConfigured) {
      return NextResponse.json({
        success: false,
        error: "Nenhuma fonte de IA configurada. Salve sua chave Gemini/OpenRouter ou conecte o Gateway de Assinatura em Configurações.",
        models: [],
      });
    }

    // Busca em paralelo as três fontes (real-time, sem hardcode).
    const [gemini, openrouter, gateway] = await Promise.all([
      geminiKey ? listGemini(geminiKey) : Promise.resolve([] as UnifiedModel[]),
      openrouterKey
        ? listAvailableOpenRouterModels().then((list) =>
            list.map((m): UnifiedModel => ({
              id: formatModelRef("openrouter", m.id),
              rawId: m.id,
              name: m.name,
              description: m.description,
              provider: "openrouter",
              supportsTools: m.supportsTools,
            }))
          )
        : Promise.resolve([] as UnifiedModel[]),
      gatewayConfigured
        ? listAvailableGatewayModels().then((list) => {
            // Com mais de uma conta conectada, mostra de qual conexão é o modelo.
            const multi = new Set(list.map((m) => m.endpointId)).size > 1;
            return list.map((m): UnifiedModel => ({
              id: formatModelRef("gateway", m.id),
              rawId: m.id,
              name: m.name,
              description: [
                m.ownedBy ? `Conta/assinatura · ${m.ownedBy}` : "Conta/assinatura",
                multi && m.endpointLabel ? m.endpointLabel : null,
              ].filter(Boolean).join(" · "),
              provider: "gateway",
              supportsTools: m.supportsTools,
            }));
          })
        : Promise.resolve([] as UnifiedModel[]),
    ]);

    const models = [...gemini, ...openrouter, ...gateway];
    return NextResponse.json({
      success: true,
      models,
      providers: {
        gemini: { configured: !!geminiKey, count: gemini.length },
        openrouter: { configured: !!openrouterKey, count: openrouter.length },
        gateway: { configured: gatewayConfigured, count: gateway.length },
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message, models: [] }, { status: 500 });
  }
}
