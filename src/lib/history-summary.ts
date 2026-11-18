/**
 * Resumo do MEIO do histórico — garante "lembrar tudo" sem perder qualidade.
 *
 * POR QUE EXISTE: a janela adaptativa do agente (`agent/process/route.ts`)
 * mantém as 3 primeiras + 12 últimas mensagens de conversas longas e descarta
 * as do MEIO. Antes o "meio" virava um placeholder vago (placeholder fixo),
 * então a IA esquecia dados coletados no meio da conversa (nome, preferências,
 * decisões). Aqui geramos um RESUMO REAL dessas mensagens intermediárias — a IA
 * continua enxergando o que rolou, sem reenviar tudo (economiza token).
 *
 * ECONOMIA: o resumo substitui N mensagens inteiras por ~1 parágrafo curto →
 * menos tokens por turno em conversas longas. E é CACHEADO por conteúdo (hash):
 * só regenera quando o meio muda (ex.: novas mensagens enquadram no intervalo).
 *
 * CUSTO do resumo: usa `generateText` com reasoningMode=0 (Econômico) e o modelo
 * PADRÃO da conta (Gemini Flash se disponível) — nunca o modelo caro do agente.
 *
 * Server-only. Não tem acoplamento com o provedor específico — só chama generateText.
 */

import { supabaseAdmin } from "@/lib/supabase_admin";
import { generateText, parseModelRef } from "@/lib/ai-provider";
import { getAiKeys } from "@/lib/ai-keys";
import {
  isAutoFreeModelRef,
  isModelUnavailable,
  isProviderUnreachable,
  isReasoningHeavyModel,
  pickBestFreeModelRef,
} from "@/lib/ai-smart-free-router";
import { createHmac } from "crypto";

// Cache em memória (process): remoteJid → { hash, summary }.
// Persistência no DB seria mais robusta, mas em memória já evita regerar a cada
// turno (só regenera quando o conteúdo do meio muda). Restart = cache frio,
// o que é OK (primeira msg após restart regera uma vez).
const MEM_CACHE = new Map<string, { hash: string; summary: string; at: number }>();
const MEM_TTL_MS = 60 * 60 * 1000; // 1h — depois revalida (meio pode ter mudado).
const BUCKET_SIZE = 8;

export interface SummarizeHistoryOptions {
  preferredModelRef?: string | null;
  geminiApiKey?: string | null;
  openrouterApiKey?: string | null;
  nvidiaApiKey?: string | null;
  sessionId?: string | null;
  sessionVariables?: Record<string, any> | null;
}

/**
 * Hash estável do conteúdo das mensagens do bloco. Se mudou (novo bloco de 8
 * mensagens completou), regera; senão, reaproveita o resumo cacheado.
 */
export function contentHash(msgs: Array<{ sender_type?: string; sender?: string; content?: string }>): string {
  const text = msgs
    .map((m) => `${m.sender_type || m.sender || ""}:${(m.content || "").slice(0, 200)}`)
    .join("|");
  return createHmac("sha1", "history-summary").update(text).digest("hex").slice(0, 24);
}

/**
 * Resolve a modelRef + api keys do modelo mais econômico disponível pra gerar o
 * resumo em QUALQUER provedor configurado no sistema (Gemini, OpenRouter,
 * NVIDIA NIM, OpenCode/Gateway de Assinatura ou Combo).
 */
