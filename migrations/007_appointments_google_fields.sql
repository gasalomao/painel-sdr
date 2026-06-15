-- ============================================================================
-- Migration 007 — Campos do Google Calendar em appointments
--
-- Adiciona colunas pra appointments virar espelho 1-pra-1 do Google Calendar:
--   • location           — local do evento ("Av. Paulista 1000")
--   • attendees          — array de emails convidados (jsonb)
--   • all_day            — evento dia inteiro (sem dateTime)
--   • visibility         — default | public | private | confidential
--   • color_id           — id do colorset do Google (1-11)
--   • html_link          — link pra abrir o evento direto no Google Calendar UI
--   • conference_data    — Google Meet (jsonb com hangoutLink, conferenceId)
--   • recurrence         — RRULE pra eventos recorrentes (text[])
--   • organizer_email    — quem criou (vem do Google)
--
-- Tudo nullable + IF NOT EXISTS — seguro re-rodar.
-- ============================================================================

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS location          TEXT,
  ADD COLUMN IF NOT EXISTS attendees         JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS all_day           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS visibility        TEXT DEFAULT 'default'
                            CHECK (visibility IN ('default','public','private','confidential')),
  ADD COLUMN IF NOT EXISTS color_id          TEXT,
  ADD COLUMN IF NOT EXISTS html_link         TEXT,
  ADD COLUMN IF NOT EXISTS conference_data   JSONB,
  ADD COLUMN IF NOT EXISTS recurrence        TEXT[],
  ADD COLUMN IF NOT EXISTS organizer_email   TEXT;

COMMENT ON COLUMN public.appointments.attendees IS
  'Lista de { email, displayName?, responseStatus? } — espelho do attendees do Google Calendar.';
COMMENT ON COLUMN public.appointments.color_id IS
  'ID 1-11 do color set do Google. Mapeia pra cor do evento na UI do Google.';
COMMENT ON COLUMN public.appointments.html_link IS
  'URL pra abrir o evento direto na UI do Google Calendar. Vem da API do Google.';

ANALYZE public.appointments;
