-- ============================================================
-- MIGRATION 027: AQUECER CHIPS - SCHEMA FIX & COLUNAS AVANÇADAS
-- Adiciona colunas para piloto automático, saúde do chip, quarentena preventiva,
-- postagem de status e sincronização de vCard à tabela whatsapp_warmup_configs.
-- ============================================================

ALTER TABLE public.whatsapp_warmup_configs
  ADD COLUMN IF NOT EXISTS stage_auto_progress BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS days_active INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS consecutive_successful_days INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS health_score INT NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS is_quarantined BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS quarantine_reason TEXT,
  ADD COLUMN IF NOT EXISTS quarantine_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error_count_today INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_status_post_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS vcard_exchanged_peers JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS min_typing_seconds INT NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS max_typing_seconds INT NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS enable_vcard BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS enable_status_posts BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS continuous_warmup BOOLEAN NOT NULL DEFAULT true;

-- Índices complementares de busca rápida para o worker e dashboard
CREATE INDEX IF NOT EXISTS idx_warmup_configs_client_quarantine
  ON public.whatsapp_warmup_configs (client_id, is_quarantined);

CREATE INDEX IF NOT EXISTS idx_warmup_configs_last_activity
  ON public.whatsapp_warmup_configs (client_id, last_activity_at DESC);

