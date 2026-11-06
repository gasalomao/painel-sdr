/**
 * src/lib/sites/agreement-detector.ts
 *
 * Avaliador leve de aceite de prévia de site para agentes IA (WhatsApp).
 * Analisa as últimas mensagens entre atendente e lead com consumo mínimo de tokens
 * (~50 tokens por chamada) para identificar com alta precisão se o cliente concordou
 * em receber/visualizar uma prévia gratuita do site.
 */

import {
  DEFAULT_SITE_PREVIEW_EVAL_PROMPT,
  DEFAULT_SITE_PREVIEW_PING_MESSAGE,
  type AgreementEvaluationResult,
  type ConversationMessage,
} from "./agreement-detector-constants";

export {
  DEFAULT_SITE_PREVIEW_EVAL_PROMPT,
  DEFAULT_SITE_PREVIEW_PING_MESSAGE,
  type AgreementEvaluationResult,
  type ConversationMessage,
};

/** Heurística determinística para fallback ou validação rápida */
const AFFIRMATIVE_REGEX =
  /\b(sim|quero|pode|manda|topo|com certeza|claro|fechado|bora|beleza|combinado|show|pode ser|manda aí|manda aqui|manda a prévia|quero ver|quero sim|gostaria|pode criar|pode fazer|pode montar|show pode mandar|beleza pode|manda lá|manda no whats|manda no whatsapp)\b/i;

const NEGATIVE_REGEX =
  /\b(não|não quero|não tenho interesse|já temos site|já tenho site|depois vejo|agora não|sem interesse|não preciso)\b/i;

/**
 * Avalia as últimas mensagens da conversa para detectar se o cliente aceitou a prévia do site.
 */
export async function evaluatePreviewAgreement(opts: {
  messages: ConversationMessage[];
  customPrompt?: string | null;
  modelRef?: string | null;
}): Promise<AgreementEvaluationResult> {
  const { messages, customPrompt, modelRef } = opts;

  // Filtra e pega as últimas 5 mensagens mais relevantes
  const recent = (messages || [])
    .filter((m) => m && typeof m.content === "string" && m.content.trim().length > 0)
    .slice(-5);

  if (recent.length === 0) {
    return {
      agreed: false,
      confidence: "baixa",
      reason: "Sem mensagens para avaliar",
      evaluatorMethod: "heuristic_fallback",
    };
  }

  const lastUserMsg = [...recent].reverse().find((m) => m.role === "user");
  const lastUserText = lastUserMsg?.content?.trim() || "";

  // Heurística rápida de descarte imediato (se o cliente disse explicitamente "não", não gasta token)
  if (NEGATIVE_REGEX.test(lastUserText) && !AFFIRMATIVE_REGEX.test(lastUserText)) {
    return {
      agreed: false,
      confidence: "alta",
      reason: "Cliente recusou ou expressou desinteresse explicitamente",
      evaluatorMethod: "heuristic_fallback",
    };
  }

  // Prepara o contexto compacto das mensagens para a IA
  const formattedConversation = recent
    .map((m) => {
      const sender = m.role === "user" ? "Cliente" : "Atendente";
      return `[${sender}]: ${m.content.slice(0, 300)}`;
    })
    .join("\n");

  const systemPrompt =
    customPrompt && customPrompt.trim().length > 20
      ? customPrompt.trim()
      : DEFAULT_SITE_PREVIEW_EVAL_PROMPT;

  const targetModel =
    modelRef && modelRef.trim().length > 0
      ? modelRef.trim()
      : process.env.DEFAULT_FAST_MODEL || "gemini-2.0-flash";

  try {
    const { generateText } = await import("@/lib/ai-provider");
    const aiRes = await generateText({
      modelRef: targetModel,
      system: systemPrompt,
      prompt: `Analise as últimas mensagens abaixo e responda APENAS o JSON:\n\n${formattedConversation}`,
      temperature: 0.1,
      maxOutputTokens: 80,
      reasoningMode: 0,
    });

    const rawText = (aiRes.text || "").trim();
    const jsonMatch = rawText.match(/\{[\s\S]*?\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const agreed = Boolean(parsed.aceitou ?? parsed.agreed);
      const confidence = parsed.confianca ?? parsed.confidence ?? "alta";
      const reason = parsed.motivo ?? parsed.reason ?? "Avaliação por IA";

      return {
        agreed,
        confidence: confidence === "baixa" ? "baixa" : "alta",
        reason: String(reason),
        evaluatorMethod: "ai",
        tokensUsed: aiRes.usage?.totalTokens ?? 0,
      };
    }
  } catch (err: any) {
    console.warn("[agreement-detector] Avaliador IA falhou, acionando fallback heurístico:", err?.message);
  }

  // Fallback heurístico resiliente caso a IA falhe ou não devolva JSON
  const agreedHeuristic =
    AFFIRMATIVE_REGEX.test(lastUserText) && !NEGATIVE_REGEX.test(lastUserText);

  return {
    agreed: agreedHeuristic,
    confidence: "baixa",
    reason: `Fallback heurístico baseado na mensagem: "${lastUserText.slice(0, 50)}"`,
    evaluatorMethod: "heuristic_fallback",
  };
}
