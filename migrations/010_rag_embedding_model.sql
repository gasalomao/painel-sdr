-- 010_rag_embedding_model
-- Permite escolher o MODELO DE EMBEDDINGS do RAG (base de conhecimento) entre
-- Gemini e OpenRouter, em tempo real. A dimensão do vetor continua 768 (a coluna
-- e o índice HNSW não mudam): pro OpenRouter pedimos `dimensions: 768` na API de
-- embeddings, e pro Gemini usamos um modelo que devolve 768.
--
-- IMPORTANTE: embeddings de modelos DIFERENTES não são comparáveis entre si —
-- ao trocar o modelo é preciso RE-INDEXAR a base (botão em /configuracoes).
-- A coluna embedding_model registra com qual modelo cada chunk foi indexado.
-- Idempotente.

ALTER TABLE public.agent_knowledge_chunks
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;

-- Modelo de embeddings padrão (mesmo de antes — Gemini). Admin troca em /configuracoes.
INSERT INTO public.app_settings (key, value, updated_at)
VALUES ('rag_embedding_model', 'gemini-embedding-001', NOW())
ON CONFLICT (key) DO NOTHING;
