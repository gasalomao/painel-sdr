-- Adiciona colunas para combos de IA e suporte multi-chave/endpoints na tabela ai_organizer_config
ALTER TABLE public.ai_organizer_config ADD COLUMN IF NOT EXISTS ai_combos jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.ai_organizer_config ADD COLUMN IF NOT EXISTS openrouter_keys jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.ai_organizer_config ADD COLUMN IF NOT EXISTS gateway_endpoints jsonb DEFAULT '[]'::jsonb;

-- Recarrega o cache de schema da API REST do Supabase (PostgREST)
NOTIFY pgrst, 'reload config';
