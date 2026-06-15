/**
 * Agrupamento de modelos pros seletores — sem hardcode de lista.
 *
 * O OpenRouter expõe 300+ modelos; o gateway de assinatura pode expor dezenas
 * (Gemini + Claude + GPT da sua conta). Pra não virar uma lista gigante e
 * indistinta, agrupamos por PROVEDOR e, dentro dele, por SUBGRUPO:
 *   - OpenRouter → "Grátis" (ids terminando em :free) + por família (Claude, GPT…)
 *   - Gateway    → por família (Claude, GPT, Gemini…) da sua assinatura
 *   - Gemini     → sem subgrupo (lista curta)
 *
 * Funções puras, sem React — usadas tanto pelo dropdown rico
 * (ai-module-shared) quanto pelos <select> nativos inline das páginas.
 */

export type GroupableModel = {
  id: string;
  rawId?: string;
  name?: string;
  description?: string;
  provider?: string; // "gemini" | "openrouter" | "gateway"
  supportsTools?: boolean;
};

// Vendor (prefixo antes de "/") → nome amigável da família.
const VENDOR_MAP: Record<string, string> = {
  anthropic: "Claude",
  openai: "GPT (OpenAI)",
  google: "Gemini",
  "meta-llama": "Llama",
  meta: "Llama",
  deepseek: "DeepSeek",
  mistralai: "Mistral",
  qwen: "Qwen",
  "x-ai": "Grok",
  cohere: "Cohere",
  perplexity: "Perplexity",
  microsoft: "Phi (Microsoft)",
  nvidia: "NVIDIA",
  "z-ai": "GLM (Z-AI)",
  moonshotai: "Moonshot/Kimi",
  "01-ai": "Yi",
  nousresearch: "Nous",
  amazon: "Nova (Amazon)",
};

/**
 * Família/marca amigável a partir do id do modelo. Funciona com ids que têm
 * prefixo de vendor ("anthropic/claude-3.5-sonnet") e com ids "crus" do gateway
 * ("gpt-4o", "claude-3-5-sonnet", "gemini-2.5-flash").
 */
export function modelFamily(rawIdOrId: string): string {
  const s = (rawIdOrId || "").toLowerCase();
  const slash = s.indexOf("/");
  if (slash > 0) {
    const vendor = s.slice(0, slash);
    if (VENDOR_MAP[vendor]) return VENDOR_MAP[vendor];
  }
  // Por palavra-chave no id (cobre o gateway, que não tem prefixo de vendor).
  if (/claude/.test(s)) return "Claude";
  if (/(gpt|chatgpt|davinci|o1|o3|o4|codex)/.test(s)) return "GPT (OpenAI)";
  if (/gemini|gemma|palm|bison/.test(s)) return "Gemini";
  if (/llama/.test(s)) return "Llama";
  if (/deepseek/.test(s)) return "DeepSeek";
  if (/mi(x|s)tral/.test(s)) return "Mistral";
  if (/qwen/.test(s)) return "Qwen";
  if (/grok/.test(s)) return "Grok";
  if (/\bphi-?\d/.test(s)) return "Phi";
  if (/command-|cohere/.test(s)) return "Cohere";
  if (/\bglm-|\bglm\b/.test(s)) return "GLM (Z-AI)";
  if (/kimi|moonshot/.test(s)) return "Moonshot/Kimi";
  if (/\byi-/.test(s)) return "Yi";
  if (slash > 0) {
    const v = s.slice(0, slash);
    return v.charAt(0).toUpperCase() + v.slice(1);
  }
  return "Outros";
}

/** Modelo gratuito do OpenRouter (convenção: id termina em ":free"). */
export function isFreeModel(m: GroupableModel): boolean {
  const raw = (m.rawId || m.id || "").toLowerCase();
  return raw.endsWith(":free");
}

/** Rótulo do subgrupo dentro de um provedor (string vazia = sem subgrupo). */
export function subGroupLabel(m: GroupableModel): string {
  const provider = m.provider || "gemini";
  if (provider === "openrouter") {
    if (isFreeModel(m)) return "Grátis";
    return modelFamily(m.rawId || m.id);
  }
  if (provider === "gateway") {
    return modelFamily(m.rawId || m.id);
  }
  return ""; // Gemini: lista curta, sem subgrupo.
}

export type SubGroup<T extends GroupableModel = GroupableModel> = { label: string; items: T[] };
export type ProviderGroup<T extends GroupableModel = GroupableModel> = { provider: string; subgroups: SubGroup<T>[] };

const PROVIDER_ORDER = ["gemini", "openrouter", "gateway"];

/**
 * Agrupa por provedor (na ordem gemini → openrouter → gateway) e, dentro de cada
 * um, por subgrupo. "Grátis" vem primeiro; subgrupos sem rótulo, por último.
 */
export function groupModels<T extends GroupableModel>(models: T[]): ProviderGroup<T>[] {
  const byProvider: Record<string, T[]> = {};
  for (const m of models) {
    const p = m.provider || "gemini";
    (byProvider[p] ||= []).push(m);
  }
  return PROVIDER_ORDER.filter((p) => byProvider[p]?.length).map((p) => {
    const bySub: Record<string, T[]> = {};
    for (const m of byProvider[p]) {
      const sub = subGroupLabel(m);
      (bySub[sub] ||= []).push(m);
    }
    const subgroups = Object.keys(bySub)
      .sort((a, b) => {
        if (a === "Grátis") return -1;
        if (b === "Grátis") return 1;
        if (a === "") return 1;
        if (b === "") return -1;
        return a.localeCompare(b, "pt-BR");
      })
      .map((label) => ({ label, items: bySub[label] }));
    return { provider: p, subgroups };
  });
}

/** Rótulo amigável de cada provedor (compartilhado entre os seletores). */
export const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  gateway: "Gateway (Assinatura)",
};
