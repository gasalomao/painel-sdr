import fs from "fs";
import path from "path";

const _cachedSamples: string[] = [];

/**
 * Retorna uma nota de voz Opus real (base64) com áudio e waveform autênticos para WhatsApp PTT.
 */
export function getRandomWarmupVoiceBase64(): string {
  if (_cachedSamples.length === 0) {
    const files = [
      path.join(process.cwd(), "public", "warmup_voice_sample.ogg"),
      path.join(process.cwd(), "public", "warmup_voice_sample2.ogg"),
      path.join(process.cwd(), "public", "warmup_voice_sample3.ogg"),
    ];

    for (const file of files) {
      try {
        if (fs.existsSync(file)) {
          const buf = fs.readFileSync(file);
          if (buf.length > 500) {
            _cachedSamples.push(buf.toString("base64"));
          }
        }
      } catch {}
    }
  }

  if (_cachedSamples.length > 0) {
    const idx = Math.floor(Math.random() * _cachedSamples.length);
    return _cachedSamples[idx];
  }

  // Fallback seguro caso os arquivos não sejam encontrados
  return "";
}
