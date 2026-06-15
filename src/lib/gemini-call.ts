/**
 * Wrapper resiliente pra chamadas Gemini. Detecta 404 "model no longer available"
 * e auto-tenta com o melhor modelo descoberto via API.
 *
 * Por quê: o endpoint `/v1beta/models` da Google fica DESATUALIZADO. Modelos
 * preview que foram despublicados ainda aparecem na lista, mas `generateContent`
 * retorna 404. A única fonte de verdade é a chamada real — então tentamos, e
 * se 404 do tipo "modelo morto", retentamos com o melhor flash GA descoberto.
 *
 * Bonus: opcionalmente persiste o modelo "vivo" no DB pra próxima chamada já
 * usar o certo (evita 1 roundtrip extra por mensagem). Caller decide.
 */

import type { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import { pickBestFlashModel } from "@/lib/gemini-model-discovery";

const DEAD_MODEL_PATTERNS = [
  /no longer available/i,
  /not found/i,
  /\b404\b/,
  /is not supported/i,
];

export function isDeadModelError(err: any): boolean {
  const msg = String(err?.message || err || "");
  // Só conta como "modelo morto" se a mensagem cita o endpoint generateContent
  // ou explicitamente "no longer available". 404 de outras causas (auth, quota)
  // não deve disparar fallback.
  if (/no longer available/i.test(msg)) return true;
  if (/\b404\b/.test(msg) && /generateContent|models\//i.test(msg)) return true;
  return false;
}

/**
 * Executa uma chamada Gemini com retry automático se o modelo estiver morto.
 *
 * @param genAI instância já configurada
 * @param requestedModel modelo que o caller pediu (vem do DB)
 * @param buildAndRun função que recebe um GenerativeModel e roda a chamada.
 *                    DEVE ser idempotente — pode ser invocada 2x em caso de retry.
 * @param modelOpts opções pra passar pro getGenerativeModel (tools, systemInstruction, etc)
 *
 * Retorna: { result, modelUsed } onde modelUsed pode ser ≠ requestedModel se houve fallback.
 */
export async function callGeminiWithFallback<T>(
  genAI: GoogleGenerativeAI,
  requestedModel: string,
  buildAndRun: (model: GenerativeModel) => Promise<T>,
  modelOpts: any = {}
): Promise<{ result: T; modelUsed: string; didFallback: boolean }> {
  // Primeira tentativa: modelo pedido
  try {
    const model = genAI.getGenerativeModel({ model: requestedModel, ...modelOpts });
    const result = await buildAndRun(model);
    return { result, modelUsed: requestedModel, didFallback: false };
  } catch (err) {
    if (!isDeadModelError(err)) throw err;

    // Modelo morto — descobre o melhor disponível e tenta de novo
    const fallback = await pickBestFlashModel();
    if (!fallback || fallback === requestedModel) {
      // Sem alternativa real — propaga erro original
      throw err;
    }
    console.warn(
      `[gemini-call] "${requestedModel}" retornou 404. Retentando com "${fallback}".`
    );
    const model = genAI.getGenerativeModel({ model: fallback, ...modelOpts });
    const result = await buildAndRun(model);
    return { result, modelUsed: fallback, didFallback: true };
  }
}
