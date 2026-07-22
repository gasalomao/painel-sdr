/**
 * RAG (Retrieval-Augmented Generation) — busca vetorial na base de conhecimento.
 *
 * Fluxo:
 *   1. INDEXAÇÃO: chamada quando um doc é criado/editado em /agente.
 *      → chunk(doc) → embed(chunks) → upsert na agent_knowledge_chunks
 *   2. QUERY: chamada pelo agent/process quando IA aciona search_knowledge_base.
 *      → embed(query) → match_knowledge_chunks RPC → top-5 chunks relevantes
 *
 * Custos (gemini-embedding-001, $0.15 / 1M tokens):
 *   - Doc 50KB ≈ 12K tokens ≈ $0.0018 pra indexar 1x. Re-indexação só se
 *     content mudou (content_hash protege).
 *   - Query (~10 tokens) ≈ $0.0000015 por busca. Praticamente grátis.
 *
 * Por que NÃO usar OpenAI/Cohere/Voyage: a key Gemini já está configurada,
 * o app já é "Gemini-first". Adicionar outro provider seria 1 ponto de
 * falha + 1 secret a gerenciar pra benefício marginal de qualidade.
 */

import { supabaseAdmin } from "@/lib/supabase_admin";
import crypto from "crypto";

// ============================================================================
// CONFIG
// ============================================================================

const EMBEDDING_MODEL = "gemini-embedding-001"; // fallback se app_settings não tiver
const EMBEDDING_DIMS = 768; // FIXO — coluna vector(768) + índice HNSW + RPC dependem disso
const CHUNK_TARGET_TOKENS = 500; // sweet spot pra texto BR — ~2KB de chars
const CHUNK_OVERLAP_TOKENS = 50; // overlap pra não perder contexto na borda
const APPROX_CHARS_PER_TOKEN = 4; // estimativa conservadora pra PT-BR

const CHUNK_TARGET_CHARS = CHUNK_TARGET_TOKENS * APPROX_CHARS_PER_TOKEN; // 2000
const CHUNK_OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * APPROX_CHARS_PER_TOKEN; // 200

// ============================================================================
// CHUNKING — sentence-aware splitter
// ============================================================================

/**
 * Divide um texto em chunks de ~500 tokens preservando fronteiras de
 * sentenças/parágrafos quando possível. Faz overlap de ~50 tokens entre
 * chunks pra não cortar contexto em transições.
 *
 * Estratégia:
 *   1. Divide por parágrafos (\n\n)
 *   2. Agrupa parágrafos até chegar perto do target
 *   3. Se um parágrafo sozinho passa do target (ex: lista de preços em
 *      única linha), divide por sentenças (. ! ?)
 *   4. Se ainda passa (linha de 5K chars), corta por chars com overlap
 */
export function chunkText(text: string): string[] {
  if (!text || !text.trim()) return [];
  const cleanText = text.trim();

  // Caso simples: doc inteiro cabe em 1 chunk
  if (cleanText.length <= CHUNK_TARGET_CHARS) {
    return [cleanText];
  }

  const chunks: string[] = [];
  const paragraphs = cleanText.split(/\n\n+/).filter(Boolean);

  let current = "";
  for (const para of paragraphs) {
    // Parágrafo grande sozinho — explode por sentenças
    if (para.length > CHUNK_TARGET_CHARS) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      const sentenceChunks = splitBySentences(para);
      chunks.push(...sentenceChunks);
      continue;
    }

    // Cabe junto?
    if ((current + "\n\n" + para).length <= CHUNK_TARGET_CHARS) {
      current = current ? current + "\n\n" + para : para;
    } else {
      if (current) chunks.push(current.trim());
      current = para;
    }
  }
  if (current) chunks.push(current.trim());

  // Adiciona overlap entre chunks adjacentes (ajuda buscas que caem na borda)
  return addOverlap(chunks);
}

function splitBySentences(text: string): string[] {
  // Split por . ! ? mantendo o delimitador. Lista de preços tipo
  // "R$ 99\nR$ 199\n..." cai aqui também (split por \n se não tem pontuação).
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());

  const chunks: string[] = [];
  let current = "";
  for (const sent of sentences) {
    // Sentença monstruosa — chars hard cut
    if (sent.length > CHUNK_TARGET_CHARS) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      chunks.push(...hardSplitByChars(sent));
      continue;
    }
    if ((current + " " + sent).length <= CHUNK_TARGET_CHARS) {
      current = current ? current + " " + sent : sent;
    } else {
      if (current) chunks.push(current.trim());
      current = sent;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

function hardSplitByChars(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_TARGET_CHARS, text.length);
    chunks.push(text.slice(start, end));
    start = end - CHUNK_OVERLAP_CHARS; // overlap dentro do mesmo split
    if (start <= 0) start = end;
  }
  return chunks;
}

