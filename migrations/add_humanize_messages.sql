-- Humanização + anexo de mídia em campanhas, automações e follow-ups

-- ═══ HUMANIZAR (picotar mensagens) ═══

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS humanize_messages BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS dispatch_humanize BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.followup_campaigns
  ADD COLUMN IF NOT EXISTS humanize_messages BOOLEAN NOT NULL DEFAULT false;

-- ═══ MÍDIA ANEXA (envia após texto) ═══

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS media_url       TEXT,
  ADD COLUMN IF NOT EXISTS media_type      TEXT,
  ADD COLUMN IF NOT EXISTS media_caption   TEXT,
  ADD COLUMN IF NOT EXISTS media_file_name TEXT,
  ADD COLUMN IF NOT EXISTS media_mimetype  TEXT;

ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS dispatch_media_url       TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_media_type      TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_media_caption   TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_media_file_name TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_media_mimetype  TEXT;

ALTER TABLE public.followup_campaigns
  ADD COLUMN IF NOT EXISTS media_url       TEXT,
  ADD COLUMN IF NOT EXISTS media_type      TEXT,
  ADD COLUMN IF NOT EXISTS media_caption   TEXT,
  ADD COLUMN IF NOT EXISTS media_file_name TEXT,
  ADD COLUMN IF NOT EXISTS media_mimetype  TEXT;
