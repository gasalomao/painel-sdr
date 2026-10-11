-- ========================================
-- MIGRATION: Sistema de Backup Automático
-- Execute este SQL no Supabase SQL Editor
-- ========================================

-- Tabela de configuração de backup
CREATE TABLE IF NOT EXISTS backup_config (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL UNIQUE,

    -- Google Drive Auth
    google_access_token TEXT,
    google_refresh_token TEXT,
    google_token_expiry TIMESTAMPTZ,
    google_drive_folder_id TEXT,

    -- Configurações de backup
    enabled BOOLEAN DEFAULT false,
    interval_hours INTEGER DEFAULT 24, -- backup a cada X horas
    retention_days INTEGER DEFAULT 7, -- manter backups por X dias

    -- Último backup
    last_backup_at TIMESTAMPTZ,
    last_backup_size_bytes BIGINT,
    last_backup_status TEXT, -- 'success', 'failed', 'running'
    last_backup_error TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Histórico de backups
CREATE TABLE IF NOT EXISTS backup_history (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL,

    -- Informações do arquivo
    drive_file_id TEXT NOT NULL,
    drive_file_name TEXT NOT NULL,
    file_size_bytes BIGINT,

    -- Metadados
    backup_type TEXT DEFAULT 'automatic', -- 'automatic', 'manual'
    status TEXT DEFAULT 'success', -- 'success', 'failed'
    error_message TEXT,

    -- Timestamps
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_backup_config_client_id ON backup_config(client_id);
CREATE INDEX IF NOT EXISTS idx_backup_history_client_id ON backup_history(client_id);
CREATE INDEX IF NOT EXISTS idx_backup_history_created_at ON backup_history(created_at);

-- RLS
ALTER TABLE backup_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_history ENABLE ROW LEVEL SECURITY;

-- Somente servidor. Não expor tokens OAuth ao cliente/anon.
DROP POLICY IF EXISTS backup_config_all ON backup_config;
CREATE POLICY backup_config_all ON backup_config FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON backup_config FROM anon, authenticated;

DROP POLICY IF EXISTS backup_history_all ON backup_history;
CREATE POLICY backup_history_all ON backup_history FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON backup_history FROM anon, authenticated;
-- Para o worker/logs atualizados, aplicar também migrations/020_backup_security_runs.sql após revisão.

-- Mensagem de sucesso
DO $$
BEGIN
    RAISE NOTICE '✅ Migration 019_backup_config executada com sucesso!';
    RAISE NOTICE '📋 Tabelas criadas: backup_config, backup_history';
    RAISE NOTICE 'RLS configurado para acesso exclusivo do servidor';
END $$;
