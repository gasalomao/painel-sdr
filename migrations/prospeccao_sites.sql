-- ============================================================
-- PROSPECÇÃO SITES — discrimina campanhas de prospecção (empresas sem site)
-- Reusa campaigns/campaign_targets/campaign_logs. Sem novas tabelas.
-- Rode no SQL Editor do Supabase.
-- ============================================================

-- Tipo de campanha: 'disparo' (padrão legado) | 'prospeccao_sites'
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS campaign_type TEXT NOT NULL DEFAULT 'disparo';

-- Lead que originou a prospecção (opcional — para rastreabilidade)
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS prospeccao_lead INT REFERENCES public.leads_extraidos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_campaigns_type ON public.campaigns(campaign_type);

-- Filtro rápido "sem website" — partial index cobre query mais comum
CREATE INDEX IF NOT EXISTS idx_prospeccao_no_website
  ON public.leads_extraidos(client_id, created_at DESC)
  WHERE COALESCE(website, '') = '';

-- Opt-out: marca lead que pediu parar de receber prospecção.
-- Worker checa antes do envio e pula + loga.
ALTER TABLE public.leads_extraidos
  ADD COLUMN IF NOT EXISTS opt_out BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_leads_opt_out ON public.leads_extraidos(client_id, opt_out);

-- Prioridade de envio por target — maior priority dispara primeiro.
-- Computado no POST de /api/prospeccao-sites/campaigns a partir de
-- order_by (reviews|rating|created_at) + order_dir (asc|desc).
-- Worker ordena por priority DESC, created_at ASC.
ALTER TABLE public.campaign_targets
  ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ct_priority
  ON public.campaign_targets(campaign_id, status, priority DESC, created_at);