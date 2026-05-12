/**
 * /api/leads/analyze
 *
 *   POST { lead_id, force? }                → analisa 1 lead, retorna briefing
 *   POST { lead_ids: number[], force? }     → batch (analisa em paralelo, chunks de 5)
 *
 * Reutilizado por:
 *   - /leads (modal "Analisar com IA" no card do kanban)
 *   - /automacao (botão "Analisar leads desta automação" antes de iniciar)
 *   - /disparo (mesmo, antes de criar campanha)
 *
 * Cache: 30 dias. force=true ignora.
 *
 * API key do Gemini vem da `ai_organizer_config` (chave central, igual o
 * resto do painel). Se não tiver, devolve erro com mensagem clara.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { analyzeLead } from "@/lib/lead-intelligence";

export const dynamic = "force-dynamic";
// Análise pode demorar 5-15s por lead (fetch site + Gemini). Em batch grande,
// damos margem confortável até o limite do Next standalone.
export const maxDuration = 300;

async function getApiKey(): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("ai_organizer_config")
    .select("api_key")
    .eq("id", 1)
    .maybeSingle();
  return data?.api_key || null;
}

/** Modelo configurado em /configuracoes pra Lead Intelligence. Default: 2.5-flash. */
async function getConfiguredModel(): Promise<string> {
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", "lead_intelligence_model")
      .maybeSingle();
    return data?.value || "gemini-2.5-flash";
  } catch {
    return "gemini-2.5-flash";
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const force = !!body.force;
    // Prioridade: model do body > app_settings > default. Permite override por
    // chamada (ex: futuro batch que queira usar 2.5-pro pra qualidade extra).
    const model = body.model || (await getConfiguredModel());

    const apiKey = await getApiKey();
    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "API Key Gemini não configurada. Salve em Configurações → Organizador IA." },
        { status: 400 },
      );
    }

    // ───────── Modo single ─────────
    if (body.lead_id) {
      const r = await analyzeLead({ leadId: Number(body.lead_id), apiKey, model, force });
      if ("error" in r) return NextResponse.json({ success: false, error: r.error }, { status: 500 });
      return NextResponse.json({ success: true, result: r });
    }

    // ───────── Modo batch ─────────
    if (Array.isArray(body.lead_ids) && body.lead_ids.length > 0) {
      const ids = body.lead_ids.map(Number).filter(Boolean).slice(0, 200); // hard cap
      const results: any[] = [];
      const errors: { lead_id: number; error: string }[] = [];

      // Chunks de 5 em paralelo — equilíbrio entre velocidade e quota Gemini.
      const CHUNK = 5;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        const settled = await Promise.allSettled(
          batch.map(id => analyzeLead({ leadId: id, apiKey, model, force })),
        );
        settled.forEach((s, idx) => {
          if (s.status === "fulfilled") {
            const r = s.value;
            if ("error" in r) errors.push({ lead_id: batch[idx], error: r.error });
            else results.push(r);
          } else {
            errors.push({ lead_id: batch[idx], error: String(s.reason).slice(0, 200) });
          }
        });
      }

      return NextResponse.json({
        success: true,
        total: ids.length,
        analyzed: results.length,
        cached: results.filter(r => r.cached).length,
        fresh: results.filter(r => !r.cached).length,
        errors,
        results,
      });
    }

    return NextResponse.json({ success: false, error: "Forneça lead_id ou lead_ids" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