function addOverlap(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks;
  const result: string[] = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const overlapStart = Math.max(0, prev.length - CHUNK_OVERLAP_CHARS);
    const overlap = prev.slice(overlapStart);
    result.push(overlap + "\n\n" + chunks[i]);
  }
  return result;
}

// ============================================================================
// EMBEDDING — multi-provedor (Gemini OU OpenRouter), sempre 768 dims
// ============================================================================
//
// O modelo de embeddings é configurável em /configuracoes (app_settings
// `rag_embedding_model`). Pode ser Gemini (bare, ex "gemini-embedding-001") ou
// OpenRouter (ex "openrouter:openai/text-embedding-3-small"). A dimensão é
// SEMPRE forçada em 768 (coluna do banco): Gemini via outputDimensionality,
// OpenRouter via o parâmetro `dimensions`.
//
// ⚠ Embeddings de modelos diferentes NÃO são comparáveis — trocar o modelo
// exige RE-INDEXAR a base (botão em /configuracoes / endpoint reindex-kb).

let RAG_MODEL_CACHE: { ref: string; at: number } | null = null;

/** Lê o modelo de embeddings configurado (app_settings), com cache de 30s. */
export async function getRagEmbeddingRef(): Promise<string> {
  if (RAG_MODEL_CACHE && Date.now() - RAG_MODEL_CACHE.at < 30_000) return RAG_MODEL_CACHE.ref;
  let ref = EMBEDDING_MODEL;
  try {
    if (supabaseAdmin) {
      const { data } = await supabaseAdmin
        .from("app_settings").select("value").eq("key", "rag_embedding_model").maybeSingle();
      if (data?.value && String(data.value).trim()) ref = String(data.value).trim();
    }
  } catch { /* usa fallback */ }
  RAG_MODEL_CACHE = { ref, at: Date.now() };
  return ref;
}

export function invalidateRagEmbeddingCache() { RAG_MODEL_CACHE = null; }

