// GERADO AUTOMATICAMENTE a partir de SETUP_COMPLETO.sql.
// Pra atualizar: edite SETUP_COMPLETO.sql e rode `node scripts/build-setup-sql.mjs`.
// Não edite este arquivo manualmente.

export const SETUP_SQL = `-- =====================================================================
-- PAINEL SDR — SETUP COMPLETO DO ZERO
-- =====================================================================
-- Cole TUDO num Supabase novo (SQL Editor) e clique RUN.
-- 100% idempotente: pode rodar várias vezes sem quebrar nada.
--
-- Versão: 2026-05-27 (sincronizado com schema real de produção)
-- 32 tabelas + extensões + índices + constraints.
--
-- Como foi gerado: rodando queries de introspecção em pg_class,
-- information_schema e pg_indexes contra o banco real. NÃO inventa
-- nada — espelha exatamente o que existe em prod.
--
-- O que NÃO está aqui (gerenciar separadamente):
--   - RLS policies (gerenciadas via service_role no app)
--   - Foreign keys explícitas (a maioria é validada via app/RLS)
--   - Storage buckets (criados via /api/setup-db ou manualmente)
--   - Publicação realtime (configurar via Supabase Studio)
-- =====================================================================

-- =====================================================================
-- EXTENSÕES
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "vector";     -- agent_knowledge_chunks.embedding

-- =====================================================================
-- TABELAS
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.agent_batch_locks (
  agent_id      integer PRIMARY KEY,
  locked_until  timestamp with time zone,
  updated_at    timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_knowledge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    integer,
  title       text NOT NULL,
  content     text,
  created_at  timestamp with time zone DEFAULT now(),
  client_id   uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.agent_knowledge_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_id  uuid NOT NULL,
  agent_id      integer NOT NULL,
  client_id     uuid,
  chunk_index   integer NOT NULL DEFAULT 0,
  content       text NOT NULL,
  embedding     vector(768),
  token_count   integer,
  content_hash  text,
  created_at    timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_settings (
  id                         SERIAL PRIMARY KEY,
  name                       text NOT NULL DEFAULT 'Agente'::text,
  main_prompt                text DEFAULT ''::text,
  role                       text DEFAULT ''::text,
  personality                text DEFAULT ''::text,
  tone                       text DEFAULT ''::text,
  target_model               text,
  main_number                text,
  is_active                  boolean DEFAULT true,
  is_24h                     boolean DEFAULT true,
  away_message               text,
  schedules                  jsonb DEFAULT '[]'::jsonb,
  options                    jsonb DEFAULT '{}'::jsonb,
  created_at                 timestamp with time zone DEFAULT now(),
  updated_at                 timestamp with time zone DEFAULT now(),
  client_id                  uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  lead_intelligence_enabled  boolean DEFAULT false,
  is_scheduler               boolean NOT NULL DEFAULT false,
  scheduler_config           jsonb DEFAULT '{"reminders": [{"message": "Oi {nome}! Lembrete: amanhã às {hora_agendamento} temos seu agendamento de {servico}. Confirma a presença?", "offset_minutes": 1440}, {"message": "Oi {nome}! Em 1h é o seu agendamento ({servico}). Te esperamos!", "offset_minutes": 60}], "calendar_id": "primary", "owner_phone": null, "notify_owner": false, "business_hours": {"tz": "America/Sao_Paulo", "end": "18:00", "days": [1, 2, 3, 4, 5, 6], "start": "09:00"}, "cancel_window_minutes": 120, "default_duration_minutes": 60, "auto_promote_kanban_after_minutes": 30}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.agent_stages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            integer,
  title               text NOT NULL,
  goal_prompt         text,
  order_index         integer DEFAULT 0,
  condition_variable  text,
  condition_operator  text,
  condition_value     text,
  captured_variables  jsonb DEFAULT '[]'::jsonb,
  created_at          timestamp with time zone DEFAULT now(),
  client_id           uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.ai_control (
  remote_jid    text PRIMARY KEY,
  is_paused     boolean DEFAULT false,
  paused_until  timestamp with time zone,
  updated_at    timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_organizer_config (
  id                      integer PRIMARY KEY DEFAULT 1,
  enabled                 boolean DEFAULT false,
  api_key                 text,
  openrouter_api_key      text,
  gateway_base_url        text,
  gateway_api_key         text,
  gateway_fallback_model  text,
  gateway_endpoints       jsonb DEFAULT '[]'::jsonb,
  model                   text,
  provider                text DEFAULT 'Gemini'::text,
  execution_hour          integer DEFAULT 20,
  last_run                timestamp with time zone,
  app_url                 text,
  updated_at              timestamp with time zone DEFAULT now()
);
-- Idempotente: bancos antigos ganham as colunas novas sem recriar a tabela.
ALTER TABLE public.ai_organizer_config ADD COLUMN IF NOT EXISTS openrouter_api_key text;
-- Gateway de Assinatura (proxy OpenAI-compatible da sua conta — ex: CLIProxyAPI):
--   gateway_base_url       = URL do proxy local (ex: http://127.0.0.1:8317/v1)
--   gateway_api_key        = management key opcional do proxy
--   gateway_fallback_model = modelRef de reserva (API key) se o gateway cair
ALTER TABLE public.ai_organizer_config ADD COLUMN IF NOT EXISTS gateway_base_url text;
ALTER TABLE public.ai_organizer_config ADD COLUMN IF NOT EXISTS gateway_api_key text;
ALTER TABLE public.ai_organizer_config ADD COLUMN IF NOT EXISTS gateway_fallback_model text;
-- gateway_endpoints = lista JSON de conexões (várias contas: Gemini, Claude,
-- ChatGPT). Cada item: {id, label, base_url, api_key}. Os campos single acima
-- viram a 1ª conexão (retrocompat). gateway_fallback_model continua global.
ALTER TABLE public.ai_organizer_config ADD COLUMN IF NOT EXISTS gateway_endpoints jsonb DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS public.ai_organizer_runs (
  id              BIGSERIAL PRIMARY KEY,
  batch_id        uuid,
  triggered_by    text NOT NULL DEFAULT 'manual'::text,
  started_at      timestamp with time zone NOT NULL DEFAULT now(),
  finished_at     timestamp with time zone,
  duration_ms     integer,
  model           text,
  provider        text,
  chats_analyzed  integer DEFAULT 0,
  leads_moved     integer DEFAULT 0,
  status          text NOT NULL DEFAULT 'running'::text,
  error           text,
  summary         text,
  client_id       uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.ai_pricing_cache (
  key         text PRIMARY KEY,
  payload     jsonb NOT NULL,
  fetched_at  timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_token_usage (
  id                 BIGSERIAL PRIMARY KEY,
  source             text NOT NULL,
  source_id          text,
  source_label       text,
  model              text,
  provider           text DEFAULT 'Gemini'::text,
  prompt_tokens      integer DEFAULT 0,
  completion_tokens  integer DEFAULT 0,
  total_tokens       integer DEFAULT 0,
  cost_usd           numeric(12,8) DEFAULT 0,
  metadata           jsonb DEFAULT '{}'::jsonb,
  created_at         timestamp with time zone DEFAULT now(),
  client_id          uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.app_settings (
  key         text PRIMARY KEY,
  value       text,
  updated_at  timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.appointments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL,
  agent_id          integer,
  lead_id           integer,
  remote_jid        text NOT NULL,
  instance_name     text,
  google_event_id   text,
  calendar_id       text DEFAULT 'primary'::text,
  title             text NOT NULL,
  description       text,
  service_name      text,
  start_at          timestamp with time zone NOT NULL,
  end_at            timestamp with time zone NOT NULL,
  status            text NOT NULL DEFAULT 'confirmed'::text,
  reminders_sent    jsonb DEFAULT '[]'::jsonb,
  created_by        text NOT NULL DEFAULT 'ia'::text,
  metadata          jsonb DEFAULT '{}'::jsonb,
  cancelled_reason  text,
  cancelled_at      timestamp with time zone,
  completed_at      timestamp with time zone,
  created_at        timestamp with time zone NOT NULL DEFAULT now(),
  updated_at        timestamp with time zone NOT NULL DEFAULT now(),
  location          text,
  attendees         jsonb DEFAULT '[]'::jsonb,
  all_day           boolean NOT NULL DEFAULT false,
  visibility        text DEFAULT 'default'::text,
  color_id          text,
  html_link         text,
  conference_data   jsonb,
  recurrence        text[],
  organizer_email   text
);

CREATE TABLE IF NOT EXISTS public.auth_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL,
  impersonated_as  uuid,
  token_hash       text NOT NULL UNIQUE,
  user_agent       text,
  ip               text,
  expires_at       timestamp with time zone NOT NULL,
  revoked_at       timestamp with time zone,
  created_at       timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.automation_logs (
  id             BIGSERIAL PRIMARY KEY,
  automation_id  uuid NOT NULL,
  kind           text NOT NULL DEFAULT 'state'::text,
  level          text NOT NULL DEFAULT 'info'::text,
  message        text NOT NULL,
  remote_jid     text,
  metadata       jsonb DEFAULT '{}'::jsonb,
  created_at     timestamp with time zone DEFAULT now(),
  client_id      uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.automations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                       text NOT NULL,
  agent_id                   integer,
  instance_name              text NOT NULL,
  niches                     jsonb NOT NULL DEFAULT '[]'::jsonb,
  regions                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  scrape_filters             jsonb DEFAULT '{}'::jsonb,
  scrape_max_leads           integer DEFAULT 200,
  dispatch_template          text,
  dispatch_min_interval      integer NOT NULL DEFAULT 60,
  dispatch_max_interval      integer NOT NULL DEFAULT 180,
  dispatch_personalize       boolean DEFAULT false,
  dispatch_ai_model          text,
  dispatch_ai_prompt         text,
  followup_steps             jsonb NOT NULL DEFAULT '[]'::jsonb,
  followup_min_interval      integer NOT NULL DEFAULT 60,
  followup_max_interval      integer NOT NULL DEFAULT 240,
  followup_ai_enabled        boolean DEFAULT false,
  followup_ai_model          text,
  followup_ai_prompt         text,
  allowed_start_hour         integer NOT NULL DEFAULT 9,
  allowed_end_hour           integer NOT NULL DEFAULT 20,
  phase                      text NOT NULL DEFAULT 'idle'::text,
  status                     text NOT NULL DEFAULT 'draft'::text,
  campaign_id                uuid,
  followup_campaign_id       uuid,
  scraped_count              integer DEFAULT 0,
  last_error                 text,
  last_error_at              timestamp with time zone,
  started_at                 timestamp with time zone,
  finished_at                timestamp with time zone,
  scrape_finished_at         timestamp with time zone,
  dispatch_finished_at       timestamp with time zone,
  created_at                 timestamp with time zone DEFAULT now(),
  updated_at                 timestamp with time zone DEFAULT now(),
  followup_enabled           boolean DEFAULT true,
  lead_intelligence_enabled  boolean DEFAULT false,
  client_id                  uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.campaign_logs (
  id           BIGSERIAL PRIMARY KEY,
  campaign_id  uuid NOT NULL,
  message      text NOT NULL,
  level        text NOT NULL DEFAULT 'info'::text,
  created_at   timestamp with time zone DEFAULT now(),
  client_id    uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.campaign_targets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       uuid NOT NULL,
  remote_jid        text NOT NULL,
  nome_negocio      text,
  ramo_negocio      text,
  next_send_at      timestamp with time zone,
  status            text NOT NULL DEFAULT 'pending'::text,
  message_id        text,
  rendered_message  text,
  ai_input          text,
  error_message     text,
  attempts          integer DEFAULT 0,
  sent_at           timestamp with time zone,
  created_at        timestamp with time zone DEFAULT now(),
  client_id         uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.campaigns (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                       text NOT NULL,
  instance_name              text NOT NULL,
  agent_id                   integer,
  message_template           text NOT NULL,
  min_interval_seconds       integer NOT NULL DEFAULT 60,
  max_interval_seconds       integer NOT NULL DEFAULT 180,
  allowed_start_hour         integer DEFAULT 9,
  allowed_end_hour           integer DEFAULT 20,
  status                     text NOT NULL DEFAULT 'draft'::text,
  total_targets              integer DEFAULT 0,
  sent_count                 integer DEFAULT 0,
  failed_count               integer DEFAULT 0,
  skipped_count              integer DEFAULT 0,
  personalize_with_ai        boolean DEFAULT false,
  use_web_search             boolean DEFAULT false,
  ai_model                   text,
  ai_prompt                  text,
  last_error                 text,
  last_error_at              timestamp with time zone,
  started_at                 timestamp with time zone,
  finished_at                timestamp with time zone,
  created_at                 timestamp with time zone DEFAULT now(),
  updated_at                 timestamp with time zone DEFAULT now(),
  automation_id              uuid,
  lead_intelligence_enabled  boolean DEFAULT false,
  client_id                  uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.channel_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         text NOT NULL DEFAULT 'evolution_go'::text,
  instance_name    text NOT NULL UNIQUE,
  agent_id         integer,
  status           text DEFAULT 'disconnected'::text,
  provider_config  jsonb DEFAULT '{}'::jsonb,
  created_at       timestamp with time zone DEFAULT now(),
  client_id        uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.chat_buffers (
  remote_jid     text NOT NULL,
  instance_name  text NOT NULL,
  expires_at     timestamp with time zone NOT NULL,
  created_at     timestamp with time zone DEFAULT now(),
  client_id      uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  PRIMARY KEY (remote_jid, instance_name)
);

CREATE TABLE IF NOT EXISTS public.chats_dashboard (
  id                 BIGSERIAL PRIMARY KEY,
  remote_jid         text NOT NULL,
  instance_name      text NOT NULL DEFAULT 'sdr'::text,
  message_id         text UNIQUE,
  sender_type        text NOT NULL DEFAULT 'customer'::text,
  content            text,
  status_envio       text,
  is_from_me         boolean DEFAULT (sender_type = ANY (ARRAY['ai'::text, 'human'::text])),
  media_url          text,
  media_type         text,
  mimetype           text,
  message_type       text,
  quoted_id          text,
  quoted_text        text,
  created_at         timestamp with time zone DEFAULT now(),
  contact_name       text,
  profile_pic_url    text,
  last_message       text,
  last_message_time  timestamp with time zone,
  unread_count       integer DEFAULT 0,
  status             text DEFAULT 'bot_active'::text,
  agent_id           integer,
  updated_at         timestamp with time zone DEFAULT now(),
  file_name          text,
  client_id          uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.clients (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  email                     text NOT NULL UNIQUE,
  password_hash             text,
  is_admin                  boolean NOT NULL DEFAULT false,
  is_active                 boolean NOT NULL DEFAULT true,
  default_ai_model          text,
  features                  jsonb NOT NULL DEFAULT '{"chat": true, "leads": true, "agente": true, "tokens": true, "disparo": true, "captador": true, "followup": true, "whatsapp": true, "automacao": true, "dashboard": true, "historico": true, "inteligencia": true, "configuracoes": true}'::jsonb,
  organizer_prompt          text,
  notes                     text,
  created_at                timestamp with time zone DEFAULT now(),
  updated_at                timestamp with time zone DEFAULT now(),
  organizer_enabled         boolean NOT NULL DEFAULT true,
  organizer_execution_hour  integer NOT NULL DEFAULT 20,
  organizer_last_run        timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.contacts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  remote_jid             text NOT NULL UNIQUE,
  phone_number           text,
  nome_negocio           text,
  push_name              text,
  created_at             timestamp with time zone DEFAULT now(),
  profile_pic_url        text,
  profile_pic_fetched_at timestamp with time zone,
  profile_pic            text,
  lead_id                integer,
  tags                   text[] DEFAULT '{}'::text[],
  notes                  text,
  updated_at             timestamp with time zone DEFAULT now(),
  client_id              uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.followup_campaigns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  instance_name         text NOT NULL,
  ai_enabled            boolean DEFAULT false,
  ai_model              text,
  ai_prompt             text,
  steps                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  min_interval_seconds  integer NOT NULL DEFAULT 60,
  max_interval_seconds  integer NOT NULL DEFAULT 240,
  allowed_start_hour    integer DEFAULT 9,
  allowed_end_hour      integer DEFAULT 20,
  auto_execute          boolean DEFAULT false,
  status                text NOT NULL DEFAULT 'draft'::text,
  total_enrolled        integer DEFAULT 0,
  total_sent            integer DEFAULT 0,
  total_responded       integer DEFAULT 0,
  total_exhausted       integer DEFAULT 0,
  last_error            text,
  last_error_at         timestamp with time zone,
  created_at            timestamp with time zone DEFAULT now(),
  updated_at            timestamp with time zone DEFAULT now(),
  client_id             uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.followup_logs (
  id                    BIGSERIAL PRIMARY KEY,
  followup_campaign_id  uuid NOT NULL,
  message               text NOT NULL,
  level                 text NOT NULL DEFAULT 'info'::text,
  created_at            timestamp with time zone DEFAULT now(),
  client_id             uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.followup_targets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  followup_campaign_id  uuid NOT NULL,
  lead_id               integer,
  remote_jid            text NOT NULL,
  nome_negocio          text,
  ramo_negocio          text,
  current_step          integer NOT NULL DEFAULT 0,
  last_sent_at          timestamp with time zone,
  next_send_at          timestamp with time zone,
  status                text NOT NULL DEFAULT 'pending'::text,
  last_message_id       text,
  last_rendered         text,
  ai_input              text,
  error_message         text,
  created_at            timestamp with time zone DEFAULT now(),
  updated_at            timestamp with time zone DEFAULT now(),
  client_id             uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.historico_ia_leads (
  id            BIGSERIAL PRIMARY KEY,
  remote_jid    text,
  nome_negocio  text,
  status_antigo text,
  status_novo   text,
  razao         text,
  resumo        text,
  batch_id      text,
  created_at    timestamp with time zone DEFAULT now(),
  client_id     uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.kanban_columns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL,
  status_key   text NOT NULL,
  label        text NOT NULL,
  color        text,
  order_index  integer NOT NULL DEFAULT 0,
  is_system    boolean NOT NULL DEFAULT false,
  is_terminal  boolean NOT NULL DEFAULT false,
  created_at   timestamp with time zone DEFAULT now(),
  updated_at   timestamp with time zone DEFAULT now(),
  UNIQUE (client_id, status_key)
);

CREATE TABLE IF NOT EXISTS public.leads_extraidos (
  id                       BIGSERIAL PRIMARY KEY,
  "remoteJid"              text UNIQUE,
  nome_negocio             text,
  ramo_negocio             text,
  status                   text DEFAULT 'novo'::text,
  instance_name            text DEFAULT 'sdr'::text,
  justificativa_ia         text,
  resumo_ia                text,
  ia_last_analyzed_at      timestamp with time zone,
  primeiro_contato_at      timestamp with time zone,
  primeiro_contato_source  text,
  telefone                 text,
  endereco                 text,
  avaliacao                numeric,
  reviews                  integer,
  website                  text,
  categoria                text,
  created_at               timestamp with time zone DEFAULT now(),
  updated_at               timestamp with time zone DEFAULT now(),
  icp_score                integer,
  lead_type                text,
  intelligence             jsonb,
  intelligence_at          timestamp with time zone,
  instagram                text,
  facebook                 text,
  rating                   numeric,
  next_follow_up           timestamp with time zone,
  current_stage_index      integer DEFAULT 0,
  client_id                uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  last_analysis_hash       text,
  last_analysis_at         timestamp with time zone,
  email                    text,
  observacoes              text
);

CREATE TABLE IF NOT EXISTS public.messages (
  id              BIGSERIAL PRIMARY KEY,
  session_id      uuid,
  message_id      text UNIQUE,
  sender          text NOT NULL DEFAULT 'customer'::text,
  content         text,
  media_category  text,
  media_url       text,
  mimetype        text,
  file_name       text,
  file_size       bigint,
  base64_content  text,
  delivery_status text,
  quoted_msg_id   text,
  quoted_text     text,
  raw_payload     jsonb,
  created_at      timestamp with time zone DEFAULT now(),
  chat_id         bigint,
  remote_jid      text,
  text            text,
  is_from_me      boolean DEFAULT false,
  status          text,
  "timestamp"     timestamp with time zone DEFAULT now(),
  instance_name   text DEFAULT 'sdr'::text,
  media_type      text,
  media_mimetype  text,
  context_info    jsonb DEFAULT '{}'::jsonb,
  client_id       uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        uuid,
  instance_name     text NOT NULL DEFAULT 'sdr'::text,
  agent_id          integer,
  bot_status        text DEFAULT 'bot_active'::text,
  last_message_at   timestamp with time zone,
  variables         jsonb DEFAULT '{}'::jsonb,
  unread_count      integer DEFAULT 0,
  paused_by         text,
  paused_at         timestamp with time zone,
  resume_at         timestamp with time zone,
  created_at        timestamp with time zone DEFAULT now(),
  current_stage_id  uuid,
  current_stage     text,
  updated_at        timestamp with time zone DEFAULT now(),
  client_id         uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  UNIQUE (contact_id, instance_name)
);

CREATE TABLE IF NOT EXISTS public.webhook_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_name  text,
  event          text,
  payload        jsonb,
  created_at     timestamp with time zone DEFAULT now(),
  client_id      uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

-- Backup duplo de contas conectadas (gateway OAuth + DeepSeek tokens). O código
-- salva aqui após cada login/mudança e restaura pro FS no boot do proxy.
-- Assim as contas sobrevivem a redeploys mesmo sem volume no Easypanel.
CREATE TABLE IF NOT EXISTS public.provider_credentials (
  id          text PRIMARY KEY,
  provider    text NOT NULL,
  content     jsonb NOT NULL,
  label       text,
  paused      boolean DEFAULT false,
  created_at  timestamp with time zone DEFAULT now(),
  updated_at  timestamp with time zone DEFAULT now()
);

-- =====================================================================
-- CONSTRAINTS COMPOSTAS / UNIQUE (idempotente via DO blocks)
-- =====================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_campaign_target') THEN
    ALTER TABLE public.campaign_targets ADD CONSTRAINT uq_campaign_target UNIQUE (campaign_id, remote_jid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_followup_target') THEN
    ALTER TABLE public.followup_targets ADD CONSTRAINT uq_followup_target UNIQUE (followup_campaign_id, remote_jid);
  END IF;
END $$;

-- =====================================================================
-- ÍNDICES
-- =====================================================================

-- agent_knowledge / chunks
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_client              ON public.agent_knowledge        USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_chunks_agent_id     ON public.agent_knowledge_chunks USING btree (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_chunks_knowledge_id ON public.agent_knowledge_chunks USING btree (knowledge_id);
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_chunks_embedding_hnsw ON public.agent_knowledge_chunks USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64');

-- agents
CREATE INDEX IF NOT EXISTS idx_agent_settings_client ON public.agent_settings USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_agent_stages_client   ON public.agent_stages   USING btree (client_id);

-- AI organizer / tokens
CREATE INDEX IF NOT EXISTS idx_ai_organizer_runs_client  ON public.ai_organizer_runs USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_ai_organizer_runs_started ON public.ai_organizer_runs USING btree (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_token_usage_client     ON public.ai_token_usage    USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_ai_token_usage_created    ON public.ai_token_usage    USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_created       ON public.ai_token_usage    USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_day           ON public.ai_token_usage    USING btree ((((created_at AT TIME ZONE 'UTC'::text))::date));
CREATE INDEX IF NOT EXISTS idx_token_usage_source        ON public.ai_token_usage    USING btree (source, source_id);

-- appointments
CREATE INDEX IF NOT EXISTS idx_appointments_agent_start  ON public.appointments USING btree (agent_id, start_at);
CREATE INDEX IF NOT EXISTS idx_appointments_client_start ON public.appointments USING btree (client_id, start_at);
CREATE INDEX IF NOT EXISTS idx_appointments_remote_jid   ON public.appointments USING btree (remote_jid);
CREATE INDEX IF NOT EXISTS idx_appointments_status_start ON public.appointments USING btree (status, start_at);
CREATE UNIQUE INDEX IF NOT EXISTS appointments_google_event_id_unique ON public.appointments USING btree (google_event_id) WHERE (google_event_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS appointments_no_overlap             ON public.appointments USING btree (agent_id, start_at) WHERE ((agent_id IS NOT NULL) AND (status = ANY (ARRAY['confirmed'::text, 'tentative'::text])));

-- auth
CREATE INDEX IF NOT EXISTS idx_auth_sessions_client ON public.auth_sessions USING btree (client_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token  ON public.auth_sessions USING btree (token_hash) WHERE (revoked_at IS NULL);

-- automations
CREATE INDEX IF NOT EXISTS idx_automation_logs_automation ON public.automation_logs USING btree (automation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_logs_client     ON public.automation_logs USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_automations_client         ON public.automations     USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_automations_status         ON public.automations     USING btree (status, phase);

-- campaigns / targets
CREATE INDEX IF NOT EXISTS idx_campaign_logs_campaign    ON public.campaign_logs    USING btree (campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_campaign_logs_client      ON public.campaign_logs    USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_campaign_targets_campaign ON public.campaign_targets USING btree (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_targets_client   ON public.campaign_targets USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_campaign_targets_status   ON public.campaign_targets USING btree (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_campaigns_automation      ON public.campaigns        USING btree (automation_id) WHERE (automation_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_campaigns_client          ON public.campaigns        USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status          ON public.campaigns        USING btree (status);

-- channel_connections
CREATE INDEX IF NOT EXISTS idx_channel_connections_client ON public.channel_connections USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_channel_provider_phone_id  ON public.channel_connections USING btree (((provider_config ->> 'phone_number_id'::text))) WHERE (provider = 'whatsapp_cloud'::text);

-- chat / chats_dashboard
CREATE INDEX IF NOT EXISTS idx_chat_buffers_client             ON public.chat_buffers    USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_chats_dashboard_client          ON public.chats_dashboard USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_chats_dashboard_client_created  ON public.chats_dashboard USING btree (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_dashboard_client_inst_jid ON public.chats_dashboard USING btree (client_id, instance_name, remote_jid);
CREATE INDEX IF NOT EXISTS idx_chats_dashboard_jid_created     ON public.chats_dashboard USING btree (remote_jid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_instance                  ON public.chats_dashboard USING btree (instance_name);
CREATE INDEX IF NOT EXISTS idx_chats_remote_jid                ON public.chats_dashboard USING btree (remote_jid, created_at DESC);

-- clients
CREATE INDEX IF NOT EXISTS idx_clients_email     ON public.clients USING btree (email);
CREATE INDEX IF NOT EXISTS idx_clients_is_active ON public.clients USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_clients_is_admin  ON public.clients USING btree (is_admin);

-- contacts
CREATE INDEX IF NOT EXISTS idx_contacts_client ON public.contacts USING btree (client_id);

-- followup
CREATE INDEX IF NOT EXISTS idx_followup_campaigns_client    ON public.followup_campaigns USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_followup_campaigns_status    ON public.followup_campaigns USING btree (status);
CREATE INDEX IF NOT EXISTS idx_followup_logs_campaign       ON public.followup_logs      USING btree (followup_campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_followup_logs_client         ON public.followup_logs      USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_followup_targets_camp_status ON public.followup_targets   USING btree (followup_campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_followup_targets_campaign    ON public.followup_targets   USING btree (followup_campaign_id);
CREATE INDEX IF NOT EXISTS idx_followup_targets_client      ON public.followup_targets   USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_followup_targets_next        ON public.followup_targets   USING btree (followup_campaign_id, status, next_send_at);

-- historico
CREATE INDEX IF NOT EXISTS idx_historico_ia_created      ON public.historico_ia_leads USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_historico_ia_jid_created  ON public.historico_ia_leads USING btree (remote_jid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_historico_ia_leads_client ON public.historico_ia_leads USING btree (client_id);

-- kanban
CREATE INDEX IF NOT EXISTS idx_kanban_columns_client ON public.kanban_columns USING btree (client_id, order_index);

-- leads_extraidos
CREATE INDEX IF NOT EXISTS idx_leads_extraidos_client         ON public.leads_extraidos USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_leads_extraidos_client_created ON public.leads_extraidos USING btree (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_extraidos_client_email   ON public.leads_extraidos USING btree (client_id, email) WHERE (email IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_leads_extraidos_client_status  ON public.leads_extraidos USING btree (client_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_extraidos_remotejid      ON public.leads_extraidos USING btree ("remoteJid");
CREATE INDEX IF NOT EXISTS idx_leads_icp_score                ON public.leads_extraidos USING btree (icp_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_leads_lead_type                ON public.leads_extraidos USING btree (lead_type);
CREATE INDEX IF NOT EXISTS idx_leads_primeiro_contato_source  ON public.leads_extraidos USING btree (status, primeiro_contato_source, primeiro_contato_at) WHERE (status = 'primeiro_contato'::text);
CREATE INDEX IF NOT EXISTS idx_leads_remotejid                ON public.leads_extraidos USING btree ("remoteJid");
CREATE INDEX IF NOT EXISTS idx_leads_status                   ON public.leads_extraidos USING btree (status);

-- messages / sessions
CREATE INDEX IF NOT EXISTS idx_messages_client          ON public.messages USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_messages_session         ON public.messages USING btree (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON public.messages USING btree (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_client          ON public.sessions USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_sessions_contact_inst    ON public.sessions USING btree (contact_id, instance_name);

-- webhook_logs
CREATE INDEX IF NOT EXISTS idx_webhook_logs_client  ON public.webhook_logs USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created ON public.webhook_logs USING btree (created_at DESC);

-- =====================================================================
-- FOREIGN KEYS (idempotente — só adiciona se não existir)
-- =====================================================================
DO $$ BEGIN
  -- agent_settings ← clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_settings_client_id_fkey') THEN
    ALTER TABLE public.agent_settings ADD CONSTRAINT agent_settings_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- agent_knowledge ← agent_settings, clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_knowledge_agent_id_fkey') THEN
    ALTER TABLE public.agent_knowledge ADD CONSTRAINT agent_knowledge_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agent_settings(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_knowledge_client_id_fkey') THEN
    ALTER TABLE public.agent_knowledge ADD CONSTRAINT agent_knowledge_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- agent_knowledge_chunks ← agent_knowledge, agent_settings
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_knowledge_chunks_knowledge_id_fkey') THEN
    ALTER TABLE public.agent_knowledge_chunks ADD CONSTRAINT agent_knowledge_chunks_knowledge_id_fkey FOREIGN KEY (knowledge_id) REFERENCES public.agent_knowledge(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_knowledge_chunks_agent_id_fkey') THEN
    ALTER TABLE public.agent_knowledge_chunks ADD CONSTRAINT agent_knowledge_chunks_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agent_settings(id) ON DELETE CASCADE;
  END IF;

  -- agent_stages ← agent_settings, clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_stages_agent_id_fkey') THEN
    ALTER TABLE public.agent_stages ADD CONSTRAINT agent_stages_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agent_settings(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_stages_client_id_fkey') THEN
    ALTER TABLE public.agent_stages ADD CONSTRAINT agent_stages_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- ai_organizer_runs ← clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_organizer_runs_client_id_fkey') THEN
    ALTER TABLE public.ai_organizer_runs ADD CONSTRAINT ai_organizer_runs_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- ai_token_usage ← clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_token_usage_client_id_fkey') THEN
    ALTER TABLE public.ai_token_usage ADD CONSTRAINT ai_token_usage_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- appointments ← clients, agent_settings, leads_extraidos
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_client_id_fkey') THEN
    ALTER TABLE public.appointments ADD CONSTRAINT appointments_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_agent_id_fkey') THEN
    ALTER TABLE public.appointments ADD CONSTRAINT appointments_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agent_settings(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_lead_id_fkey') THEN
    ALTER TABLE public.appointments ADD CONSTRAINT appointments_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads_extraidos(id) ON DELETE SET NULL;
  END IF;

  -- auth_sessions ← clients (próprio + impersonação)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_sessions_client_id_fkey') THEN
    ALTER TABLE public.auth_sessions ADD CONSTRAINT auth_sessions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_sessions_impersonated_as_fkey') THEN
    ALTER TABLE public.auth_sessions ADD CONSTRAINT auth_sessions_impersonated_as_fkey FOREIGN KEY (impersonated_as) REFERENCES public.clients(id) ON DELETE SET NULL;
  END IF;

  -- automations ← agent_settings, clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automations_agent_id_fkey') THEN
    ALTER TABLE public.automations ADD CONSTRAINT automations_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agent_settings(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automations_client_id_fkey') THEN
    ALTER TABLE public.automations ADD CONSTRAINT automations_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- automation_logs ← automations, clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_logs_automation_id_fkey') THEN
    ALTER TABLE public.automation_logs ADD CONSTRAINT automation_logs_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES public.automations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_logs_client_id_fkey') THEN
    ALTER TABLE public.automation_logs ADD CONSTRAINT automation_logs_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- campaigns ← agent_settings, clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_agent_id_fkey') THEN
    ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agent_settings(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_client_id_fkey') THEN
    ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- campaign_targets ← campaigns, clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_targets_campaign_id_fkey') THEN
    ALTER TABLE public.campaign_targets ADD CONSTRAINT campaign_targets_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_targets_client_id_fkey') THEN
    ALTER TABLE public.campaign_targets ADD CONSTRAINT campaign_targets_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- campaign_logs ← campaigns, clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_logs_campaign_id_fkey') THEN
    ALTER TABLE public.campaign_logs ADD CONSTRAINT campaign_logs_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_logs_client_id_fkey') THEN
    ALTER TABLE public.campaign_logs ADD CONSTRAINT campaign_logs_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- channel_connections ← agent_settings, clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channel_connections_agent_id_fkey') THEN
    ALTER TABLE public.channel_connections ADD CONSTRAINT channel_connections_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agent_settings(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channel_connections_client_id_fkey') THEN
    ALTER TABLE public.channel_connections ADD CONSTRAINT channel_connections_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- chat_buffers ← clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_buffers_client_id_fkey') THEN
    ALTER TABLE public.chat_buffers ADD CONSTRAINT chat_buffers_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- chats_dashboard ← clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chats_dashboard_client_id_fkey') THEN
    ALTER TABLE public.chats_dashboard ADD CONSTRAINT chats_dashboard_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- contacts ← clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_client_id_fkey') THEN
    ALTER TABLE public.contacts ADD CONSTRAINT contacts_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- followup_campaigns ← clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'followup_campaigns_client_id_fkey') THEN
    ALTER TABLE public.followup_campaigns ADD CONSTRAINT followup_campaigns_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- followup_targets ← followup_campaigns, clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'followup_targets_followup_campaign_id_fkey') THEN
    ALTER TABLE public.followup_targets ADD CONSTRAINT followup_targets_followup_campaign_id_fkey FOREIGN KEY (followup_campaign_id) REFERENCES public.followup_campaigns(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'followup_targets_client_id_fkey') THEN
    ALTER TABLE public.followup_targets ADD CONSTRAINT followup_targets_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- followup_logs ← followup_campaigns, clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'followup_logs_followup_campaign_id_fkey') THEN
    ALTER TABLE public.followup_logs ADD CONSTRAINT followup_logs_followup_campaign_id_fkey FOREIGN KEY (followup_campaign_id) REFERENCES public.followup_campaigns(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'followup_logs_client_id_fkey') THEN
    ALTER TABLE public.followup_logs ADD CONSTRAINT followup_logs_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- historico_ia_leads ← clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'historico_ia_leads_client_id_fkey') THEN
    ALTER TABLE public.historico_ia_leads ADD CONSTRAINT historico_ia_leads_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- kanban_columns ← clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kanban_columns_client_id_fkey') THEN
    ALTER TABLE public.kanban_columns ADD CONSTRAINT kanban_columns_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- leads_extraidos ← clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_extraidos_client_id_fkey') THEN
    ALTER TABLE public.leads_extraidos ADD CONSTRAINT leads_extraidos_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- messages ← sessions, chats_dashboard, clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_session_id_fkey') THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_chat_id_fkey') THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES public.chats_dashboard(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_client_id_fkey') THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- sessions ← contacts, agent_stages, clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_contact_id_fkey') THEN
    ALTER TABLE public.sessions ADD CONSTRAINT sessions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_current_stage_id_fkey') THEN
    ALTER TABLE public.sessions ADD CONSTRAINT sessions_current_stage_id_fkey FOREIGN KEY (current_stage_id) REFERENCES public.agent_stages(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_client_id_fkey') THEN
    ALTER TABLE public.sessions ADD CONSTRAINT sessions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;

  -- webhook_logs ← clients
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_logs_client_id_fkey') THEN
    ALTER TABLE public.webhook_logs ADD CONSTRAINT webhook_logs_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;
END $$;

-- =====================================================================
-- FIM
-- =====================================================================
`;
