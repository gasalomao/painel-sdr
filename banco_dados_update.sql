--  SQL DE ATUALIZACAO OMNICHANNEL + AGENDA

-- 1. Cria a Tabela de Conexões que liga Instancias ao Agente
CREATE TABLE IF NOT EXISTS public.channel_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'evolution',
  instance_name TEXT NOT NULL UNIQUE,
  agent_id INT REFERENCES public.agent_settings(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'disconnected',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- 2. Coluna no Chats e Leads para prevenir cruzamento de mensagens
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS instance_name TEXT DEFAULT 'sdr';
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS instance_name TEXT DEFAULT 'sdr';

-- 3. Certificar que a Sequence da agent_settings permite insert sem conflito (Multi-Agentes)
-- Aqui garantimos um agente padrao no id 1 ANTES de criar a ligacao
INSERT INTO public.agent_settings (id, name, main_prompt) 
VALUES (1, 'Vendedor Geral', 'Você é um vendedor') 
ON CONFLICT (id) DO NOTHING;

-- 4. Inserir a Conexão Padrão atual para não quebrar o que já existe
INSERT INTO public.channel_connections (instance_name, agent_id, status)
VALUES ('sdr', 1, 'open')
ON CONFLICT (instance_name) DO NOTHING;

-- 5. Adiciona a coluna para configurações extras (ex: Calendar JSON auth) na Agent Settings
ALTER TABLE public.agent_settings ADD COLUMN IF NOT EXISTS options JSONB DEFAULT '{}';

-- 6. Adiciona colunas para o sistema avançado de Etapas do Agente
ALTER TABLE public.agent_stages ADD COLUMN IF NOT EXISTS condition_variable TEXT;
ALTER TABLE public.agent_stages ADD COLUMN IF NOT EXISTS condition_operator TEXT;
ALTER TABLE public.agent_stages ADD COLUMN IF NOT EXISTS condition_value TEXT;
ALTER TABLE public.agent_stages ADD COLUMN IF NOT EXISTS captured_variables JSONB DEFAULT '[]'::jsonb;

-- 7. Adiciona colunas para estado da sessão (progressão do funil)
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS variables JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS current_stage_id UUID REFERENCES public.agent_stages(id) ON DELETE SET NULL;

-- 8. Cria a tabela de logs de tokens da IA (ai_token_usage)
CREATE TABLE IF NOT EXISTS public.ai_token_usage (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT,
  source_label TEXT,
  model TEXT,
  provider TEXT DEFAULT 'Gemini',
  prompt_tokens INT DEFAULT 0,
  completion_tokens INT DEFAULT 0,
  total_tokens INT DEFAULT 0,
  cost_usd NUMERIC(12, 8) DEFAULT 0,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_usage_created ON public.ai_token_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_source ON public.ai_token_usage(source, source_id);


-- Permissão do RLS
ALTER TABLE public.ai_token_usage DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.ai_token_usage TO anon, authenticated, service_role;

-- Atualizar cache do postgREST
NOTIFY pgrst, 'reload_schema';

-- 9. Cria a tabela de Buffers de Chat (Agrupamento de Mensagens)
CREATE TABLE IF NOT EXISTS public.chat_buffers (
  remote_jid TEXT,
  instance_name TEXT,
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (remote_jid, instance_name)
);

-- Permissão do RLS para chat_buffers
ALTER TABLE public.chat_buffers DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.chat_buffers TO anon, authenticated, service_role;
