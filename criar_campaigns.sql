-- ============================================================
-- DISPARO EM MASSA — schema
-- Rodar no SQL Editor do Supabase
-- ============================================================

CREATE TABLE IF NOT EXISTS public.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  instance_name TEXT NOT NULL,
  agent_id INT REFERENCES public.agent_settings(id) ON DELETE SET NULL,
  message_template TEXT NOT NULL,
  -- Intervalo aleatório entre cada envio (em segundos)
  min_interval_seconds INT NOT NULL DEFAULT 30,
  max_interval_seconds INT NOT NULL DEFAULT 60,
  -- Horário permitido pra disparar (ex: 9h-20h). Fora disso, pausa automática.
  allowed_start_hour INT DEFAULT 9,   -- 0-23
  allowed_end_hour   INT DEFAULT 20,  -- 0-23
  -- Estado: draft | running | paused | done | cancelled
  status TEXT NOT NULL DEFAULT 'draft',
  -- Métricas
  total_targets INT DEFAULT 0,
  sent_count INT DEFAULT 0,
  failed_count INT DEFAULT 0,
  skipped_count INT DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON public.campaigns(status);

CREATE TABLE IF NOT EXISTS public.campaign_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  remote_jid TEXT NOT NULL,
  nome_negocio TEXT,
  ramo_negocio TEXT,
  -- Quando foi/será enviada esta msg específica (resilience: worker pode reiniciar)
  next_send_at TIMESTAMPTZ,
  -- Estado: pending | sent | failed | skipped
  status TEXT NOT NULL DEFAULT 'pending',
  message_id TEXT,
  rendered_message TEXT,
  error_message TEXT,
  attempts INT DEFAULT 0,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_targets_campaign ON public.campaign_targets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_targets_status ON public.campaign_targets(campaign_id, status);
-- Evita duplicação do mesmo lead na mesma campanha
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_target ON public.campaign_targets(campaign_id, remote_jid);

ALTER TABLE public.campaigns         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_targets  DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.campaigns         TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.campaign_targets  TO anon, authenticated, service_role;
