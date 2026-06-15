-- =====================================================================
--  PAINEL SDR — Migration completa (Evolution + WhatsApp Cloud API)
--  Cole TUDO no SQL Editor do Supabase.
--  Idempotente: pode rodar várias vezes sem dar erro.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- 1) channel_connections : multi-provider (Evolution + WhatsApp Cloud)
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.channel_connections
  ADD COLUMN IF NOT EXISTS provider        TEXT NOT NULL DEFAULT 'evolution';

ALTER TABLE public.channel_connections
  ADD COLUMN IF NOT EXISTS provider_config JSONB DEFAULT '{}'::jsonb;

-- Schema esperado em provider_config quando provider='whatsapp_cloud':
-- {
--   "phone_number_id":     "123456789012345",  -- da Meta (Phone Number ID)
--   "access_token":        "EAAG...",          -- System User Token (permanente)
--   "business_account_id": "987654321",        -- WABA ID (pra subscribed_apps)
--   "verify_token":        "qualquer-string",  -- igual ao do Meta App
--   "app_secret":          "...",              -- opcional
--   "graph_version":       "v21.0"
-- }

-- Lookup rápido de qual instance recebe um phone_number_id (rotear webhook entrante)
CREATE INDEX IF NOT EXISTS idx_channel_provider_phone_id
  ON public.channel_connections ((provider_config->>'phone_number_id'))
  WHERE provider = 'whatsapp_cloud';

-- ─────────────────────────────────────────────────────────────────────
-- 2) chats_dashboard : colunas usadas para mídia (preview no /chat)
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS instance_name TEXT DEFAULT 'sdr';
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS media_url     TEXT;
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS media_type    TEXT;   -- image | audio | video | document | sticker
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS mimetype      TEXT;
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS message_type  TEXT;
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS quoted_id     TEXT;
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS quoted_text   TEXT;

-- ─────────────────────────────────────────────────────────────────────
-- 3) leads_extraidos : garante todas as colunas usadas pelas variáveis
--    do prompt ({{nome_empresa}}, {{ramo}}, {{categoria}}, ...)
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS instance_name        TEXT DEFAULT 'sdr';
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS nome_negocio         TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS ramo_negocio         TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS categoria            TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS endereco             TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS website              TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS avaliacao            NUMERIC;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS reviews              INT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS telefone             TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS status               TEXT DEFAULT 'novo';
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS justificativa_ia     TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS resumo_ia            TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS ia_last_analyzed_at  TIMESTAMPTZ;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS primeiro_contato_at  TIMESTAMPTZ;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS primeiro_contato_source TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_leads_remoteJid ON public.leads_extraidos ("remoteJid");
CREATE INDEX IF NOT EXISTS idx_leads_status    ON public.leads_extraidos (status);

-- ─────────────────────────────────────────────────────────────────────
-- 4) sessions : variáveis dinâmicas + funil
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS variables       JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS current_stage_id INT;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS unread_count    INT DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS paused_by       TEXT;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS paused_at       TIMESTAMPTZ;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS resume_at       TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────────────
-- 5) contacts : push_name (nome do WhatsApp) usado em {{nome}} e {{push_name}}
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS push_name TEXT;

-- ─────────────────────────────────────────────────────────────────────
-- 6) messages (V2): file_name, mimetype, quoted_msg_id, quoted_text,
--    media_url, media_category — tudo usado pelo /chat e pela IA
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS file_name      TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS file_size      BIGINT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS mimetype       TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS media_url      TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS quoted_msg_id  TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS quoted_text    TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS raw_payload    JSONB;

-- ─────────────────────────────────────────────────────────────────────
-- 7) chat_buffers : usado pelo "agrupador" de mensagens do agent/process
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_buffers (
  remote_jid    TEXT NOT NULL,
  instance_name TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (remote_jid, instance_name)
);

-- ─────────────────────────────────────────────────────────────────────
-- 8) webhook_logs : já existe; só garante idempotência
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_name TEXT,
  event TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created ON public.webhook_logs (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- 9) app_settings : guarda a public_url (ngrok / domínio VPS)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────
-- 10) Storage bucket whatsapp_media — execute UMA VEZ:
--     (Se já existe, ignora)
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('whatsapp_media', 'whatsapp_media', true)
ON CONFLICT (id) DO NOTHING;

-- Política pública de leitura (ajuste conforme política do projeto)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'whatsapp_media_public_read'
  ) THEN
    CREATE POLICY whatsapp_media_public_read ON storage.objects
      FOR SELECT USING (bucket_id = 'whatsapp_media');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'whatsapp_media_service_write'
  ) THEN
    CREATE POLICY whatsapp_media_service_write ON storage.objects
      FOR ALL TO service_role USING (bucket_id = 'whatsapp_media') WITH CHECK (bucket_id = 'whatsapp_media');
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 11) ai_pricing_cache : preços online de modelos (LiteLLM)
--     Usado pela página /tokens pra calcular custo em tempo real
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_pricing_cache (
  key        TEXT PRIMARY KEY,
  payload    JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================================================================
-- FIM. Pronto pra usar Evolution + WhatsApp Cloud no mesmo painel.
-- =====================================================================
