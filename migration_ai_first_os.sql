-- =====================================================================
-- 🚀 PAINEL SDR — MIGRAÇÃO: AI-First OS
-- Adiciona tabelas para os novos módulos sem alterar nada existente.
-- 100% idempotente: pode rodar várias vezes sem quebrar nada.
-- Rode DEPOIS do SETUP_COMPLETO.sql.
--
-- Módulos: Knowledge Base, Anti-Vácuo, Sales Intelligence,
--          Handoff IA→Humano, CS Pós-Venda
-- =====================================================================

-- =====================================================================
-- MÓDULO 1 — BASE DE CONHECIMENTO ("Segundo Cérebro")
-- Documentos que a IA usa como contexto para responder melhor.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT DEFAULT 'geral',
  tags TEXT[] DEFAULT '{}',
  is_active BOOLEAN DEFAULT TRUE,
  token_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_category ON public.knowledge_base(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_active ON public.knowledge_base(is_active) WHERE is_active = TRUE;

-- =====================================================================
-- MÓDULO 2 — ANTI-VÁCUO (Reengajamento Inteligente)
-- Regras + logs de follow-up automático para leads silenciosos.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.antivacuo_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  instance_name TEXT NOT NULL,
  hours_without_reply INT NOT NULL DEFAULT 24,
  max_attempts INT DEFAULT 3,
  ai_prompt TEXT DEFAULT 'Gere uma mensagem curta e amigável de follow-up para reengajar o lead que não respondeu.',
  ai_model TEXT DEFAULT 'gemini-2.5-flash',
  target_status TEXT DEFAULT 'primeiro_contato',
  is_active BOOLEAN DEFAULT TRUE,
  total_reengaged INT DEFAULT 0,
  total_recovered INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.antivacuo_logs (
  id BIGSERIAL PRIMARY KEY,
  rule_id UUID REFERENCES public.antivacuo_rules(id) ON DELETE CASCADE,
  remote_jid TEXT NOT NULL,
  nome_negocio TEXT,
  attempt_number INT DEFAULT 1,
  message_sent TEXT,
  client_replied BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_antivacuo_logs_rule ON public.antivacuo_logs(rule_id, created_at DESC);

-- =====================================================================
-- MÓDULO 3 — SALES INTELLIGENCE (Extração de Insights)
-- Dores, objeções, dados extraídos das conversas pela IA.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.sales_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  remote_jid TEXT NOT NULL,
  nome_negocio TEXT,
  insight_type TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence NUMERIC(3,2) DEFAULT 0.80,
  extracted_from TEXT DEFAULT 'chat_ai',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sales_insights_type ON public.sales_insights(insight_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_insights_jid ON public.sales_insights(remote_jid);

-- =====================================================================
-- MÓDULO 4 — HANDOFF IA → HUMANO
-- Fila de passagem de bastão: IA detecta que precisa de humano.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.handoff_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  remote_jid TEXT NOT NULL,
  instance_name TEXT NOT NULL,
  nome_negocio TEXT,
  reason TEXT NOT NULL,
  priority TEXT DEFAULT 'normal',
  status TEXT DEFAULT 'pending',
  assigned_to TEXT,
  ai_summary TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_handoff_status ON public.handoff_queue(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handoff_priority ON public.handoff_queue(priority) WHERE status = 'pending';

-- =====================================================================
-- MÓDULO 5 — PÓS-VENDA (Customer Success)
-- Campanhas de NPS, indicação e acompanhamento pós-venda.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.pos_venda_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  instance_name TEXT NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'days_after_sale',
  trigger_days INT DEFAULT 7,
  message_template TEXT NOT NULL DEFAULT '',
  ai_enabled BOOLEAN DEFAULT FALSE,
  ai_model TEXT,
  ai_prompt TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  total_sent INT DEFAULT 0,
  total_responded INT DEFAULT 0,
  total_nps_collected INT DEFAULT 0,
  avg_nps NUMERIC(3,1),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.pos_venda_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES public.pos_venda_campaigns(id) ON DELETE CASCADE,
  remote_jid TEXT NOT NULL,
  nome_negocio TEXT,
  sale_date TIMESTAMPTZ,
  nps_score INT,
  feedback TEXT,
  status TEXT DEFAULT 'pending',
  indicated_contacts JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pos_venda_contacts_campaign ON public.pos_venda_contacts(campaign_id, status);

-- =====================================================================
-- PERMISSÕES (mesmo padrão do SETUP_COMPLETO.sql)
-- =====================================================================
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'knowledge_base',
      'antivacuo_rules','antivacuo_logs',
      'sales_insights',
      'handoff_queue',
      'pos_venda_campaigns','pos_venda_contacts'
    ])
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO anon, authenticated, service_role', tbl);
  END LOOP;
END$$;

-- Sequences
DO $$
DECLARE seq TEXT;
BEGIN
  FOR seq IN
    SELECT sequence_name FROM information_schema.sequences
    WHERE sequence_schema = 'public'
      AND sequence_name LIKE '%antivacuo%' OR sequence_name LIKE '%sales_insights%'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO anon, authenticated, service_role', seq);
  END LOOP;
END$$;

-- Realtime (adiciona novas tabelas à publicação existente)
-- NOTA: Só pode adicionar tabelas que ainda não estão na publicação.
-- Se rodar 2x, o ALTER falha silenciosamente — por isso o BEGIN/EXCEPTION.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE
    knowledge_base,
    antivacuo_rules,
    antivacuo_logs,
    sales_insights,
    handoff_queue,
    pos_venda_campaigns,
    pos_venda_contacts;
EXCEPTION WHEN duplicate_object THEN
  -- Tabela(s) já na publicação — ignora.
  NULL;
END$$;

-- =====================================================================
-- ✅ PRONTO. Se viu "Success. No rows returned" está tudo certo.
-- =====================================================================
