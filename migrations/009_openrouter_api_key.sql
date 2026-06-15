-- 009_openrouter_api_key
-- Adiciona suporte a OpenRouter como provedor de IA alternativo ao Gemini.
-- A chave é compartilhada por todo o sistema (igual à chave Gemini) e fica em
-- ai_organizer_config (id=1), configurada em /configuracoes (apenas admin).
-- Idempotente: pode rodar quantas vezes quiser.

ALTER TABLE public.ai_organizer_config
  ADD COLUMN IF NOT EXISTS openrouter_api_key TEXT;
