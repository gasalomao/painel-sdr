-- Tabela para armazenar configurações do sistema (URL pública, etc.)
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Inserir URL padrão (se existir)
INSERT INTO app_settings (key, value, updated_at) 
VALUES ('public_url', '', NOW())
ON CONFLICT (key) DO NOTHING;
