-- ============================================================
-- MIGRATION 032: GOVERNADOR MMZAP BROWSER WORKER & TELEMETRIA
-- ============================================================

DO $$ BEGIN
  IF to_regclass('public.whatsapp_warmup_configs') IS NOT NULL THEN
    ALTER TABLE public.whatsapp_warmup_configs
      ADD COLUMN IF NOT EXISTS external_mmzap_sent_today INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS external_mmzap_sent_total INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS mmzap_browser_enabled BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS mmzap_browser_status TEXT NOT NULL DEFAULT 'unpaired',
      ADD COLUMN IF NOT EXISTS mmzap_shift_started_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS mmzap_last_shift_ended_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS mmzap_minutes_today INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS mmzap_shifts_today INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS mmzap_max_sends_override INTEGER,
      ADD COLUMN IF NOT EXISTS mmzap_proxy_endpoint TEXT,
      ADD COLUMN IF NOT EXISTS mmzap_last_error TEXT;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'chk_warmup_mmzap_browser_status'
    ) THEN
      ALTER TABLE public.whatsapp_warmup_configs
        ADD CONSTRAINT chk_warmup_mmzap_browser_status
        CHECK (mmzap_browser_status IN (
          'unpaired',
          'qr_pending',
          'needs_extension_setup',
          'idle',
          'running',
          'paused_safety',
          'error'
        ));
    END IF;
  END IF;

  IF to_regclass('public.whatsapp_phone_passports') IS NOT NULL THEN
    ALTER TABLE public.whatsapp_phone_passports
      ADD COLUMN IF NOT EXISTS external_mmzap_sent_today INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS external_mmzap_sent_total INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;
