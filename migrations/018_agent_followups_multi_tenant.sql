-- ============================================================
-- MIGRATION: Follow-ups Automáticos Multi-Agente Multi-Tenant
-- ============================================================
--
-- Cria infraestrutura completa para follow-ups automáticos:
-- 1. Tabela de follow-ups agendados (SEM foreign keys problemáticas)
-- 2. Índices de performance
-- 3. Trigger de atualização de timestamps
-- 4. RLS (Row Level Security) para multi-tenant
--
-- ============================================================

-- 1. Criar tabela de follow-ups agendados
CREATE TABLE IF NOT EXISTS agent_followups (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL,
    agent_id INTEGER NOT NULL,
    session_id BIGINT,
    remote_jid TEXT NOT NULL,
    contact_id BIGINT,
    lead_id BIGINT,

    -- Controle de sequência
    current_step INTEGER NOT NULL DEFAULT 1,
    max_step INTEGER NOT NULL DEFAULT 4,

    -- Agendamento
    next_send_at TIMESTAMPTZ NOT NULL,
    last_sent_at TIMESTAMPTZ,

    -- Status
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Constraints
    CONSTRAINT agent_followups_status_check CHECK (status IN ('pending', 'sent', 'cancelled', 'completed', 'failed')),
    CONSTRAINT agent_followups_step_check CHECK (current_step >= 1 AND current_step <= max_step)
);

-- 2. Índices de performance
CREATE INDEX IF NOT EXISTS idx_agent_followups_client_id ON agent_followups(client_id);
CREATE INDEX IF NOT EXISTS idx_agent_followups_agent_id ON agent_followups(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_followups_session_id ON agent_followups(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_followups_remote_jid ON agent_followups(remote_jid);
CREATE INDEX IF NOT EXISTS idx_agent_followups_status ON agent_followups(status);
CREATE INDEX IF NOT EXISTS idx_agent_followups_next_send_at ON agent_followups(next_send_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_agent_followups_created_at ON agent_followups(created_at DESC);

-- Índice composto para query principal do worker
CREATE INDEX IF NOT EXISTS idx_agent_followups_worker_query
ON agent_followups(status, next_send_at, agent_id, client_id)
WHERE status = 'pending';

-- 3. Trigger de updated_at
CREATE OR REPLACE FUNCTION update_agent_followups_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_followups_updated_at ON agent_followups;
CREATE TRIGGER agent_followups_updated_at
    BEFORE UPDATE ON agent_followups
    FOR EACH ROW
    EXECUTE FUNCTION update_agent_followups_updated_at();

-- 4. Acesso somente pelo servidor; APIs validam tenant da sessão.
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
CREATE POLICY agent_followups_server_only ON public.agent_followups
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5. Comentários de documentação
COMMENT ON TABLE agent_followups IS 'Fila de follow-ups automáticos multi-agente multi-tenant';
COMMENT ON COLUMN agent_followups.client_id IS 'ID do cliente (tenant isolation)';
COMMENT ON COLUMN agent_followups.agent_id IS 'Agente de IA responsável';
COMMENT ON COLUMN agent_followups.session_id IS 'Sessão de conversa original';
COMMENT ON COLUMN agent_followups.remote_jid IS 'WhatsApp JID do contato';
COMMENT ON COLUMN agent_followups.current_step IS 'Etapa atual (1=1h, 2=4h, 3=24h, 4=48h)';
COMMENT ON COLUMN agent_followups.next_send_at IS 'Quando enviar próxima mensagem';
COMMENT ON COLUMN agent_followups.status IS 'Status: pending, sent, cancelled, completed, failed';

-- ============================================================
-- VERIFICAÇÃO
-- ============================================================

-- Mostrar estatísticas
SELECT
    'agent_followups' as tabela,
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE status = 'pending') as pendentes,
    COUNT(*) FILTER (WHERE status = 'sent') as enviados,
    COUNT(*) FILTER (WHERE status = 'cancelled') as cancelados,
    COUNT(*) FILTER (WHERE status = 'completed') as completados,
    COUNT(*) FILTER (WHERE status = 'failed') as falhas
FROM agent_followups;

-- ============================================================
-- FIM DA MIGRATION
-- ============================================================
