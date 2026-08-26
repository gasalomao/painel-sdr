/**
 * SONDA 2 — confirma se UA PRÓPRIO (honesto) libera os :free e se funciona
 * com ÁUDIO real (WAV sintético), não só texto.
 * OPT-IN: LIVE_E2E=1.
 */
import { describe, it, expect } from "vitest";
import { getAiKeys } from "@/lib/ai-keys";

const BASE = "https://openrouter.ai/api/v1/chat/completions";

function silenceWavBase64(seconds = 1): string {
  const sampleRate = 16000;
  const dataBytes = sampleRate * seconds * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataBytes, 40);
  return buf.toString("base64");
}

async function callAudio(key: string, model: string, ua: string): Promise<{ status: number; body: string }> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": ua,
      "HTTP-Referer": "https://painel-sdr.local",
      "X-Title": "Painel SDR",
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Transcreva esse áudio em Português (BR). Devolva APENAS o texto." },
          { type: "input_audio", input_audio: { data: silenceWavBase64(1), format: "wav" } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: (await res.text()).slice(0, 220) };
}

describe.skipIf(process.env.LIVE_E2E !== "1")("SONDA 2: UA próprio + áudio real nos :free", () => {
  it("testa UA customizado com input_audio", async () => {
    const keys = await getAiKeys();
    const key = keys.openrouter!;
    for (const [model, ua] of [
      ["thinkingmachines/inkling-small:free", "PainelSDR-Agent/1.0"],
      ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "PainelSDR-Agent/1.0"],
      ["thinkingmachines/inkling-small:free", "PainelSDR/1.0"],
    ] as Array<[string, string]>) {
      let r: { status: number; body: string };
      try { r = await callAudio(key, model, ua); }
      catch (e: any) { r = { status: -1, body: String(e?.message).slice(0, 140) }; }
      console.log(`[SONDA2] ${ua} :: ${model.split("/")[1].padEnd(42)} → ${r.status} ${r.body.slice(0, 130)}`);
      if (r.status === 200) {
        try {
          const j = JSON.parse(r.body.length >= 220 ? "" : r.body);
        } catch { /* body truncado, ok */ }
      }
    }
    expect(true).toBe(true);
  }, 240_000);
});
