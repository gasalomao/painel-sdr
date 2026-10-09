-- Adiciona tabela de activity logs para o Site Studio
-- Tracking em tempo real de tudo que o agent está fazendo

CREATE TABLE IF NOT EXISTS website_run_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES website_runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'tool_start', 'tool_complete', 'tool_error',
    'model_start', 'model_thinking', 'model_complete', 'model_error',
    'validation_start', 'validation_complete', 'validation_error',
    'build_start', 'build_progress', 'build_complete', 'build_error',
    'checkpoint_created', 'revision_created',
    'thinking', 'planning', 'error', 'info'
  )),
  message TEXT NOT NULL,
  status TEXT CHECK (status IN ('pending', 'success', 'error')),
  details JSONB,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX idx_website_run_activities_run_id ON website_run_activities(run_id);
CREATE INDEX idx_website_run_activities_created_at ON website_run_activities(run_id, created_at);
CREATE INDEX idx_website_run_activities_type ON website_run_activities(run_id, type);

-- RLS Policies
ALTER TABLE website_run_activities ENABLE ROW LEVEL SECURITY;

-- Policy: usuários podem ver activities dos seus próprios runs
CREATE POLICY website_run_activities_select_policy ON website_run_activities
  FOR SELECT
  USING (
    run_id IN (
      SELECT r.id
      FROM website_runs r
      JOIN website_projects p ON r.project_id = p.id
      WHERE p.client_id = auth.uid()
    )
  );

-- Policy: sistema pode inserir activities
CREATE POLICY website_run_activities_insert_policy ON website_run_activities
  FOR INSERT
  WITH CHECK (true);

-- Comentários
COMMENT ON TABLE website_run_activities IS 'Activity logs em tempo real dos runs do Site Studio';
COMMENT ON COLUMN website_run_activities.type IS 'Tipo de atividade (tool, model, validation, build, etc)';
COMMENT ON COLUMN website_run_activities.message IS 'Mensagem legível para exibir ao usuário';
COMMENT ON COLUMN website_run_activities.status IS 'Status da operação (pending, success, error)';
COMMENT ON COLUMN website_run_activities.details IS 'Detalhes adicionais em JSON (params, results, usage, etc)';
COMMENT ON COLUMN website_run_activities.duration_ms IS 'Duração da operação em milissegundos';
