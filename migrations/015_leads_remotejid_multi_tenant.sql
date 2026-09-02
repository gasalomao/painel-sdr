BEGIN;

UPDATE public.leads_extraidos AS lead
SET client_id = connection.client_id
FROM public.channel_connections AS connection
WHERE lead.client_id IS NULL
  AND lead.instance_name = connection.instance_name
  AND connection.client_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.leads_extraidos
    WHERE client_id IS NULL
  ) THEN
    RAISE EXCEPTION 'leads_extraidos contém client_id nulo; corrija o ownership antes da migração';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leads_extraidos
    WHERE "remoteJid" IS NOT NULL
    GROUP BY client_id, "remoteJid"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'leads_extraidos contém remoteJid duplicado no mesmo tenant; faça merge antes da migração';
  END IF;
END
$$;

ALTER TABLE public.leads_extraidos
  ALTER COLUMN client_id SET NOT NULL;

ALTER TABLE public.leads_extraidos
  DROP CONSTRAINT IF EXISTS "leads_extraidos_remoteJid_key";

DROP INDEX IF EXISTS public.idx_leads_extraidos_client_remotejid;

CREATE UNIQUE INDEX idx_leads_extraidos_client_remotejid
  ON public.leads_extraidos (client_id, "remoteJid");

COMMIT;
