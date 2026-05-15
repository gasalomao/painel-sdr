/**
 * Preços de modelos de IA — fonte online com cache.
 *
 * Por que online: a tabela do Google muda direto, e a gente cobre vários modelos
 * (gemini-2.5, 2.0, 1.5, etc). Ficar atualizando array no código manualmente é falho.
 *
 * Fonte: LiteLLM mantém um JSON crowd-sourced atualizado com preços de
 * praticamente todos os modelos comerciais. URL pública, sem auth, JSON gigante.
 *   https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
 *
 * Estratégia:
 *  - Em memória: cache de 6h. Primeira chamada do processo busca; depois só lê.
 *  - Persistência: salvamos em `ai_pricing_cache` (Supabase) pra não bater no GitHub
 *    a cada cold-start de função serverless.
 *  - Fallback estático: se tudo falhar, usamos um snapshot conservador (preços oficiais
 *    Gemini de 2025) — o cálculo nunca fica em zero.
 */

import { supabaseAdmin } from "@/lib/supabase";
import { supabase } from "@/lib/supabase";

const adminClient = supabaseAdmin || supabase;

const SOURCE_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_KEY = "litellm_pricing";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

export type ModelPrice = {
  /** Custo USD por 1 token de prompt */
  input_per_token: number;
  /** Custo USD por 1 token de saída */
  output_per_token: number;
  /** Custo USD por 1 token de cache hit (lê cache) — opcional */
  cache_read_per_token?: number;
  /** Provider: "vertex_ai", "gemini", "openai", "anthropic", etc */
  provider?: string;
  /** Modo de uso: "chat" | "embedding" | "audio_transcription" | ... */
  mode?: string;
};

type PricingMap = Record<string, ModelPrice>;

type CacheState = {
  map: PricingMap;
  fetchedAt: number;
  source: "remote" | "db" | "fallback";
};

let memCache: CacheState | null = null;
let inflightFetch: Promise<CacheState> | null = null;

/**
 * Snapshot de fallback. Só vale se NUNCA conseguimos buscar online.
 * Preços em USD/token (não por 1M). Atualizado conforme docs Google em 2025.
 */
const FALLBACK_PRICES: PricingMap = {
  // Gemini 3 family (lançado 2026) — flagship multimodal
  "gemini-3-flash":                 { input_per_token: 0.50e-6,   output_per_token: 3.00e-6,  provider: "gemini", mode: "chat" },
  "gemini-3-pro":                   { input_per_token: 2.50e-6,   output_per_token: 15.00e-6, provider: "gemini", mode: "chat" },
  "gemini-3.1-flash-lite-preview":  { input_per_token: 0.10e-6,   output_per_token: 0.40e-6,  provider: "gemini", mode: "chat" },
  "gemini-3.1-flash-lite":          { input_per_token: 0.10e-6,   output_per_token: 0.40e-6,  provider: "gemini", mode: "chat" },
  // Gemini 2.x family
  "gemini-2.5-flash":               { input_per_token: 0.075e-6,  output_per_token: 0.30e-6,  provider: "gemini", mode: "chat" },
  "gemini-2.5-flash-lite":          { input_per_token: 0.040e-6,  output_per_token: 0.15e-6,  provider: "gemini", mode: "chat" },
  "gemini-2.5-pro":                 { input_per_token: 1.25e-6,   output_per_token: 10.0e-6,  provider: "gemini", mode: "chat" },
  "gemini-2.0-flash":               { input_per_token: 0.075e-6,  output_per_token: 0.30e-6,  provider: "gemini", mode: "chat" },
  "gemini-2.0-flash-lite":          { input_per_token: 0.040e-6,  output_per_token: 0.15e-6,  provider: "gemini", mode: "chat" },
  // Gemini 1.5 family (fallback pra keys legadas)
  "gemini-1.5-flash":               { input_per_token: 0.075e-6,  output_per_token: 0.30e-6,  provider: "gemini", mode: "chat" },
  "gemini-1.5-flash-8b":            { input_per_token: 0.040e-6,  output_per_token: 0.15e-6,  provider: "gemini", mode: "chat" },
  "gemini-1.5-pro":                 { input_per_token: 1.25e-6,   output_per_token: 5.00e-6,  provider: "gemini", mode: "chat" },
};

