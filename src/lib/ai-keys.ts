/**
 * Leitura centralizada das API Keys de IA (Gemini + OpenRouter + Gateway de
 * Assinatura) salvas em ai_organizer_config (id=1). Cache curto (30s) pra não
 * bater no banco a cada chamada de IA. As chaves são compartilhadas por todo o
 * sistema e configuradas em /configuracoes (apenas admin).
 */

import { supabaseAdmin } from "@/lib/supabase_admin";
import { supabase } from "@/lib/supabase";

const adminClient = supabaseAdmin || supabase;

/**
 * Uma CONEXÃO de gateway = uma conta/assinatura conectada via proxy local. Dá
 * pra ter várias ao mesmo tempo (ex: Gemini, Claude e ChatGPT). Cada uma aponta
 * pra um proxy OpenAI-compatible (pode ser o MESMO proxy multiplexando contas,
 * ou proxies separados).
 */
export interface GatewayEndpoint {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string | null;
}

export interface AiKeys {
  /** Chave Google Gemini (ai_organizer_config.api_key). */
  gemini: string | null;
  /** Chave OpenRouter (ai_organizer_config.openrouter_api_key). */
  openrouter: string | null;
  /**
   * Gateway de ASSINATURA (LEGADO/1ª conexão) — baseURL do proxy local
   * OpenAI-compatible. Mantido por retrocompat; a fonte canônica agora é
   * `gatewayEndpoints`. (ai_organizer_config.gateway_base_url)
   */
  gatewayBaseUrl: string | null;
  /** Management key opcional do proxy gateway legado (ai_organizer_config.gateway_api_key). */
  gatewayApiKey: string | null;
  /**
   * modelRef de RESERVA (API key) usado quando o gateway falha — garante "nunca
   * quebra". (ai_organizer_config.gateway_fallback_model)
   */
  gatewayFallbackModel: string | null;
  /**
   * TODAS as conexões de gateway (várias contas). Se o banco só tiver os campos
   * legados (gateway_base_url), sintetizamos uma única conexão aqui.
   * (ai_organizer_config.gateway_endpoints)
   */
  gatewayEndpoints: GatewayEndpoint[];
}

const EMPTY_KEYS: AiKeys = {
  gemini: null,
  openrouter: null,
  gatewayBaseUrl: null,
  gatewayApiKey: null,
  gatewayFallbackModel: null,
  gatewayEndpoints: [],
};

/** Normaliza um valor de coluna texto pra string-ou-null (trim, vazio→null). */
function txt(v: unknown): string | null {
  const s = (v == null ? "" : String(v)).trim();
  return s ? s : null;
}

/**
 * Lê a lista de conexões do JSON `gateway_endpoints` (defensivo: aceita array já
 * parseado ou string). Se vier vazia mas existir o campo legado base_url,
 * sintetiza uma conexão única. Garante id/label/baseUrl válidos.
 */
export function parseGatewayEndpoints(
  raw: unknown,
  legacyBaseUrl: string | null,
  legacyApiKey: string | null
): GatewayEndpoint[] {
  let arr: any[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string" && raw.trim()) {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p; } catch { /* ignora */ }
  }
  const out: GatewayEndpoint[] = [];
  for (const e of arr) {
    const baseUrl = txt(e?.base_url ?? e?.baseUrl);
    if (!baseUrl) continue; // sem URL não é uma conexão válida
    out.push({
      id: txt(e?.id) || `g_${out.length + 1}`,
      label: txt(e?.label) || baseUrl,
      baseUrl,
      apiKey: txt(e?.api_key ?? e?.apiKey),
    });
  }
  // Retrocompat: nenhuma conexão na lista, mas existe a config single legada.
  if (out.length === 0 && legacyBaseUrl) {
    out.push({ id: "legacy", label: "Gateway", baseUrl: legacyBaseUrl, apiKey: legacyApiKey });
  }
  return out;
}

let CACHE: { keys: AiKeys; at: number } | null = null;
const TTL_MS = 30 * 1000;

export async function getAiKeys(force = false): Promise<AiKeys> {
  if (!force && CACHE && Date.now() - CACHE.at < TTL_MS) return CACHE.keys;
  try {
    // Tenta com as colunas do gateway; se ainda não existirem (migração não
    // rodada), o select falha e caímos no fallback só-Gemini/OpenRouter abaixo.
    // Garante retrocompatibilidade com bancos antigos.
    let d: Record<string, unknown>;
    const full = await adminClient
      .from("ai_organizer_config")
      .select("api_key, openrouter_api_key, gateway_base_url, gateway_api_key, gateway_fallback_model, gateway_endpoints")
      .eq("id", 1)
      .maybeSingle();
    if (full.error) {
      // Pode faltar SÓ a coluna gateway_endpoints (migração parcial): tenta sem ela.
      const mid = await adminClient
        .from("ai_organizer_config")
        .select("api_key, openrouter_api_key, gateway_base_url, gateway_api_key, gateway_fallback_model")
        .eq("id", 1)
        .maybeSingle();
      if (mid.error) {
        const base = await adminClient
          .from("ai_organizer_config")
          .select("api_key, openrouter_api_key")
          .eq("id", 1)
          .maybeSingle();
        d = (base.data || {}) as Record<string, unknown>;
      } else {
        d = (mid.data || {}) as Record<string, unknown>;
      }
    } else {
      d = (full.data || {}) as Record<string, unknown>;
    }
    const gatewayBaseUrl = txt(d.gateway_base_url);
    const gatewayApiKey = txt(d.gateway_api_key);
    const keys: AiKeys = {
      gemini: txt(d.api_key),
      openrouter: txt(d.openrouter_api_key),
      gatewayBaseUrl,
      gatewayApiKey,
      gatewayFallbackModel: txt(d.gateway_fallback_model),
      gatewayEndpoints: parseGatewayEndpoints(d.gateway_endpoints, gatewayBaseUrl, gatewayApiKey),
    };
    CACHE = { keys, at: Date.now() };
    return keys;
  } catch {
    return CACHE?.keys || { ...EMPTY_KEYS };
  }
}

export function invalidateAiKeysCache() {
  CACHE = null;
}
