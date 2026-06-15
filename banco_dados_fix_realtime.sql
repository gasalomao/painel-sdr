-- COPIE E COLE ESTE BLOCO NO SQL EDITOR DO SEU SUPABASE:

-- 1. Cria a tabela com as colunas corretas se não existir
CREATE TABLE IF NOT EXISTS public.webhook_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_name TEXT,
    event TEXT,
    payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- 2. Habilita o REALTIME para a tabela de logs (ESSENCIAL PARA O TERMINAL FUNCIONAR)
-- Nota: Se já estiver ativado, este comando pode dar aviso, mas é seguro rodar.
BEGIN;
  DROP PUBLICATION IF EXISTS supabase_realtime;
  CREATE PUBLICATION supabase_realtime FOR TABLE webhook_logs, agent_settings, agent_stages, agent_knowledge, channel_connections;
COMMIT;

-- 3. Libera permissões totais para o terminal ler os dados sem erro de RLS
ALTER TABLE public.webhook_logs DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.webhook_logs TO anon, authenticated, service_role;
