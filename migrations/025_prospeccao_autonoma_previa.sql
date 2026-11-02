-- ============================================================
-- MIGRATION 025: PROSPECÇÃO AUTÔNOMA DE SITES COM OPENCODE + VERCEL + QA
-- Adiciona campos de controle do ciclo de vida da prévia de site,
-- auditoria tripla de qualidade e agendamento de fechamento.
-- ============================================================

ALTER TABLE public.leads_extraidos
  ADD COLUMN IF NOT EXISTS previa_status TEXT,
  ADD COLUMN IF NOT EXISTS link_previa TEXT,
  ADD COLUMN IF NOT EXISTS previa_error TEXT,
  ADD COLUMN IF NOT EXISTS previa_tentativas INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS previa_solicitada_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS previa_pronta_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS previa_ping_enviado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS previa_link_enviado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS previa_qa_score INT,
  ADD COLUMN IF NOT EXISTS previa_qa_report JSONB,
  ADD COLUMN IF NOT EXISTS previa_whatsapp_insights JSONB,
  ADD COLUMN IF NOT EXISTS previa_fup_3h_enviado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS previa_fup_24h_enviado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reuniao_agendada_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reuniao_horario_confirmado TEXT,
  ADD COLUMN IF NOT EXISTS reuniao_resumo TEXT;

-- Índice para a fila de geração autônoma na VPS (worker consome status = 'PREVIA_SOLICITADA')
CREATE INDEX IF NOT EXISTS idx_leads_previa_status
  ON public.leads_extraidos (client_id, previa_status)
  WHERE previa_status IS NOT NULL;

-- Índice para busca rápida de prévias prontas por link
CREATE INDEX IF NOT EXISTS idx_leads_link_previa
  ON public.leads_extraidos (link_previa)
  WHERE link_previa IS NOT NULL;

-- Configurações de Geração de Sites na tabela automations
ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS site_generation_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS site_generation_mode TEXT DEFAULT 'imediato'::text,
  ADD COLUMN IF NOT EXISTS site_generation_prompt TEXT;

COMMENT ON COLUMN public.leads_extraidos.previa_status IS 'Status do pipeline autônomo: PREVIA_SOLICITADA, GERANDO_WORKSPACE, EXECUTANDO_OPENCODE, FAZENDO_DEPLOY, INSPECIONANDO_QA, PREVIA_PRONTA, PREVIA_FALHOU, REUNIAO_AGENDADA';
COMMENT ON COLUMN public.leads_extraidos.link_previa IS 'URL pública da prévia hospedada na Vercel (https://slug.vercel.app)';
COMMENT ON COLUMN public.leads_extraidos.previa_qa_score IS 'Nota estética e técnica atribuída pelo QA triplo (0 a 100)';
COMMENT ON COLUMN public.leads_extraidos.previa_qa_report IS 'Relatório detalhado das 3 camadas de inspeção (HTTP, Puppeteer mobile e LLM Vision)';
COMMENT ON COLUMN public.leads_extraidos.previa_whatsapp_insights IS 'Insights minerados da conversa no WhatsApp (regras de PIX, links de agenda externa, etc.)';
