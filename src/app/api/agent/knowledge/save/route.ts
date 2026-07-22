import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { indexKnowledgeDocument, deleteKnowledgeChunks } from "@/lib/rag";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ success: false, error: "Banco de dados indisponível" }, { status: 500 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { action, id, agent_id, title, content } = body;

    const numAgentId = Number(agent_id) || 1;
    const titleToUse = String(title || "").trim() || "Catálogo de Produtos";
    const contentToUse = String(content || "").trim();

    if (action === "create") {
      if (!contentToUse) {
        return NextResponse.json({ success: false, error: "O conteúdo da base de conhecimento não pode estar vazio." }, { status: 400 });
      }

      const { data, error } = await supabaseAdmin
        .from("agent_knowledge")
        .insert({
          agent_id: numAgentId,
          client_id: auth.clientId,
          title: titleToUse,
          content: contentToUse,
        })
        .select("*")
        .single();

      if (error) {
        console.error("[KBSave] Error creating document:", error.message);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      }

      // Re-indexa no RAG vetorial (pgvector + HNSW)
      const { data: org } = await supabaseAdmin.from("ai_organizer_config").select("api_key").eq("id", 1).maybeSingle();
      const apiKey = org?.api_key || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";

      indexKnowledgeDocument({
        knowledgeId: data.id,
        agentId: numAgentId,
        clientId: auth.clientId,
        title: titleToUse,
        content: contentToUse,
        apiKey,
      }).catch(() => {});

      return NextResponse.json({ success: true, data });
    }

    if (action === "update") {
      if (!id || !contentToUse) {
        return NextResponse.json({ success: false, error: "ID e conteúdo são obrigatórios para edição." }, { status: 400 });
      }

      const { data, error } = await supabaseAdmin
        .from("agent_knowledge")
        .update({
          title: titleToUse,
          content: contentToUse,
          client_id: auth.clientId,
        })
        .eq("id", id)
        .select("*")
        .single();

      if (error) {
        console.error("[KBSave] Error updating document:", error.message);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      }

      // Re-indexa no RAG vetorial
      const { data: org } = await supabaseAdmin.from("ai_organizer_config").select("api_key").eq("id", 1).maybeSingle();
      const apiKey = org?.api_key || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";

      indexKnowledgeDocument({
        knowledgeId: data.id,
        agentId: numAgentId,
        clientId: auth.clientId,
        title: titleToUse,
        content: contentToUse,
        apiKey,
      }).catch(() => {});

      return NextResponse.json({ success: true, data });
    }

    if (action === "delete") {
      if (!id) {
        return NextResponse.json({ success: false, error: "ID é obrigatório para exclusão." }, { status: 400 });
      }

      await deleteKnowledgeChunks(id).catch(() => {});
      const { error } = await supabaseAdmin.from("agent_knowledge").delete().eq("id", id);
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      }

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: "Ação inválida" }, { status: 400 });
  } catch (err: any) {
    console.error("[KBSave] Handler error:", err?.message);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
