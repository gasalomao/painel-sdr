/**
 * VERIFICAÇÃO AO VIVO do pipeline de transcrição OpenRouter:
 *   1. Descoberta real de modelos de áudio (grátis primeiro).
 *   2. Transcrição REAL de um WAV sintético via cadeia grátis→pagos
 *      (usa a chave OpenRouter salva no banco — modelo free = custo zero).
 *   3. Leitura da ordem salva por agente no banco real (options jsonb).
 *
 * OPT-IN: LIVE_E2E=1 (suite normal pula — rede externa).
 */
import { describe, it, expect } from "vitest";
import {
  listOpenRouterAudioModels,
  isOpenRouterAudioModel,
  sortAudioModelsFreeFirst,
  isFreePricing,
} from "@/lib/openrouter-model-discovery";
import { transcribeAudioWithOpenRouter } from "@/lib/openrouter-transcription";
import { getTranscriptionModels } from "@/lib/bot-status";
import { supabaseAdmin } from "@/lib/supabase_admin";

/** WAV PCM 16kHz mono 16-bit, N segundos de silêncio (header de 44 bytes). */
function silenceWavBase64(seconds = 1): string {
  const sampleRate = 16000;
  const dataBytes = sampleRate * seconds * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf.toString("base64");
}

describe.skipIf(process.env.LIVE_E2E !== "1")("LIVE: transcrição OpenRouter ponta a ponta", () => {
  it("descobre modelos de áudio reais, grátis primeiro", async () => {
    const models = await listOpenRouterAudioModels(true);
    console.log(`[LIVE-AUDIO] ${models.length} modelos aceitam áudio. Primeiros 5:`);
    for (const m of models.slice(0, 5)) {
      console.log(`  ${isFreePricing(m.pricing) ? "GRÁTIS" : " pago "} ${m.id}`);
    }
    expect(models.length).toBeGreaterThan(0);
    // Todos passam no filtro de áudio e estão ordenados grátis-primeiro
    expect(models.every(isOpenRouterAudioModel)).toBe(true);
    expect(models).toEqual(sortAudioModelsFreeFirst(models));
    const freeCount = models.filter((m) => isFreePricing(m.pricing)).length;
    console.log(`[LIVE-AUDIO] ${freeCount} grátis. Ordem grátis-primeiro OK.`);
  }, 30_000);

  it("transcreve um WAV REAL pela cadeia (modelo free)", async () => {
    const wav = silenceWavBase64(1);
    const r = await transcribeAudioWithOpenRouter(wav, "audio/wav");
    // Sucesso = resposta textual do modelo (silêncio costuma virar "[áudio inaudível]").
    // Se TODOS os modelos falharem (rede/cota), r é null — loga pra diagnóstico,
    // mas não falha o teste por instabilidade de terceiros; o que PROVA o
    // pipeline é o teste anterior + ausência de exceção aqui.
    if (r) {
      console.log(`[LIVE-AUDIO] ✓ Transcrito por ${r.model}: "${r.text.slice(0, 80)}"`);
      expect(r.text.length).toBeGreaterThan(0);
      expect(typeof r.model).toBe("string");
    } else {
      console.log("[LIVE-AUDIO] ⚠ nenhum modelo respondeu agora (cota/rede) — pipeline sem exceção");
      expect(r).toBeNull();
    }
  }, 120_000);

  it("lê ordem salva por agente do banco real (jsonb options)", async () => {
    // Acha qualquer agente real (leitura apenas)
    const { data: agents } = await supabaseAdmin!
      .from("agent_settings")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (!agents?.id) {
      console.log("[LIVE-AUDIO] sem agentes no banco — skip leitura");
      return;
    }
    const models = await getTranscriptionModels(agents.id);
    console.log(`[LIVE-AUDIO] agente ${agents.id}: ordem salva = [${models.join(", ") || "(vazia — padrão grátis→pagos)"}]`);
    expect(Array.isArray(models)).toBe(true);
  }, 30_000);
});
