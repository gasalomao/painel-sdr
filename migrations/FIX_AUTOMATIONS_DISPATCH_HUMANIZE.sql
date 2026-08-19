-- ==============================================================================
-- MIGRATION: Colunas de Humanização e Mídia (automations, campaigns, followup_campaigns)
-- Execute este script no SQL Editor do Supabase Dashboard
-- ==============================================================================

-- 1. Tabela automations
ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS dispatch_humanize BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dispatch_media_url TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_media_type TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_media_caption TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_media_file_name TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_media_mimetype TEXT;

-- 2. Tabela campaigns
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS humanize_messages BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  ADD COLUMN IF NOT EXISTS media_caption TEXT,
  ADD COLUMN IF NOT EXISTS media_file_name TEXT,
  ADD COLUMN IF NOT EXISTS media_mimetype TEXT;

-- 3. Tabela followup_campaigns
ALTER TABLE public.followup_campaigns
  ADD COLUMN IF NOT EXISTS humanize_messages BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  ADD COLUMN IF NOT EXISTS media_caption TEXT,
  ADD COLUMN IF NOT EXISTS media_file_name TEXT,
  ADD COLUMN IF NOT EXISTS media_mimetype TEXT;

-- 4. Notificar PostgREST para recarregar o schema cache imediatamente
NOTIFY pgrst, 'reload schema';