export async function cheapModelForSummary(opts?: SummarizeHistoryOptions): Promise<{
  modelRef: string;
  geminiApiKey?: string | null;
  openrouterApiKey?: string | null;
  nvidiaApiKey?: string | null;
} | null> {
  const keys = await getAiKeys().catch(() => null);
  const geminiKey = opts?.geminiApiKey || keys?.gemini || null;
  const openrouterKey =
    opts?.openrouterApiKey || keys?.openrouter || keys?.openrouterKeys?.[0] || null;
  const nvidiaKey =
    opts?.nvidiaApiKey || keys?.nvidia || keys?.nvidiaAccounts?.[0]?.apiKey || null;
  const hasGateway = Boolean(keys?.gatewayEndpoints && keys.gatewayEndpoints.length > 0);

  const pref = (opts?.preferredModelRef || "").trim();
  if (pref && (pref.startsWith("gateway:") || isAutoFreeModelRef(pref))) {
    return {
      modelRef: pref,
      geminiApiKey: geminiKey,
      openrouterApiKey: openrouterKey,
      nvidiaApiKey: nvidiaKey,
    };
  }

  if (pref && pref.endsWith(":free")) {
    const parsedPref = parseModelRef(pref);
    const prefUnavailable = isModelUnavailable(parsedPref.provider, parsedPref.model);
    const prefHeavy = isReasoningHeavyModel(parsedPref.model);
    if (!prefUnavailable && !prefHeavy) {
      return {
        modelRef: pref,
        geminiApiKey: geminiKey,
        openrouterApiKey: openrouterKey,
        nvidiaApiKey: nvidiaKey,
      };
    }
    // Se o modelo :free titular é pesado de reasoning ou está em cooldown, tenta achar um :free instruct veloz
    const fastFree = await pickBestFreeModelRef({
      profile: "fast",
      hasOpenRouter: Boolean(openrouterKey),
      hasNvidia: Boolean(nvidiaKey),
      hasGateway,
    }).catch(() => null);
    if (fastFree) {
      return {
        modelRef: fastFree,
        geminiApiKey: geminiKey,
        openrouterApiKey: openrouterKey,
        nvidiaApiKey: nvidiaKey,
      };
    }
    if (!prefUnavailable) {
      return {
        modelRef: pref,
        geminiApiKey: geminiKey,
        openrouterApiKey: openrouterKey,
        nvidiaApiKey: nvidiaKey,
      };
    }
  }

  if (geminiKey && !isProviderUnreachable("gemini")) {
    return {
      modelRef: "gemini-2.5-flash",
      geminiApiKey: geminiKey,
      openrouterApiKey: openrouterKey,
      nvidiaApiKey: nvidiaKey,
    };
  }

  if (openrouterKey || nvidiaKey) {
    const fastFree = await pickBestFreeModelRef({
      profile: "fast",
      hasOpenRouter: Boolean(openrouterKey),
      hasNvidia: Boolean(nvidiaKey),
      hasGateway,
    }).catch(() => null);
    if (fastFree) {
      return {
        modelRef: fastFree,
        geminiApiKey: geminiKey,
        openrouterApiKey: openrouterKey,
        nvidiaApiKey: nvidiaKey,
      };
    }
  }

  if (openrouterKey) {
    return {
      modelRef: "openrouter:meta-llama/llama-3.1-8b-instruct",
      openrouterApiKey: openrouterKey,
      nvidiaApiKey: nvidiaKey,
    };
  }
  if (nvidiaKey) {
    return {
      modelRef: "nvidia:meta/llama-3.1-8b-instruct",
      nvidiaApiKey: nvidiaKey,
    };
  }
  if (pref) {
    return {
      modelRef: pref,
      geminiApiKey: geminiKey,
      openrouterApiKey: openrouterKey,
      nvidiaApiKey: nvidiaKey,
    };
  }
  if (hasGateway) {
    try {
      const { listAvailableGatewayModels } = await import("@/lib/gateway-model-discovery");
      const gwModels = await listAvailableGatewayModels();
      if (gwModels.length > 0) {
        return { modelRef: `gateway:${gwModels[0].id}` };
      }
    } catch {
      // ignora
    }
  }
  return null;
}

function formatRemainderCompact(msgs: Array<{ sender_type?: string; sender?: string; content?: string }>): string {
  if (!msgs.length) return "";
  return msgs
    .map((m) => {
      const s = m.sender_type || m.sender;
      const who = s === "customer" ? "Cliente" : "Atendimento";
      const txt = String(m.content || "[mídia]").replace(/\s+/g, " ").trim().slice(0, 140);
      return `${who}: ${txt}`;
    })
    .join(" / ");
}

/**
 * Gera o resumo das mensagens do MEIO de uma conversa em blocos estáveis de 8 mensagens.
 * - Economiza até 87% das chamadas de resumo (recalcula só a cada 8 novas mensagens no meio,
 *   anexando o restante recente de forma compacta sem gastar chamada de IA).
 * - Persiste em memória + `sessions.variables._history_summary` para manter 100% do contexto
 *   mesmo se o admin trocar o modelo/provedor (ex.: Gemini ↔ OpenCode ↔ OpenRouter ↔ NVIDIA)
 *   no meio do atendimento.
 */
