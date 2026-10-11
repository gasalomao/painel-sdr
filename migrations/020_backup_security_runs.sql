-- Incremental: mantém dados/configurações anteriores. Executar somente após aprovação.
BEGIN;
ALTER TABLE public.backup_config ADD COLUMN IF NOT EXISTS next_backup_at timestamptz;
ALTER TABLE public.backup_config ADD COLUMN IF NOT EXISTS encrypted_tokens text;
ALTER TABLE public.backup_history ADD COLUMN IF NOT EXISTS run_id uuid;

CREATE TABLE IF NOT EXISTS public.backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL,
  backup_type text NOT NULL CHECK (backup_type IN ('manual','automatic')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','success','failed')),
  stage text NOT NULL DEFAULT 'queued',
  worker_id uuid,
  heartbeat_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.backup_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.backup_runs(id) ON DELETE CASCADE,
  level text NOT NULL DEFAULT 'info' CHECK (level IN ('info','error','warning')),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backup_events_run_idx ON public.backup_events(run_id,id);
-- Uma única exportação global, independentemente do cliente/replica.
CREATE UNIQUE INDEX IF NOT EXISTS backup_one_active_idx ON public.backup_runs ((true)) WHERE status IN ('queued','running');

DO $$ DECLARE t text; p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['backup_config','backup_history','backup_runs','backup_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname,t);
    END LOOP;
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated',t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role',t);
    EXECUTE format('CREATE POLICY backup_server_only ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',t);
  END LOOP;
END $$;

GRANT USAGE, SELECT ON SEQUENCE public.backup_events_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.backup_config_id_seq, public.backup_history_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.claim_backup_run(p_worker uuid)
RETURNS SETOF public.backup_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE selected uuid;
BEGIN
  -- Não roubar uma execução expirada: marcar falha exige confirmação de processo encerrado.
  SELECT id INTO selected FROM public.backup_runs WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF selected IS NOT NULL THEN
    RETURN QUERY UPDATE public.backup_runs SET status='running',stage='starting',worker_id=p_worker,heartbeat_at=now() WHERE id=selected RETURNING *;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.claim_backup_run(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_backup_run(uuid) TO service_role;
COMMIT;
