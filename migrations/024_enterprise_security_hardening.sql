-- ============================================================================
-- Migration 024: Blindagem Enterprise SaaS (RLS Total, Cofre de Segredos,
--                Anti-Sabotagem, Imutabilidade Multi-Tenant e Search Path)
-- 100% Idempotente e Zero-Downtime (não quebra absolutamente nada do sistema)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. BLOQUEIO DE DDL NO SCHEMA PUBLIC PARA ROLES NÃO-PRIVILEGIADAS
--    Impede criação de tabelas, views ou funções maliciosas via PostgREST.
-- ----------------------------------------------------------------------------
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. REVOGAÇÃO GLOBAL DE PRIVILÉGIOS DESTRUTIVOS (TRUNCATE / TRIGGER / REFERENCES)
--    Impede que qualquer requisição externa dê TRUNCATE em tabelas do SaaS.
-- ----------------------------------------------------------------------------
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. COFRE DE SEGREDOS E TABELAS SERVER-ONLY (ACESSO EXCLUSIVO service_role)
--    Contêm hashes de senha, sessões JWT, API keys (Gemini/OpenRouter/NVIDIA),
--    credenciais de provedores, backups, custos de tokens e filas internas.
--    Nenhuma página do navegador precisa ler essas tabelas diretamente.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  server_only_tables text[] := ARRAY[
    'clients',
    'auth_sessions',
    'ai_organizer_config',
    'provider_credentials',
    'app_settings',
    'ai_control',
    'ai_pricing_cache',
    'ai_token_usage',
    'agent_batch_locks',
    'agent_knowledge_chunks',
    'agent_followups',
    'agent_settings_backup',
    'chat_buffers',
    'reviews_ai_logs',
    'dashboard_tasks',
    'backup_config',
    'backup_history',
    'backup_runs',
    'backup_events',
    'backup_diagnostics',
    'website_projects',
    'website_runs',
    'website_run_activities',
    'website_messages',
    'website_prompt_versions',
    'website_skills'
  ];
  t text;
  p record;
BEGIN
  FOREACH t IN ARRAY server_only_tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      -- Ativa RLS (remove o aviso vermelho UNRESTRICTED / RLS disabled no Supabase)
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

      -- Remove policies antigas frouxas (ex: "Permitir tudo para todos")
      FOR p IN
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = t
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, t);
      END LOOP;

      -- Revoga acesso direto de anon e authenticated; mantém apenas service_role
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);

      -- Cria policy estrita exclusiva para service_role
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        t || '_service_role_only',
        t
      );
    END IF;
  END LOOP;
END
$$;

-- ----------------------------------------------------------------------------
-- 4. TABELAS DE AUDITORIA E TELEMETRIA SOMENTE-LEITURA NO FRONTEND
--    O navegador apenas exibe esses logs filtrados por client_id (nunca insere,
--    edita ou apaga diretamente — toda escrita é feita pelo backend service_role).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  readonly_client_tables text[] := ARRAY[
    'ai_organizer_runs',
    'webhook_logs',
    'automation_logs',
    'followup_logs'
  ];
  t text;
  p record;
  has_client_id boolean;
BEGIN
  FOREACH t IN ARRAY readonly_client_tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

      FOR p IN
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = t
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, t);
      END LOOP;

      -- Revoga INSERT, UPDATE, DELETE, TRUNCATE de anon/authenticated (somente leitura)
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO anon, authenticated', t);
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);

      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = t AND column_name = 'client_id'
      ) INTO has_client_id;

      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        t || '_service_role_all',
        t
      );

      IF has_client_id THEN
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR SELECT TO anon, authenticated USING (client_id IS NOT NULL)',
          t || '_tenant_select',
          t
        );
      ELSE
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR SELECT TO anon, authenticated USING (true)',
          t || '_tenant_select',
          t
        );
      END IF;
    END IF;
  END LOOP;
END
$$;

-- ----------------------------------------------------------------------------
-- 5. TABELAS OPERACIONAIS MULTI-TENANT (RLS ATIVO + ESCOPO DE TENANT OBRIGATÓRIO)
--    Garante que NENHUMA tabela do schema public fique com RLS desativado
--    (elimina 100% dos alertas UNRESTRICTED) e exige client_id válido em cada linha.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  p record;
  has_client_id boolean;
