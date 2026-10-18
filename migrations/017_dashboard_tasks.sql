-- Apenas preparar: executar manualmente no SQL Editor quando autorizado.
BEGIN;

CREATE TABLE IF NOT EXISTS public.dashboard_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  text text NOT NULL CHECK (char_length(btrim(text, E' \t\n\r\f\013')) BETWEEN 1 AND 1000 AND char_length(text) <= 1000),
  due_at timestamptz NOT NULL,
  completed_at timestamptz,
  lead_id integer REFERENCES public.leads_extraidos(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dashboard_tasks_pending_idx
  ON public.dashboard_tasks(client_id, due_at, id) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS dashboard_tasks_completed_idx
  ON public.dashboard_tasks(client_id, completed_at DESC, id) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS dashboard_tasks_lead_idx
  ON public.dashboard_tasks(lead_id) WHERE lead_id IS NOT NULL;

-- FK por id não garante o tenant. Verificação SQL também protege escritas fora da API.
CREATE OR REPLACE FUNCTION public.dashboard_tasks_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  lead_client_id uuid;
BEGIN
  IF NEW.lead_id IS NOT NULL THEN
    SELECT client_id INTO lead_client_id FROM public.leads_extraidos WHERE id = NEW.lead_id FOR SHARE;
    IF lead_client_id IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'dashboard_tasks_lead_tenant' USING ERRCODE = '23503';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- O lock de linha do UPDATE torna conclusões concorrentes idempotentes.
    IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT NULL THEN
      NEW.completed_at := OLD.completed_at;
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dashboard_tasks_guard ON public.dashboard_tasks;
CREATE TRIGGER dashboard_tasks_guard BEFORE INSERT OR UPDATE ON public.dashboard_tasks
  FOR EACH ROW EXECUTE FUNCTION public.dashboard_tasks_guard();

-- Não permitir que uma transferência de lead torne tarefas existentes estrangeiras.
-- SECURITY DEFINER verifica os vínculos mesmo para updates do lead sujeitos a RLS.
CREATE OR REPLACE FUNCTION public.dashboard_tasks_lead_scope_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.client_id IS DISTINCT FROM OLD.client_id AND EXISTS (
    SELECT 1 FROM public.dashboard_tasks WHERE lead_id = OLD.id AND client_id IS DISTINCT FROM NEW.client_id
  ) THEN
    RAISE EXCEPTION 'dashboard_tasks_lead_tenant' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS dashboard_tasks_lead_scope_guard ON public.leads_extraidos;
CREATE TRIGGER dashboard_tasks_lead_scope_guard BEFORE UPDATE OF client_id ON public.leads_extraidos
  FOR EACH ROW EXECUTE FUNCTION public.dashboard_tasks_lead_scope_guard();

ALTER TABLE public.dashboard_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dashboard_tasks FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dashboard_tasks_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dashboard_tasks_lead_scope_guard() FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON public.dashboard_tasks FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION public.dashboard_tasks_guard() FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION public.dashboard_tasks_lead_scope_guard() FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.dashboard_tasks TO service_role;
    GRANT EXECUTE ON FUNCTION public.dashboard_tasks_guard() TO service_role;
  END IF;
END;
$$;

COMMIT;
