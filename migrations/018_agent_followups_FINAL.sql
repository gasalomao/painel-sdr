-- MIGRATION: Follow-ups Automáticos Multi-Agente Multi-Tenant
-- Incremental: nunca descartar follow-ups existentes.
BEGIN;
CREATE TABLE IF NOT EXISTS public.agent_followups (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL,
    agent_id INTEGER NOT NULL,
    session_id BIGINT,
    remote_jid TEXT NOT NULL,
    contact_id BIGINT,
    lead_id BIGINT,
    current_step INTEGER NOT NULL DEFAULT 1,
    max_step INTEGER NOT NULL DEFAULT 4,
    next_send_at TIMESTAMPTZ NOT NULL,
    last_sent_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT agent_followups_status_check CHECK (status IN ('pending', 'sent', 'cancelled', 'completed', 'failed')),
    CONSTRAINT agent_followups_step_check CHECK (current_step >= 1 AND current_step <= max_step)
);
CREATE INDEX IF NOT EXISTS idx_agent_followups_client_id ON public.agent_followups(client_id);
CREATE INDEX IF NOT EXISTS idx_agent_followups_agent_id ON public.agent_followups(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_followups_status ON public.agent_followups(status);
CREATE INDEX IF NOT EXISTS idx_agent_followups_next_send_at ON public.agent_followups(next_send_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_agent_followups_worker_query ON public.agent_followups(status, next_send_at, agent_id, client_id) WHERE status = 'pending';
CREATE OR REPLACE FUNCTION public.update_agent_followups_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agent_followups_updated_at ON public.agent_followups;
CREATE TRIGGER agent_followups_updated_at BEFORE UPDATE ON public.agent_followups
    FOR EACH ROW EXECUTE FUNCTION public.update_agent_followups_updated_at();
-- Acesso somente pelo servidor; APIs validam tenant da sessão.
ALTER TABLE public.agent_followups ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE p record;
BEGIN
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_followups' LOOP
        EXECUTE format('DROP POLICY %I ON public.agent_followups', p.policyname);
    END LOOP;
END $$;
REVOKE ALL ON public.agent_followups FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.agent_followups_id_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.agent_followups TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.agent_followups_id_seq TO service_role;
CREATE POLICY agent_followups_server_only ON public.agent_followups FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMIT;
SELECT 'Tabela agent_followups criada com sucesso!' as resultado;
