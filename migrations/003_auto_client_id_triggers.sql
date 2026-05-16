-- =====================================================================
-- Migration 003 — Triggers BEFORE INSERT que auto-setam client_id
-- =====================================================================
-- Solução defensiva: mesmo se o código da VPS estiver desatualizado e
-- gravar sem `client_id` (ou com Default), o banco resolve sozinho
-- pelo `instance_name` → `channel_connections.client_id`.
--
-- Por que: deploy do Easypanel pode demorar / falhar / cache. Triggers
-- garantem multi-tenancy correto na CAMADA DE DADOS, não só no código.
--
-- Idempotente. Re-aplicar mil vezes = mesmo resultado.
-- =====================================================================

-- ============= 1. FUNÇÃO COMPARTILHADA: lookup pelo instance_name =============
CREATE OR REPLACE FUNCTION public.auto_set_client_id_from_instance()
RETURNS TRIGGER AS $$
DECLARE
  resolved UUID;
BEGIN
  -- Só age quando client_id vem NULL ou explicitamente Default — preserva
  -- gravações que JÁ especificaram um client_id real.
  IF NEW.client_id IS NULL OR NEW.client_id = '00000000-0000-0000-0000-000000000001' THEN
    IF NEW.instance_name IS NOT NULL THEN
      SELECT cc.client_id INTO resolved
      FROM public.channel_connections cc
      WHERE cc.instance_name = NEW.instance_name
      LIMIT 1;
      IF resolved IS NOT NULL THEN
        NEW.client_id := resolved;
      ELSIF NEW.client_id IS NULL THEN
        NEW.client_id := '00000000-0000-0000-0000-000000000001';
      END IF;
    ELSIF NEW.client_id IS NULL THEN
      NEW.client_id := '00000000-0000-0000-0000-000000000001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============= 2. FUNÇÃO PRA messages: via session_id → sessions.instance_name =============
CREATE OR REPLACE FUNCTION public.auto_set_client_id_for_messages()
RETURNS TRIGGER AS $$
DECLARE
  resolved UUID;
BEGIN
  IF NEW.client_id IS NULL OR NEW.client_id = '00000000-0000-0000-0000-000000000001' THEN
    IF NEW.session_id IS NOT NULL THEN
      SELECT cc.client_id INTO resolved
      FROM public.sessions s
      JOIN public.channel_connections cc ON s.instance_name = cc.instance_name
      WHERE s.id = NEW.session_id
      LIMIT 1;
      IF resolved IS NOT NULL THEN
        NEW.client_id := resolved;
      ELSIF NEW.client_id IS NULL THEN
        NEW.client_id := '00000000-0000-0000-0000-000000000001';
      END IF;
    ELSIF NEW.client_id IS NULL THEN
      NEW.client_id := '00000000-0000-0000-0000-000000000001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============= 3. FUNÇÃO PRA contacts (via outras sessions DESSE contato) =============
-- Lógica: se o contato vai ser criado e há alguma session/chats_dashboard
-- preexistente com esse remote_jid + instance vinculada → pega o client_id daí.
-- Se for primeira aparição do contato sem contexto, vai pro Default mesmo.
CREATE OR REPLACE FUNCTION public.auto_set_client_id_for_contacts()
RETURNS TRIGGER AS $$
DECLARE
  resolved UUID;
BEGIN
  IF NEW.client_id IS NULL OR NEW.client_id = '00000000-0000-0000-0000-000000000001' THEN
    -- Tenta pegar via chats_dashboard recente do mesmo jid
    SELECT cd.client_id INTO resolved
    FROM public.chats_dashboard cd
    WHERE cd.remote_jid = NEW.remote_jid
      AND cd.client_id IS NOT NULL
      AND cd.client_id != '00000000-0000-0000-0000-000000000001'
    ORDER BY cd.created_at DESC
    LIMIT 1;
    IF resolved IS NOT NULL THEN
      NEW.client_id := resolved;
    ELSIF NEW.client_id IS NULL THEN
      NEW.client_id := '00000000-0000-0000-0000-000000000001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============= 4. APLICA TRIGGERS =============
-- DROP+CREATE pra ser idempotente em re-execução.

DROP TRIGGER IF EXISTS trg_chats_dashboard_client_id ON public.chats_dashboard;
CREATE TRIGGER trg_chats_dashboard_client_id
  BEFORE INSERT ON public.chats_dashboard
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_client_id_from_instance();

DROP TRIGGER IF EXISTS trg_sessions_client_id ON public.sessions;
CREATE TRIGGER trg_sessions_client_id
  BEFORE INSERT ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_client_id_from_instance();

