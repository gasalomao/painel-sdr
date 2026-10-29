-- =====================================================================
-- Migration 023: Otimização de Performance para Leads, Kanban, Chat e CRM
-- 100% idempotente e segura (CREATE INDEX IF NOT EXISTS + backfill não-destrutivo)
-- =====================================================================

-- 1. Índices compostos B-Tree para listagem, paginação, Kanban e filtros em leads_extraidos
CREATE INDEX IF NOT EXISTS idx_leads_extraidos_client_created_id
  ON public.leads_extraidos USING btree (client_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_leads_extraidos_client_followup
  ON public.leads_extraidos USING btree (client_id, next_follow_up ASC)
  WHERE (next_follow_up IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_leads_extraidos_client_ramo
  ON public.leads_extraidos USING btree (client_id, ramo_negocio);

CREATE INDEX IF NOT EXISTS idx_leads_extraidos_client_contato_src
  ON public.leads_extraidos USING btree (client_id, primeiro_contato_source);

-- 2. Covering index (Index-Only Scan) para badges de disparo em /leads e /prospeccao-sites
CREATE INDEX IF NOT EXISTS idx_campaign_targets_client_status_jid
  ON public.campaign_targets USING btree (client_id, status, remote_jid);

-- 3. Índices compostos para listagem de conversas (/chat) e vínculo CRM (contacts -> leads_extraidos)
CREATE INDEX IF NOT EXISTS idx_sessions_client_last_msg
  ON public.sessions USING btree (client_id, last_message_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_sessions_client_contact
  ON public.sessions USING btree (client_id, contact_id);

CREATE INDEX IF NOT EXISTS idx_contacts_client_lead_id
  ON public.contacts USING btree (client_id, lead_id)
  WHERE (lead_id IS NOT NULL);

-- 4. Índices GIN Trigram (pg_trgm) para buscas rápidas com ILIKE '%termo%' em leads_extraidos
-- Protegido por bloco DO/EXCEPTION para compatibilidade com ambientes sem pg_trgm (ex: PGlite WASM)
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_leads_extraidos_nome_trgm ON public.leads_extraidos USING gin (nome_negocio gin_trgm_ops)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_leads_extraidos_telefone_trgm ON public.leads_extraidos USING gin (telefone gin_trgm_ops)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_leads_extraidos_remotejid_trgm ON public.leads_extraidos USING gin ("remoteJid" gin_trgm_ops)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_leads_extraidos_ramo_trgm ON public.leads_extraidos USING gin (ramo_negocio gin_trgm_ops)';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm indisponível neste ambiente — índices B-Tree aplicados normalmente.';
END
$$;

-- 5. Backfill seguro de contacts.lead_id quando houver correspondência exata (client_id, remote_jid)
-- Transforma a resolução de CRM (/api/contacts/crm) de varredura paginada para busca O(1) por PK
UPDATE public.contacts AS c
SET lead_id = l.id
FROM public.leads_extraidos AS l
WHERE c.lead_id IS NULL
  AND c.client_id = l.client_id
  AND c.remote_jid = l."remoteJid";

