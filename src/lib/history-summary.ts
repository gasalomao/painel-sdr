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
import { generateText } from "@/lib/ai-provider";
import { getAiKeys } from "@/lib/ai-keys";
import { createHmac } from "crypto";

// Cache em memória (process): remoteJid → { hash, summary }.
// Persistência no DB seria mais robusta, mas em memória já evita regerar a cada
// turno (só regenera quando o conteúdo do meio muda). Restart = cache frio,
// o que é OK (primeira msg após restart regera uma vez).
const MEM_CACHE = new Map<string, { hash: string; summary: string; at: number }>();
const MEM_TTL_MS = 60 * 60 * 1000; // 1h — depois revalida (meio pode ter mudado).

/**
 * Hash estável do conteúdo das mensagens do meio. Se mudou (novas msgs entraram
 * no intervalo), regera; senão, reaproveita o resumo cacheado.
 */
function contentHash(msgs: Array<{ sender_type?: string; content?: string }>): string {
  const text = msgs.map((m) => `${m.sender_type || ""}:${(m.content || "").slice(0, 200)}`).join("|");
  return createHmac("sha1", "history-summary").update(text).digest("hex").slice(0, 24);
}

/**
 * Resolve a modelRef + api key do modelo MAIS BARATO disponível pra gerar o
 * resumo. Prefere Gemini (grátis/flash); fallback OpenRouter; fallback gateway.
 * Nunca usa um modelo de raciocínio (seria contraditório com o objetivo de economizar).
 */
async function cheapModelForSummary(): Promise<{
  modelRef: string;
  geminiApiKey?: string | null;
  openrouterApiKey?: string | null;
} | null> {
  const keys = await getAiKeys().catch(() => null);
  if (keys?.gemini) {
    // Gemini 2.5 Flash: rápido, barato, ótimo pra resumo.
    return { modelRef: "gemini-2.5-flash", geminiApiKey: keys.gemini };
  }
  if (keys?.openrouter) {
    // Modelo leve do OpenRouter (grátis ou barato).
    return {
      modelRef: "openrouter:meta-llama/llama-3.1-8b-instruct",
      openrouterApiKey: keys.openrouter,
    };
  }
  return null;
}

/**
 * Gera o resumo das mensagens do MEIO de uma conversa. Cacheado por conteúdo
 * (hash) + TTL em memória. Retorna o texto do resumo, ou `null` se não houver
 * meio pra resumir / se falhar (o caller cai no placeholder antigo como fallback).
 *
 * @param remoteJid  Identificador do contato (chave do cache).
 * @param middleMsgs Mensagens intermediárias (entre as 3 primeiras e 12 últimas).
 */
export async function summarizeMiddleMessages(
  remoteJid: string,
  middleMsgs: Array<{ sender_type?: string; content?: string }>,
): Promise<string | null> {
  if (!middleMsgs || middleMsgs.length === 0) return null;

  const hash = contentHash(middleMsgs);
  const cached = MEM_CACHE.get(remoteJid);
  if (cached && cached.hash === hash && Date.now() - cached.at < MEM_TTL_MS) {
    return cached.summary; // cache hit — mesmo conteúdo, reaproveita.
  }

  const model = await cheapModelForSummary();
  if (!model) return null; // sem modelo disponível — caller usa placeholder.

  // Monta o texto das mensagens do meio (cortadas p/ não estourar o prompt).
  const lines = middleMsgs.slice(0, 60).map((m, i) => {
    const who = m.sender_type === "customer" ? "Cliente" : "IA";
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
      geminiApiKey: model.geminiApiKey,
      openrouterApiKey: model.openrouterApiKey,
      maxOutputTokens: 300,
    });
    const summary = (result.text || "").trim();
    if (!summary) return null;
    MEM_CACHE.set(remoteJid, { hash, summary, at: Date.now() });
    return summary;
  } catch (err: any) {
    console.warn("[history-summary] falha gerando resumo do meio (não-fatal):", err?.message);
    return null;
  }
}

/** Invalida o cache de um contato (ex.: ao apagar a conversa). */
export function invalidateHistorySummary(remoteJid: string): void {
  MEM_CACHE.delete(remoteJid);
}

/** DB: persistência opcional do resumo por contato (se quisermos sobreviver a restart). */
export async function getPersistedSummary(remoteJid: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from("sessions")
      .select("variables")
      .eq("contact_id", `(select id from contacts where phone_number = '${remoteJid}')` as any)
      .maybeSingle();
    const v = (data as any)?.variables;
    return v?.history_summary || null;
  } catch {
    return null;
  }
}
