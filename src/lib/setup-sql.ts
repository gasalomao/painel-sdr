// GERADO AUTOMATICAMENTE a partir de SETUP_COMPLETO.sql.
// Pra atualizar: edite SETUP_COMPLETO.sql e rode `node scripts/build-setup-sql.mjs`.
// Não edite este arquivo manualmente.

export const SETUP_SQL = `-- =====================================================================
-- 🚀 PAINEL SDR — SETUP COMPLETO DO ZERO
-- Cole TUDO num Supabase novo (SQL Editor) e clique RUN.
-- 100% idempotente: pode rodar várias vezes sem quebrar nada.
-- Este arquivo unifica todas as migrações antigas: cria as tabelas,
-- adiciona TODAS as colunas, índices, permissões, bucket de storage,
-- publicação realtime e seeds iniciais.
--
-- Versão: 2026-05-07
-- Inclui: 26 tabelas, automation/automation_logs, lead_intelligence,
-- automation.followup_enabled, profile_pic_*, push_name, provider
-- multi-canal, todos os campos de IA (token usage, pricing cache,
-- ai_organizer_runs), upsert-safe unique constraints em messages e
-- chats_dashboard, bucket whatsapp_media pré-criado.
--
-- Garantia: rodando este script num Supabase NOVO, o programa inteiro
-- (chat, IA, disparo em massa, follow-up, automação, leads, tokens)
-- deve funcionar sem precisar de NENHUM outro SQL auxiliar.
-- =====================================================================

-- =====================================================================
-- PARTE 1 — CONTATOS / SESSÕES / MENSAGENS (V2)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  remote_jid    TEXT NOT NULL UNIQUE,
  phone_number  TEXT,
  nome_negocio  TEXT,
  push_name     TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS push_name TEXT;
-- Foto de perfil do WhatsApp + timestamp do último fetch (cache TTL).
-- A URL Evolution retornada é assinada e tipicamente expira em 7 dias.
-- Renovamos opportunisticamente quando passa de 24h.
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS profile_pic_url TEXT;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS profile_pic_fetched_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        UUID REFERENCES public.contacts(id) ON DELETE CASCADE,
  instance_name     TEXT NOT NULL DEFAULT 'sdr',
  agent_id          INT,
  bot_status        TEXT DEFAULT 'bot_active',
  last_message_at   TIMESTAMPTZ,
  variables         JSONB DEFAULT '{}'::jsonb,
  unread_count      INT DEFAULT 0,
  paused_by         TEXT,
  paused_at         TIMESTAMPTZ,
  resume_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contact_id, instance_name)
);
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS variables        JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS unread_count     INT DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS paused_by        TEXT;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS paused_at        TIMESTAMPTZ;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS resume_at        TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.messages (
  id BIGSERIAL PRIMARY KEY,
  session_id        UUID REFERENCES public.sessions(id) ON DELETE CASCADE,
  message_id        TEXT UNIQUE,
  sender            TEXT NOT NULL DEFAULT 'customer', -- customer | ai | human | system
  content           TEXT,
  media_category    TEXT,                              -- text | image | audio | video | document
  media_url         TEXT,
  mimetype          TEXT,
  file_name         TEXT,
  file_size         BIGINT,
  base64_content    TEXT,
  delivery_status   TEXT,                              -- pending | sent | delivered | read | error
  quoted_msg_id     TEXT,
  quoted_text       TEXT,
  raw_payload       JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS file_name      TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS file_size      BIGINT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS mimetype       TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS media_url      TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS quoted_msg_id  TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS quoted_text    TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS raw_payload    JSONB;
CREATE INDEX IF NOT EXISTS idx_messages_session ON public.messages(session_id, created_at);

-- =====================================================================
-- PARTE 2 — chats_dashboard (LEGADO, fonte que o painel /chat lê)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.chats_dashboard (
  id BIGSERIAL PRIMARY KEY,
  remote_jid     TEXT NOT NULL,
  instance_name  TEXT NOT NULL DEFAULT 'sdr',
  message_id     TEXT UNIQUE,
  sender_type    TEXT NOT NULL DEFAULT 'customer', -- customer | ai | human | system
  content        TEXT,
  status_envio   TEXT,                             -- sent | delivered | read | error | received
  is_from_me     BOOLEAN GENERATED ALWAYS AS (sender_type IN ('ai','human')) STORED,
  -- mídia
  media_url      TEXT,
  media_type     TEXT,
  mimetype       TEXT,
  message_type   TEXT,
  -- reply
  quoted_id      TEXT,
  quoted_text    TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS instance_name TEXT DEFAULT 'sdr';
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS media_url     TEXT;
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS media_type    TEXT;
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS mimetype      TEXT;
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS message_type  TEXT;
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS quoted_id     TEXT;
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS quoted_text   TEXT;
CREATE INDEX IF NOT EXISTS idx_chats_remote_jid ON public.chats_dashboard(remote_jid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_instance   ON public.chats_dashboard(instance_name);

-- =====================================================================
-- PARTE 3 — LEADS
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.leads_extraidos (
  id BIGSERIAL PRIMARY KEY,
  "remoteJid"              TEXT UNIQUE,
  nome_negocio             TEXT,
  ramo_negocio             TEXT,
  status                   TEXT DEFAULT 'novo',
  instance_name            TEXT DEFAULT 'sdr',
  justificativa_ia         TEXT,
  resumo_ia                TEXT,
  ia_last_analyzed_at      TIMESTAMPTZ,
  primeiro_contato_at      TIMESTAMPTZ,
  primeiro_contato_source  TEXT,                       -- disparo | ia | manual
  telefone                 TEXT,
  endereco                 TEXT,
  avaliacao                NUMERIC,
  reviews                  INT,
  website                  TEXT,
  categoria                TEXT,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS instance_name        TEXT DEFAULT 'sdr';
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS nome_negocio         TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS ramo_negocio         TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS categoria            TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS endereco             TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS website              TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS avaliacao            NUMERIC;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS reviews              INT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS telefone             TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS justificativa_ia     TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS resumo_ia            TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS ia_last_analyzed_at  TIMESTAMPTZ;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS primeiro_contato_at  TIMESTAMPTZ;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS primeiro_contato_source TEXT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ DEFAULT NOW();
-- =====================================================================
-- Lead Intelligence — briefing gerado por IA antes do disparo.
-- Ideia: cada lead recebe um "diagnóstico" 1x (cache no banco). Esse
-- briefing é reaproveitado pelo /disparo, /automacao e /leads — economia
-- de tokens (não re-analisa o mesmo lead) + personalização cirúrgica.
-- =====================================================================
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS icp_score INT;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS lead_type TEXT;
  -- Valores: b2b_recurring | b2c_oneshot | mixed | unknown
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS intelligence JSONB;
  -- { dores: [], abordagem: "...", decisor: "...", concorrente_local: "...",
  --   alerta: "..." (compliance, sazonalidade), briefing_md: "..." }
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS intelligence_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_leads_icp_score ON public.leads_extraidos (icp_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_leads_lead_type ON public.leads_extraidos (lead_type);

CREATE INDEX IF NOT EXISTS idx_leads_remoteJid ON public.leads_extraidos ("remoteJid");
CREATE INDEX IF NOT EXISTS idx_leads_status    ON public.leads_extraidos (status);
CREATE INDEX IF NOT EXISTS idx_leads_primeiro_contato_source
  ON public.leads_extraidos (status, primeiro_contato_source, primeiro_contato_at)
  WHERE status = 'primeiro_contato';

-- =====================================================================
-- PARTE 4 — AGENTES (settings, stages, knowledge)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.agent_settings (
  id SERIAL PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT 'Agente',
  main_prompt    TEXT DEFAULT '',
  role           TEXT DEFAULT '',
  personality    TEXT DEFAULT '',
  tone           TEXT DEFAULT '',
  target_model   TEXT DEFAULT 'gemini-1.5-flash',
  main_number    TEXT,
  is_active      BOOLEAN DEFAULT TRUE,
  is_24h         BOOLEAN DEFAULT TRUE,
  away_message   TEXT,
  schedules      JSONB DEFAULT '[]'::jsonb,
  options        JSONB DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.agent_settings ADD COLUMN IF NOT EXISTS options JSONB DEFAULT '{}'::jsonb;

INSERT INTO public.agent_settings (id, name, main_prompt)
VALUES (1, 'Vendedor Geral', 'Você é um vendedor.')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.agent_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           INT REFERENCES public.agent_settings(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  goal_prompt        TEXT,
  order_index        INT DEFAULT 0,
  condition_variable TEXT,
  condition_operator TEXT,
  condition_value    TEXT,
  captured_variables JSONB DEFAULT '[]'::jsonb,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.agent_stages ADD COLUMN IF NOT EXISTS condition_variable TEXT;
ALTER TABLE public.agent_stages ADD COLUMN IF NOT EXISTS condition_operator TEXT;
ALTER TABLE public.agent_stages ADD COLUMN IF NOT EXISTS condition_value    TEXT;
ALTER TABLE public.agent_stages ADD COLUMN IF NOT EXISTS captured_variables JSONB DEFAULT '[]'::jsonb;

-- Agora que agent_stages existe, podemos adicionar a chave estrangeira em sessions
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS current_stage_id UUID REFERENCES public.agent_stages(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.agent_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    INT REFERENCES public.agent_settings(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  content     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.agent_batch_locks (
  agent_id     INT PRIMARY KEY,
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.chat_buffers (
  remote_jid    TEXT NOT NULL,
  instance_name TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (remote_jid, instance_name)
);

-- =====================================================================
-- PARTE 5 — INSTÂNCIAS (channel_connections multi-provider)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.channel_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         TEXT NOT NULL DEFAULT 'evolution',  -- evolution | whatsapp_cloud
  instance_name    TEXT NOT NULL UNIQUE,
  agent_id         INT REFERENCES public.agent_settings(id) ON DELETE SET NULL,
  status           TEXT DEFAULT 'disconnected',
  provider_config  JSONB DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.channel_connections ADD COLUMN IF NOT EXISTS provider        TEXT NOT NULL DEFAULT 'evolution';
ALTER TABLE public.channel_connections ADD COLUMN IF NOT EXISTS provider_config JSONB DEFAULT '{}'::jsonb;

INSERT INTO public.channel_connections (instance_name, agent_id, status)
VALUES ('sdr', 1, 'open')
ON CONFLICT (instance_name) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_channel_provider_phone_id
  ON public.channel_connections ((provider_config->>'phone_number_id'))
  WHERE provider = 'whatsapp_cloud';

-- =====================================================================
-- PARTE 6 — webhook_logs
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_name TEXT,
  event         TEXT,
  payload       JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created ON public.webhook_logs (created_at DESC);

-- =====================================================================
-- PARTE 7 — HISTÓRICO / ORGANIZADOR IA
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.historico_ia_leads (
  id BIGSERIAL PRIMARY KEY,
  remote_jid     TEXT,
  nome_negocio   TEXT,
  status_antigo  TEXT,
  status_novo    TEXT,
  razao          TEXT,
  resumo         TEXT,
  batch_id       TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_historico_ia_created ON public.historico_ia_leads(created_at DESC);

CREATE TABLE IF NOT EXISTS public.ai_organizer_config (
  id INT PRIMARY KEY DEFAULT 1,
  enabled        BOOLEAN DEFAULT FALSE,
  api_key        TEXT,
  model          TEXT,
  provider       TEXT DEFAULT 'Gemini',
  execution_hour INT DEFAULT 20,
  last_run       TIMESTAMPTZ,
  app_url        TEXT,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO public.ai_organizer_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ai_organizer_runs (
  id BIGSERIAL PRIMARY KEY,
  batch_id        UUID,
  triggered_by    TEXT NOT NULL DEFAULT 'manual',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  duration_ms     INT,
  model           TEXT,
  provider        TEXT,
  chats_analyzed  INT DEFAULT 0,
  leads_moved     INT DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'running',
  error           TEXT,
  summary         TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_organizer_runs_started ON public.ai_organizer_runs(started_at DESC);

-- =====================================================================
-- PARTE 8 — DISPARO EM MASSA
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    TEXT NOT NULL,
  instance_name           TEXT NOT NULL,
  agent_id                INT REFERENCES public.agent_settings(id) ON DELETE SET NULL,
  message_template        TEXT NOT NULL,
  -- Intervalos SEGUROS pra WhatsApp (Evolution / Baileys). Defaults conservadores
  -- baseados em práticas anti-banimento: 60-180s entre disparos (média ~2 min)
  -- + janela de horário comercial. Para números novos/frios, considere 90-300s.
  min_interval_seconds    INT NOT NULL DEFAULT 60,
  max_interval_seconds    INT NOT NULL DEFAULT 180,
  allowed_start_hour      INT DEFAULT 9,
  allowed_end_hour        INT DEFAULT 20,
  status                  TEXT NOT NULL DEFAULT 'draft',
  total_targets           INT DEFAULT 0,
  sent_count              INT DEFAULT 0,
  failed_count            INT DEFAULT 0,
  skipped_count           INT DEFAULT 0,
  personalize_with_ai     BOOLEAN DEFAULT FALSE,
  use_web_search          BOOLEAN DEFAULT FALSE,
  ai_model                TEXT,
  ai_prompt               TEXT,
  last_error              TEXT,
  last_error_at           TIMESTAMPTZ,
  started_at              TIMESTAMPTZ,
  finished_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON public.campaigns(status);
-- Marca campanhas criadas pela automação. /disparo filtra IS NULL pra
-- esconder essas e evitar disparo manual acidental.
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS automation_id UUID;
-- Toggle "pré-analisar leads com Lead Intelligence" antes de disparar.
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS lead_intelligence_enabled BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_campaigns_automation ON public.campaigns(automation_id) WHERE automation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.campaign_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  remote_jid        TEXT NOT NULL,
  nome_negocio      TEXT,
  ramo_negocio      TEXT,
  next_send_at      TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'pending',
  message_id        TEXT,
  rendered_message  TEXT,
  ai_input          TEXT,
  error_message     TEXT,
  attempts          INT DEFAULT 0,
  sent_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaign_targets_campaign ON public.campaign_targets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_targets_status   ON public.campaign_targets(campaign_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_target     ON public.campaign_targets(campaign_id, remote_jid);

CREATE TABLE IF NOT EXISTS public.campaign_logs (
  id BIGSERIAL PRIMARY KEY,
  campaign_id  UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  message      TEXT NOT NULL,
  level        TEXT NOT NULL DEFAULT 'info',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaign_logs_campaign ON public.campaign_logs(campaign_id, created_at);

-- =====================================================================
-- PARTE 9 — FOLLOW-UP AUTOMÁTICO
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.followup_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  instance_name         TEXT NOT NULL,
  ai_enabled            BOOLEAN DEFAULT FALSE,
  ai_model              TEXT,
  ai_prompt             TEXT,
  steps                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Follow-up: ainda mais espaçado que disparo, pra parecer humano (60-240s).
  min_interval_seconds  INT NOT NULL DEFAULT 60,
  max_interval_seconds  INT NOT NULL DEFAULT 240,
  allowed_start_hour    INT DEFAULT 9,
  allowed_end_hour      INT DEFAULT 20,
  auto_execute          BOOLEAN DEFAULT FALSE,
  status                TEXT NOT NULL DEFAULT 'draft',
  total_enrolled        INT DEFAULT 0,
  total_sent            INT DEFAULT 0,
  total_responded       INT DEFAULT 0,
  total_exhausted       INT DEFAULT 0,
  last_error            TEXT,
  last_error_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_followup_campaigns_status ON public.followup_campaigns(status);

CREATE TABLE IF NOT EXISTS public.followup_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  followup_campaign_id  UUID NOT NULL REFERENCES public.followup_campaigns(id) ON DELETE CASCADE,
  lead_id               INT,
  remote_jid            TEXT NOT NULL,
  nome_negocio          TEXT,
  ramo_negocio          TEXT,
  current_step          INT NOT NULL DEFAULT 0,
  last_sent_at          TIMESTAMPTZ,
  next_send_at          TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'pending',
  last_message_id       TEXT,
  last_rendered         TEXT,
  ai_input              TEXT,
  error_message         TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_followup_targets_campaign ON public.followup_targets(followup_campaign_id);
CREATE INDEX IF NOT EXISTS idx_followup_targets_next     ON public.followup_targets(followup_campaign_id, status, next_send_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_followup_target     ON public.followup_targets(followup_campaign_id, remote_jid);

CREATE TABLE IF NOT EXISTS public.followup_logs (
  id BIGSERIAL PRIMARY KEY,
  followup_campaign_id  UUID NOT NULL REFERENCES public.followup_campaigns(id) ON DELETE CASCADE,
  message               TEXT NOT NULL,
  level                 TEXT NOT NULL DEFAULT 'info',
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_followup_logs_campaign ON public.followup_logs(followup_campaign_id, created_at);

-- =====================================================================
-- PARTE 10 — TOKENS / CUSTO IA
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.ai_token_usage (
  id BIGSERIAL PRIMARY KEY,
  source             TEXT NOT NULL,                 -- agent | disparo | followup | organizer | other
  source_id          TEXT,
  source_label       TEXT,
  model              TEXT,
  provider           TEXT DEFAULT 'Gemini',
  prompt_tokens      INT DEFAULT 0,
  completion_tokens  INT DEFAULT 0,
  total_tokens       INT DEFAULT 0,
  cost_usd           NUMERIC(12, 8) DEFAULT 0,
  metadata           JSONB DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_usage_created ON public.ai_token_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_source  ON public.ai_token_usage(source, source_id);
-- Indexar por dia: timestamptz→date depende da timezone da sessão (não é
-- IMMUTABLE). Postgres rejeita índices em expressões não-IMMUTABLE. Fixando
-- UTC com \`AT TIME ZONE\` torna a expressão determinística.
CREATE INDEX IF NOT EXISTS idx_token_usage_day     ON public.ai_token_usage(((created_at AT TIME ZONE 'UTC')::date));

-- Cache de preços online de modelos (LiteLLM) — usado em /tokens
CREATE TABLE IF NOT EXISTS public.ai_pricing_cache (
  key         TEXT PRIMARY KEY,
  payload     JSONB NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================================================================
-- PARTE 10.5 — AUTOMAÇÃO (orquestrador: scrape → disparo → follow-up)
-- Uma "automação" amarra: scraper (nicho/região/filtros) + disparo em massa
-- (template + intervalos + horários) + follow-up (steps + IA opcional),
-- vinculados a um agente IA + instância. State machine progride:
-- idle → scraping → dispatching → following → done.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL,
  agent_id               INT REFERENCES public.agent_settings(id) ON DELETE SET NULL,
  instance_name          TEXT NOT NULL,
  -- Scraper config
  niches                 JSONB NOT NULL DEFAULT '[]'::jsonb,    -- ["pizzaria","açaí"]
  regions                JSONB NOT NULL DEFAULT '[]'::jsonb,    -- ["Vitoria/ES","Vila Velha/ES"]
  scrape_filters         JSONB DEFAULT '{}'::jsonb,             -- {filterEmpty,filterDuplicates,filterLandlines,maxLeads}
  scrape_max_leads       INT DEFAULT 200,
  -- Disparo (intervalos SEGUROS WhatsApp: 60-180s aleatório, média ~2 min)
  dispatch_template      TEXT,
  dispatch_min_interval  INT NOT NULL DEFAULT 60,
  dispatch_max_interval  INT NOT NULL DEFAULT 180,
  dispatch_personalize   BOOLEAN DEFAULT FALSE,
  dispatch_ai_model      TEXT,
  dispatch_ai_prompt     TEXT,
  -- Follow-up (mais espaçado: 60-240s)
  followup_steps         JSONB NOT NULL DEFAULT '[]'::jsonb,    -- [{day_offset,template}]
  followup_min_interval  INT NOT NULL DEFAULT 60,
  followup_max_interval  INT NOT NULL DEFAULT 240,
  followup_ai_enabled    BOOLEAN DEFAULT FALSE,
  followup_ai_model      TEXT,
  followup_ai_prompt     TEXT,
  -- Janela de horário (válida pra disparo + follow-up)
  allowed_start_hour     INT NOT NULL DEFAULT 9,
  allowed_end_hour       INT NOT NULL DEFAULT 20,
  -- State machine
  phase                  TEXT NOT NULL DEFAULT 'idle',          -- idle|scraping|dispatching|following|done|error|paused
  status                 TEXT NOT NULL DEFAULT 'draft',         -- draft|running|paused|done|error
  campaign_id            UUID,                                  -- ref. solta pra evitar cascade surpresa
  followup_campaign_id   UUID,
  -- Contadores e timestamps
  scraped_count          INT DEFAULT 0,
  last_error             TEXT,
  last_error_at          TIMESTAMPTZ,
  started_at             TIMESTAMPTZ,
  finished_at            TIMESTAMPTZ,
  scrape_finished_at     TIMESTAMPTZ,
  dispatch_finished_at   TIMESTAMPTZ,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automations_status ON public.automations(status, phase);
-- Migração defensiva: tabela existente ganha o toggle de follow-up.
ALTER TABLE public.automations ADD COLUMN IF NOT EXISTS followup_enabled BOOLEAN DEFAULT TRUE;
-- Toggle pra rodar Lead Intelligence automaticamente entre captação e disparo.
ALTER TABLE public.automations ADD COLUMN IF NOT EXISTS lead_intelligence_enabled BOOLEAN DEFAULT FALSE;

-- Log estruturado da automação — feed em tempo real visível na UI.
-- Diferentes "kind" (fonte): scrape | dispatch | followup | reply | state | error
-- Carrega remote_jid quando aplicável pra você clicar no log e abrir o chat.
CREATE TABLE IF NOT EXISTS public.automation_logs (
  id BIGSERIAL PRIMARY KEY,
  automation_id  UUID NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'state',  -- scrape|dispatch|followup|reply|state|error
  level          TEXT NOT NULL DEFAULT 'info',   -- info|success|warning|error
  message        TEXT NOT NULL,
  remote_jid     TEXT,
  metadata       JSONB DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_logs_automation ON public.automation_logs(automation_id, created_at DESC);

-- =====================================================================
-- PARTE 11 — app_settings (URL pública, credenciais Evolution global, flags)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO public.app_settings (key, value, updated_at) VALUES
  ('public_url',          '', NOW()),
  ('evolution_url',       '', NOW()),
  ('evolution_api_key',   '', NOW()),
  ('evolution_instance',  '', NOW()),
  ('lead_intelligence_model', 'gemini-2.5-flash', NOW())  -- modelo padrão pra Lead Intelligence
ON CONFLICT (key) DO NOTHING;

-- =====================================================================
-- PARTE 11.5 — UNIQUE CONSTRAINTS DEFENSIVAS (necessárias pra UPSERT)
-- Garante que tabelas pré-existentes (de bancos antigos sem o CREATE
-- TABLE original) ganhem as UNIQUE necessárias pros upserts dos workers
-- de disparo / follow-up / webhook funcionarem. Sem isso, o
-- \`upsert(onConflict: "message_id")\` falha em runtime.
-- =====================================================================
DO $$
BEGIN
  -- chats_dashboard.message_id UNIQUE (campaign-worker faz upsert por aqui)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.chats_dashboard'::regclass
      AND contype  = 'u'
      AND conkey   = (SELECT array_agg(attnum) FROM pg_attribute
                      WHERE attrelid = 'public.chats_dashboard'::regclass
                        AND attname  = 'message_id')
  ) THEN
    BEGIN
      ALTER TABLE public.chats_dashboard
        ADD CONSTRAINT chats_dashboard_message_id_key UNIQUE (message_id);
    EXCEPTION WHEN duplicate_table OR duplicate_object THEN
      -- já existe sob outro nome — ignora
      NULL;
    END;
  END IF;

  -- messages.message_id UNIQUE (idem, agora também via upsert)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.messages'::regclass
      AND contype  = 'u'
      AND conkey   = (SELECT array_agg(attnum) FROM pg_attribute
                      WHERE attrelid = 'public.messages'::regclass
                        AND attname  = 'message_id')
  ) THEN
    BEGIN
      ALTER TABLE public.messages
        ADD CONSTRAINT messages_message_id_key UNIQUE (message_id);
    EXCEPTION WHEN duplicate_table OR duplicate_object THEN
      NULL;
    END;
  END IF;
END $$;

-- =====================================================================
-- PARTE 12 — STORAGE BUCKET (mídia do WhatsApp)
-- =====================================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('whatsapp_media', 'whatsapp_media', true)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'whatsapp_media_public_read'
  ) THEN
    CREATE POLICY whatsapp_media_public_read ON storage.objects
      FOR SELECT USING (bucket_id = 'whatsapp_media');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'whatsapp_media_service_write'
  ) THEN
    CREATE POLICY whatsapp_media_service_write ON storage.objects
      FOR ALL TO service_role USING (bucket_id = 'whatsapp_media') WITH CHECK (bucket_id = 'whatsapp_media');
  END IF;
END $$;

-- =====================================================================
-- PARTE 13 — DESATIVA RLS + GRANTS (todas as operações usam service_role)
-- =====================================================================
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'contacts','sessions','messages',
      'chats_dashboard','leads_extraidos',
      'agent_settings','agent_stages','agent_knowledge','agent_batch_locks',
      'channel_connections','webhook_logs',
      'historico_ia_leads','ai_organizer_config','ai_organizer_runs',
      'campaigns','campaign_targets','campaign_logs',
      'followup_campaigns','followup_targets','followup_logs',
      'automations','automation_logs',
      'app_settings','ai_token_usage','ai_pricing_cache','chat_buffers'
    ])
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO anon, authenticated, service_role', tbl);
  END LOOP;
END$$;

-- Sequences (BIGSERIAL/SERIAL)
DO $$
DECLARE seq TEXT;
BEGIN
  FOR seq IN
    SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO anon, authenticated, service_role', seq);
  END LOOP;
END$$;

-- Schema-level grants (defensivo: garante CREATE/USAGE no schema public)
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL  ON ALL TABLES    IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL  ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL  ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

-- =====================================================================
-- PARTE 14 — REALTIME (publicação para logs / chats em tempo real)
-- =====================================================================
DO $$
BEGIN
  DROP PUBLICATION IF EXISTS supabase_realtime;
  CREATE PUBLICATION supabase_realtime FOR TABLE
    webhook_logs,
    agent_settings,
    agent_stages,
    agent_knowledge,
    channel_connections,
    chats_dashboard,
    messages,
    campaigns,
    campaign_targets,
    campaign_logs,
    followup_campaigns,
    followup_targets,
    followup_logs,
    ai_organizer_runs,
    historico_ia_leads,
    leads_extraidos,
    automations,
    automation_logs;
END$$;

-- =====================================================================
-- PARTE 15 — SANITY CHECK FINAL
-- Conta tabelas essenciais. Se retornar count=26, tudo OK. Se faltar
-- alguma, o script lança RAISE NOTICE com a lista do que falta — mais
-- útil que descobrir depois pela UI.
-- =====================================================================
DO $$
DECLARE
  required_tables TEXT[] := ARRAY[
    'contacts','sessions','messages','chats_dashboard','leads_extraidos',
    'agent_settings','agent_stages','agent_knowledge','agent_batch_locks','chat_buffers',
    'channel_connections','webhook_logs',
    'historico_ia_leads','ai_organizer_config','ai_organizer_runs',
    'campaigns','campaign_targets','campaign_logs',
    'followup_campaigns','followup_targets','followup_logs',
    'automations','automation_logs',
    'app_settings','ai_token_usage','ai_pricing_cache'
  ];
  missing TEXT[];
BEGIN
  SELECT array_agg(t)
    INTO missing
    FROM unnest(required_tables) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
   );
  IF missing IS NOT NULL AND array_length(missing, 1) > 0 THEN
    RAISE WARNING '⚠️ Tabelas faltando: %', missing;
  ELSE
    RAISE NOTICE '✅ Todas as 26 tabelas essenciais foram criadas.';
  END IF;
END $$;

-- =====================================================================
-- ✅ PRONTO. Se viu "Success. No rows returned" está tudo certo.
-- Volte ao painel: Configurações → Setup do Banco → "Verificar agora".
-- Deve aparecer o badge verde "Banco pronto".
-- =====================================================================
`;
