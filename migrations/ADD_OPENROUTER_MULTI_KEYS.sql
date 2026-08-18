-- ==============================================================================
-- Migração: Suporte a Múltiplas Contas/API Keys no OpenRouter (9Router-Style)
-- Permite salvar várias API keys que rotacionam automaticamente quando uma bate 429/quota.
-- ==============================================================================

ALTER TABLE public.ai_organizer_config ADD COLUMN IF NOT EXISTS openrouter_keys jsonb DEFAULT '[]'::jsonb;
