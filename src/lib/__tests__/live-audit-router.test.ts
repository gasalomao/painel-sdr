/**
 * AUDIT AO VIVO — valida TODOS os modelRefs configurados no painel (combos,
 * modelo global, defaults por cliente, lead-intelligence) e mostra onde os
 * tokens estão sendo gastos. Sem segredos no output.
 */
import { describe, it } from "vitest";
import { getAiKeys } from "@/lib/ai-keys";
import { generateText } from "@/lib/ai-provider";
import { supabaseAdmin } from "@/lib/supabase_admin";

describe.skipIf(process.env.LIVE_E2E !== "1")("auditoria 9router", () => {
  it("testa cada modelRef da configuração", async () => {
    const k = await getAiKeys();
    const refs = new Set<string>();
    for (const c of k.aiCombos || []) {
      console.log(`[COMBO ${c.id}] passos: ${(c.models || []).map((m: any) => `${m.modelRef}${m.enabled ? "" : " (off)"}`).join(" → ")}`);
      for (const m of c.models || []) if (m.enabled) refs.add(m.modelRef);
    }
    const { data: cfg } = await supabaseAdmin!.from("ai_organizer_config").select("model").eq("id", 1).maybeSingle();
    if (cfg?.model) refs.add(cfg.model);
    const { data: clients } = await supabaseAdmin!.from("clients").select("default_ai_model").limit(10);
    for (const cl of clients || []) if (cl.default_ai_model) refs.add(cl.default_ai_model);
    const { data: li } = await supabaseAdmin!.from("app_settings").select("value").eq("key", "lead_intelligence_model").maybeSingle();
    if (li?.value) refs.add(li.value);

    console.log(`\n[AUDIT] ${refs.size} refs únicas. Testando com prompt mínimo...\n`);
    for (const ref of Array.from(refs)) {
      if (ref.startsWith("gateway:")) {
        console.log(`[AUDIT] ✗ ${ref} → GATEWAY NÃO CONFIGURADO (falha garantida)`);
        continue;
      }
      const t0 = Date.now();
      try {
        const r = await generateText({
          modelRef: ref,
          prompt: "Responda apenas: OK",
          maxOutputTokens: 16,
          geminiApiKey: k.gemini,
          openrouterApiKey: k.openrouter,
        });
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        const txt = (r.text || "").trim().slice(0, 30).replace(/\n/g, " ");
        const tok = r.usage?.totalTokens ?? "?";
        console.log(`[AUDIT] ✓ ${ref} (${dt}s, ${tok} tokens) → "${txt}"`);
      } catch (e: any) {
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[AUDIT] ✗ ${ref} (${dt}s) → ${String(e?.message || e).slice(0, 110)}`);
      }
    }

    // Gasto real dos últimos 7 dias por fonte+modelo
    const since = new Date(Date.now() - 7 * 24 * 3600e3).toISOString();
    const { data: spend } = await supabaseAdmin!
      .from("ai_token_usage")
      .select("source, model, prompt_tokens, completion_tokens, total_tokens, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(2000);
    const agg: Record<string, { calls: number; prompt: number; completion: number }> = {};
    let totalAll = 0;
    for (const r of spend || []) {
      const key = `${r.source} · ${r.model}`;
      agg[key] ||= { calls: 0, prompt: 0, completion: 0 };
      agg[key].calls++;
      agg[key].prompt += Number(r.prompt_tokens || 0);
      agg[key].completion += Number(r.completion_tokens || 0);
      totalAll += Number(r.total_tokens || 0);
    }
    console.log(`\n[GASTO 7d] total ~${totalAll.toLocaleString("pt-BR")} tokens em ${(spend || []).length} chamadas:`);
    const rows = Object.entries(agg).sort((a, b) => (b[1].prompt + b[1].completion) - (a[1].prompt + a[1].completion));
    for (const [k2, v] of rows.slice(0, 12)) {
      console.log(`[GASTO] ${k2}: ${v.calls}x · prompt ${v.prompt.toLocaleString("pt-BR")} · saída ${v.completion.toLocaleString("pt-BR")}`);
    }
  }, 300000);
});
