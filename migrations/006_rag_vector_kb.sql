-- ============================================================================
-- Migration 006 — RAG vetorial pra Base de Conhecimento
-- ============================================================================
-- Por quê: o sistema antigo (ILIKE em title/content) não escala. Um doc de
-- 50KB tipo "lista de preços com 1000 itens" não cabe num único retrieval.
-- Cliente perguntando "quanto custa o pacote ouro" precisa achar a LINHA
-- específica, não receber o doc inteiro cortado em 1800 chars.
--
-- Solução: embeddings + similarity search no pgvector. Cada doc da KB é
-- quebrado em chunks de ~500 tokens, cada chunk vira um vetor de 768 dims
-- (gemini-embedding-001). Na query, embedamos a pergunta e fazemos top-k
-- via cosine distance — pega o trecho cirúrgico.
--
-- Comportamento durante deploy: até o app rodar a indexação, busca cai no
-- fallback ILIKE (mantido no agent/process). Sem regressão.
-- ============================================================================

-- 1) Garante a extensão pgvector (Supabase já tem disponível, só precisa ativar)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2) Tabela de chunks indexados — 1 doc da KB vira N chunks
CREATE TABLE IF NOT EXISTS public.agent_knowledge_chunks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Referência ao doc origem. CASCADE → quando deletar doc, chunks somem juntos.
  knowledge_id   UUID NOT NULL REFERENCES public.agent_knowledge(id) ON DELETE CASCADE,
  -- Redundante mas crítico pra performance: filtro por agent_id é o caso mais
  -- comum (1 conversa = 1 agente). Sem isso o join puxaria tudo.
  agent_id       INT  NOT NULL REFERENCES public.agent_settings(id) ON DELETE CASCADE,
  -- Multi-tenant: defesa em profundidade. Query SEMPRE filtra por client_id.
  client_id      UUID,
  -- Ordem do chunk no doc original (pra reconstruir contexto se precisar)
  chunk_index    INT  NOT NULL DEFAULT 0,
  -- Texto do chunk (até ~2KB). Volta isso pro Gemini direto.
  content        TEXT NOT NULL,
  -- Vector embedding (768 dims = gemini-embedding-001 default).
  -- Se trocar pra outro modelo no futuro, vai precisar de migration nova.
  embedding      vector(768),
  -- Metadata útil: nº de tokens estimado, hash do conteúdo (pra detectar
  -- mudança e re-embedar só se mudou).
  token_count    INT,
  content_hash   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) Índices

-- Filtro mais comum: por agent_id durante query. Sem isso o vector search
-- escaneia tudo. CRITICAL pra perf em multi-tenant.
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_chunks_agent_id
  ON public.agent_knowledge_chunks (agent_id);

-- Filtro secundário: ao re-indexar 1 doc específico, precisamos deletar
-- os chunks antigos dele.
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_chunks_knowledge_id
  ON public.agent_knowledge_chunks (knowledge_id);

-- HNSW pra similarity search (mais rápido que IVFFlat pra <100K vetores).
-- Cosine distance é a métrica padrão pra texto (Gemini embeddings são
-- normalizados — cosine == dot product).
-- m=16, ef_construction=64 são padrões equilibrados pra qualidade/build time.
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_chunks_embedding_hnsw
  ON public.agent_knowledge_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 4) RPC pra search — encapsula a query vetorial. O front/back chama isso
-- via supabase.rpc('match_knowledge_chunks', {...}).
--
-- Parâmetros:
--   query_embedding: vetor 768 da pergunta (gerado pelo gemini-embedding-001)
--   p_agent_id     : escopo do agente (multi-agent por cliente)
--   p_client_id    : escopo do tenant (defesa em profundidade)
--   match_count    : top-k a retornar (default 5)
--   min_similarity : threshold 0-1 (default 0.6 — abaixo disso o match é
--                    fraco e pode atrapalhar mais do que ajudar)
--
-- Retorna: chunks ordenados por similaridade descendente.
CREATE OR REPLACE FUNCTION public.match_knowledge_chunks(
  query_embedding vector(768),
  p_agent_id      INT,
  p_client_id     UUID DEFAULT NULL,
  match_count     INT  DEFAULT 5,
  min_similarity  FLOAT DEFAULT 0.6
)
RETURNS TABLE (
  id           UUID,
  knowledge_id UUID,
  title        TEXT,
  content      TEXT,
  chunk_index  INT,
  similarity   FLOAT
)
LANGUAGE sql STABLE AS $$
  SELECT
    c.id,
    c.knowledge_id,
    k.title,
    c.content,
    c.chunk_index,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.agent_knowledge_chunks c
  JOIN public.agent_knowledge k ON k.id = c.knowledge_id
  WHERE c.agent_id = p_agent_id
    AND (p_client_id IS NULL OR c.client_id = p_client_id)
    AND c.embedding IS NOT NULL
    AND (1 - (c.embedding <=> query_embedding)) >= min_similarity
  ORDER BY c.embedding <=> query_embedding ASC
  LIMIT match_count;
$$;

-- 5) Grants — mesmo padrão das outras tabelas do projeto
GRANT ALL ON TABLE public.agent_knowledge_chunks TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.match_knowledge_chunks TO anon, authenticated, service_role;

-- 6) Sanity check: confere se a extensão e a tabela estão prontas
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'pgvector não foi instalada — verifique se o projeto Supabase suporta extensions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'agent_knowledge_chunks') THEN
    RAISE EXCEPTION 'agent_knowledge_chunks não foi criada';
  END IF;
  RAISE NOTICE '✓ Migration 006 OK — RAG vetorial pronto. Rode "node scripts/backfill-rag.mjs" pra indexar docs existentes.';
END$$;
