-- ============================================================
-- SQL de GARANTIA — recursos entregues em 2026-05-22 (Painel SDR)
-- ------------------------------------------------------------
-- Cole TUDO isto no Supabase → SQL Editor → Run.
-- 100% idempotente: pode rodar quantas vezes quiser, sem risco.
--
-- IMPORTANTE: a maioria das features de hoje NÃO precisa de SQL —
-- elas usam `scheduler_config` (JSONB) e `app_settings` (chave-valor),
-- que aceitam campos novos sem alterar o banco. Este script só
-- garante as tabelas de LOG e colunas opcionais, pra o "Log ao vivo"
-- da automação/disparo funcionar 100%.
-- ============================================================

-- 1) Log da AUTOMAÇÃO (heartbeat de cada fase: captação/disparo/follow-up)
CREATE TABLE IF NOT EXISTS public.automation_logs (
  id BIGSERIAL PRIMARY KEY,
  automation_id  UUID NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'state',
  level          TEXT NOT NULL DEFAULT 'info',
  message        TEXT NOT NULL,
  remote_jid     TEXT,
  metadata       JSONB DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_logs_automation
  ON public.automation_logs(automation_id, created_at DESC);

-- 2) Log do DISPARO em massa (cada envio, com a mensagem real)
CREATE TABLE IF NOT EXISTS public.campaign_logs (
  id BIGSERIAL PRIMARY KEY,
  campaign_id  UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  message      TEXT NOT NULL,
  level        TEXT NOT NULL DEFAULT 'info',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaign_logs_campaign
  ON public.campaign_logs(campaign_id, created_at);

-- 3) Colunas opcionais (o código tem fallback, mas com elas tudo fica completo)
ALTER TABLE public.campaigns        ADD COLUMN IF NOT EXISTS automation_id UUID;
ALTER TABLE public.campaign_targets ADD COLUMN IF NOT EXISTS ai_input TEXT;
ALTER TABLE public.campaign_targets ADD COLUMN IF NOT EXISTS rendered_message TEXT;
CREATE INDEX IF NOT EXISTS idx_campaigns_automation
  ON public.campaigns(automation_id) WHERE automation_id IS NOT NULL;

-- 4) "Log ao vivo" em tempo real — adiciona as tabelas de log à publicação
--    de realtime do Supabase (sem isto, o painel ainda funciona via
--    polling de 5s; com isto, atualiza instantâneo).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'automation_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.automation_logs;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'campaign_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.campaign_logs;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Realtime publication (ignorado): %', SQLERRM;
END $$;

-- ============================================================
-- NÃO precisa de SQL (já funciona com o banco atual):
--   • Resumo IA pro dono ......... usa scheduler_config (JSONB)
--   • Kanban auto-mover De→Para .. usa scheduler_config (JSONB)
--   • Pausa automática da IA ..... usa app_settings (chave-valor)
--   • Auto-vínculo de agente ..... usa channel_connections / agent_settings
--   • Gate anti-burst do disparo . usa campaigns.updated_at (já existe)
--   • Variáveis / JID / nome ..... sem mudança de schema
-- ============================================================
