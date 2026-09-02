import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { indexKnowledgeDocument } from "@/lib/rag";

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

      // SECURITY (SEC-H4): o agente precisa pertencer ao tenant (ou ser
      // legado sem dono) — sem isso dava pra anexar conteúdo no agent_id
      // de outro tenant e envenenar o agente dele.
      const { data: agentRow } = await supabaseAdmin
        .from("agent_settings")
        .select("id, client_id")
        .eq("id", numAgentId)
        .maybeSingle();
      if (!agentRow || (agentRow.client_id && agentRow.client_id !== auth.clientId)) {
        return NextResponse.json({ success: false, error: "Agente inválido para este tenant." }, { status: 403 });
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

      // SECURITY: update escopado no tenant do caller — sem isso, id de
      // outro tenant era editado E reescrito p/ client_id do atacante.
      const { data, error } = await supabaseAdmin
        .from("agent_knowledge")
        .update({
          title: titleToUse,
          content: contentToUse,
        })
        .eq("id", id)
        .eq("client_id", auth.clientId)
        .select("*")
        .single();

      if (error) {
        console.error("[KBSave] Error updating document:", error.message);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      }

      // Re-indexa no RAG vetorial
      const { data: org } = await supabaseAdmin.from("ai_organizer_config").select("api_key").eq("id", 1).maybeSingle();
      const apiKey = org?.api_key || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";

      // Reindexa com o agent_id REAL da row (o do body poderia apontar pra
      // agente de outro tenant mesmo com o update escopado por client_id).
      indexKnowledgeDocument({
        knowledgeId: data.id,
        agentId: data.agent_id,
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

      // SECURITY: delete escopado no tenant; chunks só são limpos se a row
      // era mesmo do caller (senão índice de outro tenant era apagado).
      const { data, error } = await supabaseAdmin
        .from("agent_knowledge")
        .delete()
        .eq("id", id)
        .eq("client_id", auth.clientId)
        .select("id")
        .maybeSingle();
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      }
      if (!data) {
        return NextResponse.json({ success: false, error: "Documento não encontrado." }, { status: 404 });
      }

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: "Ação inválida" }, { status: 400 });
  } catch (err: any) {
    console.error("[KBSave] Handler error:", err?.message);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
