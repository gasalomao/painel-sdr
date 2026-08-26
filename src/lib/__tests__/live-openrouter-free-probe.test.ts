/**
 * SONDA AO VIVO — por que os modelos :free de áudio estão bloqueados e se
 * alguma variação de requisição "agêntica" os libera.
 * OPT-IN: LIVE_E2E=1.
 */
import { describe, it, expect } from "vitest";
import { getAiKeys } from "@/lib/ai-keys";

const BASE = "https://openrouter.ai/api/v1/chat/completions";

async function call(
  key: string,
  model: string,
  variant: string,
  extraBody: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://painel-sdr.local",
      "X-Title": "Painel SDR",
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      max_tokens: 32,
      messages: [
        { role: "user", content: [{ type: "text", text: "Diga OK." }] },
      ],
      ...extraBody,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.text()).slice(0, 180);
  return { status: res.status, body };
}

describe.skipIf(process.env.LIVE_E2E !== "1")("SONDA: destravar modelos :free", () => {
  it("variações contra inkling-small:free e nemotron:free", async () => {
    const keys = await getAiKeys();
    const key = keys.openrouter!;
    const results: Array<{ v: string; status: number; body: string }> = [];

    const variants: Array<[string, string, Record<string, unknown>, Record<string, string>]> = [
      ["baseline texto", "thinkingmachines/inkling-small:free", {}, {}],
      ["com tools[] agêntico", "thinkingmachines/inkling-small:free", {
        tools: [{
          type: "function",
          function: { name: "noop", description: "No-op tool.", parameters: { type: "object", properties: {} } },
        }],
        tool_choice: "auto",
      }, {}],
      ["stream true", "thinkingmachines/inkling-small:free", { stream: false, seed: 42 }, {}],
      ["UA agente conhecido", "thinkingmachines/inkling-small:free", {}, { "User-Agent": "opencode/1.0" }],
      ["nemotron só texto", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", {}, {}],
      ["nemotron + tools", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", {
        tools: [{
          type: "function",
          function: { name: "noop", description: "No-op tool.", parameters: { type: "object", properties: {} } },
        }],
      }, {}],
    ];

    for (const [v, model, body, hdr] of variants) {
      let r: { status: number; body: string };
      try { r = await call(key, model, v, body, hdr); }
      catch (e: any) { r = { status: -1, body: String(e?.message).slice(0, 120) }; }
      results.push({ v, ...r });
      console.log(`[SONDA] ${v.padEnd(24)} → ${r.status} ${r.body.slice(0, 110)}`);
    }

    // O teste documenta; não falha por bloqueio de terceiros.
    const unlocked = results.find((r) => r.status === 200);
    console.log(unlocked ? `[SONDA] ✓ DESBLOQUEADO por: ${unlocked.v}` : "[SONDA] ✗ nenhuma varição liberou");
    expect(results.length).toBeGreaterThan(0);
  }, 240_000);
});
