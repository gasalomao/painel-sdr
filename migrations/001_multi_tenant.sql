-- =====================================================================
-- Migration 001 — Multi-tenant infrastructure
-- =====================================================================
-- Objetivo: adicionar isolamento por cliente sem QUEBRAR nada que existe.
--
-- Estratégia:
--   1. Tabela `clients` (admin + clientes regulares).
--   2. `client_id UUID NULLABLE` em todas tabelas tenant-aware. NULL =
--      "ainda não migrada" — código antigo continua lendo TODAS as linhas
--      por enquanto. A blindagem (filtro por client_id em cada query) vem
--      numa migration posterior, após smoke-test.
--   3. Cliente "Default" recebe TODOS os dados existentes (zero perda).
--   4. Tabela `kanban_columns` (por cliente) com seed padrão pro Default.
--
-- Idempotente: pode rodar de novo sem efeitos colaterais.
-- =====================================================================

-- ============= 1. CLIENTS TABLE =============
CREATE TABLE IF NOT EXISTS public.clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  email             TEXT NOT NULL UNIQUE,
  password_hash     TEXT,                              -- bcrypt; NULL = sem login direto (só admin pode acessar)
  is_admin          BOOLEAN NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  -- Modelo de IA padrão pra este cliente (override do global)
  default_ai_model  TEXT DEFAULT 'gemini-3.1-flash-lite-preview',
  -- Permissões granulares por módulo (JSONB pra ser flexível sem migrar a cada feature)
  features          JSONB NOT NULL DEFAULT '{
    "dashboard": true,
    "leads": true,
    "chat": true,
    "agente": true,
    "automacao": true,
    "disparo": true,
    "followup": true,
    "captador": true,
    "inteligencia": true,
    "whatsapp": true,
    "historico": true,
    "tokens": true,
    "configuracoes": true
  }'::jsonb,
  -- Prompt do organizador IA personalizado (NULL = usa o default global)
  organizer_prompt  TEXT,
  notes             TEXT,                              -- anotações do admin sobre o cliente
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clients_email      ON public.clients(email);
CREATE INDEX IF NOT EXISTS idx_clients_is_active  ON public.clients(is_active);
CREATE INDEX IF NOT EXISTS idx_clients_is_admin   ON public.clients(is_admin);

-- Seed: cliente "Default" (recebe todos os dados pré-existentes)
INSERT INTO public.clients (id, name, email, is_admin, is_active, notes)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Default',
  'default@local',
  FALSE,
  TRUE,
  'Cliente automático criado pela migração multi-tenant — todos os dados pré-existentes apontam pra ele.'
)
ON CONFLICT (id) DO NOTHING;

-- ============= 2. SESSIONS DE LOGIN (auth) =============
-- Pra ter logout/revoke por sessão, tracking de devices, etc.
CREATE TABLE IF NOT EXISTS public.auth_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  -- Quando admin "entra como cliente", impersonated_as guarda quem está sendo personificado
  impersonated_as UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  user_agent    TEXT,
  ip            TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token   ON public.auth_sessions(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_sessions_client  ON public.auth_sessions(client_id, expires_at);

-- ============= 3. client_id em TABELAS TENANT-AWARE =============
-- NULLABLE de propósito: código antigo continua funcionando até a Fase 5.
-- DEFAULT '...001' (Default) garante que INSERT novo sem client_id vai pro
-- Default — mantém comportamento single-tenant atual até a blindagem.
DO $$
DECLARE
  tbl TEXT;
  tenant_tables TEXT[] := ARRAY[
    'leads_extraidos', 'chats_dashboard', 'messages', 'contacts', 'sessions',
    'agent_settings', 'agent_stages', 'agent_knowledge', 'channel_connections',
    'campaigns', 'campaign_targets', 'campaign_logs',
    'followup_campaigns', 'followup_targets', 'followup_logs',
    'automations', 'automation_logs',
    'ai_token_usage', 'historico_ia_leads', 'ai_organizer_runs', 'chat_buffers'
  ];
BEGIN
  FOREACH tbl IN ARRAY tenant_tables LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE DEFAULT ''00000000-0000-0000-0000-000000000001''',
      tbl
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%I_client ON public.%I(client_id)',
      tbl, tbl
    );
    -- Backfill: pega tudo que está NULL e aponta pro Default.
    EXECUTE format(
      'UPDATE public.%I SET client_id = ''00000000-0000-0000-0000-000000000001'' WHERE client_id IS NULL',
      tbl
    );
  END LOOP;
END $$;

-- ============= 4. KANBAN COLUMNS (editável por cliente) =============
CREATE TABLE IF NOT EXISTS public.kanban_columns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  status_key    TEXT NOT NULL,                          -- valor que vai pro leads_extraidos.status
  label         TEXT NOT NULL,                          -- nome exibido no Kanban
  color         TEXT,                                   -- hex ou tailwind class
  order_index   INT NOT NULL DEFAULT 0,
  is_system     BOOLEAN NOT NULL DEFAULT FALSE,         -- TRUE = não pode deletar (ex: "novo")
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, status_key)
);
CREATE INDEX IF NOT EXISTS idx_kanban_columns_client ON public.kanban_columns(client_id, order_index);

-- Seed de colunas padrão pro cliente Default (espelha os status que o sistema já usa)
INSERT INTO public.kanban_columns (client_id, status_key, label, color, order_index, is_system) VALUES
  ('00000000-0000-0000-0000-000000000001', 'novo',              'Novos',             '#3b82f6', 0, TRUE),
  ('00000000-0000-0000-0000-000000000001', 'primeiro_contato',  'Primeiro contato',  '#06b6d4', 1, FALSE),
  ('00000000-0000-0000-0000-000000000001', 'follow-up',         'Follow-up',         '#eab308', 2, FALSE),
  ('00000000-0000-0000-0000-000000000001', 'qualificado',       'Qualificado',       '#10b981', 3, FALSE),
  ('00000000-0000-0000-0000-000000000001', 'fechado',           'Fechado',           '#22c55e', 4, FALSE),
  ('00000000-0000-0000-0000-000000000001', 'perdido',           'Perdido',           '#ef4444', 5, FALSE),
  ('00000000-0000-0000-0000-000000000001', 'sem_contato',       'Sem contato',       '#6b7280', 6, FALSE)
ON CONFLICT (client_id, status_key) DO NOTHING;

-- ============= 5. GRANTS + RLS DESLIGADO (continua usando service_role) =============
ALTER TABLE public.clients         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_sessions   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.kanban_columns  DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.clients         TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.auth_sessions   TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.kanban_columns  TO anon, authenticated, service_role;

-- ============= 6. REALTIME (clients pra UI admin live) =============
DO $$
BEGIN
  -- pg_publication só permite adicionar se a tabela ainda não estiver lá
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'clients'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.clients;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'kanban_columns'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.kanban_columns;
  END IF;
END $$;

-- ============= 7. SANITY CHECK =============
DO $$
DECLARE
  cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt FROM public.clients WHERE id = '00000000-0000-0000-0000-000000000001';
  IF cnt = 0 THEN
    RAISE EXCEPTION '❌ Cliente Default não foi criado.';
  END IF;
  SELECT COUNT(*) INTO cnt FROM public.kanban_columns WHERE client_id = '00000000-0000-0000-0000-000000000001';
  IF cnt < 7 THEN
    RAISE WARNING '⚠️ Colunas padrão do Kanban: % (esperado 7)', cnt;
  END IF;
  RAISE NOTICE '✅ Migration 001 aplicada. Default client: 00000000-0000-0000-0000-000000000001';
END $$;
