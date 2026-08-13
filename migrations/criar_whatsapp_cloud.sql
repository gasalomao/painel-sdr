-- =====================================================================
-- WhatsApp Cloud API (Meta) — suporte multi-provider
-- =====================================================================
-- Adiciona a coluna `provider_config` (JSONB) em channel_connections.
-- Schema do JSON quando provider='whatsapp_cloud':
-- {
--   "phone_number_id": "1234567890",         -- Phone Number ID (Meta Business)
--   "access_token":    "EAAG...",            -- System User Token (recomenda permanente)
--   "business_account_id": "987654321",      -- WABA ID (opcional, usado em logs)
--   "verify_token":   "qualquer-string",     -- Usado no GET de verificação do webhook
--   "app_secret":     "...",                 -- Pra validar X-Hub-Signature-256 (opcional)
--   "graph_version":  "v21.0"                -- Default v21.0
-- }
-- =====================================================================

ALTER TABLE public.channel_connections
  ADD COLUMN IF NOT EXISTS provider_config JSONB DEFAULT '{}'::jsonb;

-- Índice GIN pra acelerar lookup por phone_number_id (usado pelo webhook
-- /api/webhooks/whatsapp-cloud pra rotear pra instância correta).
CREATE INDEX IF NOT EXISTS idx_channel_provider_phone_id
  ON public.channel_connections ((provider_config->>'phone_number_id'))
  WHERE provider = 'whatsapp_cloud';

-- Garante que provider tenha a coluna (já existe nos schemas atuais, idempotente)
ALTER TABLE public.channel_connections
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'evolution';
