-- ============================================================
-- MIGRATION 026: AQUECER CHIPS (WHATSAPP WARMUP VIA EVOLUTION API)
-- Permite maturação automática e mútua de números de WhatsApp
-- com escada de aquecimento, IA, presença humana e isolamento do CRM.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_warmup_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  instance_name TEXT NOT NULL,
  phone_number TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  stage INT NOT NULL DEFAULT 1, -- 1: Frio, 2: Morno, 3: Quente, 4: Blindado
  daily_target INT NOT NULL DEFAULT 10,
  sent_today INT NOT NULL DEFAULT 0,
  received_today INT NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMPTZ,
  min_interval_seconds INT NOT NULL DEFAULT 90,
  max_interval_seconds INT NOT NULL DEFAULT 300,
  allowed_start_hour INT NOT NULL DEFAULT 8,
  allowed_end_hour INT NOT NULL DEFAULT 21,
  ai_model TEXT NOT NULL DEFAULT 'fallback', -- 'fallback' (grátis) ou modelo de ai_models
  ai_theme TEXT NOT NULL DEFAULT 'dia_a_dia',
  enable_typing BOOLEAN NOT NULL DEFAULT true,
  enable_blue_ticks BOOLEAN NOT NULL DEFAULT true,
  enable_reactions BOOLEAN NOT NULL DEFAULT true,
  enable_audio BOOLEAN NOT NULL DEFAULT false,
  custom_prompt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_warmup_client_instance UNIQUE (client_id, instance_name)
);

CREATE TABLE IF NOT EXISTS public.whatsapp_warmup_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  sender_instance TEXT NOT NULL,
  receiver_instance TEXT NOT NULL,
  sender_phone TEXT,
  receiver_phone TEXT,
  message_text TEXT NOT NULL,
  action_type TEXT NOT NULL DEFAULT 'text', -- 'text', 'reaction', 'audio', 'presence', 'system'
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.whatsapp_warmup_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  instance_a TEXT NOT NULL,
  instance_b TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT 'dia_a_dia',
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  turn_count INT NOT NULL DEFAULT 0,
  max_turns INT NOT NULL DEFAULT 6,
  last_sender TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'finished'
  next_turn_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_warmup_configs_client_enabled 
  ON public.whatsapp_warmup_configs (client_id, enabled);

CREATE INDEX IF NOT EXISTS idx_warmup_logs_client_created 
  ON public.whatsapp_warmup_logs (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_warmup_convs_status 
  ON public.whatsapp_warmup_conversations (client_id, status, next_turn_at);

ALTER TABLE public.whatsapp_warmup_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_warmup_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_warmup_conversations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'warmup_configs_tenant') THEN
    CREATE POLICY warmup_configs_tenant ON public.whatsapp_warmup_configs
      FOR ALL USING (client_id = (SELECT auth.uid()) OR (SELECT current_setting('role', true)) = 'service_role');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'warmup_logs_tenant') THEN
    CREATE POLICY warmup_logs_tenant ON public.whatsapp_warmup_logs
      FOR ALL USING (client_id = (SELECT auth.uid()) OR (SELECT current_setting('role', true)) = 'service_role');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'warmup_convs_tenant') THEN
    CREATE POLICY warmup_convs_tenant ON public.whatsapp_warmup_conversations
      FOR ALL USING (client_id = (SELECT auth.uid()) OR (SELECT current_setting('role', true)) = 'service_role');
  END IF;
END $$;

