/**
 * Gerenciamento de Combos de Modelos (Filas com Fallback Ordenado e Failover de Contas).
 *
 * Inspirado no 9Router:
 * Um Combo é um modelo virtual composto por uma lista prioritária de modelos
 * (ex: [gateway:claude-3-5-sonnet, gateway:gpt-4o, openrouter:meta-llama/llama-3.3-70b-instruct, gemini-2.5-flash]).
 *
 * Ao chamar um combo:
 * 1. O sistema tenta o 1º modelo em todas as contas conectadas disponíveis.
 * 2. Se todas as contas daquele modelo falharem (429, quota, 5xx, timeout, 401),
 *    o sistema avança suavemente para o 2º modelo da lista.
 * 3. O processo se repete até obter resposta com sucesso ou esgotar a cadeia.
 */

export interface AiComboStep {
  modelRef: string;     // ex: "gateway:claude-3-7-sonnet", "openrouter:anthropic/claude-3.5-sonnet", "gemini-2.5-flash"
  label?: string;       // rótulo descritivo opcional
  enabled?: boolean;    // permite desativar temporariamente um modelo sem removê-lo
}

export interface AiCombo {
  id: string;           // ex: "principal", "rapido", "economico", "custom_1"
  name: string;         // ex: "⚡ Combo Principal (Resiliência Máxima)"
  description?: string; // ex: "Claude 3.7 -> GPT-4o -> Gemini 2.5 Flash"
  models: AiComboStep[];
  isDefault?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export const COMBO_PREFIX = "combo:";

/** Combos padrão pré-configurados prontos para uso imediato */
export const DEFAULT_AI_COMBOS: AiCombo[] = [
  {
    id: "principal",
    name: "⚡ Combo Principal (Qualidade & Resiliência)",
    description: "Prioriza modelos de ponta (Claude 3.7 / GPT-4o) via Gateway e cai para Flash/Llama se esgotar quota.",
    models: [
      { modelRef: "gateway:claude-3-7-sonnet", label: "Claude 3.7 Sonnet (Gateway)", enabled: true },
      { modelRef: "gateway:claude-3-5-sonnet", label: "Claude 3.5 Sonnet (Gateway)", enabled: true },
      { modelRef: "gateway:gpt-4o", label: "GPT-4o (Gateway)", enabled: true },
      { modelRef: "gateway:gemini-2.5-pro", label: "Gemini 2.5 Pro (Gateway)", enabled: true },
      { modelRef: "gemini-2.5-flash", label: "Gemini 2.5 Flash (Nativo / API Key)", enabled: true },
    ],
    isDefault: true,
  },
  {
    id: "rapido",
    name: "🚀 Combo Ultra Rápido (SDR & Disparos)",
    description: "Focado em velocidade e alta taxa de resposta com custo mínimo.",
    models: [
      { modelRef: "gateway:gemini-2.5-flash", label: "Gemini 2.5 Flash (Gateway)", enabled: true },
      { modelRef: "gateway:gpt-4o-mini", label: "GPT-4o Mini (Gateway)", enabled: true },
      { modelRef: "gemini-2.5-flash", label: "Gemini 2.5 Flash (Nativo)", enabled: true },
      { modelRef: "openrouter:meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B Free (OpenRouter)", enabled: true },
    ],
  },
  {
    id: "economico",
    name: "💡 Combo 100% Econômico / Grátis",
    description: "Gira exclusivamente em contas conectadas de Gateway e modelos gratuitos do OpenRouter.",
    models: [
      { modelRef: "gateway:gemini-2.5-flash", label: "Gemini Flash (Gateway)", enabled: true },
      { modelRef: "openrouter:meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B (OpenRouter Free)", enabled: true },
      { modelRef: "openrouter:deepseek/deepseek-r1:free", label: "DeepSeek R1 (OpenRouter Free)", enabled: true },
      { modelRef: "gemini-2.5-flash", label: "Gemini 2.5 Flash (API Key Fallback)", enabled: true },
    ],
  },
];

/** Valida e normaliza um array de combos vindo do banco ou API */
export function sanitizeCombos(raw: unknown): AiCombo[] {
  let list: any[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      // Ignora erro de parse
    }
  }

  if (!list.length) {
    return DEFAULT_AI_COMBOS;
  }

  const out: AiCombo[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const name = String(item.name || "").trim() || `Combo ${id}`;
    if (!id) continue;

    const rawModels = Array.isArray(item.models) ? item.models : [];
    const models: AiComboStep[] = [];

    for (const m of rawModels) {
      if (!m) continue;
      const ref = typeof m === "string" ? m.trim() : String(m.modelRef || "").trim();
      if (!ref) continue;
      // Previne loops onde um combo aponta para ele mesmo
      if (ref === `${COMBO_PREFIX}${id}` || ref === id) continue;

      const label = typeof m === "object" && m.label ? String(m.label).trim() : undefined;
      const enabled = typeof m === "object" && m.enabled !== undefined ? Boolean(m.enabled) : true;

      models.push({
        modelRef: ref,
        label,
        enabled,
      });
    }

    if (models.length > 0) {
      out.push({
        id,
        name,
        description: item.description ? String(item.description).trim() : undefined,
        models,
        isDefault: Boolean(item.isDefault),
        createdAt: item.createdAt ? String(item.createdAt) : undefined,
        updatedAt: item.updatedAt ? String(item.updatedAt) : undefined,
      });
    }
  }

  return out.length > 0 ? out : DEFAULT_AI_COMBOS;
}

/** Retorna a lista de modelRefs ativos de um combo para execução */
export function resolveComboSteps(comboId: string, combos: AiCombo[]): string[] {
  const cleanId = comboId.startsWith(COMBO_PREFIX) ? comboId.slice(COMBO_PREFIX.length) : comboId;
  const combo = combos.find((c) => c.id === cleanId) || DEFAULT_AI_COMBOS.find((c) => c.id === cleanId);
  if (!combo) return [];
  return combo.models.filter((m) => m.enabled !== false).map((m) => m.modelRef);
}
