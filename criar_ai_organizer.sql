-- Configuração do Organizador IA de Leads
CREATE TABLE IF NOT EXISTS ai_organizer_config (
  id INT PRIMARY KEY DEFAULT 1,
  enabled BOOLEAN DEFAULT FALSE,
  api_key TEXT,
  model TEXT,
  provider TEXT DEFAULT 'Gemini',
  execution_hour INT DEFAULT 20,
  last_run TIMESTAMPTZ,
  app_url TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO ai_organizer_config (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Resumo e motivo da IA no lead (motivo já usa justificativa_ia existente)
ALTER TABLE leads_extraidos
  ADD COLUMN IF NOT EXISTS resumo_ia TEXT;

ALTER TABLE leads_extraidos
  ADD COLUMN IF NOT EXISTS ia_last_analyzed_at TIMESTAMPTZ;

-- Resumo também no histórico para ver a evolução
ALTER TABLE historico_ia_leads
  ADD COLUMN IF NOT EXISTS resumo TEXT;

-- ============================================================
-- ai_organizer_runs — registro de TODA execução do Organizador.
-- Permite ver histórico completo (manual + automático), mesmo
-- quando nenhum lead foi movido ou a execução falhou.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_organizer_runs (
  id BIGSERIAL PRIMARY KEY,
  batch_id UUID,
  triggered_by TEXT NOT NULL DEFAULT 'manual', -- manual | auto | schedule_catchup
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  duration_ms INT,
  model TEXT,
  provider TEXT,
  chats_analyzed INT DEFAULT 0,
  leads_moved INT DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running', -- running | ok | error | noop
  error TEXT,
  summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_organizer_runs_started ON ai_organizer_runs(started_at DESC);
ALTER TABLE ai_organizer_runs DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE ai_organizer_runs TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE ai_organizer_runs_id_seq TO anon, authenticated, service_role;

-- Nota: o valor "primeiro_contato" em leads_extraidos.status é um novo estágio do Kanban
-- usado tanto pelo Organizador IA quanto pelo disparo em massa (ao enviar com sucesso).
-- Se houver CHECK constraint ou enum em leads_extraidos.status, adicione 'primeiro_contato':
-- ALTER TABLE leads_extraidos DROP CONSTRAINT IF EXISTS leads_extraidos_status_check;
-- ALTER TABLE leads_extraidos ADD CONSTRAINT leads_extraidos_status_check
--   CHECK (status IN ('novo','primeiro_contato','interessado','follow-up','agendado','fechado','sem_interesse','descartado'));
