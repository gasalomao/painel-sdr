import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { transcribeAudioWithWhisper, getWhisperStatus } from "../whisper-manager";

/**
 * E2E REAL (sem mock) — prova que o pipeline whisper.cpp + ffmpeg funciona.
 * Skipa automaticamente em máquina sem whisper instalado (CI).
 */
// OPT-IN: só roda com RUN_LIVE_TESTS=1 — spawn do whisper.cpp + áudio real.
const d = process.env.RUN_LIVE_TESTS === "1" ? describe : describe.skip;
d("whisper E2E real (sem mock)", () => {
  it("transcreve real-audio.ogg de verdade", async () => {
    const status = await getWhisperStatus();
    if (!status.installed) return; // sem whisper local → skip silencioso

    const oggPath = path.join(process.cwd(), ".whisper", "test-audios", "real-audio.ogg");
    if (!fs.existsSync(oggPath)) return; // fixture ausente → skip

    const base64 = fs.readFileSync(oggPath).toString("base64");
    const result = await transcribeAudioWithWhisper(base64, "audio/ogg; codecs=opus");
    console.log("TRANSCRICAO REAL:", JSON.stringify(result));
    expect(result).toBeTruthy();
  }, 180000);
});