DROP TRIGGER IF EXISTS trg_webhook_logs_client_id ON public.webhook_logs;
CREATE TRIGGER trg_webhook_logs_client_id
  BEFORE INSERT ON public.webhook_logs
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_client_id_from_instance();

DROP TRIGGER IF EXISTS trg_leads_extraidos_client_id ON public.leads_extraidos;
CREATE TRIGGER trg_leads_extraidos_client_id
  BEFORE INSERT ON public.leads_extraidos
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_client_id_from_instance();

DROP TRIGGER IF EXISTS trg_chat_buffers_client_id ON public.chat_buffers;
CREATE TRIGGER trg_chat_buffers_client_id
  BEFORE INSERT ON public.chat_buffers
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_client_id_from_instance();

-- Messages: via session_id (não tem instance_name)
DROP TRIGGER IF EXISTS trg_messages_client_id ON public.messages;
CREATE TRIGGER trg_messages_client_id
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_client_id_for_messages();

-- Contacts: via chats_dashboard prévio do mesmo remote_jid
DROP TRIGGER IF EXISTS trg_contacts_client_id ON public.contacts;
CREATE TRIGGER trg_contacts_client_id
  BEFORE INSERT ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_client_id_for_contacts();

-- ============= 5. BACKFILL AGRESSIVO DE NOVAS LINHAS QUE CAÍRAM EM DEFAULT =============
-- Re-aplica a lógica da Migration 002 pra capturar tudo que entrou depois.

UPDATE public.chats_dashboard cd
SET client_id = cc.client_id
FROM public.channel_connections cc
WHERE cd.instance_name = cc.instance_name
  AND cc.client_id IS NOT NULL
  AND cc.client_id != '00000000-0000-0000-0000-000000000001'
  AND cd.client_id = '00000000-0000-0000-0000-000000000001';

UPDATE public.sessions s
SET client_id = cc.client_id
FROM public.channel_connections cc
WHERE s.instance_name = cc.instance_name
  AND cc.client_id IS NOT NULL
  AND cc.client_id != '00000000-0000-0000-0000-000000000001'
  AND s.client_id = '00000000-0000-0000-0000-000000000001';

UPDATE public.messages m
SET client_id = cc.client_id
FROM public.sessions s
JOIN public.channel_connections cc ON s.instance_name = cc.instance_name
WHERE m.session_id = s.id
  AND cc.client_id IS NOT NULL
  AND cc.client_id != '00000000-0000-0000-0000-000000000001'
  AND m.client_id = '00000000-0000-0000-0000-000000000001';

UPDATE public.contacts ct
SET client_id = cc.client_id
FROM public.sessions s
JOIN public.channel_connections cc ON s.instance_name = cc.instance_name
WHERE s.contact_id = ct.id
  AND cc.client_id IS NOT NULL
  AND cc.client_id != '00000000-0000-0000-0000-000000000001'
  AND ct.client_id = '00000000-0000-0000-0000-000000000001';

UPDATE public.webhook_logs wl
SET client_id = cc.client_id
FROM public.channel_connections cc
WHERE wl.instance_name = cc.instance_name
  AND cc.client_id IS NOT NULL
  AND cc.client_id != '00000000-0000-0000-0000-000000000001'
  AND (wl.client_id = '00000000-0000-0000-0000-000000000001' OR wl.client_id IS NULL);

UPDATE public.leads_extraidos l
SET client_id = cc.client_id
FROM public.channel_connections cc
WHERE l.instance_name = cc.instance_name
  AND cc.client_id IS NOT NULL
  AND cc.client_id != '00000000-0000-0000-0000-000000000001'
  AND l.client_id = '00000000-0000-0000-0000-000000000001';

-- ============= 6. SANITY CHECK =============
DO $$
DECLARE
  triggers_count INT;
  remaining_default_chats INT;
  remaining_default_leads INT;
BEGIN
  SELECT COUNT(*) INTO triggers_count
  FROM pg_trigger
  WHERE tgname LIKE 'trg_%_client_id' AND NOT tgisinternal;

  SELECT COUNT(*) INTO remaining_default_chats
  FROM chats_dashboard WHERE client_id = '00000000-0000-0000-0000-000000000001';
  SELECT COUNT(*) INTO remaining_default_leads
  FROM leads_extraidos WHERE client_id = '00000000-0000-0000-0000-000000000001';

  RAISE NOTICE '✅ Migration 003: % triggers BEFORE INSERT criados.', triggers_count;
  RAISE NOTICE '   Restam em Default: chats=%, leads=% (esperado: só os realmente órfãos)', remaining_default_chats, remaining_default_leads;
END $$;
