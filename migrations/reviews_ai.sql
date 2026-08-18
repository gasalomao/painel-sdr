-- =====================================================================
-- Reviews AI — resumo de avaliações do Google com IA
-- Aplica: colunas de cache em leads_extraidos, config em automations,
--         tabela de log reviews_ai_logs.
-- Idempotente (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS).
-- Rode no SQL Editor do Supabase.
-- =====================================================================

ALTER TABLE public.leads_extraidos
  ADD COLUMN IF NOT EXISTS resumo_avaliacoes text,
  ADD COLUMN IF NOT EXISTS resumo_avaliacoes_at timestamptz;

ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS reviews_ai_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS reviews_ai_model text,
  ADD COLUMN IF NOT EXISTS reviews_ai_prompt text;

CREATE TABLE IF NOT EXISTS public.reviews_ai_logs (
  id                BIGSERIAL PRIMARY KEY,
  client_id         uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  lead_id           bigint,
  remote_jid        text,
  nome_negocio      text,
  model             text,
  prompt            text,
  response          text,
  cached            boolean DEFAULT false,
  prompt_tokens     integer DEFAULT 0,
  completion_tokens integer DEFAULT 0,
  total_tokens      integer DEFAULT 0,
  source            text DEFAULT 'manual',
  automation_id     uuid,
  created_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reviews_ai_logs_lead   ON public.reviews_ai_logs USING btree (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_ai_logs_client ON public.reviews_ai_logs USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_reviews_ai_logs_jid    ON public.reviews_ai_logs USING btree (remote_jid, created_at DESC);

-- Libera leitura/escrita via service_role (PostgREST). Anon não lê.
ALTER TABLE public.reviews_ai_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reviews_ai_logs_service_all ON public.reviews_ai_logs;
CREATE POLICY reviews_ai_logs_service_all ON public.reviews_ai_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