export async function summarizeMiddleMessages(
  clientId: string,
  remoteJid: string,
  middleMsgs: Array<{ sender_type?: string; sender?: string; content?: string }>,
  opts?: SummarizeHistoryOptions,
): Promise<string | null> {
  if (!middleMsgs || middleMsgs.length === 0) return null;

  // Curto-circuito econômico: 1-3 mensagens no meio (~30-100 tokens) não justificam
  // gastar +200 tokens de prompt numa chamada extra de LLM; devolve compacto fiel.
  if (middleMsgs.length < 4) {
    return formatRemainderCompact(middleMsgs) || null;
  }

  // Divide em bloco estável (múltiplo de BUCKET_SIZE, ou bloco inicial >= 4 enquanto < BUCKET_SIZE)
  // + cauda residual, evitando recalcular o hash a cada único turno.
  const stableCount =
    middleMsgs.length >= BUCKET_SIZE
      ? Math.floor(middleMsgs.length / BUCKET_SIZE) * BUCKET_SIZE
      : middleMsgs.length;
  const stableSlice = middleMsgs.slice(0, stableCount);
  const remainderSlice = middleMsgs.slice(stableCount);

  const cacheKey = `${clientId}:${remoteJid}`;
  const hash = contentHash(stableSlice);

  // 1) Checa cache em memória (processo)
  const cached = MEM_CACHE.get(cacheKey);
  if (cached && cached.hash === hash && Date.now() - cached.at < MEM_TTL_MS) {
    const rem = formatRemainderCompact(remainderSlice);
    return rem ? `${cached.summary} | Contexto adicional: ${rem}` : cached.summary;
  }

  // 2) Checa resumo persistido na sessão (sobrevive a restart e troca de modelo)
  const persistedObj = opts?.sessionVariables?._history_summary;
  if (
    persistedObj &&
    typeof persistedObj === "object" &&
    persistedObj.hash === hash &&
    typeof persistedObj.summary === "string" &&
    persistedObj.summary.trim()
  ) {
    const baseSummary = persistedObj.summary.trim();
    MEM_CACHE.set(cacheKey, { hash, summary: baseSummary, at: Date.now() });
    const rem = formatRemainderCompact(remainderSlice);
    return rem ? `${baseSummary} | Contexto adicional: ${rem}` : baseSummary;
  }

  const model = await cheapModelForSummary(opts);
  if (!model) return null; // sem modelo disponível — caller usa placeholder.

  // Monta o texto das mensagens do bloco estável (cortadas p/ não estourar o prompt).
  const lines = stableSlice.slice(0, 60).map((m, i) => {
    const s = m.sender_type || m.sender;
    const who = s === "customer" ? "Cliente" : "IA";
    const content = (m.content || "[mídia]").slice(0, 300);
    return `${i + 1}. ${who}: ${content}`;
  });
  const transcript = lines.join("\n");

  const prompt =
    `Resuma CONCISAMENTE esta conversa intermediária de WhatsApp entre um cliente e uma IA de atendimento (SDR). ` +
    `Foque em: dados do cliente (nome, contato, necessidade), decisões/acordos, estágio da negociação, e qualquer informação importante que a IA precise lembrar pra continuar o atendimento. ` +
    `Máximo 3 frases. Sem rodeios, só fatos.\n\n` +
    `Conversa:\n${transcript}`;

  try {
    const result = await generateText({
      modelRef: model.modelRef,
      prompt,
      // Econômico: resumo não precisa raciocínio profundo. Economiza token.
      reasoningMode: 0,
      taskProfile: "fast",
      geminiApiKey: model.geminiApiKey,
      openrouterApiKey: model.openrouterApiKey,
      nvidiaApiKey: model.nvidiaApiKey,
      maxOutputTokens: 300,
    });

    if (result.usage && result.usage.totalTokens > 0) {
      import("@/lib/token-usage")
        .then(async ({ logTokenUsage }) => {
          const { providerDisplayName } = await import("@/lib/ai-provider");
          await logTokenUsage({
            source: "other",
            sourceLabel: "Resumo de histórico (agente)",
            model: result.modelUsed || model.modelRef,
            provider: providerDisplayName(result.provider),
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
            cachedTokens: result.usage.cachedTokens,
            costUsd: result.usage.costUsd,
            clientId: clientId || undefined,
            metadata: { kind: "history_summary", messagesSummarized: stableSlice.length },
          });
        })
        .catch(() => {});
    }

    const summary = (result.text || "").trim();
    if (!summary) return null;
    MEM_CACHE.set(cacheKey, { hash, summary, at: Date.now() });

    const summaryEntry = {
      hash,
      summary,
      updated_at: new Date().toISOString(),
    };

    // Atualiza em memória e persiste fazendo merge antes de retornar (evita corrida com save_variables)
    if (opts?.sessionVariables && typeof opts.sessionVariables === "object") {
      opts.sessionVariables._history_summary = summaryEntry;
    }
    if (opts?.sessionId && supabaseAdmin) {
      try {
        const { data: latest } = await supabaseAdmin
          .from("sessions")
          .select("variables")
          .eq("id", opts.sessionId)
          .eq("client_id", clientId)
          .maybeSingle();
        const base =
          latest?.variables && typeof latest.variables === "object"
            ? (latest.variables as Record<string, any>)
            : opts?.sessionVariables || {};
        await supabaseAdmin
          .from("sessions")
          .update({ variables: { ...base, _history_summary: summaryEntry } })
          .eq("id", opts.sessionId)
          .eq("client_id", clientId);
      } catch {
        // Persistência de cache é best-effort
      }
    }

    const rem = formatRemainderCompact(remainderSlice);
    return rem ? `${summary} | Contexto adicional: ${rem}` : summary;
  } catch (err: any) {
    console.warn("[history-summary] falha gerando resumo do meio (não-fatal):", err?.message);
    return null;
  }
}

/** Invalida o cache de um contato (ex.: ao apagar a conversa). */
export function invalidateHistorySummary(clientId: string, remoteJid: string): void {
  MEM_CACHE.delete(`${clientId}:${remoteJid}`);
}
