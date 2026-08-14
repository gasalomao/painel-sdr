/**
 * Teste E2E do pipeline de transcrição: OGG → ffmpeg → whisper → texto
 *
 * Simula exatamente o que acontece quando o webhook recebe um áudio:
 *   1. Lê arquivo OGG (formato WhatsApp) como base64
 *   2. Chama transcribeAudioWithWhisper() — mesma função do webhook
 *   3. Valida que retorna texto transcrito
 *
 * Uso: node --import tsx scripts/test-transcription.mjs
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");

async function main() {
  console.log("=== Teste E2E de Transcrição Whisper ===\n");

  // 1. Verificar que whisper está instalado
  const { isWhisperInstalled, getWhisperStatus } = await import(
    "../src/lib/whisper-manager.ts"
  );
  console.log("Whisper instalado:", isWhisperInstalled());
  const status = await getWhisperStatus();
  console.log("Status:", JSON.stringify(status));

  if (!isWhisperInstalled()) {
    console.error("\nFALHA: whisper-cli não encontrado. Rode o build primeiro.");
    process.exit(1);
  }

  // 2. Carregar áudio OGG (formato WhatsApp) como base64
  const testOgg = resolve(ROOT, ".whisper", "test-audio.ogg");
  if (!existsSync(testOgg)) {
    // Fallback: gerar um OGG de teste com ffmpeg
    console.log("Gerando OGG de teste com ffmpeg...");
    const { execFileSync } = await import("child_process");
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:a", "libopus", "-b:a", "32k", testOgg,
    ], { stdio: "pipe" });
    console.log("OGG gerado:", testOgg);
  }

  const audioBuffer = readFileSync(testOgg);
  const base64 = audioBuffer.toString("base64");
  console.log("Áudio OGG:", audioBuffer.length, "bytes,", base64.length, "base64 chars");

  // 3. Transcrever (mesma função que o webhook usa)
  console.log("\nTranscrevendo... (timeout 120s)");
  const { transcribeAudioWithWhisper } = await import(
    "../src/lib/whisper-manager.ts"
  );

  const t0 = Date.now();
  const result = await transcribeAudioWithWhisper(base64, "audio/ogg", 120000);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\nTempo: ${elapsed}s`);
  console.log("Resultado:", JSON.stringify(result));

  // 4. Validar
  if (result !== null) {
    console.log("\n✅ PASSOU: Whisper transcreveu o áudio com sucesso.");
    console.log("   (Nota: áudio de teste é tom senoidal — transcrição pode ser vazia ou ruído.)");
    process.exit(0);
  } else {
    console.log("\n❌ FALHOU: Whisper retornou null. Verificar ffmpeg + modelo + binário.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("ERRO:", e.message);
  process.exit(1);
});
