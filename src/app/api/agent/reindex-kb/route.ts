/**
 * POST /api/agent/reindex-kb
 *
 * Re-indexa TODA a base de conhecimento com o modelo de embeddings ATUAL
 * (app_settings.rag_embedding_model). Necessário sempre que o modelo de
 * embeddings é trocado — vetores de modelos diferentes não são comparáveis.
 *
 * Apenas admin. Best-effort, processa em blocos. Retorna contagem.
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { indexKnowledgeDocument, getRagEmbeddingRef } from "@/lib/rag";
import { getAiKeys } from "@/lib/ai-keys";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;
    if (!ctx.isAdmin) {
      return NextResponse.json({ success: false, error: "Apenas admin pode re-indexar a base." }, { status: 403 });
    }

    const model = await getRagEmbeddingRef();
    const keys = await getAiKeys();

    const { data: docs, error } = await supabaseAdmin
      .from("agent_knowledge")
      .select("id, agent_id, client_id, title, content");
    if (error) throw error;

    const all = docs || [];
    let ok = 0, failed = 0, totalChunks = 0;
    const errors: { id: string; error: string }[] = [];

    // Blocos de 3 docs em paralelo — equilíbrio entre velocidade e quota.
    const CHUNK = 3;
    for (let i = 0; i < all.length; i += CHUNK) {
      const batch = all.slice(i, i + CHUNK);
      const results = await Promise.allSettled(
        batch.map((d: any) => indexKnowledgeDocument({
          knowledgeId: d.id,
          agentId: d.agent_id,
          clientId: d.client_id || null,
          title: d.title || "",
          content: d.content || "",
          apiKey: keys.gemini,
          force: true,
        }))
      );
      results.forEach((r, idx) => {
        if (r.status === "fulfilled" && r.value.ok) { ok++; totalChunks += r.value.chunks; }
        else { failed++; errors.push({ id: batch[idx].id, error: r.status === "fulfilled" ? (r.value.error || "?") : String(r.reason).slice(0, 200) }); }
      });
    }

    return NextResponse.json({ success: true, model, total: all.length, reindexed: ok, failed, chunks: totalChunks, errors: errors.slice(0, 10) });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
