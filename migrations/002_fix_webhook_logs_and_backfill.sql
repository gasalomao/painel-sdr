-- =====================================================================
-- Migration 002 — fix webhook_logs.client_id + backfill cross-tenant
-- =====================================================================
-- 1. webhook_logs ficou de fora da migration 001 (bug). Adiciona agora.
-- 2. Backfill TODOS os dados que foram pro cliente Default por código antigo
--    (antes do deploy fdd6c95) — pega pelo instance_name → channel_connections.client_id.
--
-- Idempotente: roda sem efeito quando todas as linhas já estão no client_id certo.
-- =====================================================================

-- 1. webhook_logs.client_id
ALTER TABLE public.webhook_logs
  ADD COLUMN IF NOT EXISTS client_id UUID
  REFERENCES public.clients(id) ON DELETE CASCADE
  DEFAULT '00000000-0000-0000-0000-000000000001';
CREATE INDEX IF NOT EXISTS idx_webhook_logs_client ON public.webhook_logs(client_id);

-- 2. Backfill chats_dashboard
UPDATE public.chats_dashboard cd
SET client_id = cc.client_id
FROM public.channel_connections cc
WHERE cd.instance_name = cc.instance_name
  AND cc.client_id IS NOT NULL
  AND cc.client_id != '00000000-0000-0000-0000-000000000001'
  AND cd.client_id = '00000000-0000-0000-0000-000000000001';

-- 3. Backfill sessions
UPDATE public.sessions s
SET client_id = cc.client_id
FROM public.channel_connections cc
WHERE s.instance_name = cc.instance_name
  AND cc.client_id IS NOT NULL
  AND cc.client_id != '00000000-0000-0000-0000-000000000001'
  AND s.client_id = '00000000-0000-0000-0000-000000000001';

-- 4. Backfill messages (via sessions.instance_name → channel_connections)
UPDATE public.messages m
SET client_id = cc.client_id
FROM public.sessions s
JOIN public.channel_connections cc ON s.instance_name = cc.instance_name
WHERE m.session_id = s.id
  AND cc.client_id IS NOT NULL
  AND cc.client_id != '00000000-0000-0000-0000-000000000001'
  AND m.client_id = '00000000-0000-0000-0000-000000000001';

-- 5. Backfill contacts (via sessions → channel_connections)
UPDATE public.contacts ct
SET client_id = cc.client_id
FROM public.sessions s
JOIN public.channel_connections cc ON s.instance_name = cc.instance_name
WHERE s.contact_id = ct.id
  AND cc.client_id IS NOT NULL
  AND cc.client_id != '00000000-0000-0000-0000-000000000001'
  AND ct.client_id = '00000000-0000-0000-0000-000000000001';

-- 6. Backfill webhook_logs (agora que a coluna existe)
UPDATE public.webhook_logs wl
SET client_id = cc.client_id
FROM public.channel_connections cc
WHERE wl.instance_name = cc.instance_name
  AND cc.client_id IS NOT NULL
  AND cc.client_id != '00000000-0000-0000-0000-000000000001'
  AND (wl.client_id = '00000000-0000-0000-0000-000000000001' OR wl.client_id IS NULL);

-- 7. Backfill leads_extraidos (via instance_name)
UPDATE public.leads_extraidos l
SET client_id = cc.client_id
FROM public.channel_connections cc
WHERE l.instance_name = cc.instance_name
  AND cc.client_id IS NOT NULL
  AND cc.client_id != '00000000-0000-0000-0000-000000000001'
  AND l.client_id = '00000000-0000-0000-0000-000000000001';

-- 8. Backfill ai_token_usage onde source_id é um agent_id que pertence a outro cliente
UPDATE public.ai_token_usage tu
SET client_id = ag.client_id
FROM public.agent_settings ag
WHERE tu.source = 'agent'
  AND tu.source_id = ag.id::TEXT
  AND ag.client_id IS NOT NULL
  AND ag.client_id != '00000000-0000-0000-0000-000000000001'
  AND tu.client_id = '00000000-0000-0000-0000-000000000001';

-- Sanity check
DO $$
DECLARE
  default_chats INT;
  default_msgs INT;
  default_logs INT;
BEGIN
  SELECT COUNT(*) INTO default_chats FROM chats_dashboard WHERE client_id = '00000000-0000-0000-0000-000000000001';
  SELECT COUNT(*) INTO default_msgs FROM messages WHERE client_id = '00000000-0000-0000-0000-000000000001';
  SELECT COUNT(*) INTO default_logs FROM webhook_logs WHERE client_id = '00000000-0000-0000-0000-000000000001';
  RAISE NOTICE '✅ Migration 002 aplicada. Restam no cliente Default: chats=%, messages=%, webhook_logs=%', default_chats, default_msgs, default_logs;
END $$;
