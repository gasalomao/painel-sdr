-- 013_disable_groups.sql
-- ============================================================================
-- Adiciona coluna disable_groups em agent_settings.
--
-- Quando disable_groups = true, a IA:
--   - NAO responde mensagens de grupos (@g.us)
--   - NAO transcreve audios de grupo (economiza tokens)
-- As mensagens de grupo continuam sendo SALVAS no banco (visiveis no painel).
--
-- Rodar via: Supabase Studio -> SQL Editor -> colar -> Run.
-- ============================================================================

ALTER TABLE public.agent_settings ADD COLUMN IF NOT EXISTS disable_groups boolean DEFAULT false;
