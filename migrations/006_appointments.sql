-- ============================================================================
-- Migration 006 — Sistema de agendamentos (Calendário)
--
-- Cria:
--   1. Tabela `appointments`: cada row = 1 agendamento de 1 lead, criado pela
--      IA (tool schedule_appointment) ou manualmente pelo dono no painel.
--      Sincroniza com Google Calendar via google_event_id quando o agente
--      tem OAuth configurado.
--
--   2. Colunas em agent_settings: is_scheduler (flag) + scheduler_config (JSONB
--      com horários, lembretes com mensagens template, duração padrão).
--
--   3. Constraint anti-double-booking: índice UNIQUE parcial em (agent_id,
--      start_at) WHERE status IN (confirmed, tentative) — impede a IA criar
--      2 agendamentos pro mesmo agente no mesmo horário.
--
--   4. Índices de performance pros workers (lookup por start_at + status).
-- ============================================================================

-- --- Tabela appointments ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.appointments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  agent_id          INT REFERENCES public.agent_settings(id) ON DELETE SET NULL,
  lead_id           INT REFERENCES public.leads_extraidos(id) ON DELETE SET NULL,
  remote_jid        TEXT NOT NULL,
  instance_name     TEXT,
  google_event_id   TEXT,
  calendar_id       TEXT DEFAULT 'primary',
  title             TEXT NOT NULL,
  description       TEXT,
  service_name      TEXT,
  start_at          TIMESTAMPTZ NOT NULL,
  end_at            TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'confirmed'
                      CHECK (status IN ('confirmed','tentative','cancelled','completed','no_show')),
  reminders_sent    JSONB DEFAULT '[]'::jsonb,
  created_by        TEXT NOT NULL DEFAULT 'ia'
                      CHECK (created_by IN ('ia','manual','google_sync')),
  metadata          JSONB DEFAULT '{}'::jsonb,
  cancelled_reason  TEXT,
  cancelled_at      TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- google_event_id é UNIQUE só quando não é NULL (evita conflito de NULLs).
CREATE UNIQUE INDEX IF NOT EXISTS appointments_google_event_id_unique
  ON public.appointments (google_event_id)
  WHERE google_event_id IS NOT NULL;

-- Anti-double-booking: mesmo agente não pode ter 2 agendamentos ativos no
-- mesmo start_at. IA respeita ao tentar create — o constraint do banco é
-- defesa final contra race condition (2 leads pedindo mesmo slot).
CREATE UNIQUE INDEX IF NOT EXISTS appointments_no_overlap
  ON public.appointments (agent_id, start_at)
  WHERE agent_id IS NOT NULL AND status IN ('confirmed','tentative');

-- Hot paths: listagem por cliente e período + worker reminder.
CREATE INDEX IF NOT EXISTS idx_appointments_client_start
  ON public.appointments (client_id, start_at);

CREATE INDEX IF NOT EXISTS idx_appointments_status_start
  ON public.appointments (status, start_at);

CREATE INDEX IF NOT EXISTS idx_appointments_remote_jid
  ON public.appointments (remote_jid);

CREATE INDEX IF NOT EXISTS idx_appointments_agent_start
  ON public.appointments (agent_id, start_at);

-- Trigger pra manter updated_at
CREATE OR REPLACE FUNCTION public.appointments_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointments_updated_at ON public.appointments;
CREATE TRIGGER appointments_updated_at
  BEFORE UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.appointments_set_updated_at();


-- --- Flags no agent_settings -----------------------------------------------
ALTER TABLE public.agent_settings
  ADD COLUMN IF NOT EXISTS is_scheduler BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.agent_settings
  ADD COLUMN IF NOT EXISTS scheduler_config JSONB DEFAULT '{
    "calendar_id": "primary",
    "default_duration_minutes": 60,
    "buffer_between_minutes": 0,
    "business_hours": {
      "start": "09:00",
      "end": "18:00",
      "tz": "America/Sao_Paulo",
      "days": [1,2,3,4,5,6]
    },
    "services": [],
    "reminders": [
      {
        "offset_minutes": 1440,
        "message": "Oi {nome}! Lembrete: amanhã às {hora_agendamento} temos seu agendamento de {servico}. Confirma a presença?"
      },
      {
        "offset_minutes": 60,
        "message": "Oi {nome}! Em 1h é o seu agendamento ({servico}). Te esperamos!"
      }
    ],
    "cancel_window_minutes": 120,
    "notify_owner": false,
    "owner_phone": null,
    "auto_promote_kanban_after_minutes": 30
  }'::jsonb;


-- --- Feature flag pro cliente (libera o módulo Calendário no menu) ---------
-- Adiciona "calendario" como feature opt-in nas configurações do cliente.
-- Default = true (libera pra todos) pra não quebrar UX de quem já existe.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='clients' AND column_name='features'
  ) THEN
    UPDATE public.clients
       SET features = COALESCE(features, '{}'::jsonb) || jsonb_build_object('calendario', true)
     WHERE NOT (features ? 'calendario');
  END IF;
END $$;


-- --- ANALYZE ---------------------------------------------------------------
ANALYZE public.appointments;
ANALYZE public.agent_settings;
