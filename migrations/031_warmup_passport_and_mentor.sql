-- ============================================================
-- MIGRATION 031: PASSAPORTE DE CHIP PÓS-BAN, ESCUDO EXTERNO (MMZAP)
-- E FILA DE ENTREGA DE PRÉVIA (MÉTODO MENTOR)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_phone_passports (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                   UUID NOT NULL,
  canonical_phone             TEXT NOT NULL,
  current_instance_name       TEXT,
  previous_instances          JSONB NOT NULL DEFAULT '[]'::jsonb,
  stage                       INTEGER NOT NULL DEFAULT 1 CHECK (stage BETWEEN 1 AND 4),
  days_active                 INTEGER NOT NULL DEFAULT 0 CHECK (days_active >= 0),
  health_score                INTEGER NOT NULL DEFAULT 100 CHECK (health_score BETWEEN 0 AND 100),
  career_mode                 TEXT NOT NULL DEFAULT 'maturing' CHECK (career_mode IN ('maturing', 'production_light', 'maintenance', 'rehab')),
  ban_count                   INTEGER NOT NULL DEFAULT 0 CHECK (ban_count >= 0),
  last_ban_at                 TIMESTAMPTZ,
  last_ban_reason             TEXT,
  rehab_until                 TIMESTAMPTZ,
  cold_outreach_locked_until  TIMESTAMPTZ,
  external_warmup_mode        TEXT NOT NULL DEFAULT 'off' CHECK (external_warmup_mode IN ('off', 'receive_only', 'hybrid_quarantine')),
  external_warmup_inbound_total INTEGER NOT NULL DEFAULT 0 CHECK (external_warmup_inbound_total >= 0),
  external_warmup_inbound_today INTEGER NOT NULL DEFAULT 0 CHECK (external_warmup_inbound_today >= 0),
  external_warmup_last_at     TIMESTAMPTZ,
  total_messages_sent         INTEGER NOT NULL DEFAULT 0 CHECK (total_messages_sent >= 0),
  total_messages_received     INTEGER NOT NULL DEFAULT 0 CHECK (total_messages_received >= 0),
  total_groups_joined         INTEGER NOT NULL DEFAULT 0 CHECK (total_groups_joined >= 0),
  total_status_posted         INTEGER NOT NULL DEFAULT 0 CHECK (total_status_posted >= 0),
  total_cold_outreach_sent    INTEGER NOT NULL DEFAULT 0 CHECK (total_cold_outreach_sent >= 0),
  total_cold_replies_received INTEGER NOT NULL DEFAULT 0 CHECK (total_cold_replies_received >= 0),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, canonical_phone)
);

CREATE INDEX IF NOT EXISTS idx_phone_passports_client_phone
  ON public.whatsapp_phone_passports (client_id, canonical_phone);

CREATE INDEX IF NOT EXISTS idx_phone_passports_client_mode
  ON public.whatsapp_phone_passports (client_id, career_mode, stage);

CREATE INDEX IF NOT EXISTS idx_phone_passports_rehab_until
  ON public.whatsapp_phone_passports (rehab_until)
  WHERE rehab_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.warmup_external_quarantine (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id              UUID NOT NULL,
  instance_name          TEXT NOT NULL,
  canonical_sender_phone TEXT NOT NULL,
  remote_jid             TEXT NOT NULL,
  sender_name            TEXT,
  message_id             TEXT,
  message_preview        TEXT,
  source_tag             TEXT NOT NULL DEFAULT 'mmzap',
  classification         TEXT NOT NULL DEFAULT 'external_warmup_inbound' CHECK (classification IN ('external_warmup_inbound', 'self_echo', 'quarantined_unknown')),
  seen_count             INTEGER NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_to_crm_at     TIMESTAMPTZ,
  UNIQUE (client_id, instance_name, canonical_sender_phone)
);

