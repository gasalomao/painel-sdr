/**
 * PROBE AO VIVO — testa todos os modelos FREE do OpenRouter disponíveis na
 * chave configurada, com prompt mínimo. Reporta status real de cada um.
 * OPT-IN: LIVE_E2E=1 (npm test normal pula).
 */
import { describe, it, expect } from "vitest";
import { listAvailableOpenRouterModels } from "@/lib/openrouter-model-discovery";
import { getAiKeys } from "@/lib/ai-keys";
import { generateText } from "@/lib/ai-provider";

describe.skipIf(process.env.LIVE_E2E !== "1")("Probe modelos free OpenRouter", () => {
  it("testa cada modelo :free com prompt mínimo", async () => {
    const [models, keys] = await Promise.all([
      listAvailableOpenRouterModels(true),
      getAiKeys(),
    ]);
    expect(keys.openrouter).toBeTruthy();
    const free = models.filter((m) => m.id.endsWith(":free"));
    console.log(`[PROBE] ${free.length} modelos free. Testando...\n`);
    const ok: string[] = [];
    const failed: Array<{ id: string; err: string }> = [];
    for (const m of free) {
      const t0 = Date.now();
      try {
        const r = await generateText({
          modelRef: `openrouter:${m.id}`,
          system: "Responda apenas: OK",
          prompt: "Diga OK.",
          maxOutputTokens: 16,
          openrouterApiKey: keys.openrouter,
        });
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        const txt = (r.text || "").trim().slice(0, 40).replace(/\n/g, " ");
        console.log(`[PROBE] ✓ ${m.id} (${dt}s) → "${txt}"`);
        ok.push(m.id);
      } catch (e: any) {
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        const msg = String(e?.message || e).slice(0, 140);
        console.log(`[PROBE] ✗ ${m.id} (${dt}s) → ${msg}`);
        failed.push({ id: m.id, err: msg });
      }
    }
    console.log(`\n[PROBE] RESULTADO: ${ok.length}/${free.length} funcionando`);
    if (failed.length) {
      console.log("[PROBE] Falhados:");
      for (const f of failed) console.log(`[PROBE]   - ${f.id}: ${f.err}`);
    }
    expect(ok.length).toBeGreaterThan(0);
  }, 600000);
});
