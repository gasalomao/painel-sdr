/**
 * src/lib/sites/agreement-detector-constants.ts
 *
 * Constantes e tipos leves para o avaliador de aceite de prévia de site.
 * Seguro para importação em Client Components (zero dependências Node.js/servidor).
 */

export const DEFAULT_SITE_PREVIEW_EVAL_PROMPT = `Você é um classificador binário ultra-rápido e objetivo. Sua ÚNICA função é analisar as últimas mensagens de uma conversa de WhatsApp entre o atendente e um cliente e responder se o cliente CONCORDOU/ACEITOU receber ou ver uma prévia de site gratuita para a empresa dele.

Responda ESTRITAMENTE em formato JSON:
{"aceitou": true, "confianca": "alta", "motivo": "cliente disse que quer ver o site"}
ou
{"aceitou": false, "confianca": "alta", "motivo": "cliente apenas tirou dúvidas sobre preço"}

Regras estritas:
1. "aceitou" é true SOMENTE se o cliente expressar concordância clara (ex: "sim", "pode mandar", "quero ver", "pode fazer", "manda aí", "manda a prévia", "combinado", "pode criar", "com certeza", "manda no whatsapp").
2. Se o cliente apenas tirou dúvidas, fez perguntas, recusou ou a conversa ainda está no início sem proposta aceita, "aceitou" DEVE ser false.
3. Se houver dúvida ou falta de clareza, "aceitou" DEVE ser false.`;

export const DEFAULT_SITE_PREVIEW_PING_MESSAGE = `Oi! Tudo bem? Acabei de finalizar aqui no computador a prévia do site da {{nome_negocio}} e já subi no ar para teste. Você tá com o celular na mão agora para eu te mandar o link e você dar uma olhada rápida?`;

export interface AgreementEvaluationResult {
  agreed: boolean;
  confidence: "alta" | "baixa";
  reason: string;
  tokensUsed?: number;
  evaluatorMethod: "ai" | "heuristic_fallback";
}

export type ConversationMessage = {
  role: "user" | "agent" | "assistant" | "system";
  content: string;
};
