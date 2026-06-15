-- ==============================================================================================
-- 🚀 SCRIPT DE CORREÇÃO: LEADS NÃO APARECENDO NO CRM E ERRO DE RLS
-- Copie todo o conteúdo abaixo e execute no SQL Editor do seu Supabase.
-- ==============================================================================================

-- 1. Desabilita RLS na tabela de leads e garante acesso total para o frontend
ALTER TABLE public.leads_extraidos DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.leads_extraidos TO anon, authenticated, service_role;

-- 2. Desabilita RLS na tabela de automações para evitar bloqueios ao tentar iniciar automações
ALTER TABLE public.automations DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.automations TO anon, authenticated, service_role;

-- 3. Desabilita RLS nos logs de automação para garantir que os logs apareçam no frontend
ALTER TABLE public.automation_logs DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.automation_logs TO anon, authenticated, service_role;

-- (Opcional) Re-aplica grants no schema public para garantir
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Finalizado! Atualize a página do Painel SDR e os leads vão aparecer.
