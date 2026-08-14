-- ============================================================================
-- SECURITY HARDENING — painel-sdr (Supabase self-hosted)
-- ============================================================================
-- PROBLEMA: com RLS desligado, a anon key (pública, embutida no JS do site)
-- lê e escreve TODAS as tabelas — incluindo clients (hashes de senha),
-- auth_sessions e app_settings (chaves da Evolution API).
--
-- Este script revoga o acesso anônito às tabelas que o browser NUNCA usa.
-- O servidor (service_role key) NÃO é afetado. Idempotente.
--
-- ONDE RODAR: Supabase Studio → SQL Editor (no seu Supabase do Easypanel:
-- sistema-supabase.ridnii.easypanel.host) e colar/executar isto.
-- ============================================================================

REVOKE ALL ON TABLE public.clients FROM anon, authenticated;
REVOKE ALL ON TABLE public.auth_sessions FROM anon, authenticated;
REVOKE ALL ON TABLE public.app_settings FROM anon, authenticated;
REVOKE ALL ON TABLE public.messages FROM anon, authenticated;
REVOKE ALL ON TABLE public.ai_token_usage FROM anon, authenticated;
REVOKE ALL ON TABLE public.ai_pricing_cache FROM anon, authenticated;
REVOKE ALL ON TABLE public.agent_knowledge_chunks FROM anon, authenticated;

-- Verificação (deve listar zero permissões para anon nas tabelas acima):
-- SELECT grantee, table_name, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_schema='public' AND grantee='anon'
--   AND table_name IN ('clients','auth_sessions','app_settings','messages');

-- ============================================================================
-- FASE 2 (recomendado, exige refactor do frontend — NÃO rodar antes):
-- As tabelas operacionais (chats_dashboard, sessions, contacts, etc) ainda
-- são legíveis por anon (cross-tenant). Para fechá-las 100% é preciso mover
-- as queries do browser para rotas /api (ou adotar Supabase Auth) e então:
--   ALTER TABLE public.<tabela> ENABLE ROW LEVEL SECURITY;
-- ============================================================================

-- ============================================================================
-- ROTAÇÃO DE CHAVES (fazer APÓS rodar o REVOKE acima):
-- evolution_api_key e evolution_go_key ficaram expostas em app_settings
-- enquanto a tabela era pública. Gerar novas chaves no painel da Evolution
-- e atualizar em Configurações (a UI grava em app_settings via servidor).
-- ============================================================================
