-- ============================================================
-- FOLLOW-UP AUTOMATIZADO — schema
-- Rodar no SQL Editor do Supabase
-- ============================================================

CREATE TABLE IF NOT EXISTS public.followup_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  instance_name TEXT NOT NULL,
  -- Configuração do agente IA (opcional)
  ai_enabled BOOLEAN DEFAULT FALSE,
  ai_model TEXT,          -- modelo Gemini (ex: gemini-1.5-flash)
  ai_prompt TEXT,         -- prompt custom que define comportamento do agente
  -- Passos do follow-up: array ordenado de { day_offset, template }
  -- Ex: [{"day_offset":2,"template":"{{saudacao}} {{nome_empresa}}, ainda está aí?"}]
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Anti-bloqueio
  min_interval_seconds INT NOT NULL DEFAULT 40,
  max_interval_seconds INT NOT NULL DEFAULT 90,
  allowed_start_hour INT DEFAULT 9,
  allowed_end_hour   INT DEFAULT 20,
  -- Modo de execução: roda sozinho OU só dispara quando clicar "Executar agora"
  auto_execute BOOLEAN DEFAULT FALSE,
  -- 'active' | 'paused' | 'draft'
  status TEXT NOT NULL DEFAULT 'draft',
  -- Métricas
  total_enrolled INT DEFAULT 0,
  total_sent INT DEFAULT 0,
  total_responded INT DEFAULT 0,
  total_exhausted INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_followup_campaigns_status ON public.followup_campaigns(status);

CREATE TABLE IF NOT EXISTS public.followup_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  followup_campaign_id UUID NOT NULL REFERENCES public.followup_campaigns(id) ON DELETE CASCADE,
  lead_id INT,
  remote_jid TEXT NOT NULL,
  nome_negocio TEXT,
  ramo_negocio TEXT,
  -- current_step = índice do próximo step a disparar (0 = primeiro follow-up)
  current_step INT NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMPTZ,
  next_send_at TIMESTAMPTZ,  -- quando pode disparar o próximo (respeita day_offset)
  -- 'pending' | 'waiting' | 'responded' | 'exhausted' | 'failed'
  status TEXT NOT NULL DEFAULT 'pending',
  last_message_id TEXT,
  last_rendered TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_followup_targets_campaign ON public.followup_targets(followup_campaign_id);
CREATE INDEX IF NOT EXISTS idx_followup_targets_next ON public.followup_targets(followup_campaign_id, status, next_send_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_followup_target
  ON public.followup_targets(followup_campaign_id, remote_jid);

ALTER TABLE public.followup_campaigns DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.followup_targets   DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.followup_campaigns TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.followup_targets   TO anon, authenticated, service_role;

-- ============================================================
-- followup_logs — eventos em tempo real (igual campaign_logs).
-- Alimenta o painel ao vivo e o indicador "Agora..." no card.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.followup_logs (
  id BIGSERIAL PRIMARY KEY,
  followup_campaign_id UUID NOT NULL REFERENCES public.followup_campaigns(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info', -- info | success | warning | error
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_followup_logs_campaign ON public.followup_logs(followup_campaign_id, created_at);
ALTER TABLE public.followup_logs DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.followup_logs TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.followup_logs_id_seq TO anon, authenticated, service_role;

-- Último erro persistente na campanha (visibilidade no card)
ALTER TABLE public.followup_campaigns ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE public.followup_campaigns ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;

-- Guarda o INPUT da IA (template renderizado) pra o painel mostrar
-- "Template → IA → enviado" igual ao disparo em massa.
ALTER TABLE public.followup_targets ADD COLUMN IF NOT EXISTS ai_input TEXT;
