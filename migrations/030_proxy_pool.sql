-- ============================================================
-- MIGRATION 030: POOL DE PROXIES ROTATIVOS + LISTA NEGRA
-- Suporta importação mensal (.txt Webshare), vínculo exclusivo 1:1
-- sem colisão sob concorrência, lista negra de proxies usados/falhos/banidos
-- e fail-open seguro para IP padrão da VPS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.proxy_pool (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host               TEXT NOT NULL,
  port               INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  protocol           TEXT NOT NULL DEFAULT 'http' CHECK (protocol IN ('http', 'https', 'socks4', 'socks5')),
  username           TEXT NOT NULL DEFAULT '',
  password           TEXT NOT NULL DEFAULT '',
  provider_label     TEXT NOT NULL DEFAULT 'webshare',
  country_code       TEXT NOT NULL DEFAULT 'BR',
  status             TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'assigned', 'blacklisted', 'retired')),
  blacklist_reason   TEXT CHECK (blacklist_reason IS NULL OR blacklist_reason IN ('used', 'failed', 'banned', 'manual')),
  blacklisted_at     TIMESTAMPTZ,
  assigned_instance  TEXT,
  assigned_client_id UUID,
  assigned_at        TIMESTAMPTZ,
  last_batch_id      UUID,
  fail_count         INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  last_checked_at    TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.proxy_pool_batches (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by            TEXT,
  protocol               TEXT NOT NULL DEFAULT 'http',
  total_parsed           INTEGER NOT NULL DEFAULT 0,
  added_count            INTEGER NOT NULL DEFAULT 0,
  kept_assigned_count    INTEGER NOT NULL DEFAULT 0,
  kept_blacklisted_count INTEGER NOT NULL DEFAULT 0,
  retired_count          INTEGER NOT NULL DEFAULT 0,
  migrated_instances     INTEGER NOT NULL DEFAULT 0,
  fallback_vps_instances INTEGER NOT NULL DEFAULT 0,
  clear_used_blacklist   BOOLEAN NOT NULL DEFAULT false,
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices únicos parciais: garantem exclusividade 1:1 no banco mesmo com múltiplos cliques simultâneos.
CREATE UNIQUE INDEX IF NOT EXISTS uq_proxy_pool_active_endpoint
  ON public.proxy_pool (host, port)
  WHERE status <> 'retired';

CREATE UNIQUE INDEX IF NOT EXISTS uq_proxy_pool_assigned_instance
  ON public.proxy_pool (assigned_instance)
  WHERE status = 'assigned' AND assigned_instance IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_proxy_pool_status_created
  ON public.proxy_pool (status, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_proxy_pool_blacklist
  ON public.proxy_pool (status, blacklist_reason, blacklisted_at DESC)
  WHERE status = 'blacklisted';

CREATE INDEX IF NOT EXISTS idx_proxy_pool_assigned_client
  ON public.proxy_pool (assigned_client_id)
  WHERE status = 'assigned';

-- RPC atômico de claim: serializa apenas requisições da mesma instância via advisory lock
-- e distribui proxies diferentes em paralelo para instâncias distintas via FOR UPDATE SKIP LOCKED.
CREATE OR REPLACE FUNCTION public.claim_next_proxy(
  p_instance_name text,
  p_client_id uuid DEFAULT NULL,
  p_reserve_for_warmup integer DEFAULT 0,
  p_for_warmup boolean DEFAULT false
)
RETURNS SETOF public.proxy_pool
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.proxy_pool%ROWTYPE;
  v_claimed_id uuid;
  v_available integer;
BEGIN
  IF p_instance_name IS NULL OR btrim(p_instance_name) = '' THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(btrim(p_instance_name)));

  SELECT * INTO v_existing
  FROM public.proxy_pool
  WHERE assigned_instance = btrim(p_instance_name)
    AND status = 'assigned'
  LIMIT 1;

  IF FOUND THEN
    RETURN NEXT v_existing;
    RETURN;
  END IF;

  IF NOT COALESCE(p_for_warmup, false) AND COALESCE(p_reserve_for_warmup, 0) > 0 THEN
    SELECT count(*) INTO v_available
    FROM public.proxy_pool
    WHERE status = 'available';

    IF v_available <= p_reserve_for_warmup THEN
      RETURN;
    END IF;
  END IF;

  SELECT p.id INTO v_claimed_id
  FROM public.proxy_pool p
  WHERE p.status = 'available'
  ORDER BY p.created_at ASC, p.id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_claimed_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.proxy_pool
  SET status = 'assigned',
      assigned_instance = btrim(p_instance_name),
      assigned_client_id = p_client_id,
      assigned_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE id = v_claimed_id
  RETURNING *;
END $$;

-- RPC atômico para mover proxy atribuído diretamente para a Lista Negra rotativa.
CREATE OR REPLACE FUNCTION public.blacklist_instance_proxy(
  p_instance_name text,
  p_reason text DEFAULT 'used',
  p_error text DEFAULT NULL
)
RETURNS SETOF public.proxy_pool
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason text;
BEGIN
  IF p_instance_name IS NULL OR btrim(p_instance_name) = '' THEN
    RETURN;
  END IF;

  v_reason := CASE
    WHEN p_reason IN ('used', 'failed', 'banned', 'manual') THEN p_reason
    ELSE 'used'
  END;

  PERFORM pg_advisory_xact_lock(hashtext(btrim(p_instance_name)));

  RETURN QUERY
  UPDATE public.proxy_pool
  SET status = 'blacklisted',
      blacklist_reason = v_reason,
      blacklisted_at = clock_timestamp(),
      assigned_instance = NULL,
      assigned_client_id = NULL,
      fail_count = fail_count + CASE WHEN v_reason IN ('failed', 'banned') THEN 1 ELSE 0 END,
      last_error = COALESCE(NULLIF(btrim(COALESCE(p_error, '')), ''), last_error),
      updated_at = clock_timestamp()
  WHERE assigned_instance = btrim(p_instance_name)
    AND status = 'assigned'
  RETURNING *;
END $$;

ALTER TABLE public.proxy_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proxy_pool_batches ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'proxy_pool' AND policyname = 'service_role_only_proxy_pool'
  ) THEN
    CREATE POLICY service_role_only_proxy_pool ON public.proxy_pool
      FOR ALL USING ((SELECT current_setting('role', true)) = 'service_role')
      WITH CHECK ((SELECT current_setting('role', true)) = 'service_role');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'proxy_pool_batches' AND policyname = 'service_role_only_proxy_pool_batches'
  ) THEN
    CREATE POLICY service_role_only_proxy_pool_batches ON public.proxy_pool_batches
      FOR ALL USING ((SELECT current_setting('role', true)) = 'service_role')
      WITH CHECK ((SELECT current_setting('role', true)) = 'service_role');
  END IF;
END $$;

DO $$ BEGIN
  REVOKE ALL ON TABLE public.proxy_pool, public.proxy_pool_batches FROM PUBLIC, anon, authenticated;
  GRANT ALL ON TABLE public.proxy_pool, public.proxy_pool_batches TO service_role;
  REVOKE ALL ON FUNCTION public.claim_next_proxy(text, uuid, integer, boolean) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.claim_next_proxy(text, uuid, integer, boolean) TO service_role;
  REVOKE ALL ON FUNCTION public.blacklist_instance_proxy(text, text, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.blacklist_instance_proxy(text, text, text) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