/** Filtra do JSON do LiteLLM só os modelos que a gente realmente usa (chat de Gemini etc). */
function normalizeLiteLLM(raw: any): PricingMap {
  const out: PricingMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, val] of Object.entries(raw as Record<string, any>)) {
    if (!val || typeof val !== "object") continue;
    if (val.mode && val.mode !== "chat" && val.mode !== "completion") continue;
    const inp = Number(val.input_cost_per_token);
    const outp = Number(val.output_cost_per_token);
    if (!isFinite(inp) && !isFinite(outp)) continue;
    out[key.toLowerCase()] = {
      input_per_token: isFinite(inp) ? inp : 0,
      output_per_token: isFinite(outp) ? outp : 0,
      cache_read_per_token: isFinite(Number(val.cache_read_input_token_cost))
        ? Number(val.cache_read_input_token_cost) : undefined,
      provider: val.litellm_provider || val.provider,
      mode: val.mode,
    };
  }
  return out;
}

async function loadFromDb(): Promise<CacheState | null> {
  try {
    const { data, error } = await adminClient
      .from("ai_pricing_cache")
      .select("payload, fetched_at")
      .eq("key", CACHE_KEY)
      .maybeSingle();
    if (error || !data?.payload) return null;
    const fetchedAt = data.fetched_at ? new Date(data.fetched_at).getTime() : 0;
    return {
      map: data.payload as PricingMap,
      fetchedAt,
      source: "db",
    };
  } catch {
    return null;
  }
}

async function saveToDb(map: PricingMap): Promise<void> {
  try {
    await adminClient.from("ai_pricing_cache").upsert({
      key: CACHE_KEY,
      payload: map,
      fetched_at: new Date().toISOString(),
    }, { onConflict: "key" });
  } catch (e: any) {
    // Tabela pode não existir — não-fatal
    console.warn("[Pricing] não consegui persistir cache:", e?.message);
  }
}

async function fetchFromRemote(): Promise<PricingMap> {
  const res = await fetch(SOURCE_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`LiteLLM HTTP ${res.status}`);
  const raw = await res.json();
  return normalizeLiteLLM(raw);
}

/**
 * Garante que `memCache` está populado. Faz reuso de promise inflight pra
 * concorrência (várias chamadas paralelas → 1 só fetch).
 */
export async function ensurePricing(force = false): Promise<CacheState> {
  if (!force && memCache && Date.now() - memCache.fetchedAt < CACHE_TTL_MS) {
    return memCache;
  }
  if (inflightFetch && !force) return inflightFetch;

  inflightFetch = (async () => {
    // 1) Tenta DB se memória vazia (acelera cold-start)
    if (!force && !memCache) {
      const fromDb = await loadFromDb();
      if (fromDb && Date.now() - fromDb.fetchedAt < CACHE_TTL_MS) {
        memCache = fromDb;
        return fromDb;
      }
    }
    // 2) Vai pro GitHub
    try {
      const map = await fetchFromRemote();
      const state: CacheState = { map, fetchedAt: Date.now(), source: "remote" };
      memCache = state;
      // Persiste em background — não bloqueia
      saveToDb(map).catch(() => {});
      return state;
    } catch (err: any) {
      console.warn("[Pricing] fetch remoto falhou:", err?.message);
      // 3) DB ainda que velho
      const fromDb = await loadFromDb();
      if (fromDb) {
        memCache = fromDb;
        return fromDb;
      }
      // 4) Fallback estático
      const state: CacheState = { map: FALLBACK_PRICES, fetchedAt: Date.now(), source: "fallback" };
      memCache = state;
      return state;
    } finally {
      inflightFetch = null;
    }
  })();

  return inflightFetch;
}

