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
import { requireClientId } from "@/lib/tenant";
import { checkTenantAiQuota, checkTenantRateLimit } from "@/lib/saas-limits";
import { getAiKeys } from "@/lib/ai-keys";

/** Mantém apenas IDs cujo client_id bate com o do auth. */
async function filterLeadIdsByOwnership(ids: number[], clientId: string): Promise<number[]> {
  if (ids.length === 0) return [];
  const { data } = await supabaseAdmin
    .from("leads_extraidos")
    .select("id")
    .in("id", ids)
    .eq("client_id", clientId);
  return (data || []).map(r => Number(r.id));
}

export const dynamic = "force-dynamic";
// Análise pode demorar 5-15s por lead (fetch site + Gemini). Em batch grande,
// damos margem confortável até o limite do Next standalone.
export const maxDuration = 300;

async function hasAnyAiKey(): Promise<{ ok: boolean; geminiKey: string | null }> {
  const keys = await getAiKeys();
  const ok = Boolean(
    keys.gemini ||
    keys.openrouter ||
    keys.openrouterKeys?.length ||
    keys.nvidia ||
    keys.nvidiaAccounts?.length ||
    keys.gatewayBaseUrl ||
    keys.gatewayEndpoints?.length
  );
  return { ok, geminiKey: keys.gemini || null };
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
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;
    if (!auth.isAdmin) {
      const rl = checkTenantRateLimit(`leads_analyze:${auth.clientId}`, 10, 60_000);
      if (!rl.allowed) {
        return NextResponse.json(
          { success: false, error: `Muitas análises seguidas. Aguarde ${rl.retryAfterSec ?? 1}s.` },
          { status: 429 },
        );
      }
      const quota = await checkTenantAiQuota(auth.clientId, false);
      if (!quota.allowed) {
        return NextResponse.json(
          { success: false, error: quota.reason || "Limite mensal de IA do plano atingido." },
          { status: 429 },
        );
      }
    }
    const body = await req.json().catch(() => ({}));
    const force = !!body.force;
    // SaaS guard: apenas admin pode escolher modelo em runtime via body; cliente comum usa o configurado.
    const adminModelOverride =
      auth.isAdmin && typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : null;
    const model = adminModelOverride || (await getConfiguredModel());

    const cred = await hasAnyAiKey();
    if (!cred.ok) {
      return NextResponse.json(
        { success: false, error: "Nenhuma API Key de IA configurada. Salve em Configurações." },
        { status: 400 },
      );
    }
    const apiKey = cred.geminiKey;

    // ───────── Modo single ─────────
    if (body.lead_id !== undefined && body.lead_id !== null) {
      const leadIdNum = Number(body.lead_id);
      if (!Number.isInteger(leadIdNum) || leadIdNum <= 0) {
        return NextResponse.json({ success: false, error: "lead_id inválido" }, { status: 400 });
      }
      const owned = await filterLeadIdsByOwnership([leadIdNum], auth.clientId);
      if (owned.length === 0) return NextResponse.json({ success: false, error: "Lead não encontrado" }, { status: 404 });
      const r = await analyzeLead({ leadId: owned[0], apiKey, model, force, clientId: auth.clientId });
      if ("error" in r) return NextResponse.json({ success: false, error: r.error }, { status: 500 });
      return NextResponse.json({ success: true, result: r });
    }

    // ───────── Modo batch ─────────
    if (Array.isArray(body.lead_ids) && body.lead_ids.length > 0) {
      const maxBatch = auth.isAdmin ? 200 : 20;
      const batchForce = auth.isAdmin ? force : false;
      const requested = body.lead_ids.map(Number).filter(Boolean).slice(0, maxBatch);
      const ids = await filterLeadIdsByOwnership(requested, auth.clientId);
      const results: any[] = [];
      const errors: { lead_id: number; error: string }[] = [];

      // Chunks de 5 em paralelo — equilíbrio entre velocidade e quota Gemini.
      const CHUNK = 5;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        const settled = await Promise.allSettled(
          batch.map((id: number) => analyzeLead({ leadId: id, apiKey, model, force: batchForce, clientId: auth.clientId })),
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
  } catch (e: unknown) {
    console.error("[leads/analyze] Erro inesperado:", e instanceof Error ? e.message : e);
    return NextResponse.json({ success: false, error: "Erro interno ao analisar leads" }, { status: 500 });
  }
}
