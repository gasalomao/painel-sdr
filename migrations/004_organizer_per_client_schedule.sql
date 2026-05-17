-- ============================================================================
-- Migration 004 — Organizador IA per-client schedule
--
-- Cada cliente escolhe a hora do dia em que o Organizador IA roda
-- (clients.organizer_execution_hour). O scheduler em instrumentation.ts
-- itera por cliente, e dispara um run isolado pra cada um na sua hora.
-- organizer_last_run guarda quando rodou pela última vez pra evitar
-- duplo disparo no mesmo dia.
-- ============================================================================

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS organizer_execution_hour INTEGER NOT NULL DEFAULT 20
    CHECK (organizer_execution_hour BETWEEN 0 AND 23),
  ADD COLUMN IF NOT EXISTS organizer_last_run TIMESTAMPTZ;

COMMENT ON COLUMN public.clients.organizer_execution_hour IS
  'Hora do dia (0-23, hora do servidor) em que o Organizador IA roda automaticamente pra este cliente.';
COMMENT ON COLUMN public.clients.organizer_last_run IS
  'Timestamp do último disparo automático do Organizador IA pra este cliente. Usado pra evitar duplo run no mesmo dia.';