/**
 * Procura o melhor match pra um model name no mapa de preços.
 * Tenta:
 *   1. Match exato (lowercase)
 *   2. Strip de variantes/datas: gemini-2.5-flash-preview-09-2025 → gemini-2.5-flash
 *   3. Match por prefixo
 */
export function findPriceFor(map: PricingMap, model: string): ModelPrice | null {
  if (!model) return null;
  const m = model.toLowerCase().trim();

  if (map[m]) return map[m];

  // Tenta com prefixo "gemini/" (formato LiteLLM)
  if (map[`gemini/${m}`]) return map[`gemini/${m}`];

  // Strip variantes comuns: -001, -002, -latest, -preview-MM-YYYY, -preview-MM-DD
  const stripped = m
    .replace(/-preview-\d{2}-\d{2,4}/g, "")
    .replace(/-(latest|preview|exp|experimental)$/g, "")
    .replace(/-\d{3,4}$/g, "");
  if (stripped !== m && map[stripped]) return map[stripped];
  if (stripped !== m && map[`gemini/${stripped}`]) return map[`gemini/${stripped}`];

  // Procura por prefixo (modelo mais específico ganha)
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [k, v] of Object.entries(map)) {
    const kk = k.toLowerCase();
    const target = kk.startsWith("gemini/") ? kk.slice(7) : kk;
    if (m.startsWith(target) || target.startsWith(m)) {
      if (!best || target.length > best.key.length) best = { key: target, price: v };
    }
  }
  return best?.price || null;
}

/** Sync — assume cache já carregado. Use depois de `await ensurePricing()`. */
export function lookupPriceSync(model: string): ModelPrice | null {
  if (!memCache) return findPriceFor(FALLBACK_PRICES, model);
  const found = findPriceFor(memCache.map, model);
  if (found) return found;
  return findPriceFor(FALLBACK_PRICES, model);
}

/** Async — garante cache antes de buscar. */
export async function lookupPrice(model: string): Promise<ModelPrice | null> {
  await ensurePricing();
  return lookupPriceSync(model);
}

/** Calcula custo USD pra uma chamada. */
export function computeCost(price: ModelPrice | null, promptTokens: number, completionTokens: number): number {
  if (!price) return 0;
  const cost = (promptTokens || 0) * (price.input_per_token || 0)
             + (completionTokens || 0) * (price.output_per_token || 0);
  return Math.round(cost * 1e10) / 1e10;
}

// ===========================================================================
// CÂMBIO USD → BRL EM TEMPO REAL
// Fonte: AwesomeAPI (gratuita, pública, sem auth, atualizada minuto-a-minuto)
//   https://docs.awesomeapi.com.br/api-de-moedas
// Cache: 6h em memória + persistência em ai_pricing_cache pra cold-start.
// Fallback: 5.0 (média conservadora 2024-2025) se a API cair.
// ===========================================================================

const FX_CACHE_KEY = "fx_usd_brl";
const FX_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const FX_FALLBACK = 5.0;

type FxState = { rate: number; fetchedAt: number; source: "remote" | "db" | "fallback" };
let fxMemCache: FxState | null = null;
let fxInflight: Promise<FxState> | null = null;

