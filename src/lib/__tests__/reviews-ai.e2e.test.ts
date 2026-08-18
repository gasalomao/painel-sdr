/**
 * E2E REAL do summarizeReviewsForLead contra Supabase + OpenRouter.
 * Só roda com E2E_REVIEWS_AI=1 (custa tokens reais — modelo free da OpenRouter).
 *
 *   $env:E2E_REVIEWS_AI="1"; npx vitest run src/lib/__tests__/reviews-ai.e2e.test.ts
 *
 * Pega (ou cria sintético) um lead com reviews_detalhes, roda o resumo com o
 * modelo free e valida o log em reviews_ai_logs.
 */
import { describe, it, expect } from "vitest";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { summarizeReviewsForLead } from "@/lib/reviews-ai";

const RUN = process.env.E2E_REVIEWS_AI === "1";
const MODEL = process.env.E2E_REVIEWS_AI_MODEL || "openrouter:z-ai/glm-5.2:free";
const PROMPT = "me fale os pontos fortes do negócio";

describe.skipIf(!RUN)("reviews-ai E2E real (Supabase + OpenRouter)", () => {
  it("resume avaliações com modelo free e loga em reviews_ai_logs (source=capture)", async () => {
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY ausente no .env.local").toBeTruthy();

    // 1) Lead real com reviews, ou cria sintético
    const { data: existing } = await supabaseAdmin
      .from("leads_extraidos")
      .select("id")
      .not("reviews_detalhes", "is", null)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    let leadId = existing?.id ?? null;
    if (!leadId) {
      const synthetic = {
        remoteJid: `e2e_${Date.now()}@s.whatsapp.net`,
        nome_negocio: "E2E Reviews AI Test",
        ramo_negocio: "padaria",
        avaliacao: 4.6,
        reviews: 2,
        reviews_detalhes: [
          { autor: "Ana", nota: 5, data: "2024", texto: "Pão quente excelente, atendimento nota dez." },
          { autor: "Rui", nota: 4, data: "2024", texto: "Bom café, mas fila demora no sábado." },
        ],
      };
      const { data: ins, error: insErr } = await supabaseAdmin
        .from("leads_extraidos")
        .insert(synthetic)
        .select("id")
        .single();
      if (insErr) throw new Error(`insert sintético falhou: ${insErr.message}`);
      leadId = ins!.id;
    }
    console.log("leadId:", leadId);

    // 2) Roda o resumo (force pega até cacheado)
    const res = await summarizeReviewsForLead({
      leadId: leadId!,
      model: MODEL,
      customPrompt: PROMPT,
      source: "capture",
      force: true,
    });
    if ("error" in res) throw new Error(`summarizeReviewsForLead: ${res.error}`);

    expect(res.resumo.length).toBeGreaterThan(10);
    expect(res.modelUsed).toBeTruthy();
    console.log("resumo:\n", res.resumo);

    // 3) Log persistiu com os metadados certos
    const { data: log, error: logErr } = await supabaseAdmin
      .from("reviews_ai_logs")
      .select("model, prompt, response, total_tokens, source")
      .eq("lead_id", leadId!)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (logErr) throw new Error(`reviews_ai_logs: ${logErr.message}`);
    expect(log).toBeTruthy();
    expect(log!.source).toBe("capture");
    expect(log!.model).toContain(res.modelUsed);
    expect(log!.response.length).toBeGreaterThan(10);
    console.log("log ok — model:", log!.model, "tokens:", log!.total_tokens);
  }, 120_000);
});
