-- ============================================================
-- DISPARO EM MASSA — tabela de logs
-- Rodar no SQL Editor do Supabase (estava faltando!)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.campaign_logs (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info', -- info | success | warning | error
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_logs_campaign ON public.campaign_logs(campaign_id, created_at);

ALTER TABLE public.campaign_logs DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.campaign_logs TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.campaign_logs_id_seq TO anon, authenticated, service_role;

-- Realtime: nada a fazer. A publication `supabase_realtime` deste projeto é FOR ALL TABLES,
-- então a tabela recém-criada já é publicada automaticamente.

-- ============================================================
-- CAMPAIGNS — coluna de erro persistente
-- Garante que mesmo sem a tabela campaign_logs, o usuário vê
-- o último erro diretamente no card da campanha.
-- ============================================================
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS last_error     TEXT;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS last_error_at  TIMESTAMPTZ;

-- ============================================================
-- CAMPAIGNS — prompt custom pra personalização com IA
-- Quando personalize_with_ai=true, essa instrução substitui o
-- prompt padrão. Permite ajustar tom/abordagem por campanha,
-- sem mexer no agente inteiro.
-- ============================================================
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS ai_prompt TEXT;

-- ============================================================
-- CAMPAIGNS — modelo Gemini exclusivo desta campanha
-- Quando personalize_with_ai=true, cada campanha tem seu próprio
-- "agente leve" (só prompt + modelo), não depende mais de
-- agent_settings. agent_id fica como legado nullable.
-- ============================================================
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS ai_model TEXT;

-- ============================================================
-- CAMPAIGN_TARGETS — input da IA (template renderizado antes
-- da personalização). Permite ver "o que foi pra IA" vs
-- "o que a IA devolveu" direto no histórico da campanha.
-- ============================================================
ALTER TABLE public.campaign_targets ADD COLUMN IF NOT EXISTS ai_input TEXT;