async function fetchFxRemote(): Promise<number> {
  // AwesomeAPI: GET /json/last/USD-BRL
  // Retorna { USDBRL: { bid: "5.123", ask: "...", high, low, ... } }
  const r = await fetch("https://economia.awesomeapi.com.br/json/last/USD-BRL", {
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`AwesomeAPI HTTP ${r.status}`);
  const j = await r.json();
  const bid = Number(j?.USDBRL?.bid);
  if (!isFinite(bid) || bid < 1 || bid > 50) throw new Error(`Cotação inválida: ${bid}`);
  return bid;
}

async function loadFxFromDb(): Promise<FxState | null> {
  try {
    const { data } = await adminClient
      .from("ai_pricing_cache")
      .select("payload, fetched_at")
      .eq("key", FX_CACHE_KEY)
      .maybeSingle();
    if (!data?.payload) return null;
    const rate = Number((data.payload as any).rate);
    const fetchedAt = data.fetched_at ? new Date(data.fetched_at).getTime() : 0;
    if (!isFinite(rate) || rate <= 0) return null;
    return { rate, fetchedAt, source: "db" };
  } catch { return null; }
}

async function saveFxToDb(rate: number) {
  try {
    await adminClient.from("ai_pricing_cache").upsert({
      key: FX_CACHE_KEY,
      payload: { rate },
      fetched_at: new Date().toISOString(),
    }, { onConflict: "key" });
  } catch {}
}

/** Garante cotação USD→BRL atualizada (cache 6h). */
export async function ensureFxRate(force = false): Promise<FxState> {
  if (!force && fxMemCache && Date.now() - fxMemCache.fetchedAt < FX_TTL_MS) return fxMemCache;
  if (fxInflight && !force) return fxInflight;

  fxInflight = (async () => {
    try {
      // 1) DB se memória vazia
      if (!force && !fxMemCache) {
        const fromDb = await loadFxFromDb();
        if (fromDb && Date.now() - fromDb.fetchedAt < FX_TTL_MS) {
          fxMemCache = fromDb;
          return fromDb;
        }
      }
      // 2) Tenta remoto
      try {
        const rate = await fetchFxRemote();
        const state: FxState = { rate, fetchedAt: Date.now(), source: "remote" };
        fxMemCache = state;
        saveFxToDb(rate).catch(() => {});
        return state;
      } catch (err: any) {
        console.warn("[FX] AwesomeAPI falhou:", err?.message);
        // 3) DB ainda que velho
        const fromDb = await loadFxFromDb();
        if (fromDb) { fxMemCache = fromDb; return fromDb; }
        // 4) Fallback duro
        const state: FxState = { rate: FX_FALLBACK, fetchedAt: Date.now(), source: "fallback" };
        fxMemCache = state;
        return state;
      }
    } finally {
      fxInflight = null;
    }
  })();
  return fxInflight;
}

/** Sync — assume cache já carregado. Use depois de await ensureFxRate(). */
export function getFxRateSync(): number {
  return fxMemCache?.rate ?? FX_FALLBACK;
}

/** Converte custo USD pra BRL usando cotação atual. */
export async function usdToBrl(usd: number): Promise<{ brl: number; rate: number; source: string }> {
  const fx = await ensureFxRate();
  return { brl: usd * fx.rate, rate: fx.rate, source: fx.source };
}

/** Estado do câmbio pra UI mostrar (origem, idade, cotação). */
export async function getFxState(): Promise<{ rate: number; fetchedAt: number; source: string; ageMinutes: number }> {
  const s = await ensureFxRate();
  return {
    rate: s.rate,
    fetchedAt: s.fetchedAt,
    source: s.source,
    ageMinutes: Math.floor((Date.now() - s.fetchedAt) / 60000),
  };
}

export async function getCacheState(): Promise<{ source: string; fetchedAt: number; modelCount: number }> {
  const s = await ensurePricing();
  return { source: s.source, fetchedAt: s.fetchedAt, modelCount: Object.keys(s.map).length };
}

/** Lista os modelos Gemini conhecidos no cache atual (pra UI mostrar tabela). */
export async function listGeminiPrices(): Promise<Array<{ model: string; input_per_1m: number; output_per_1m: number }>> {
  const s = await ensurePricing();
  const out: Array<{ model: string; input_per_1m: number; output_per_1m: number }> = [];
  for (const [k, v] of Object.entries(s.map)) {
    if (!k.toLowerCase().includes("gemini")) continue;
    if (v.mode && v.mode !== "chat" && v.mode !== "completion") continue;
    out.push({
      model: k.replace(/^gemini\//, ""),
      input_per_1m: v.input_per_token * 1_000_000,
      output_per_1m: v.output_per_token * 1_000_000,
    });
  }
  return out
    .filter((v, i, a) => a.findIndex(x => x.model === v.model) === i)
    .sort((a, b) => a.model.localeCompare(b.model));
}
