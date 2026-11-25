/**
 * POST /api/agent/knowledge/reindex
 *
 * Re-indexa um doc da KB no índice vetorial (agent_knowledge_chunks).
 * Chamado pela UI logo depois de criar/editar um doc em /agente.
 *
 * Body: { knowledge_id: string }    -- re-indexa 1 doc específico
 *    OU: { agent_id: number, all: true }  -- re-indexa TODOS docs do agente
 *
 * Segurança: requer sessão. Cliente comum só re-indexa docs do PRÓPRIO tenant
 * (defesa em profundidade contra cliente fazer reindex sobre KB alheia).
 *
 * Latência: pode demorar 1-3s por doc (chunk + embeddings). Por isso a UI
 * chama em fire-and-forget (não bloqueia o save).
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { checkTenantAiQuota, checkTenantRateLimit } from "@/lib/saas-limits";
import { getRagEmbeddingRef, indexKnowledgeDocument } from "@/lib/rag";
import { getAiKeys } from "@/lib/ai-keys";
import { parseModelRef } from "@/lib/ai-provider";
import { invalidateAgentConfigCache } from "@/lib/agent-config-cache";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!auth.isAdmin) {
    const rl = checkTenantRateLimit(`kb_reindex:${auth.clientId}`, 5, 5 * 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: `Limite de reindexação atingido. Aguarde ${rl.retryAfterSec ?? 1}s.` },
        { status: 429 },
      );
    }
    const quota = await checkTenantAiQuota(auth.clientId, false);
    if (!quota.allowed) {
      return NextResponse.json(
        { ok: false, error: quota.reason || "Limite mensal de IA do plano atingido." },
        { status: 429 },
      );
    }
  }
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const knowledgeId: string | undefined = body.knowledge_id;
  const agentIdParam: number | undefined = body.agent_id ? Number(body.agent_id) : undefined;
  const all: boolean = !!body.all;

  // Valida chave apenas do provider configurado para embeddings (Gemini, OpenRouter ou NVIDIA NIM)
  const [keys, embeddingRef] = await Promise.all([
    getAiKeys().catch(() => null),
    getRagEmbeddingRef().catch(() => "gemini-embedding-001"),
  ]);
  const { provider: embProvider } = parseModelRef(embeddingRef);
  const hasRequiredKey =
    embProvider === "nvidia"
      ? Boolean(keys?.nvidia)
      : embProvider === "openrouter"
        ? Boolean(keys?.openrouter)
        : Boolean(keys?.gemini);

  if (!hasRequiredKey) {
    return NextResponse.json(
      { ok: false, error: `API Key ${embProvider.toUpperCase()} não configurada em /configuracoes — indexação RAG precisa dela.` },
      { status: 400 }
    );
  }
  const apiKey = keys?.gemini || "";

  // -- Caso 1: re-indexa todos os docs do agente
  if (all && agentIdParam) {
    // Ownership: confere se o agente é do tenant
    const { data: agent } = await supabaseAdmin
      .from("agent_settings")
      .select("id, client_id")
      .eq("id", agentIdParam)
      .maybeSingle();
    if (!agent) return NextResponse.json({ ok: false, error: "Agente não encontrado" }, { status: 404 });
    if (!auth.isAdmin && agent.client_id !== auth.clientId) {
      return NextResponse.json({ ok: false, error: "Agente não pertence a este cliente" }, { status: 403 });
    }

    const { data: docs } = await supabaseAdmin
      .from("agent_knowledge")
      .select("id, title, content")
      .eq("agent_id", agentIdParam);

    const results: any[] = [];
    for (const d of docs || []) {
      const r = await indexKnowledgeDocument({
        knowledgeId: d.id,
        agentId: agentIdParam,
        clientId: agent.client_id,
        title: d.title || "",
        content: d.content || "",
        apiKey,
      });
      results.push({ id: d.id, title: d.title, ...r });
    }
    invalidateAgentConfigCache(agentIdParam);
    return NextResponse.json({ ok: true, count: results.length, results });
  }

  // -- Caso 2: re-indexa 1 doc específico
  if (!knowledgeId) {
    return NextResponse.json({ ok: false, error: "knowledge_id obrigatório (ou agent_id + all:true)" }, { status: 400 });
  }

  const { data: doc } = await supabaseAdmin
    .from("agent_knowledge")
    .select("id, agent_id, title, content")
    .eq("id", knowledgeId)
    .maybeSingle();
  if (!doc) return NextResponse.json({ ok: false, error: "Doc não encontrado" }, { status: 404 });

  // Ownership pelo agente do doc
  const { data: agent } = await supabaseAdmin
    .from("agent_settings")
    .select("client_id")
    .eq("id", doc.agent_id)
    .maybeSingle();
  if (!auth.isAdmin && agent?.client_id !== auth.clientId) {
    return NextResponse.json({ ok: false, error: "Doc pertence a outro cliente" }, { status: 403 });
  }

  const r = await indexKnowledgeDocument({
    knowledgeId: doc.id,
    agentId: doc.agent_id,
    clientId: agent?.client_id || null,
    title: doc.title || "",
    content: doc.content || "",
    apiKey,
  });
  invalidateAgentConfigCache(doc.agent_id);
  return NextResponse.json({ ...r });
}
