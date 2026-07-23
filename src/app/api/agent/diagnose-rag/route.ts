/**
 * GET /api/agent/diagnose-rag?agent_id=<id>
 *
 * Diagnóstico ESPECÍFICO do RAG (base de conhecimento do agente IA).
 * Mostra tudo que afeta se o agente consegue consultar produtos sem alucinar:
 *   - Quantos documentos / chunks estão indexados
 *   - Modelo de embeddings configurado
 *   - Se a RPC match_knowledge_chunks está acessível
 *   - Últimos erros de RAG no webhook_logs
 *   - TESTE DE BUSCA REAL: passa uma query e vê quantos matches volta
 *
 * Pro admin debugar "IA não tá achando produto X" — abre aqui e vê na hora
 * se é problema de configuração, threshold, ou chunker.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { getRagEmbeddingRef, searchKnowledge } from "@/lib/rag";
import { getAiKeys } from "@/lib/ai-keys";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  }

  const agentIdStr = req.nextUrl.searchParams.get("agent_id") || "";
  const testQuery = req.nextUrl.searchParams.get("test_query") || "";
  const agentId = Number(agentIdStr);
  if (!agentId) {
    return NextResponse.json({ ok: false, error: "agent_id é obrigatório" }, { status: 400 });
  }

  // 1) Agente existe + é desse cliente?
  const { data: agent } = await supabaseAdmin
    .from("agent_settings")
    .select("id, name, is_active, client_id")
    .eq("id", agentId)
    .maybeSingle();
  if (!agent) {
    return NextResponse.json({ ok: false, error: "Agente não encontrado" }, { status: 404 });
  }
  if (!auth.isAdmin && agent.client_id && agent.client_id !== auth.clientId) {
    return NextResponse.json({ ok: false, error: "Agente não pertence a este cliente" }, { status: 403 });
  }

  // 2) Documentos do agente
  const { data: docs } = await supabaseAdmin
    .from("agent_knowledge")
    .select("id, title, length(content) as content_len, content")
    .eq("agent_id", agentId)
    .order("title");

  // 3) Chunks indexados (vetorial)
  const { data: chunksAgg } = await supabaseAdmin
    .from("agent_knowledge_chunks")
    .select("id, content_hash, embedding_model, knowledge_id")
    .eq("agent_id", agentId);

  const totalChunks = chunksAgg?.length || 0;
  const chunksWithEmbedding = chunksAgg?.filter((c: any) => c.content_hash).length || 0;
  const distinctModels = Array.from(new Set((chunksAgg || []).map((c: any) => c.embedding_model).filter(Boolean)));

  // 4) Modelo de embeddings configurado
  const configuredModel = await getRagEmbeddingRef();

  // 5) Conflito de modelo: chunks indexados com modelo diferente do atual
  const modelMismatch = distinctModels.length > 0 && !distinctModels.includes(configuredModel);

  // 6) RPC match_knowledge_chunks existe? Testa chamando com vetor zero.
  let rpcOk = true;
  let rpcError: string | null = null;
  try {
    const zeroVec = new Array(768).fill(0);
    await supabaseAdmin.rpc("match_knowledge_chunks", {
      query_embedding: zeroVec as any,
      p_agent_id: agentId,
      p_client_id: agent.client_id || auth.clientId,
      match_count: 1,
      min_similarity: 0.99, // impossível → só pra validar que a RPC executa
    });
  } catch (e: any) {
    rpcOk = false;
    rpcError = e?.message || String(e);
  }

  // 7) Últimos erros de RAG no log
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: ragLogs } = await supabaseAdmin
    .from("webhook_logs")
    .select("event, payload, created_at")
    .or(eventFilter(), undefined as any)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(10);

  // 8) Teste de busca real (se passou test_query)
  let testResult: any = null;
  if (testQuery.trim()) {
    try {
      const keys = await getAiKeys();
      const hits = await searchKnowledge({
        query: testQuery.trim(),
        agentId,
        clientId: agent.client_id || auth.clientId,
        apiKey: keys.gemini || "",
        topK: 5,
        minSimilarity: 0.20, // bem baixo pra diagnóstico — ver tudo que chega perto
      });
      testResult = {
        query: testQuery.trim(),
        hits_count: hits.length,
        hits: hits.map((h) => ({
          title: h.title,
          similarity: Number(h.similarity.toFixed(3)),
          content_preview: (h.content || "").slice(0, 200),
        })),
      };
    } catch (e: any) {
      testResult = { query: testQuery.trim(), error: e?.message || String(e) };
    }
  }

  // 9) Veredito
  let verdict = "RAG saudável. IA consegue consultar base de conhecimento.";
  let actionable: string | null = null;

  if (totalChunks === 0) {
    if ((docs || []).length === 0) {
      verdict = "Sem base de conhecimento. IA NÃO tem onde consultar — vai alucinar se perguntarem de produto/preço.";
      actionable = "Vá em /agente → Base de Conhecimento → adicione catálogo.";
    } else {
      verdict = `${(docs || []).length} doc(s) na KB mas ZERO chunks indexados. Indexação falhou ou não terminou.`;
      actionable = "Edite cada doc (clique → salvar) pra re-indexar, ou peça pro admin POST /api/agent/reindex-kb.";
    }
  } else if (!rpcOk) {
    verdict = "RPC match_knowledge_chunks não está acessível. Busca vetorial não funciona.";
    actionable = "Rode SETUP_COMPLETO.sql no Supabase (ou a migration 006_rag_vector_kb.sql).";
  } else if (modelMismatch) {
    verdict = `Modelo de embeddings foi trocado: chunks indexados com [${distinctModels.join(", ")}] mas config atual é "${configuredModel}". Vetores não são comparáveis.`;
    actionable = "POST /api/agent/reindex-kb pra re-indexar tudo com o modelo novo.";
  } else if (testQuery.trim() && testResult?.hits_count === 0) {
    verdict = `Busca por "${testQuery.trim()}" retornou 0 matches. Pode ser threshold (0.20) alto demais, ou termos sinônimos ausentes.`;
    actionable = "Adicione o termo que o cliente usa no título/conteúdo do catálogo. Ex: cliente diz 'celular' → título 'Celulares e Smartphones'.";
  }

  return NextResponse.json({
    ok: true,
    agent: { id: agent.id, name: agent.name, is_active: agent.is_active },
    configuredEmbeddingModel: configuredModel,
    indexedEmbeddingModels: distinctModels,
    modelMismatch,
    stats: {
      documents: (docs || []).length,
      totalChunks,
      chunksWithEmbedding,
      rpcOk,
      rpcError,
    },
    documents: (docs || []).map((d: any) => ({
      id: d.id,
      title: d.title,
      content_chars: d.content_len,
      has_image_tag: /\[IMAGEM:|FOTO:/i.test(d.content || ""),
      has_product_block: /\n#{2,3}\s+PRODUTO:/.test(d.content || ""),
    })),
    testResult,
    logs: (ragLogs || []).map((l: any) => ({
      event: l.event,
      created_at: l.created_at,
      payload: l.payload,
    })),
    verdict,
    actionable,
  });
}

// Helper: filtro OR pra webhook_logs.event com keywords RAG.
function eventFilter(): string {
  // PostgREST .or() syntax: "event.ilike.%RAG%,event.ilike.%vector%,event.ilike.%embed%"
  return "event.ilike.%RAG%,event.ilike.%vector%,event.ilike.%embed%,event.ilike.%TRANSCRIPTION_FAIL%";
}