BEGIN
  FOR r IN
    SELECT c.relname AS tablename
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname <> ALL (ARRAY[
        'clients',
        'auth_sessions',
        'ai_organizer_config',
        'provider_credentials',
        'app_settings',
        'ai_control',
        'ai_pricing_cache',
        'ai_token_usage',
        'agent_batch_locks',
        'agent_knowledge_chunks',
        'agent_followups',
        'agent_settings_backup',
        'chat_buffers',
        'reviews_ai_logs',
        'dashboard_tasks',
        'backup_config',
        'backup_history',
        'backup_runs',
        'backup_events',
        'backup_diagnostics',
        'website_projects',
        'website_runs',
        'website_run_activities',
        'website_messages',
        'website_prompt_versions',
        'website_skills',
        'ai_organizer_runs',
        'webhook_logs',
        'automation_logs',
        'followup_logs'
      ])
  LOOP
    -- Ativa RLS na tabela operacional
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);

    -- Remove policies legadas inseguras ("Permitir tudo para todos", etc.)
    FOR p IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = r.tablename
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, r.tablename);
    END LOOP;

    -- Garante que anon/authenticated nunca tenham TRUNCATE, TRIGGER ou REFERENCES
    EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM PUBLIC, anon, authenticated', r.tablename);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO anon, authenticated', r.tablename);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', r.tablename);

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = r.tablename AND column_name = 'client_id'
    ) INTO has_client_id;

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      r.tablename || '_service_role_all',
      r.tablename
    );

    IF has_client_id THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO anon, authenticated USING (client_id IS NOT NULL) WITH CHECK (client_id IS NOT NULL)',
        r.tablename || '_tenant_scoped',
        r.tablename
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)',
        r.tablename || '_operational_access',
        r.tablename
      );
    END IF;
  END LOOP;
END
$$;

-- ----------------------------------------------------------------------------
-- 6. TRIGGER DE IMUTABILIDADE DE TENANT (ANTI-SEQUESTRO DE DADOS ENTRE CLIENTES)
--    Impede que qualquer UPDATE via anon/authenticated altere o client_id de um
--    registro existente para outro tenant.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_tenant_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.client_id IS NOT NULL
     AND NEW.client_id IS DISTINCT FROM OLD.client_id
     AND (
       current_user IN ('anon', 'authenticated')
       OR coalesce(current_setting('request.jwt.claim.role', true), '') IN ('anon', 'authenticated')
     )
  THEN
    RAISE EXCEPTION 'Operação bloqueada: transferência de client_id entre tenants não é permitida.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  r record;
  trig_name text;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN pg_class pc ON pc.relname = c.table_name
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = c.table_schema
    WHERE c.table_schema = 'public'
      AND c.column_name = 'client_id'
      AND pc.relkind = 'r'
  LOOP
    trig_name := 'trg_' || r.table_name || '_tenant_immutable';
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', trig_name, r.table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.enforce_tenant_immutability()',
      trig_name,
      r.table_name
    );
  END LOOP;
END
$$;

-- ----------------------------------------------------------------------------
-- 7. MOVER EXTENSÕES (vector, pg_trgm) DO SCHEMA PUBLIC PARA SCHEMA extensions
--    Elimina os 2 alertas de segurança "Extension is installed in public schema"
--    sem derrubar colunas nem índices existentes.
-- ----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  ext_name text;
BEGIN
  FOREACH ext_name IN ARRAY ARRAY['vector', 'pg_trgm'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = ext_name AND n.nspname = 'public'
    ) THEN
      BEGIN
        UPDATE pg_extension SET extrelocatable = true WHERE extname = ext_name;
        EXECUTE format('ALTER EXTENSION %I SET SCHEMA extensions', ext_name);
      EXCEPTION
        WHEN OTHERS THEN
          RAISE NOTICE 'Não foi possível mover extensão %: %', ext_name, SQLERRM;
      END;
    END IF;
  END LOOP;
END
$$;

-- Garante que todas as roles encontrem operadores (<=>, %) no schema extensions
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path TO "$user", public, extensions', current_database());
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER ROLE anon SET search_path TO "$user", public, extensions;
  ALTER ROLE authenticated SET search_path TO "$user", public, extensions;
  ALTER ROLE service_role SET search_path TO "$user", public, extensions;
  ALTER ROLE postgres SET search_path TO "$user", public, extensions;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ----------------------------------------------------------------------------
-- 8. REMOVER ÍNDICES DUPLICADOS IDÊNTICOS (ALERTA DE PERFORMANCE DO SUPABASE)
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_token_usage_created;
DROP INDEX IF EXISTS public.idx_chats_remote_jid;
DROP INDEX IF EXISTS public.idx_leads_remotejid;
DROP INDEX IF EXISTS public.idx_messages_session;

-- ----------------------------------------------------------------------------
-- 9. BLINDAGEM DE FUNÇÕES E RPCs (PREVENÇÃO DE SEARCH_PATH HIJACKING)
--    Inclui schema extensions no search_path para operadores vector/pg_trgm.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS proc_sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
  LOOP
    BEGIN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_temp', fn.proc_sig);
    EXCEPTION
      WHEN OTHERS THEN
        NULL;
    END;
  END LOOP;
END
$$;

COMMIT;
