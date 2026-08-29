-- ============================================================================
-- HARDEN_RLS.sql — Endurecimento de permissões do Supabase (painel-sdr)
-- Gerado pela auditoria de 2026-08-28. Leia ANTES de aplicar.
--
-- CONTEXTO (por que o banco está aberto):
--   O painel NÃO usa Supabase Auth — sessão é JWT próprio em cookie. 18
--   componentes client (ver lista em AUDIT_HANDOVER.md §9.2) consultam o
--   banco direto com a chave anon (NEXT_PUBLIC_...). Para "funcionar",
--   migrações antigas (fix_permissao_supa.sql, FIX_RLS.sql) desativaram RLS
--   e deram GRANT ALL para anon em várias tabelas. Resultado: qualquer
--   pessoa com a anon key (embutida no bundle do browser) lê/escreve
--   essas tabelas SEM autenticação, incluindo segredos.
--
-- ARQUITETURA ALVO: nenhuma query de tenant no browser — tudo via rotas
-- server (service_role + client_id derivado da sessão). Enquanto os 18
--   componentes não forem migrados, RLS por tenant é IMPOSSÍVEL (anon é uma
--   role única compartilhada por todos os tenants).
--
-- FASES:
--   FASE 0 — Auditoria do estado atual (só SELECTs, inofensivo).
--   FASE 1 — Revoga anon das tabelas SERVER-ONLY sensíveis (browser nunca
--            toca; zero impacto no app). APLICÁVEL JÁ.
--   FASE 2 — Bloqueada até migrar os componentes client (ver checklist).
--            Após migrar: revogar anon de tudo, ativar RLS, policies por
--            client_id, service_role passa a única via de acesso.
-- ============================================================================

-- ============================================================================
-- FASE 0 — AUDITORIA (rodar e salvar o output antes de qualquer mudança)
-- ============================================================================
-- Permissões atuais por tabela:
--   SELECT grantee, table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')
--   ORDER BY table_name, grantee, privilege_type;
--
-- Estado de RLS por tabela:
--   SELECT relname AS tabela, relrowsecurity AS rls_ativo, relforcerowsecurity AS forca_rls
--   FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
--   ORDER BY relname;
--
-- Policies existentes:
--   SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
--   FROM pg_policies WHERE schemaname = 'public';
-- ============================================================================


-- ============================================================================
-- FASE 1 — REVOGA ANON DAS TABELAS SERVER-ONLY SENSÍVEIS (aplicar já)
-- ============================================================================
-- Confirmed por grep: nenhum componente client consulta estas tabelas.
-- Elas contêm SEGREDOS (API keys, credenciais, tokens de sessão) ou são
-- infra interna (filas/locks/cache/telemetria). Continuam acessíveis ao
-- service_role (rotas server) — zero impacto no painel.

-- Segredos e credenciais (CRÍTICO):
REVOKE ALL ON TABLE public.ai_organizer_config   FROM anon, authenticated;
REVOKE ALL ON TABLE public.provider_credentials  FROM anon, authenticated;
REVOKE ALL ON TABLE public.auth_sessions         FROM anon, authenticated;

-- Telemetria/infra de IA (server-only):
REVOKE ALL ON TABLE public.ai_control            FROM anon, authenticated;
REVOKE ALL ON TABLE public.ai_organizer_runs     FROM anon, authenticated;
REVOKE ALL ON TABLE public.ai_pricing_cache      FROM anon, authenticated;
REVOKE ALL ON TABLE public.ai_token_usage        FROM anon, authenticated;

-- Infra interna (locks de batch, chunks vetoriais do RAG, logs de webhook):
REVOKE ALL ON TABLE public.agent_batch_locks     FROM anon, authenticated;
REVOKE ALL ON TABLE public.agent_knowledge_chunks FROM anon, authenticated;
REVOKE ALL ON TABLE public.webhook_logs          FROM anon, authenticated;

-- Conferência pós-aplicação (deve listar ZERO linhas destas tabelas p/ anon):
--   SELECT table_name FROM information_schema.role_table_grants
--   WHERE table_schema='public' AND grantee='anon'
--     AND table_name IN ('ai_organizer_config','provider_credentials',
--       'auth_sessions','ai_control','ai_organizer_runs','ai_pricing_cache',
--       'ai_token_usage','agent_batch_locks','agent_knowledge_chunks',
--       'webhook_logs');


-- ============================================================================
-- FASE 2 — BLOQUEADA (não aplicar ainda!) — exige refactor client primeiro
-- ============================================================================
-- CHECKLIST PRÉ-REQUISITO (migrar para rotas server com sessão):
--   [ ] agent-switcher.tsx        — insert/delete agent_settings
--   [ ] agente/page.tsx           — upsert/update/delete agent_settings/agent_stages
--   [ ] chat/page.tsx             — update instance_name (sessions?)
--   [ ] disparo/page.tsx          — delete campaign_logs
--   [ ] historico-ia/page.tsx     — delete historico_ia_leads
--   [ ] leads/KanbanBoard+page    — update/delete leads_extraidos
--   [ ] prospeccao-sites/page.tsx — delete campaign_logs
--   [ ] whatsapp/page.tsx         — insert/update channel_connections
--   [ ] inbox/contact-sidebar     — writes em contacts/leads
--   [ ] inbox/message-thread      — writes em chats/sessions
--   [ ] (e os reads de todas as 18 páginas → /api/* dedicadas)
--
-- APÓS concluir o checklist, aplicar (modelo):
--   DO $$ DECLARE t text; BEGIN
--     FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
--       EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
--       EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
--     END LOOP;
--   END $$;
--   -- service_role já bypassa RLS por padrão (pg_roles.rolbypassrls).
--   -- Opcional: policies defensoras p/ SELECTs públicos mínimos, ex:
--   -- CREATE POLICY p_read_app_settings ON public.app_settings
--   --   FOR SELECT TO anon USING (true);
-- ============================================================================

-- ROLLBACK da FASE 1 (se algo quebrar — não deveria):
-- GRANT ALL ON TABLE public.ai_organizer_config  TO anon, authenticated;
-- GRANT ALL ON TABLE public.provider_credentials TO anon, authenticated;
-- GRANT ALL ON TABLE public.auth_sessions        TO anon, authenticated;
-- GRANT ALL ON TABLE public.ai_control           TO anon, authenticated;
-- GRANT ALL ON TABLE public.ai_organizer_runs    TO anon, authenticated;
-- GRANT ALL ON TABLE public.ai_pricing_cache     TO anon, authenticated;
-- GRANT ALL ON TABLE public.ai_token_usage       TO anon, authenticated;
-- GRANT ALL ON TABLE public.agent_batch_locks    TO anon, authenticated;
-- GRANT ALL ON TABLE public.agent_knowledge_chunks TO anon, authenticated;
-- GRANT ALL ON TABLE public.webhook_logs         TO anon, authenticated;
