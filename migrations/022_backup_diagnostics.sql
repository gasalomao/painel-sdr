-- Diagnósticos independentes da fila/lock de backup. Aplicar manualmente, somente após aprovação.
BEGIN;

CREATE TABLE IF NOT EXISTS public.backup_diagnostics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed', 'warning')),
  checks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checks) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS backup_diagnostics_client_created_idx
  ON public.backup_diagnostics (client_id, created_at DESC);

ALTER TABLE public.backup_diagnostics ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'backup_diagnostics' LOOP
    EXECUTE format('DROP POLICY %I ON public.backup_diagnostics', p.policyname);
  END LOOP;
END $$;
REVOKE ALL ON public.backup_diagnostics FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.backup_diagnostics TO service_role;
CREATE POLICY backup_diagnostics_server_only ON public.backup_diagnostics
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
