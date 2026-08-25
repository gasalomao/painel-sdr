/**
 * Transcrição de áudio via OpenRouter (modelos multimodal com input de áudio).
 *
 * Estratégia de fallback 9Router-style:
 *   1. Cadeia de modelos: GRÁTIS primeiro (listOpenRouterAudioModels), cap em 8.
 *   2. Pra cada modelo, tenta TODAS as chaves salvas (rotação em 429/402/401).
 *   3. Falhou modelo+chave → próximo modelo. Nenhum funcionou → null
 *      (o caller cai pro whisper/gemini, espelho do "falhou Gemini → Whisper").
 *
 * API: POST https://openrouter.ai/api/v1/chat/completions (OpenAI-compatible)
 * com content part { type: "input_audio", input_audio: { data, format } }.
 */

import { getAiKeys } from "@/lib/ai-keys";
import {
  listOpenRouterAudioModels,
  isFreePricing,
  type OpenRouterModel,
} from "@/lib/openrouter-model-discovery";

const MAX_MODELS = 8;
/**
 * Webhook do WhatsApp tem ~30s de janela (Evolution). Orçamento total da
 * cadeia OpenRouter: 15s hard cap — o timeout por chamada é encurtado pro que
 * sobrar do orçamento, então nunca estoura.
 */
const BUDGET_MS = 15_000;
const PER_CALL_MS = 12_000;

const PROMPT =
  "Transcreva esse áudio em Português (BR). Devolva APENAS o texto transcrito, sem aspas, sem prefixo, sem explicação. Se não entender, devolva '[áudio inaudível]'.";

/** Deriva o `format` exigido pelo input_audio do mimetype (WhatsApp manda ogg/opus). */
export function audioFormatFromMime(mime: string | null | undefined): string {
  const sub = (mime || "").split(";")[0].split("/")[1]?.toLowerCase() || "";
  if (sub === "mpeg" || sub === "mp3") return "mp3";
  if (sub === "oga" || sub === "opus") return "ogg";
  if (sub === "wav" || sub === "wave" || sub === "x-wav") return "wav";
  if (sub === "flac" || sub === "x-flac") return "flac";
  if (sub === "aac") return "aac";
  if (sub === "webm") return "webm";
  if (sub === "m4a" || sub === "x-m4a" || sub === "mp4") return "m4a";
  return "ogg";
}

/**
 * Constrói a cadeia de tentativas: grátis primeiro, depois pagos; no máx
 * MAX_MODELS modelos. Pura — testável sem rede.
 */
export function buildAudioAttemptChain(
  models: Array<Pick<OpenRouterModel, "id" | "pricing">>,
  max = MAX_MODELS,
): string[] {
  const free = models.filter((m) => isFreePricing(m.pricing)).map((m) => m.id);
  const paid = models.filter((m) => !isFreePricing(m.pricing)).map((m) => m.id);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...free, ...paid]) {
    if (!seen.has(id)) { seen.add(id); out.push(id); }
    if (out.length >= max) break;
  }
  return out;
}

export type OpenRouterTranscription = { text: string; model: string };

async function callOnce(
  modelId: string,
  apiKey: string,
  cleanBase64: string,
  format: string,
  timeoutMs: number,
): Promise<string | null> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://painel-sdr.local",
      "X-Title": "Painel SDR",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "input_audio", input_audio: { data: cleanBase64, format } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  // 401/402/429 = problema de CHAVE (próxima chave pode resolver).
  if (res.status === 401 || res.status === 402 || res.status === 429) {
    const err: any = new Error(`openrouter ${res.status}`);
    err.keyLevel = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  const text = String(json?.choices?.[0]?.message?.content ?? "").trim();
  return text || null;
}

/**
 * Tenta transcrever com a cadeia completa (modelo × chave). Retorna na 1ª
 * sucesso; null se tudo falhar ou não houver chave/modelo configurado.
 */
export async function transcribeAudioWithOpenRouter(
  base64: string,
  mimetype: string,
): Promise<OpenRouterTranscription | null> {
  try {
    const [keysInfo, audioModels] = await Promise.all([
      getAiKeys(),
      listOpenRouterAudioModels(),
    ]);
    const keys = keysInfo.openrouterKeys.filter(Boolean);
    const chain = buildAudioAttemptChain(audioModels);
    if (!keys.length || !chain.length) return null;

    const cleanBase64 = base64.replace(/^data:.*?;base64,/, "");
    const format = audioFormatFromMime(mimetype);
    const start = Date.now();

    for (const modelId of chain) {
      for (const apiKey of keys) {
        // Orçamento global: não começa nova chamada sem tempo restante mínimo.
        const remaining = BUDGET_MS - (Date.now() - start);
        if (remaining < 500) return null;
        try {
          const text = await callOnce(modelId, apiKey, cleanBase64, format, Math.min(PER_CALL_MS, remaining));
          if (text) return { text, model: modelId };
        } catch (err: any) {
          console.warn(
            `[openrouter-transcribe] ${modelId} falhou${err?.keyLevel ? " (chave)" : ""}:`,
            err?.message?.slice(0, 160),
          );
        }
      }
    }
    return null;
  } catch (err: any) {
    console.warn("[openrouter-transcribe] Erro geral:", err?.message);
    return null;
  }
}