/** Chamada de embeddings do OpenRouter (OpenAI-compatible), forçando 768 dims. */
async function openRouterEmbed(model: string, inputs: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: inputs, dimensions: EMBEDDING_DIMS }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || `OpenRouter embeddings HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  const data: any[] = Array.isArray(json?.data) ? json.data : [];
  // Ordena por index pra garantir a MESMA ordem dos inputs.
  data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return data.map((d) => {
    const v = d.embedding;
    if (!Array.isArray(v) || v.length !== EMBEDDING_DIMS) {
      throw new Error(`Embedding OpenRouter com dim errada: esperado ${EMBEDDING_DIMS}, veio ${Array.isArray(v) ? v.length : "?"}. Escolha um modelo que suporte 768 dimensões.`);
    }
    return v as number[];
  });
}

/**
 * Gera embeddings em batch. Roteia Gemini OU OpenRouter conforme o modelo
 * configurado. Retorna vetores 768-dim na MESMA ORDEM dos textos.
 *
 * @param apiKey chave Gemini (fallback). A chave OpenRouter é lida da config.
 */
export async function embedTexts(texts: string[], apiKey?: string | null): Promise<number[][]> {
  if (texts.length === 0) return [];

  const { parseModelRef } = await import("@/lib/ai-provider");
  const { getAiKeys } = await import("@/lib/ai-keys");
  const ref = await getRagEmbeddingRef();
  const { provider, model } = parseModelRef(ref);
  const keys = await getAiKeys();

  if (provider === "openrouter") {
    const orKey = keys.openrouter;
    if (!orKey) throw new Error("Modelo de embeddings é do OpenRouter mas a chave OpenRouter não está configurada.");
    const BATCH = 100;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      out.push(...(await openRouterEmbed(model, texts.slice(i, i + BATCH), orKey)));
    }
    return out;
  }

  // Gemini
  const gKey = apiKey || keys.gemini;
  if (!gKey) throw new Error("apiKey Gemini vazia — configure em /configuracoes");
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(gKey);
  const gModel = genAI.getGenerativeModel({ model });

  const BATCH = 100;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const res = await gModel.batchEmbedContents({
      requests: slice.map((t) => ({
        content: { role: "user", parts: [{ text: t }] },
        taskType: "RETRIEVAL_DOCUMENT" as any,
        // Força 768 em modelos que suportam (ex: gemini-embedding-001). Modelos
        // fixos em 768 (text-embedding-004) ignoram.
        outputDimensionality: EMBEDDING_DIMS,
      })) as any,
    });
    for (const e of res.embeddings) {
      if (!e.values || e.values.length !== EMBEDDING_DIMS) {
        throw new Error(`Embedding com dim errada: esperado ${EMBEDDING_DIMS}, veio ${e.values?.length}`);
      }
      out.push(e.values);
    }
  }
  return out;
}

/**
 * Embedding de UMA query (mesmo modelo configurado da indexação).
 */
export async function embedQuery(text: string, apiKey?: string | null): Promise<number[]> {
  const { parseModelRef } = await import("@/lib/ai-provider");
  const { getAiKeys } = await import("@/lib/ai-keys");
  const ref = await getRagEmbeddingRef();
  const { provider, model } = parseModelRef(ref);
  const keys = await getAiKeys();

  if (provider === "openrouter") {
    const orKey = keys.openrouter;
    if (!orKey) throw new Error("Modelo de embeddings é do OpenRouter mas a chave OpenRouter não está configurada.");
    const [v] = await openRouterEmbed(model, [text], orKey);
    return v;
  }

  const gKey = apiKey || keys.gemini;
  if (!gKey) throw new Error("apiKey Gemini vazia — configure em /configuracoes");
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(gKey);
  const gModel = genAI.getGenerativeModel({ model });
  const res = await gModel.embedContent({
    content: { role: "user", parts: [{ text }] },
    taskType: "RETRIEVAL_QUERY" as any,
    outputDimensionality: EMBEDDING_DIMS,
  } as any);
  return res.embedding.values;
}

// ============================================================================
// INDEXAÇÃO — orchestration
// ============================================================================

export interface IndexResult {
  ok: boolean;
  chunks: number;
  skipped?: boolean; // true se content_hash não mudou (no-op)
  error?: string;
}

/**
 * Indexa (ou re-indexa) UM documento da KB. Idempotente.
 *
 * Lógica:
 *   1. Calcula hash do content. Se TODOS os chunks existentes desse doc
 *      têm esse hash, é no-op (skip — content não mudou).
 *   2. Caso contrário: chunk → embed → DELETE chunks antigos → INSERT novos.
 *
 * Usado em:
 *   - POST /api/agents/.../knowledge (criar doc)
 *   - PUT /api/agents/.../knowledge/:id (editar doc)
 *   - Backfill script (indexa massa de docs existentes)
 */
export async function indexKnowledgeDocument(opts: {
  knowledgeId: string;
  agentId: number;
  clientId: string | null;
  title: string;
  content: string;
  apiKey?: string | null;
  /** Força re-indexação mesmo se o conteúdo não mudou (ex: trocou o modelo de embeddings). */
  force?: boolean;
}): Promise<IndexResult> {
  const { knowledgeId, agentId, clientId, title, content, apiKey, force } = opts;
  if (!supabaseAdmin) return { ok: false, chunks: 0, error: "DB indisponível" };
  const embeddingModel = await getRagEmbeddingRef();

  // Texto pra indexar inclui o título — ajuda matches do tipo "qual é
  // o horário de funcionamento" achar o doc "Horário de Atendimento"
  // mesmo se o content não tem essa frase.
  const fullText = `${title}\n\n${content || ""}`.trim();
  if (!fullText || fullText === title) {
    // Doc vazio. Limpa chunks que possam existir e termina.
    await supabaseAdmin.from("agent_knowledge_chunks").delete().eq("knowledge_id", knowledgeId);
    return { ok: true, chunks: 0 };
  }

  const contentHash = crypto.createHash("sha256").update(fullText).digest("hex").slice(0, 16);

  // Skip se já indexado com mesmo hash E mesmo modelo de embeddings (senão
  // precisa re-embedar — vetores de modelos diferentes não são comparáveis).
  if (!force) {
    const existing = await supabaseAdmin
      .from("agent_knowledge_chunks")
      .select("id, content_hash, embedding_model")
      .eq("knowledge_id", knowledgeId)
      .limit(1);
    if (existing.data && existing.data.length > 0
        && existing.data[0].content_hash === contentHash
        && (existing.data[0] as any).embedding_model === embeddingModel) {
      return { ok: true, chunks: existing.data.length, skipped: true };
    }
  }

  try {
    const chunks = chunkText(fullText);
    if (chunks.length === 0) return { ok: true, chunks: 0 };

    const embeddings = await embedTexts(chunks, apiKey);

    // Atômico: delete + insert numa transação? Supabase JS não dá transação
    // nativa, mas a janela de inconsistência é mínima e o pior caso é a IA
    // não achar nada por <100ms — aceitável.
    await supabaseAdmin.from("agent_knowledge_chunks").delete().eq("knowledge_id", knowledgeId);

    const rows = chunks.map((c, i) => ({
      knowledge_id: knowledgeId,
      agent_id: agentId,
      client_id: clientId,
      chunk_index: i,
      content: c,
      embedding: embeddings[i],
      token_count: Math.ceil(c.length / APPROX_CHARS_PER_TOKEN),
      content_hash: contentHash,
      embedding_model: embeddingModel,
    }));

    // Insert em batches de 50 (payload pode ficar grande com embeddings)
    for (let i = 0; i < rows.length; i += 50) {
      const slice = rows.slice(i, i + 50);
      const { error } = await supabaseAdmin.from("agent_knowledge_chunks").insert(slice);
      if (error) throw error;
    }

    return { ok: true, chunks: chunks.length };
  } catch (e: any) {
    console.error("[RAG] indexKnowledgeDocument falhou:", e.message);
    return { ok: false, chunks: 0, error: e.message };
  }
}

/**
 * Remove TODOS os chunks de um doc (chamado em DELETE da KB).
 * ON DELETE CASCADE da FK já faz isso automaticamente, mas explícito
 * é seguro caso a UI delete via path diferente.
 */
export async function deleteKnowledgeChunks(knowledgeId: string): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin.from("agent_knowledge_chunks").delete().eq("knowledge_id", knowledgeId);
}

// ============================================================================
// QUERY — busca semântica top-k
// ============================================================================

export interface RagMatch {
  knowledgeId: string;
  title: string;
  content: string;
  similarity: number;
}

/**
 * Busca os top-k chunks mais relevantes pra `query` na KB do agente.
 *
 * Retorna chunks ordenados por similaridade desc. Se nada acima do threshold,
 * retorna []. Caller decide o que fazer com vazio (geralmente fallback ILIKE).
 */
export async function searchKnowledge(opts: {
  query: string;
  agentId: number;
  clientId: string | null;
  apiKey: string;
  topK?: number;
  minSimilarity?: number;
}): Promise<RagMatch[]> {
  const { query, agentId, clientId, apiKey, topK = 5, minSimilarity = 0.20 } = opts;
  if (!query || !query.trim()) return [];
  if (!supabaseAdmin) return [];

  const results: RagMatch[] = [];
  const seenIds = new Set<string>();

  try {
    const qEmbed = await embedQuery(query.trim(), apiKey);

    const { data, error } = await supabaseAdmin.rpc("match_knowledge_chunks", {
      query_embedding: qEmbed as any,
      p_agent_id: agentId,
      p_client_id: clientId,
      match_count: topK,
      min_similarity: minSimilarity,
    });

    if (!error && Array.isArray(data)) {
      for (const r of data) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          results.push({
            knowledgeId: r.knowledge_id,
            title: r.title,
            content: r.content,
            similarity: Number(r.similarity),
          });
        }
      }
    }
  } catch (e: any) {
    console.warn("[RAG] Vector search failed, falling back to hybrid keyword search:", e.message);
  }

  // Hybrid Fallback: Se a busca vetorial retornou poucos resultados, busca por termos/SKUs exatos
  if (results.length < topK) {
    try {
      const cleanTerms = query.trim().split(/\s+/).filter((t) => t.length > 2);
      if (cleanTerms.length > 0) {
        let q = supabaseAdmin
          .from("agent_knowledge")
          .select("id, title, content")
          .eq("agent_id", agentId);

        const firstTerm = cleanTerms[0];
        q = q.or(`title.ilike.%${firstTerm}%,content.ilike.%${firstTerm}%`);

        const { data: kwMatches } = await q.limit(topK - results.length);
        if (kwMatches) {
          for (const k of kwMatches) {
            if (!seenIds.has(k.id)) {
              seenIds.add(k.id);
              results.push({
                knowledgeId: k.id,
                title: k.title,
                content: k.content || "",
                similarity: 0.90,
              });
            }
          }
        }
      }
    } catch (err: any) {
      console.warn("[RAG] Keyword fallback error:", err?.message);
    }
  }

  return results;
}
