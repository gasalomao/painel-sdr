-- FIX DE PERMISSÃO (RLS) PARA AS TABELAS DO AGENTE
-- Execute isso no SQL Editor do Supabase para liberar o salvamento

-- 1. Desativar RLS (método mais rápido para dashboards privados)
ALTER TABLE IF EXISTS public.agent_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.agent_knowledge DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.agent_stages DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.channel_connections DISABLE ROW LEVEL SECURITY;

-- 2. Caso prefira manter RLS ativo mas liberar para todos (alternativa):
/*
CREATE POLICY "Permitir tudo para todos" ON public.agent_settings FOR ALL USING (true);
CREATE POLICY "Permitir tudo para todos" ON public.agent_knowledge FOR ALL USING (true);
CREATE POLICY "Permitir tudo para todos" ON public.agent_stages FOR ALL USING (true);
CREATE POLICY "Permitir tudo para todos" ON public.channel_connections FOR ALL USING (true);
*/

-- 3. Grant total para as roles de API
GRANT ALL ON TABLE public.agent_settings TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.agent_knowledge TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.agent_stages TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.channel_connections TO anon, authenticated, service_role;
