/**
 * GET   /api/settings/embedding-model  → { model }  (modelo de embeddings do RAG)
 * PATCH /api/settings/embedding-model  → { model }  salva em app_settings.rag_embedding_model
 *
 * A lista de modelos disponíveis vem de /api/ai-models/embeddings.
 * ⚠ Trocar o modelo exige RE-INDEXAR a base (POST /api/agent/reindex-kb).
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const KEY = "rag_embedding_model";
const DEFAULT_MODEL = "gemini-embedding-001";

export async function GET() {
  try {
    const { data } = await supabaseAdmin
      .from("app_settings").select("value").eq("key", KEY).maybeSingle();
    return NextResponse.json({ success: true, model: data?.value || DEFAULT_MODEL });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;
    if (!ctx.isAdmin) {
      return NextResponse.json({ success: false, error: "Apenas admin pode alterar o modelo de embeddings." }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const model = String(body.model || "").trim();
    if (!model) return NextResponse.json({ success: false, error: "model vazio" }, { status: 400 });

    const { error } = await supabaseAdmin
      .from("app_settings")
      .upsert({ key: KEY, value: model, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;

    // Invalida o cache do RAG pra a próxima indexação/busca já usar o novo modelo.
    try {
      const { invalidateRagEmbeddingCache } = await import("@/lib/rag");
      invalidateRagEmbeddingCache();
    } catch { /* não-fatal */ }

    return NextResponse.json({ success: true, model });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
