-- ============================================================================
-- BLINDAGEM DO BANCO ATUAL — rode AGORA no SQL Editor do Supabase de produção.
-- Camada extra de segurança além dos REVOKEs já aplicados. Idempotente.
-- Copie deste arquivo (Bloco de Notas), nunca do chat/terminal.
-- ============================================================================

-- 1) RLS SEM políticas nas 7 tabelas sensíveis: mesmo um GRANT acidental
--    futuro não reabre o acesso ao anon (RLS sem policy = deny all).
--    service_role (servidor do painel) BYPASSA RLS — nada quebra.
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_token_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_pricing_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_knowledge_chunks ENABLE ROW LEVEL SECURITY;

-- 2) Só o dono/service_role cria objetos no schema public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;

-- 3) RPCs (funções via PostgREST) fechados para anon — o app só chama
--    via service_role (verificado: match_knowledge_chunks, instances_stats).
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- 4) Tabelas criadas DEPOIS ficam negadas ao anon por padrão.
--    Se um futuro recurso precisar que o browser leia tabela nova,
--    conceder explicitamente: GRANT SELECT ON public.<tabela> TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;

-- 5) Limpa lixo antigo (tabelas órfãs de experimento, 0 linhas, nada usa):
DROP TABLE IF EXISTS public.messages_2026_08_07 CASCADE;
DROP TABLE IF EXISTS public.messages_2026_08_08 CASCADE;
DROP TABLE IF EXISTS public.messages_2026_08_09 CASCADE;
DROP TABLE IF EXISTS public.messages_2026_08_10 CASCADE;
DROP TABLE IF EXISTS public.messages_2026_08_11 CASCADE;
DROP TABLE IF EXISTS public.messages_2026_08_12 CASCADE;
DROP TABLE IF EXISTS public.messages_2026_08_13 CASCADE;

-- CONFERÊNCIA — cada linha deve mostrar rls_enabled = true e 0 grants p/ anon:
SELECT c.relname AS tabela,
       c.relrowsecurity AS rls_enabled,
       COALESCE((SELECT count(*) FROM information_schema.role_table_grants g
         WHERE g.table_schema = 'public' AND g.table_name = c.relname
           AND g.grantee IN ('anon', 'authenticated')), 0) AS grants_anon
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname IN ('clients', 'auth_sessions', 'app_settings', 'messages',
                    'ai_token_usage', 'ai_pricing_cache', 'agent_knowledge_chunks')
ORDER BY c.relname;