CREATE INDEX IF NOT EXISTS idx_warmup_ext_quarantine_lookup
  ON public.warmup_external_quarantine (client_id, instance_name, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.scheduled_preview_deliveries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL,
  contact_id    UUID,
  campaign_id   UUID,
  remote_jid    TEXT NOT NULL,
  instance_name TEXT NOT NULL,
  company_name  TEXT,
  preview_url   TEXT NOT NULL,
  message_text  TEXT NOT NULL,
  delivery_slot TEXT NOT NULL DEFAULT 'now' CHECK (delivery_slot IN ('now', 'plus_3h', 'evening_18h', 'next_morning_09h', 'custom')),
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'cancelled', 'failed')),
  sent_at       TIMESTAMPTZ,
  last_error    TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_preview_due
  ON public.scheduled_preview_deliveries (status, scheduled_for ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_scheduled_preview_client
  ON public.scheduled_preview_deliveries (client_id, status, scheduled_for ASC);

DO $$ BEGIN
  IF to_regclass('public.whatsapp_warmup_configs') IS NOT NULL THEN
    ALTER TABLE public.whatsapp_warmup_configs
      ADD COLUMN IF NOT EXISTS career_mode TEXT NOT NULL DEFAULT 'maturing',
      ADD COLUMN IF NOT EXISTS rehab_until TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cold_outreach_locked_until TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS external_warmup_mode TEXT NOT NULL DEFAULT 'off',
      ADD COLUMN IF NOT EXISTS external_warmup_inbound_today INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS external_warmup_inbound_total INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS external_warmup_last_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS internal_groups_enabled BOOLEAN NOT NULL DEFAULT true;
  END IF;

  IF to_regclass('public.whatsapp_warmup_groups') IS NOT NULL THEN
    ALTER TABLE public.whatsapp_warmup_groups
      ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'external',
      ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;
  END IF;

  IF to_regclass('public.campaigns') IS NOT NULL THEN
    ALTER TABLE public.campaigns
      ADD COLUMN IF NOT EXISTS max_daily_previews INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS approach_strategy TEXT NOT NULL DEFAULT 'mentor_2step';
  END IF;

  IF to_regclass('public.contacts') IS NOT NULL THEN
    ALTER TABLE public.contacts
      ADD COLUMN IF NOT EXISTS ab_variant TEXT,
      ADD COLUMN IF NOT EXISTS preview_accepted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS preview_delivered_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS manual_handoff_at TIMESTAMPTZ;
  END IF;
END $$;

ALTER TABLE public.whatsapp_phone_passports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warmup_external_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_preview_deliveries ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'whatsapp_phone_passports' AND policyname = 'service_role_only_phone_passports'
  ) THEN
    CREATE POLICY service_role_only_phone_passports ON public.whatsapp_phone_passports
      FOR ALL USING ((SELECT current_setting('role', true)) = 'service_role')
      WITH CHECK ((SELECT current_setting('role', true)) = 'service_role');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'warmup_external_quarantine' AND policyname = 'service_role_only_warmup_ext_quarantine'
  ) THEN
    CREATE POLICY service_role_only_warmup_ext_quarantine ON public.warmup_external_quarantine
      FOR ALL USING ((SELECT current_setting('role', true)) = 'service_role')
      WITH CHECK ((SELECT current_setting('role', true)) = 'service_role');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'scheduled_preview_deliveries' AND policyname = 'service_role_only_scheduled_preview_deliveries'
  ) THEN
    CREATE POLICY service_role_only_scheduled_preview_deliveries ON public.scheduled_preview_deliveries
      FOR ALL USING ((SELECT current_setting('role', true)) = 'service_role')
      WITH CHECK ((SELECT current_setting('role', true)) = 'service_role');
  END IF;
END $$;

DO $$ BEGIN
  REVOKE ALL ON TABLE public.whatsapp_phone_passports, public.warmup_external_quarantine, public.scheduled_preview_deliveries FROM PUBLIC, anon, authenticated;
  GRANT ALL ON TABLE public.whatsapp_phone_passports, public.warmup_external_quarantine, public.scheduled_preview_deliveries TO service_role;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
