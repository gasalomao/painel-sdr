// GERADO AUTOMATICAMENTE a partir de migrations/SETUP_COMPLETO.sql.
// Pra atualizar: edite migrations/SETUP_COMPLETO.sql e rode `node scripts/build-setup-sql.mjs`.
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
  embedding_model text,
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
  scheduler_config           jsonb DEFAULT '{"reminders": [{"message": "Oi {nome}! Lembrete: amanhã às {hora_agendamento} temos seu agendamento de {servico}. Confirma a presença?", "offset_minutes": 1440}, {"message": "Oi {nome}! Em 1h é o seu agendamento ({servico}). Te esperamos!", "offset_minutes": 60}], "calendar_id": "primary", "owner_phone": null, "notify_owner": false, "business_hours": {"tz": "America/Sao_Paulo", "end": "18:00", "days": [1, 2, 3, 4, 5, 6], "start": "09:00"}, "cancel_window_minutes": 120, "default_duration_minutes": 60, "auto_promote_kanban_after_minutes": 30}'::jsonb,
  disable_groups             boolean DEFAULT false,
  transcription_method      text DEFAULT 'auto'::text
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
  openrouter_keys         jsonb DEFAULT '[]'::jsonb,
  ai_combos               jsonb DEFAULT '[]'::jsonb,
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
ALTER TABLE public.ai_organizer_config ADD COLUMN IF NOT EXISTS openrouter_keys jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.ai_organizer_config ADD COLUMN IF NOT EXISTS ai_combos jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.ai_organizer_config ADD COLUMN IF NOT EXISTS nvidia_api_key text;

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
  dispatch_humanize          boolean NOT NULL DEFAULT false,
  dispatch_media_url         text,
  dispatch_media_type        text,
  dispatch_media_caption     text,
  dispatch_media_file_name   text,
  dispatch_media_mimetype    text,
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
  humanize_messages          boolean NOT NULL DEFAULT false,
  media_url                  text,
  media_type                 text,
  media_caption              text,
  media_file_name            text,
  media_mimetype             text,
  client_id                  uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
);

CREATE TABLE IF NOT EXISTS public.channel_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         text NOT NULL DEFAULT 'evolution'::text,
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
  message_id         text,
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
  remote_jid             text NOT NULL,
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
  humanize_messages     boolean NOT NULL DEFAULT false,
  media_url             text,
  media_type            text,
  media_caption         text,
  media_file_name       text,
  media_mimetype        text,
  source_status         text NOT NULL DEFAULT 'follow-up'::text,
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
  "remoteJid"              text,
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
  client_id                uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  last_analysis_hash       text,
  last_analysis_at         timestamp with time zone,
  email                    text,
  observacoes              text,
  -- ---- Captura profunda do Google Maps (Migration 009) ----
  reviews_detalhes         jsonb,
  business_details         jsonb,
  opening_hours            jsonb,
  attributes               jsonb,
  price_range              text,
  open_now                 text,
  photos                   jsonb,
  maps_url                 text,
  -- ---- Campos extras do painel de detalhe (Migration 011) ----
  place_id                 text,
  plus_code                text,
  lat                      numeric,
  lng                      numeric,
  cep                      text,
  distribuicao_estrelas    jsonb,
  -- ---- Captura estendida (Migration 012) — campos avançados do Maps ----
  business_status          text,
  claimed                  boolean,
  owner_name               text,
  year_established         text,
  total_photo_count        integer,
  review_topics            jsonb,
  featured_reviews         jsonb,
  additional_categories    jsonb,
  address_components       jsonb
);

CREATE TABLE IF NOT EXISTS public.messages (
  id              BIGSERIAL PRIMARY KEY,
  session_id      uuid,
  message_id      text,
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

ALTER TABLE public.agent_settings ADD COLUMN IF NOT EXISTS disable_groups boolean DEFAULT false;
ALTER TABLE public.agent_settings ADD COLUMN IF NOT EXISTS transcription_method text DEFAULT 'auto';
ALTER TABLE public.automations ADD COLUMN IF NOT EXISTS dispatch_humanize boolean NOT NULL DEFAULT false;
ALTER TABLE public.automations ADD COLUMN IF NOT EXISTS dispatch_media_url text;
ALTER TABLE public.automations ADD COLUMN IF NOT EXISTS dispatch_media_type text;
ALTER TABLE public.automations ADD COLUMN IF NOT EXISTS dispatch_media_caption text;
ALTER TABLE public.automations ADD COLUMN IF NOT EXISTS dispatch_media_file_name text;
ALTER TABLE public.automations ADD COLUMN IF NOT EXISTS dispatch_media_mimetype text;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS humanize_messages boolean NOT NULL DEFAULT false;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS media_url text;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS media_type text;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS media_caption text;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS media_file_name text;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS media_mimetype text;
ALTER TABLE public.followup_campaigns ADD COLUMN IF NOT EXISTS humanize_messages boolean NOT NULL DEFAULT false;
ALTER TABLE public.followup_campaigns ADD COLUMN IF NOT EXISTS media_url text;
ALTER TABLE public.followup_campaigns ADD COLUMN IF NOT EXISTS media_type text;
ALTER TABLE public.followup_campaigns ADD COLUMN IF NOT EXISTS media_caption text;
ALTER TABLE public.followup_campaigns ADD COLUMN IF NOT EXISTS media_file_name text;
ALTER TABLE public.followup_campaigns ADD COLUMN IF NOT EXISTS media_mimetype text;
ALTER TABLE public.followup_campaigns ADD COLUMN IF NOT EXISTS source_status text NOT NULL DEFAULT 'follow-up';

ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_remote_jid_key;
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_message_id_key;
ALTER TABLE public.chats_dashboard DROP CONSTRAINT IF EXISTS chats_dashboard_message_id_key;
INSERT INTO public.contacts (client_id, remote_jid, phone_number, push_name)
SELECT DISTINCT session.client_id, contact.remote_jid, contact.phone_number, contact.push_name
FROM public.sessions AS session
JOIN public.contacts AS contact ON contact.id = session.contact_id
WHERE session.client_id <> contact.client_id
  AND NOT EXISTS (
    SELECT 1 FROM public.contacts AS owned
    WHERE owned.client_id = session.client_id AND owned.remote_jid = contact.remote_jid
  );
INSERT INTO public.contacts (client_id, remote_jid, phone_number)
SELECT DISTINCT chat.client_id, chat.remote_jid,
  COALESCE(NULLIF(SPLIT_PART(chat.remote_jid, '@', 1), ''), chat.remote_jid)
FROM public.chats_dashboard AS chat
WHERE chat.remote_jid IS NOT NULL
  AND chat.remote_jid <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.contacts AS contact
    WHERE contact.client_id = chat.client_id AND contact.remote_jid = chat.remote_jid
  );
UPDATE public.sessions AS session
SET contact_id = owned.id
FROM public.contacts AS original
JOIN public.contacts AS owned ON owned.remote_jid = original.remote_jid
WHERE session.contact_id = original.id
  AND original.client_id <> session.client_id
  AND owned.client_id = session.client_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.contacts
    GROUP BY client_id, remote_jid
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'contacts contém remote_jid duplicado no mesmo tenant; faça merge antes de continuar';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.messages
    WHERE message_id IS NOT NULL
    GROUP BY client_id, message_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'messages contém message_id duplicado no mesmo tenant; faça merge antes de continuar';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.chats_dashboard
    WHERE message_id IS NOT NULL
    GROUP BY client_id, message_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'chats_dashboard contém message_id duplicado no mesmo tenant; faça merge antes de continuar';
  END IF;
END
$$;

REVOKE ALL ON TABLE public.clients FROM anon, authenticated;
REVOKE ALL ON TABLE public.auth_sessions FROM anon, authenticated;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;

-- =====================================================================
-- CONSTRAINTS COMPOSTAS / UNIQUE (idempotente via DO blocks)
-- =====================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_client_remote_jid_key') THEN
    ALTER TABLE public.contacts ADD CONSTRAINT contacts_client_remote_jid_key UNIQUE (client_id, remote_jid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_client_message_id_key') THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_client_message_id_key UNIQUE (client_id, message_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chats_dashboard_client_message_id_key') THEN
    ALTER TABLE public.chats_dashboard ADD CONSTRAINT chats_dashboard_client_message_id_key UNIQUE (client_id, message_id);
  END IF;
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

-- RPC pra busca vetorial (RAG). Sem essa função, o agente IA cai pra fallback
-- ILIKE que não entende sinônimos (cliente pergunta "celular" mas base tem
-- "smartphone"). Idempotente (CREATE OR REPLACE).
-- Threshold default 0.35 (threshold de runtime pode ser passado na chamada).
CREATE OR REPLACE FUNCTION public.match_knowledge_chunks(
  query_embedding vector(768),
  p_agent_id      INT,
  p_client_id     UUID DEFAULT NULL,
  match_count     INT  DEFAULT 5,
  min_similarity  FLOAT DEFAULT 0.35
)
RETURNS TABLE (
  id           UUID,
  knowledge_id UUID,
  title        TEXT,
  content      TEXT,
  chunk_index  INT,
  similarity   FLOAT
)
LANGUAGE sql STABLE AS $$
  SELECT
    c.id,
    c.knowledge_id,
    k.title,
    c.content,
    c.chunk_index,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.agent_knowledge_chunks c
  JOIN public.agent_knowledge k ON k.id = c.knowledge_id
  WHERE c.agent_id = p_agent_id
    AND (p_client_id IS NULL OR c.client_id = p_client_id)
    AND c.embedding IS NOT NULL
    AND (1 - (c.embedding <=> query_embedding)) >= min_similarity
  ORDER BY c.embedding <=> query_embedding ASC
  LIMIT match_count;
$$;
GRANT EXECUTE ON FUNCTION public.match_knowledge_chunks TO anon, authenticated, service_role;

-- Modelo de embeddings default do RAG. Sem isso, rag.ts usa fallback hard-coded
-- (gemini-embedding-001). INSERT ON CONFLICT pra ser idempotente.
INSERT INTO public.app_settings (key, value, updated_at)
VALUES ('rag_embedding_model', 'gemini-embedding-001', NOW())
ON CONFLICT (key) DO NOTHING;

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
UPDATE public.leads_extraidos AS lead
SET client_id = connection.client_id
FROM public.channel_connections AS connection
WHERE lead.client_id IS NULL
  AND lead.instance_name = connection.instance_name
  AND connection.client_id IS NOT NULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.leads_extraidos WHERE client_id IS NULL) THEN
    RAISE EXCEPTION 'leads_extraidos contém client_id nulo; corrija o ownership antes de continuar';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.leads_extraidos
    WHERE "remoteJid" IS NOT NULL
    GROUP BY client_id, "remoteJid"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'leads_extraidos contém remoteJid duplicado no mesmo tenant; faça merge antes de continuar';
  END IF;
END
$$;
ALTER TABLE public.leads_extraidos ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE public.leads_extraidos DROP CONSTRAINT IF EXISTS "leads_extraidos_remoteJid_key";
DROP INDEX IF EXISTS public.idx_leads_extraidos_client_remotejid;
CREATE UNIQUE INDEX idx_leads_extraidos_client_remotejid
  ON public.leads_extraidos USING btree (client_id, "remoteJid");
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


BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS website_leads_tenant_id ON public.leads_extraidos (client_id, id);

CREATE TABLE IF NOT EXISTS public.website_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  value jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(value) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.website_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.clients(id),
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'general',
  tags text[] NOT NULL DEFAULT '{}',
  priority integer NOT NULL DEFAULT 0,
  trigger_mode text NOT NULL DEFAULT 'manual' CHECK (trigger_mode IN ('always', 'automatic', 'manual')),
  is_enabled boolean NOT NULL DEFAULT true,
  is_builtin boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  UNIQUE (client_id, slug, version),
  CHECK (NOT is_builtin OR client_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS website_skills_global_version ON public.website_skills(slug, version) WHERE client_id IS NULL;

CREATE TABLE IF NOT EXISTS public.website_prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.clients(id),
  version integer NOT NULL CHECK (version > 0),
  prompt text NOT NULL,
  created_by uuid REFERENCES public.clients(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS website_prompts_global_version ON public.website_prompt_versions(version) WHERE client_id IS NULL;

CREATE TABLE IF NOT EXISTS public.website_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug text NOT NULL CHECK (length(slug) <= 80 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  lead_id bigint,
  client_context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(client_context) = 'object'),
  instructions text NOT NULL DEFAULT '',
  model_mode text NOT NULL DEFAULT 'auto' CHECK (model_mode IN ('auto', 'quality', 'economy', 'manual')),
  model_id text,
  selected_skill_ids uuid[] NOT NULL DEFAULT '{}',
  cta jsonb NOT NULL DEFAULT '{"type":"whatsapp","value":""}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  current_revision_id uuid,
  published_deployment_id uuid,
  published_url text,
  last_published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, lead_id) REFERENCES public.leads_extraidos(client_id, id) ON DELETE SET NULL (lead_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS website_projects_live_slug ON public.website_projects(client_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS website_projects_tenant_updated ON public.website_projects(client_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.website_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  project_id uuid NOT NULL,
  parent_id uuid,
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  files jsonb NOT NULL CHECK (jsonb_typeof(files) = 'object'),
  hash text NOT NULL,
  actor_id uuid NOT NULL REFERENCES public.clients(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, project_id, id),
  FOREIGN KEY (client_id, project_id) REFERENCES public.website_projects(client_id, id),
  FOREIGN KEY (client_id, project_id, parent_id) REFERENCES public.website_revisions(client_id, project_id, id)
);
CREATE INDEX IF NOT EXISTS website_revisions_history ON public.website_revisions(client_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.website_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL,
  path text NOT NULL UNIQUE,
  mime text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  width integer CHECK (width > 0),
  height integer CHECK (height > 0),
  purpose text NOT NULL DEFAULT 'content' CHECK (purpose IN ('content', 'logo', 'reference')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed', 'deleting')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, project_id, id),
  FOREIGN KEY (client_id, project_id) REFERENCES public.website_projects(client_id, id),
  CHECK (path LIKE client_id::text || '/' || project_id::text || '/%' AND path NOT LIKE '%..%')
);

CREATE TABLE IF NOT EXISTS public.website_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  project_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'planning', 'editing', 'validating', 'completed', 'failed', 'cancelled')),
  prompt text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 16000),
  model_id text,
  model_used text,
  base_revision_id uuid,
  asset_ids uuid[] NOT NULL DEFAULT '{}',
  error text,
  cancel_requested boolean NOT NULL DEFAULT false,
  lease_expires_at timestamptz,
  worker_id uuid,
  actor_id uuid NOT NULL REFERENCES public.clients(id),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, project_id, id),
  FOREIGN KEY (client_id, project_id) REFERENCES public.website_projects(client_id, id),
  FOREIGN KEY (client_id, project_id, base_revision_id) REFERENCES public.website_revisions(client_id, project_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS website_single_active_run ON public.website_runs(client_id, project_id)
  WHERE status IN ('queued', 'planning', 'editing', 'validating');
CREATE INDEX IF NOT EXISTS website_runs_queue ON public.website_runs(created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS website_runs_history ON public.website_runs(client_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.website_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL CHECK (length(content) <= 64000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, project_id) REFERENCES public.website_projects(client_id, id),
  FOREIGN KEY (client_id, project_id, run_id) REFERENCES public.website_runs(client_id, project_id, id)
);
CREATE INDEX IF NOT EXISTS website_messages_history ON public.website_messages(client_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.website_builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  project_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'failed', 'unconfigured')),
  success boolean NOT NULL DEFAULT false,
  logs text NOT NULL DEFAULT '',
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  artifact jsonb NOT NULL DEFAULT '{}'::jsonb,
  screenshots jsonb NOT NULL DEFAULT '{}'::jsonb,
  qa jsonb NOT NULL DEFAULT '{"passed":false,"errors":[],"warnings":[]}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, project_id, id),
  FOREIGN KEY (client_id, project_id) REFERENCES public.website_projects(client_id, id),
  FOREIGN KEY (client_id, project_id, revision_id) REFERENCES public.website_revisions(client_id, project_id, id)
);

CREATE TABLE IF NOT EXISTS public.website_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  project_id uuid NOT NULL,
  build_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'cloudflare',
  status text NOT NULL DEFAULT 'deploying' CHECK (status IN ('deploying', 'published', 'failed')),
  provider_id text,
  provider_version_id text,
  hostname text NOT NULL CHECK (length(hostname) <= 253 AND hostname = lower(hostname)),
  phase text NOT NULL DEFAULT 'reserved' CHECK (phase IN ('reserved', 'version_creating', 'version_ready', 'activating')),
  expected_revision_id uuid NOT NULL,
  rollback_id uuid,
  claim_id uuid,
  lease_expires_at timestamptz,
  url text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, project_id, id),
  FOREIGN KEY (client_id, project_id) REFERENCES public.website_projects(client_id, id),
  FOREIGN KEY (client_id, project_id, build_id) REFERENCES public.website_builds(client_id, project_id, id),
  FOREIGN KEY (client_id, project_id, expected_revision_id) REFERENCES public.website_revisions(client_id, project_id, id),
  FOREIGN KEY (client_id, project_id, rollback_id) REFERENCES public.website_deployments(client_id, project_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS website_single_active_deployment ON public.website_deployments(client_id, project_id)
  WHERE status = 'deploying';

CREATE TABLE IF NOT EXISTS public.website_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  project_id uuid NOT NULL,
  hostname text NOT NULL UNIQUE CHECK (hostname = lower(hostname)),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed')),
  provider_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, project_id) REFERENCES public.website_projects(client_id, id)
);

CREATE TABLE IF NOT EXISTS public.website_form_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  project_id uuid NOT NULL,
  deployment_id uuid,
  lead_id bigint,
  name text NOT NULL,
  email text,
  phone text,
  message text NOT NULL DEFAULT '',
  consent boolean NOT NULL CHECK (consent),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, project_id) REFERENCES public.website_projects(client_id, id),
  FOREIGN KEY (client_id, project_id, deployment_id) REFERENCES public.website_deployments(client_id, project_id, id),
  FOREIGN KEY (client_id, lead_id) REFERENCES public.leads_extraidos(client_id, id) ON DELETE SET NULL (lead_id)
);

CREATE TABLE IF NOT EXISTS public.website_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id),
  project_id uuid,
  run_id uuid,
  kind text NOT NULL CHECK (kind IN ('runs', 'builds', 'deploys', 'images', 'tokens', 'storage_bytes')),
  quantity bigint NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd numeric NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  model text,
  provider text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (run_id IS NULL OR project_id IS NOT NULL),
  FOREIGN KEY (client_id, project_id) REFERENCES public.website_projects(client_id, id),
  FOREIGN KEY (client_id, project_id, run_id) REFERENCES public.website_runs(client_id, project_id, id)
);
CREATE INDEX IF NOT EXISTS website_usage_period ON public.website_usage(client_id, kind, created_at);
ALTER TABLE public.website_usage
  ADD COLUMN IF NOT EXISTS reserved_tokens bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  ADD COLUMN IF NOT EXISTS settled_at timestamptz;

CREATE TABLE IF NOT EXISTS public.website_workers (
  id uuid PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS website_project_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'website_lead_project_fk' AND conrelid = 'public.leads_extraidos'::regclass) THEN
    ALTER TABLE public.leads_extraidos ADD CONSTRAINT website_lead_project_fk
      FOREIGN KEY (client_id, website_project_id) REFERENCES public.website_projects(client_id, id) ON DELETE SET NULL (website_project_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'website_project_current_revision_fk' AND conrelid = 'public.website_projects'::regclass) THEN
    ALTER TABLE public.website_projects ADD CONSTRAINT website_project_current_revision_fk
      FOREIGN KEY (client_id, id, current_revision_id) REFERENCES public.website_revisions(client_id, project_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'website_project_published_deployment_fk' AND conrelid = 'public.website_projects'::regclass) THEN
    ALTER TABLE public.website_projects ADD CONSTRAINT website_project_published_deployment_fk
      FOREIGN KEY (client_id, id, published_deployment_id) REFERENCES public.website_deployments(client_id, project_id, id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.website_immutable_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'website_immutable_snapshot';
END $$;
DROP TRIGGER IF EXISTS website_revisions_immutable ON public.website_revisions;
CREATE TRIGGER website_revisions_immutable BEFORE UPDATE OR DELETE ON public.website_revisions
  FOR EACH ROW EXECUTE FUNCTION public.website_immutable_snapshot();
DROP TRIGGER IF EXISTS website_prompts_immutable ON public.website_prompt_versions;
CREATE TRIGGER website_prompts_immutable BEFORE UPDATE OR DELETE ON public.website_prompt_versions
  FOR EACH ROW EXECUTE FUNCTION public.website_immutable_snapshot();

CREATE OR REPLACE FUNCTION public.website_check_project() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.name, NEW.slug, NEW.client_context, NEW.instructions, NEW.model_mode, NEW.model_id,
    NEW.selected_skill_ids, NEW.cta, NEW.current_revision_id, NEW.status, NEW.deleted_at) IS DISTINCT FROM
    (OLD.name, OLD.slug, OLD.client_context, OLD.instructions, OLD.model_mode, OLD.model_id,
    OLD.selected_skill_ids, OLD.cta, OLD.current_revision_id, OLD.status, OLD.deleted_at)
    AND EXISTS (SELECT 1 FROM public.website_deployments WHERE client_id = NEW.client_id AND project_id = NEW.id AND status = 'deploying') THEN
    RAISE EXCEPTION 'website_active_deployment';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(NEW.client_context) e WHERE
    e.key NOT IN ('name','segment','phone','whatsapp','website','city','address','description','services','notes')
    OR jsonb_typeof(e.value) <> 'string' OR length(e.value #>> '{}') > 4000) THEN
    RAISE EXCEPTION 'website_invalid_input';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.selected_skill_ids) sid WHERE NOT EXISTS (
    SELECT 1 FROM public.website_skills s WHERE s.id = sid AND (s.client_id = NEW.client_id OR s.client_id IS NULL)
  )) THEN RAISE EXCEPTION 'website_not_found'; END IF;
  IF NEW.model_mode = 'manual' AND nullif(NEW.model_id, '') IS NULL THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS website_project_validate ON public.website_projects;
CREATE TRIGGER website_project_validate BEFORE INSERT OR UPDATE ON public.website_projects
  FOR EACH ROW EXECUTE FUNCTION public.website_check_project();

CREATE OR REPLACE FUNCTION public.website_check_run_assets() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.asset_ids IS DISTINCT FROM OLD.asset_ids OR NEW.client_id <> OLD.client_id OR NEW.project_id <> OLD.project_id THEN
      RAISE EXCEPTION 'website_invalid_input';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.website_deployments WHERE client_id = NEW.client_id AND project_id = NEW.project_id AND status = 'deploying') THEN
    RAISE EXCEPTION 'website_active_deployment';
  END IF;
  IF cardinality(NEW.asset_ids) > 20 OR EXISTS (
    SELECT 1 FROM unnest(NEW.asset_ids) aid WHERE NOT EXISTS (
      SELECT 1 FROM public.website_assets a WHERE a.id = aid AND a.client_id = NEW.client_id AND a.project_id = NEW.project_id AND a.status = 'ready'
    )
  ) THEN RAISE EXCEPTION 'website_not_found'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS website_run_validate_assets ON public.website_runs;
CREATE TRIGGER website_run_validate_assets BEFORE INSERT OR UPDATE ON public.website_runs
  FOR EACH ROW EXECUTE FUNCTION public.website_check_run_assets();

CREATE OR REPLACE FUNCTION public.website_assert_access(p_client_id uuid, p_actor_id uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id = p_client_id AND is_active
    AND (is_admin OR features->'sites' = 'true'::jsonb)) THEN RAISE EXCEPTION 'website_forbidden'; END IF;
  IF p_actor_id IS NOT NULL AND p_actor_id <> p_client_id AND NOT EXISTS (
    SELECT 1 FROM public.clients WHERE id = p_actor_id AND is_active AND is_admin
  ) THEN RAISE EXCEPTION 'website_forbidden'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.website_consume_quota(p_client_id uuid, p_metric text, p_amount bigint DEFAULT 1, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS bigint
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_config jsonb;
  v_key text;
  v_limit bigint;
  v_default bigint;
  v_period timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_quantity bigint;
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_client_id::text, 0));
  SELECT value INTO v_config FROM public.website_settings WHERE id = 1;
  CASE p_metric
    WHEN 'runs' THEN v_key := 'max_runs_per_day'; v_default := 30;
    WHEN 'builds' THEN v_key := 'max_builds_per_day'; v_default := 20;
    WHEN 'deploys' THEN v_key := 'max_deploys_per_day'; v_default := 10;
    WHEN 'images' THEN v_key := 'max_images_per_day'; v_default := 0;
    WHEN 'tokens' THEN v_key := 'max_tokens_per_month'; v_default := 1000000;
      v_period := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    WHEN 'storage_bytes' THEN v_key := 'max_storage_mb'; v_default := 160; v_period := '-infinity';
    ELSE RAISE EXCEPTION 'website_invalid_input';
  END CASE;
  v_limit := coalesce((v_config->>v_key)::bigint, v_default);
  IF p_metric = 'storage_bytes' THEN v_limit := v_limit * 1024 * 1024; END IF;
  SELECT coalesce(sum(quantity), 0) INTO v_quantity FROM public.website_usage
    WHERE client_id = p_client_id AND kind = p_metric
      AND (created_at >= v_period OR (p_metric = 'tokens' AND reserved_tokens > 0 AND settled_at IS NULL));
  IF v_limit < 0 OR p_amount > v_limit OR v_quantity > v_limit - p_amount THEN RAISE EXCEPTION 'website_quota_exceeded'; END IF;
  INSERT INTO public.website_usage(client_id, kind, quantity, metadata) VALUES (p_client_id, p_metric, p_amount, coalesce(p_metadata, '{}'::jsonb));
  RETURN v_quantity + p_amount;
END $$;

CREATE OR REPLACE FUNCTION public.website_reserve_tokens(
  p_client_id uuid, p_project_id uuid, p_run_id uuid, p_worker_id uuid, p_reservation_id uuid, p_amount bigint
) RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_limit bigint;
  v_quantity bigint;
  v_period timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_reservation_id IS NULL OR p_worker_id IS NULL OR p_amount IS NULL OR p_amount <= 0
    OR p_amount > 9007199254740991 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  PERFORM 1 FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id
    AND deleted_at IS NULL AND status <> 'archived' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  PERFORM 1 FROM public.website_runs WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_run_id
    AND worker_id = p_worker_id AND lease_expires_at > now() AND NOT cancel_requested
    AND status IN ('planning','editing','validating') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_lease_lost'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_client_id::text, 0));
  SELECT coalesce((value->>'max_tokens_per_month')::bigint, 1000000) INTO v_limit FROM public.website_settings WHERE id = 1;
  v_limit := coalesce(v_limit, 1000000);
  SELECT coalesce(sum(quantity), 0) INTO v_quantity FROM public.website_usage
    WHERE client_id = p_client_id AND kind = 'tokens'
      AND (created_at >= v_period OR (reserved_tokens > 0 AND settled_at IS NULL));
  IF v_limit < 0 OR p_amount > v_limit OR v_quantity > v_limit - p_amount THEN RAISE EXCEPTION 'website_quota_exceeded'; END IF;
  INSERT INTO public.website_usage(id, client_id, project_id, run_id, kind, quantity, reserved_tokens, provider, metadata)
    VALUES (p_reservation_id, p_client_id, p_project_id, p_run_id, 'tokens', p_amount, p_amount, 'openrouter',
      jsonb_build_object('worker_id', p_worker_id));
  RETURN p_reservation_id;
END $$;

CREATE OR REPLACE FUNCTION public.website_settle_tokens(
  p_client_id uuid, p_project_id uuid, p_run_id uuid, p_worker_id uuid, p_reservation_id uuid,
  p_usage jsonb, p_model text, p_complete boolean
) RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_usage public.website_usage;
  v_input bigint := 0;
  v_output bigint := 0;
  v_total bigint := 0;
  v_value jsonb;
BEGIN
  IF p_worker_id IS NULL OR p_reservation_id IS NULL OR p_complete IS NULL
    OR p_model IS NULL OR length(p_model) NOT BETWEEN 1 AND 300
    OR (p_complete AND p_usage IS NULL) THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  IF p_usage IS NOT NULL THEN
    IF jsonb_typeof(p_usage) <> 'object' OR length(p_usage::text) > 32000 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
    FOREACH v_value IN ARRAY ARRAY[p_usage->'promptTokens', p_usage->'completionTokens', p_usage->'totalTokens'] LOOP
      IF v_value IS NULL OR jsonb_typeof(v_value) <> 'number' THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
      IF (v_value::text)::numeric < 0 OR (v_value::text)::numeric > 9007199254740991
        OR trunc((v_value::text)::numeric) <> (v_value::text)::numeric THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
    END LOOP;
    v_input := (p_usage->>'promptTokens')::bigint;
    v_output := (p_usage->>'completionTokens')::bigint;
    v_total := (p_usage->>'totalTokens')::bigint;
    IF v_total < v_input + v_output THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_client_id::text, 0));
  SELECT * INTO v_usage FROM public.website_usage WHERE id = p_reservation_id AND client_id = p_client_id
    AND project_id = p_project_id AND run_id = p_run_id AND kind = 'tokens' AND reserved_tokens > 0
    AND metadata->>'worker_id' = p_worker_id::text FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  IF v_usage.settled_at IS NOT NULL THEN
    IF p_complete AND v_usage.metadata->'usage' IS NOT DISTINCT FROM p_usage AND v_usage.model = p_model THEN
      RETURN p_reservation_id;
    END IF;
    RAISE EXCEPTION 'website_idempotency_conflict';
  END IF;
  IF v_input < v_usage.input_tokens OR v_output < v_usage.output_tokens
    OR v_total < coalesce((v_usage.metadata->'usage'->>'totalTokens')::bigint, 0) THEN
    RAISE EXCEPTION 'website_idempotency_conflict';
  END IF;
  UPDATE public.website_usage SET quantity = CASE WHEN p_complete THEN v_total ELSE greatest(quantity, v_total) END,
    input_tokens = v_input, output_tokens = v_output, model = p_model,
    settled_at = CASE WHEN p_complete THEN now() ELSE NULL END,
    metadata = metadata || jsonb_build_object('usage', p_usage, 'complete', p_complete)
    WHERE id = p_reservation_id;
  RETURN p_reservation_id;
END $$;

CREATE OR REPLACE FUNCTION public.website_reserve_images(
  p_client_id uuid, p_project_id uuid, p_reservation_id uuid, p_tokens bigint
) RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_config jsonb;
  v_limit bigint;
  v_images_limit bigint;
  v_quantity bigint;
  v_images_id uuid := gen_random_uuid();
  v_period timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_reservation_id IS NULL OR p_tokens IS NULL OR p_tokens <= 0
    OR p_tokens > 9007199254740991 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  PERFORM 1 FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id
    AND deleted_at IS NULL AND status <> 'archived' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  SELECT value INTO v_config FROM public.website_settings WHERE id = 1;
  IF NOT coalesce((v_config->>'image_generation_enabled')::boolean, false)
    OR coalesce((v_config->>'max_images_per_day')::bigint, 0) <= 0 THEN RAISE EXCEPTION 'website_forbidden'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_client_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.website_usage WHERE client_id = p_client_id AND kind = 'tokens'
    AND reserved_tokens > 0 AND settled_at IS NULL
    AND metadata ? 'images_row' AND created_at > now() - interval '15 minutes') THEN RAISE EXCEPTION 'website_quota_exceeded'; END IF;
  v_limit := coalesce((v_config->>'max_tokens_per_month')::bigint, 1000000);
  v_images_limit := coalesce((v_config->>'max_images_per_day')::bigint, 0);
  SELECT coalesce(sum(quantity), 0) INTO v_quantity FROM public.website_usage
    WHERE client_id = p_client_id AND kind = 'tokens'
      AND (created_at >= v_period OR (reserved_tokens > 0 AND settled_at IS NULL));
  IF v_limit < 0 OR v_limit > 9007199254740991 OR p_tokens > v_limit OR v_quantity > v_limit - p_tokens THEN
    RAISE EXCEPTION 'website_quota_exceeded';
  END IF;
  IF (SELECT coalesce(sum(quantity), 0) FROM public.website_usage
    WHERE client_id = p_client_id AND kind = 'images'
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') >= v_images_limit THEN
    RAISE EXCEPTION 'website_quota_exceeded';
  END IF;
  INSERT INTO public.website_usage(id, client_id, kind, quantity) VALUES (v_images_id, p_client_id, 'images', v_images_limit);
  INSERT INTO public.website_usage(id, client_id, project_id, kind, quantity, reserved_tokens, metadata)
    VALUES (p_reservation_id, p_client_id, p_project_id, 'tokens', p_tokens, p_tokens,
    jsonb_build_object('images_row', v_images_id));
  RETURN p_reservation_id;
END $$;

CREATE OR REPLACE FUNCTION public.website_settle_images(
  p_client_id uuid, p_project_id uuid, p_reservation_id uuid,
  p_images integer, p_usage jsonb, p_model text, p_complete boolean
) RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_reservation public.website_usage;
  v_images_id uuid;
  v_input bigint := 0;
  v_output bigint := 0;
  v_total bigint := 0;
  v_value jsonb;
BEGIN
  IF p_reservation_id IS NULL OR p_model IS NULL OR length(p_model) NOT BETWEEN 1 AND 300
    OR (p_images IS NOT NULL AND p_images NOT BETWEEN 1 AND 4) THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  IF p_usage IS NOT NULL THEN
    IF jsonb_typeof(p_usage) <> 'object' OR length(p_usage::text) > 32000 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
    FOREACH v_value IN ARRAY ARRAY[p_usage->'promptTokens', p_usage->'completionTokens', p_usage->'totalTokens'] LOOP
      IF v_value IS NULL OR jsonb_typeof(v_value) <> 'number' THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
      IF (v_value::text)::numeric < 0 OR (v_value::text)::numeric > 9007199254740991
        OR trunc((v_value::text)::numeric) <> (v_value::text)::numeric THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
    END LOOP;
    v_input := (p_usage->>'promptTokens')::bigint;
    v_output := (p_usage->>'completionTokens')::bigint;
    v_total := (p_usage->>'totalTokens')::bigint;
    IF v_total < v_input + v_output THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_client_id::text, 0));
  SELECT * INTO v_reservation FROM public.website_usage WHERE id = p_reservation_id AND client_id = p_client_id
    AND project_id = p_project_id AND kind = 'tokens' AND reserved_tokens > 0 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  IF v_reservation.settled_at IS NOT NULL THEN
    IF p_complete AND v_reservation.metadata->'usage' IS NOT DISTINCT FROM p_usage AND v_reservation.model = p_model
      AND (v_reservation.metadata->>'images')::int IS NOT DISTINCT FROM p_images THEN
      RETURN p_reservation_id;
    END IF;
    RAISE EXCEPTION 'website_idempotency_conflict';
  END IF;
  v_images_id := (v_reservation.metadata->>'images_row')::uuid;
  IF p_images IS NOT NULL THEN
    IF v_images_id IS NULL OR (SELECT quantity FROM public.website_usage WHERE id = v_images_id AND client_id = p_client_id AND kind = 'images') < p_images THEN
      RAISE EXCEPTION 'website_invalid_input';
    END IF;
    UPDATE public.website_usage SET quantity = p_images, settled_at = now()
      WHERE id = v_images_id AND client_id = p_client_id AND kind = 'images' AND settled_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  ELSE
    UPDATE public.website_usage SET quantity = 0, settled_at = now()
      WHERE id = v_images_id AND client_id = p_client_id AND kind = 'images' AND settled_at IS NULL;
  END IF;
  UPDATE public.website_usage SET quantity = CASE WHEN p_complete THEN v_total ELSE greatest(quantity, v_total) END,
    input_tokens = v_input, output_tokens = v_output, model = p_model,
    settled_at = CASE WHEN p_complete THEN now() ELSE NULL END,
    metadata = metadata || jsonb_build_object('usage', p_usage, 'complete', p_complete, 'images', p_images)
    WHERE id = p_reservation_id;
  RETURN p_reservation_id;
END $$;

CREATE OR REPLACE FUNCTION public.website_liquidate_run_reservations(p_client_id uuid, p_run_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_run_id IS NULL THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  UPDATE public.website_usage SET settled_at = now(),
    quantity = greatest(quantity, coalesce((metadata->'usage'->>'totalTokens')::bigint, 0))
    WHERE client_id = p_client_id AND run_id = p_run_id AND kind = 'tokens'
      AND reserved_tokens > 0 AND settled_at IS NULL;
END $$;

CREATE OR REPLACE FUNCTION public.website_reserve_asset(
  p_client_id uuid, p_project_id uuid, p_actor_id uuid, p_asset jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_asset public.website_assets;
  v_limit bigint;
  v_size bigint;
  v_extension text;
BEGIN
  PERFORM public.website_assert_access(p_client_id, p_actor_id);
  PERFORM 1 FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  IF p_asset IS NULL OR jsonb_typeof(p_asset) <> 'object'
    OR p_asset->>'client_id' IS DISTINCT FROM p_client_id::text
    OR p_asset->>'project_id' IS DISTINCT FROM p_project_id::text
    OR p_asset->>'status' IS DISTINCT FROM 'pending'
    OR coalesce(length(btrim(p_asset->>'name')), 0) NOT BETWEEN 1 AND 180
    OR p_asset->>'name' ~ '[\\\\/[:cntrl:]]'
    OR coalesce(p_asset->>'purpose', '') NOT IN ('content','logo','reference')
    OR coalesce((p_asset->>'width')::integer, 0) NOT BETWEEN 1 AND 12000
    OR coalesce((p_asset->>'height')::integer, 0) NOT BETWEEN 1 AND 12000
    OR (p_asset->>'width')::bigint * (p_asset->>'height')::bigint > 40000000 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  v_size := (p_asset->>'size')::bigint;
  v_extension := CASE p_asset->>'mime' WHEN 'image/png' THEN 'png' WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/webp' THEN 'webp' END;
  IF v_size IS NULL OR v_size NOT BETWEEN 1 AND 10485760 OR v_extension IS NULL OR p_asset->>'id' IS NULL
    OR p_asset->>'path' IS DISTINCT FROM p_client_id::text || '/' || p_project_id::text || '/' || (p_asset->>'id')::uuid::text || '.' || v_extension THEN
    RAISE EXCEPTION 'website_invalid_input';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_client_id::text, 0));
  SELECT coalesce((value->>'max_storage_mb')::bigint, 160) * 1048576 INTO v_limit FROM public.website_settings WHERE id = 1;
  v_limit := coalesce(v_limit, 167772160);
  IF (SELECT count(*) FROM public.website_assets WHERE client_id = p_client_id AND project_id = p_project_id) >= 20
    OR v_size > v_limit OR (SELECT coalesce(sum(size), 0) FROM public.website_assets WHERE client_id = p_client_id) > v_limit - v_size THEN
    RAISE EXCEPTION 'website_quota_exceeded';
  END IF;
  INSERT INTO public.website_assets(id, client_id, project_id, name, path, mime, size, width, height, purpose, status)
    VALUES ((p_asset->>'id')::uuid, p_client_id, p_project_id, p_asset->>'name', p_asset->>'path', p_asset->>'mime',
      v_size, (p_asset->>'width')::integer, (p_asset->>'height')::integer, p_asset->>'purpose', 'pending') RETURNING * INTO v_asset;
  RETURN to_jsonb(v_asset);
END $$;

CREATE OR REPLACE FUNCTION public.website_save_revision(
  p_client_id uuid, p_project_id uuid, p_files jsonb, p_message text, p_actor_id uuid, p_expected_revision_id uuid,
  p_run_id uuid DEFAULT NULL, p_worker_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_project public.website_projects;
  v_revision public.website_revisions;
  v_previous jsonb;
  v_fixed text;
BEGIN
  PERFORM public.website_assert_access(p_client_id, p_actor_id);
  SELECT * INTO v_project FROM public.website_projects
    WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  IF v_project.current_revision_id IS DISTINCT FROM p_expected_revision_id THEN RAISE EXCEPTION 'website_revision_conflict'; END IF;
  IF p_files IS NULL OR jsonb_typeof(p_files) <> 'object' OR octet_length(p_files::text) > 4194304
    OR p_message IS NULL OR length(btrim(p_message)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  IF (SELECT count(*) FROM jsonb_each(p_files)) NOT BETWEEN 1 AND 100 OR EXISTS (
    SELECT 1 FROM jsonb_each(p_files) f WHERE jsonb_typeof(f.value) <> 'string'
      OR octet_length(f.value #>> '{}') > 256000
      OR length(f.key) > 180
      OR f.key ~ '(^|/)\\.{1,2}(/|$)' OR f.key ~ '[\\\\%:[:space:]]'
      OR (f.key NOT IN ('index.html','package.json','tsconfig.json','vite.config.ts') AND f.key !~ '^(src|public)/[a-zA-Z0-9_./-]+$')
  ) OR (SELECT coalesce(sum(octet_length(value #>> '{}')), 0) FROM jsonb_each(p_files)) > 2000000 THEN
    RAISE EXCEPTION 'website_invalid_input';
  END IF;
  IF p_run_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.website_runs WHERE client_id = p_client_id AND project_id = p_project_id
      AND status IN ('queued','planning','editing','validating')) THEN RAISE EXCEPTION 'website_active_run'; END IF;
  ELSE
    PERFORM 1 FROM public.website_runs WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_run_id
      AND worker_id = p_worker_id AND lease_expires_at > now() AND NOT cancel_requested
      AND status IN ('planning','editing','validating') AND base_revision_id IS NOT DISTINCT FROM p_expected_revision_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'website_lease_lost'; END IF;
  END IF;
  IF v_project.current_revision_id IS NOT NULL THEN
    SELECT files INTO v_previous FROM public.website_revisions
      WHERE client_id = p_client_id AND project_id = p_project_id AND id = v_project.current_revision_id;
    FOREACH v_fixed IN ARRAY ARRAY['package.json','tsconfig.json','vite.config.ts'] LOOP
      IF p_files->v_fixed IS DISTINCT FROM v_previous->v_fixed THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
    END LOOP;
  END IF;
  INSERT INTO public.website_revisions(client_id, project_id, parent_id, message, files, hash, actor_id)
    VALUES (p_client_id, p_project_id, v_project.current_revision_id, p_message, p_files,
      encode(sha256(convert_to(p_files::text, 'UTF8')), 'hex'), p_actor_id) RETURNING * INTO v_revision;
  UPDATE public.website_projects SET current_revision_id = v_revision.id, updated_at = now()
    WHERE client_id = p_client_id AND id = p_project_id;
  RETURN to_jsonb(v_revision);
END $$;

CREATE OR REPLACE FUNCTION public.website_create_project(p_client_id uuid, p_actor_id uuid, p_project jsonb, p_files jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_project public.website_projects;
  v_max bigint;
BEGIN
  PERFORM public.website_assert_access(p_client_id, p_actor_id);
  PERFORM 1 FROM public.clients WHERE id = p_client_id FOR UPDATE;
  SELECT coalesce((value->>'max_sites')::bigint, 10) INTO v_max FROM public.website_settings WHERE id = 1;
  v_max := coalesce(v_max, 10);
  IF (SELECT count(*) FROM public.website_projects WHERE client_id = p_client_id AND deleted_at IS NULL) >= v_max THEN
    RAISE EXCEPTION 'website_quota_exceeded';
  END IF;
  INSERT INTO public.website_projects(id, client_id, name, slug, lead_id, client_context, instructions, model_mode, model_id, selected_skill_ids, cta, status)
    VALUES ((p_project->>'id')::uuid, p_client_id, p_project->>'name', p_project->>'slug', (p_project->>'lead_id')::bigint,
      coalesce(p_project->'client_context','{}'::jsonb), coalesce(p_project->>'instructions',''), coalesce(p_project->>'model_mode','auto'),
      p_project->>'model_id', ARRAY(SELECT jsonb_array_elements_text(coalesce(p_project->'selected_skill_ids','[]'::jsonb))::uuid),
      coalesce(p_project->'cta','{"type":"whatsapp","value":""}'::jsonb), coalesce(p_project->>'status','draft')) RETURNING * INTO v_project;
  PERFORM public.website_save_revision(p_client_id, v_project.id, p_files, 'Projeto criado', p_actor_id, NULL);
  SELECT * INTO v_project FROM public.website_projects WHERE client_id = p_client_id AND id = v_project.id;
  RETURN to_jsonb(v_project);
END $$;

CREATE OR REPLACE FUNCTION public.website_update_project(p_client_id uuid, p_project_id uuid, p_patch jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_project public.website_projects;
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  SELECT * INTO v_project FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  IF EXISTS (SELECT 1 FROM public.website_runs WHERE client_id = p_client_id AND project_id = p_project_id
    AND status IN ('queued','planning','editing','validating')) THEN RAISE EXCEPTION 'website_active_run'; END IF;
  IF p_patch ? 'status' AND p_patch->>'status' NOT IN ('draft','archived') THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  UPDATE public.website_projects SET
    name = coalesce(p_patch->>'name', name), slug = coalesce(p_patch->>'slug', slug),
    client_context = coalesce(p_patch->'client_context', client_context), instructions = coalesce(p_patch->>'instructions', instructions),
    model_mode = coalesce(p_patch->>'model_mode', model_mode), model_id = CASE WHEN p_patch ? 'model_id' THEN p_patch->>'model_id' ELSE model_id END,
    selected_skill_ids = CASE WHEN p_patch ? 'selected_skill_ids' THEN ARRAY(SELECT jsonb_array_elements_text(p_patch->'selected_skill_ids')::uuid) ELSE selected_skill_ids END,
    cta = coalesce(p_patch->'cta', cta), status = coalesce(p_patch->>'status', status), updated_at = now()
    WHERE client_id = p_client_id AND id = p_project_id RETURNING * INTO v_project;
  RETURN to_jsonb(v_project);
END $$;

CREATE OR REPLACE FUNCTION public.website_delete_project(p_client_id uuid, p_project_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_project public.website_projects;
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  SELECT * INTO v_project FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  UPDATE public.website_runs SET status = 'cancelled', cancel_requested = true, lease_expires_at = NULL, worker_id = NULL, updated_at = now()
    WHERE client_id = p_client_id AND project_id = p_project_id AND status IN ('queued','planning','editing','validating');
  UPDATE public.website_projects SET deleted_at = now(), updated_at = now(), status = 'archived'
    WHERE client_id = p_client_id AND id = p_project_id RETURNING * INTO v_project;
  RETURN to_jsonb(v_project);
END $$;

CREATE OR REPLACE FUNCTION public.website_queue_run(
  p_client_id uuid, p_project_id uuid, p_actor_id uuid, p_prompt text, p_model_id text DEFAULT NULL, p_asset_ids uuid[] DEFAULT '{}'
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_project public.website_projects;
  v_run public.website_runs;
  v_allowlist jsonb;
BEGIN
  PERFORM public.website_assert_access(p_client_id, p_actor_id);
  SELECT * INTO v_project FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  IF v_project.status = 'archived' OR p_prompt IS NULL OR length(btrim(p_prompt)) NOT BETWEEN 1 AND 16000 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  IF EXISTS (SELECT 1 FROM public.website_runs WHERE client_id = p_client_id AND project_id = p_project_id
    AND status IN ('queued','planning','editing','validating')) THEN RAISE EXCEPTION 'website_active_run'; END IF;
  SELECT value->'model_allowlist' INTO v_allowlist FROM public.website_settings WHERE id = 1;
  IF p_model_id IS NOT NULL AND jsonb_array_length(coalesce(v_allowlist,'[]'::jsonb)) > 0 AND NOT (v_allowlist ? p_model_id) THEN
    RAISE EXCEPTION 'website_invalid_input';
  END IF;
  PERFORM public.website_consume_quota(p_client_id, 'runs', 1);
  INSERT INTO public.website_runs(client_id, project_id, actor_id, prompt, model_id, base_revision_id, asset_ids)
    VALUES (p_client_id, p_project_id, p_actor_id, p_prompt, p_model_id, v_project.current_revision_id, p_asset_ids) RETURNING * INTO v_run;
  INSERT INTO public.website_messages(client_id, project_id, run_id, role, content) VALUES (p_client_id, p_project_id, v_run.id, 'user', p_prompt);
  RETURN to_jsonb(v_run);
END $$;

CREATE OR REPLACE FUNCTION public.website_claim_run(
  p_client_id uuid, p_project_id uuid, p_run_id uuid, p_worker_id uuid, p_lease_seconds integer DEFAULT 120
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_run public.website_runs;
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_worker_id IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  PERFORM 1 FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  UPDATE public.website_runs SET status = 'failed', error = 'A concessão da execução expirou.', worker_id = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_run_id
      AND status IN ('planning','editing','validating') AND (lease_expires_at IS NULL OR lease_expires_at <= now());
  IF FOUND THEN PERFORM public.website_liquidate_run_reservations(p_client_id, p_run_id); END IF;
  UPDATE public.website_runs SET status = 'planning', worker_id = p_worker_id,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds), attempts = attempts + 1, updated_at = now()
    WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_run_id AND NOT cancel_requested AND status = 'queued'
    RETURNING * INTO v_run;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN to_jsonb(v_run);
END $$;

CREATE OR REPLACE FUNCTION public.website_heartbeat_run(
  p_client_id uuid, p_project_id uuid, p_run_id uuid, p_worker_id uuid, p_status text DEFAULT 'editing', p_lease_seconds integer DEFAULT 120
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_run public.website_runs;
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_status NOT IN ('planning','editing','validating') OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  UPDATE public.website_runs SET status = p_status, lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
    WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_run_id AND worker_id = p_worker_id
      AND lease_expires_at > now() AND NOT cancel_requested AND status IN ('planning','editing','validating') RETURNING * INTO v_run;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_lease_lost'; END IF;
  RETURN to_jsonb(v_run);
END $$;

CREATE OR REPLACE FUNCTION public.website_cancel_run(p_client_id uuid, p_project_id uuid, p_run_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_run public.website_runs;
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  PERFORM 1 FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  SELECT * INTO v_run FROM public.website_runs WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  IF v_run.status IN ('queued','planning','editing','validating') THEN
    UPDATE public.website_runs SET status = 'cancelled', cancel_requested = true, worker_id = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_run_id RETURNING * INTO v_run;
    PERFORM public.website_liquidate_run_reservations(p_client_id, p_run_id);
  END IF;
  RETURN to_jsonb(v_run);
END $$;

CREATE OR REPLACE FUNCTION public.website_finish_run(
  p_client_id uuid, p_project_id uuid, p_run_id uuid, p_worker_id uuid, p_status text, p_message text, p_files jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_run public.website_runs;
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_status NOT IN ('completed','failed') OR p_message IS NULL OR length(p_message) > 64000 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  PERFORM 1 FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  SELECT * INTO v_run FROM public.website_runs WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_run_id
    AND worker_id = p_worker_id AND lease_expires_at > now() AND NOT cancel_requested AND status IN ('planning','editing','validating') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_lease_lost'; END IF;
  IF p_status = 'completed' AND p_files IS NOT NULL THEN
    PERFORM public.website_save_revision(p_client_id, p_project_id, p_files, 'Edição pelo agente', v_run.actor_id, v_run.base_revision_id, p_run_id, p_worker_id);
  END IF;
  UPDATE public.website_runs SET status = p_status, worker_id = NULL, lease_expires_at = NULL, updated_at = now(),
    error = CASE WHEN p_status = 'failed' THEN 'A execução falhou.' ELSE NULL END
    WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_run_id RETURNING * INTO v_run;
  PERFORM public.website_liquidate_run_reservations(p_client_id, p_run_id);
  INSERT INTO public.website_messages(client_id, project_id, run_id, role, content)
    VALUES (p_client_id, p_project_id, p_run_id, 'assistant', CASE WHEN p_status = 'failed' THEN 'Não foi possível concluir a execução.' ELSE p_message END);
  RETURN to_jsonb(v_run);
END $$;

-- ===== Extensões de contrato: kinds de run, idempotência e rate limit =====

ALTER TABLE public.website_runs
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'build'));

ALTER TABLE public.website_deployments
  ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.website_deployments DROP CONSTRAINT IF EXISTS website_deployments_phase_check;
ALTER TABLE public.website_deployments ADD CONSTRAINT website_deployments_phase_check
  CHECK (phase IN ('reserved', 'version_creating', 'version_ready', 'activating'));
CREATE UNIQUE INDEX IF NOT EXISTS website_deployments_idempotency
  ON public.website_deployments(client_id, project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.website_form_submissions
  ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS website_form_submissions_idempotency
  ON public.website_form_submissions(client_id, project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.website_rate_limits (
  key text PRIMARY KEY CHECK (length(key) BETWEEN 3 AND 200),
  window_start timestamptz NOT NULL DEFAULT now(),
  count bigint NOT NULL DEFAULT 1 CHECK (count >= 0)
);

CREATE OR REPLACE FUNCTION public.website_rate_limit("key" text, "limit" integer DEFAULT NULL, "window_seconds" integer DEFAULT 600) RETURNS boolean
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_limit bigint; v_count bigint;
BEGIN
  IF "key" IS NULL OR length("key") NOT BETWEEN 3 AND 200 OR "window_seconds" IS NULL
    OR "window_seconds" NOT BETWEEN 1 AND 2592000 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  v_limit := GREATEST(coalesce("limit", 0), 0);
  IF v_limit <= 0 THEN RETURN false; END IF;
  INSERT INTO public.website_rate_limits AS r (key, window_start, count) VALUES (website_rate_limit."key", now(), 1)
    ON CONFLICT ON CONSTRAINT website_rate_limits_pkey DO UPDATE SET
      count = CASE WHEN now() >= r.window_start + make_interval(secs => "window_seconds") THEN 1 ELSE r.count + 1 END,
      window_start = CASE WHEN now() >= r.window_start + make_interval(secs => "window_seconds") THEN now() ELSE r.window_start END
    WHERE CASE WHEN now() >= r.window_start + make_interval(secs => "window_seconds") THEN 0 ELSE r.count END < v_limit
      RETURNING count INTO v_count;
  IF random() < 0.01 THEN DELETE FROM public.website_rate_limits WHERE window_start < now() - interval '35 days'; END IF;
  RETURN v_count IS NOT NULL AND v_count <= v_limit;
END $$;

CREATE OR REPLACE FUNCTION public.website_claim_next_run(p_worker_id uuid, p_lease_seconds integer DEFAULT 120) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_run public.website_runs;
BEGIN
  IF p_worker_id IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  INSERT INTO public.website_workers(id, last_seen_at) VALUES (p_worker_id, now())
    ON CONFLICT (id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at;
  UPDATE public.website_runs r SET status = 'failed', error = 'A concessão da execução expirou.',
    worker_id = NULL, lease_expires_at = NULL, updated_at = now()
    FROM (SELECT id FROM public.website_runs WHERE status IN ('planning','editing','validating')
      AND (lease_expires_at IS NULL OR lease_expires_at <= now()) FOR UPDATE SKIP LOCKED) e
    WHERE r.id = e.id;
  UPDATE public.website_usage u SET settled_at = now(),
    quantity = greatest(u.quantity, coalesce((u.metadata->'usage'->>'totalTokens')::bigint, 0))
    FROM public.website_runs r
    WHERE u.client_id = r.client_id AND u.run_id = r.id AND u.kind = 'tokens'
      AND u.reserved_tokens > 0 AND u.settled_at IS NULL
      AND r.status IN ('completed','failed','cancelled');
  UPDATE public.website_usage res SET settled_at = now()
    WHERE res.kind = 'tokens' AND res.reserved_tokens > 0 AND res.settled_at IS NULL
      AND res.run_id IS NULL AND res.created_at < now() - interval '15 minutes';
  UPDATE public.website_usage img SET quantity = 1, settled_at = now()
    FROM public.website_usage res
    WHERE res.kind = 'tokens' AND res.settled_at IS NOT NULL AND res.run_id IS NULL
      AND img.id = (res.metadata->>'images_row')::uuid AND img.kind = 'images' AND img.settled_at IS NULL;
  WITH candidates AS (
    SELECT r.client_id, r.project_id, r.id FROM public.website_runs r
    JOIN public.website_projects p ON p.client_id = r.client_id AND p.id = r.project_id AND p.deleted_at IS NULL AND p.status <> 'archived'
    JOIN public.clients c ON c.id = r.client_id AND c.is_active AND (c.is_admin OR c.features->'sites' = 'true'::jsonb)
    WHERE NOT r.cancel_requested AND r.status = 'queued'
    ORDER BY r.created_at, r.id LIMIT 1 FOR UPDATE OF p, r SKIP LOCKED
  )
  UPDATE public.website_runs r SET status = 'planning', worker_id = p_worker_id,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds), attempts = attempts + 1, updated_at = now()
  FROM candidates c
  WHERE r.client_id = c.client_id AND r.project_id = c.project_id AND r.id = c.id
    AND NOT r.cancel_requested AND r.status = 'queued'
  RETURNING r.* INTO v_run;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN to_jsonb(v_run);
END $$;

CREATE OR REPLACE FUNCTION public.website_worker_health() RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.website_workers WHERE last_seen_at > now() - interval '30 seconds')
    OR EXISTS (SELECT 1 FROM public.website_runs WHERE status IN ('planning','editing','validating')
      AND worker_id IS NOT NULL AND lease_expires_at > now());
$$;

CREATE OR REPLACE FUNCTION public.website_queue_build(
  p_client_id uuid, p_project_id uuid, p_actor_id uuid, p_expected_revision_id uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_project public.website_projects; v_run public.website_runs;
BEGIN
  PERFORM public.website_assert_access(p_client_id, p_actor_id);
  SELECT * INTO v_project FROM public.website_projects
    WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  IF v_project.status = 'archived' OR v_project.current_revision_id IS NULL
    OR p_expected_revision_id IS NULL OR v_project.current_revision_id <> p_expected_revision_id THEN
    RAISE EXCEPTION 'website_revision_conflict';
  END IF;
  IF EXISTS (SELECT 1 FROM public.website_runs WHERE client_id = p_client_id AND project_id = p_project_id
    AND status IN ('queued','planning','editing','validating')) THEN RAISE EXCEPTION 'website_active_run'; END IF;
  IF (SELECT coalesce(sum(quantity), 0) FROM public.website_usage WHERE client_id = p_client_id AND kind = 'builds'
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
    >= coalesce((SELECT (value->>'max_builds_per_day')::bigint FROM public.website_settings WHERE id = 1), 20) THEN
    RAISE EXCEPTION 'website_quota_exceeded';
  END IF;
  INSERT INTO public.website_runs(client_id, project_id, actor_id, kind, prompt, base_revision_id, asset_ids)
    VALUES (p_client_id, p_project_id, p_actor_id, 'build', 'Build de validação do site.', v_project.current_revision_id, '{}')
    RETURNING * INTO v_run;
  RETURN to_jsonb(v_run);
END $$;

CREATE OR REPLACE FUNCTION public.website_complete_run(
  p_client_id uuid, p_project_id uuid, p_run_id uuid, p_worker_id uuid,
  p_expected_revision_id uuid, p_files jsonb, p_build jsonb, p_summary text, p_model_used text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_run public.website_runs;
  v_revision jsonb;
  v_revision_id uuid;
  v_status text; v_success boolean; v_logs text; v_duration integer;
  v_artifact jsonb; v_errors jsonb; v_warnings jsonb; v_screens jsonb; v_qa jsonb;
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_summary IS NULL OR length(btrim(p_summary)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  PERFORM 1 FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL FOR UPDATE;
  SELECT * INTO v_run FROM public.website_runs WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_run_id
    AND worker_id = p_worker_id AND lease_expires_at > now() AND cancel_requested = false
    AND status IN ('planning','editing','validating') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_lease_lost'; END IF;
  IF v_run.base_revision_id IS DISTINCT FROM p_expected_revision_id THEN RAISE EXCEPTION 'website_lease_lost'; END IF;
  v_revision_id := v_run.base_revision_id;
  IF v_run.kind = 'agent' THEN
    IF p_files IS NULL THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
    v_revision := public.website_save_revision(p_client_id, p_project_id, p_files, 'Edição pelo agente',
      v_run.actor_id, p_expected_revision_id, p_run_id, p_worker_id);
    v_revision_id := (v_revision->>'id')::uuid;
  END IF;
  IF p_build IS NULL OR jsonb_typeof(p_build) <> 'object' OR octet_length(p_build::text) > 83886080
    OR length(p_model_used) > 160 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  v_status := coalesce(p_build->>'status', 'failed');
  IF v_status NOT IN ('ready','failed','unconfigured') THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  v_success := coalesce((p_build->>'success')::boolean, false);
  v_logs := left(coalesce(p_build->>'logs', ''), 100000);
  v_duration := coalesce((p_build->>'duration_ms')::integer, 0);
  v_artifact := coalesce(p_build->'artifact', '{}'::jsonb);
  v_errors := coalesce(p_build->'errors', '[]'::jsonb);
  v_warnings := coalesce(p_build->'warnings', '[]'::jsonb);
  v_screens := coalesce(p_build->'screenshots', '{}'::jsonb);
  v_qa := coalesce(p_build->'qa', '{"passed":false,"errors":[],"warnings":[]}'::jsonb);
  IF jsonb_typeof(v_artifact) <> 'object' OR octet_length(v_artifact::text) > 58720256
    OR jsonb_typeof(v_screens) <> 'object' OR octet_length(v_screens::text) > 25165824
    OR jsonb_typeof(v_qa) <> 'object' OR octet_length(v_qa::text) > 262144
    OR (jsonb_typeof(v_errors) <> 'array' AND v_errors <> '[]'::jsonb)
    OR (jsonb_typeof(v_warnings) <> 'array' AND v_warnings <> '[]'::jsonb)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_errors) = 'array' THEN v_errors ELSE '[]'::jsonb END) e WHERE jsonb_typeof(e) <> 'string' OR length(e #>> '{}') > 1000)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_warnings) = 'array' THEN v_warnings ELSE '[]'::jsonb END) w WHERE jsonb_typeof(w) <> 'string' OR length(w #>> '{}') > 1000)
  THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  INSERT INTO public.website_builds(client_id, project_id, revision_id, status, success, logs, duration_ms, artifact, errors, warnings, screenshots, qa)
    VALUES (p_client_id, p_project_id, v_revision_id, v_status, v_success, v_logs, GREATEST(v_duration, 0), v_artifact, v_errors, v_warnings, v_screens, v_qa);
  UPDATE public.website_runs SET status = 'completed', model_used = p_model_used, worker_id = NULL, lease_expires_at = NULL, error = NULL, updated_at = now()
    WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_run_id RETURNING * INTO v_run;
  PERFORM public.website_liquidate_run_reservations(p_client_id, p_run_id);
  INSERT INTO public.website_messages(client_id, project_id, run_id, role, content)
    VALUES (p_client_id, p_project_id, p_run_id, 'assistant', p_summary);
  RETURN to_jsonb(v_run);
END $$;

CREATE OR REPLACE FUNCTION public.website_begin_deployment(
  p_client_id uuid, p_project_id uuid, p_build_id uuid, p_rollback_id uuid,
  p_expected_revision_id uuid, p_idempotency_key text, p_hostname text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_project public.website_projects;
  v_build public.website_builds;
  v_deployment public.website_deployments;
  v_rollback public.website_deployments;
  v_deployment_id uuid := gen_random_uuid();
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_-]{16,128}$'
    OR p_hostname IS NULL OR length(p_hostname) > 253
    OR p_hostname !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
    OR p_build_id IS NULL OR p_expected_revision_id IS NULL THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  SELECT * INTO v_project FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  SELECT * INTO v_deployment FROM public.website_deployments
    WHERE client_id = p_client_id AND project_id = p_project_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF (v_deployment.build_id, v_deployment.rollback_id, v_deployment.hostname)
      IS DISTINCT FROM (p_build_id, p_rollback_id, p_hostname) THEN RAISE EXCEPTION 'website_idempotency_conflict'; END IF;
    RETURN to_jsonb(v_deployment);
  END IF;
  IF v_project.status = 'archived' OR v_project.current_revision_id IS DISTINCT FROM p_expected_revision_id THEN
    RAISE EXCEPTION 'website_revision_conflict';
  END IF;
  IF EXISTS (SELECT 1 FROM public.website_runs WHERE client_id = p_client_id AND project_id = p_project_id
    AND status IN ('queued','planning','editing','validating')) THEN RAISE EXCEPTION 'website_active_run'; END IF;
  IF EXISTS (SELECT 1 FROM public.website_deployments WHERE client_id = p_client_id AND project_id = p_project_id
    AND status = 'deploying') THEN RAISE EXCEPTION 'website_active_deployment'; END IF;
  SELECT * INTO v_build FROM public.website_builds WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_build_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  IF p_rollback_id IS NOT NULL THEN
    SELECT * INTO v_rollback FROM public.website_deployments WHERE client_id = p_client_id AND project_id = p_project_id
      AND id = p_rollback_id AND build_id = p_build_id AND status = 'published' AND provider = 'cloudflare' AND provider_id IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  ELSIF v_build.revision_id IS DISTINCT FROM p_expected_revision_id THEN
    RAISE EXCEPTION 'website_revision_conflict';
  END IF;
  IF NOT v_build.success OR v_build.status <> 'ready' OR v_build.errors IS DISTINCT FROM '[]'::jsonb
    OR v_build.qa->'passed' IS DISTINCT FROM 'true'::jsonb OR v_build.qa->'errors' IS DISTINCT FROM '[]'::jsonb
    OR coalesce(length(btrim(v_build.qa->>'visual_review')), 0) = 0
    OR coalesce(v_build.screenshots->>'desktop', '') NOT LIKE 'data:image/png;base64,iVBOR%'
    OR coalesce(v_build.screenshots->>'mobile', '') NOT LIKE 'data:image/png;base64,iVBOR%'
    OR NOT (v_build.artifact ? '/index.html') THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  INSERT INTO public.website_domains(client_id, project_id, hostname) VALUES (p_client_id, p_project_id, p_hostname)
    ON CONFLICT (hostname) DO NOTHING;
  PERFORM 1 FROM public.website_domains WHERE client_id = p_client_id AND project_id = p_project_id AND hostname = p_hostname FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_domain_conflict'; END IF;
  PERFORM public.website_consume_quota(p_client_id, 'deploys', 1, jsonb_build_object('deployment_id', v_deployment_id));
  INSERT INTO public.website_deployments(id, client_id, project_id, build_id, expected_revision_id, rollback_id, idempotency_key, hostname,
    phase, provider_id, provider_version_id)
    VALUES (v_deployment_id, p_client_id, p_project_id, p_build_id, p_expected_revision_id, p_rollback_id, p_idempotency_key, p_hostname,
      CASE WHEN p_rollback_id IS NULL THEN 'reserved' ELSE 'version_ready' END, v_rollback.provider_id, v_rollback.provider_id)
    RETURNING * INTO v_deployment;
  RETURN to_jsonb(v_deployment);
END $$;

CREATE OR REPLACE FUNCTION public.website_list_recoverable_deployments(p_after_id uuid DEFAULT NULL)
RETURNS TABLE(client_id uuid, project_id uuid, id uuid)
LANGUAGE sql SET search_path = public, pg_temp AS $$
  SELECT d.client_id, d.project_id, d.id FROM public.website_deployments d
  JOIN public.website_projects p ON p.client_id = d.client_id AND p.id = d.project_id AND p.deleted_at IS NULL AND p.status <> 'archived'
  JOIN public.clients c ON c.id = d.client_id AND c.is_active AND (c.is_admin OR c.features->'sites' = 'true'::jsonb)
  WHERE d.status = 'deploying' AND d.provider = 'cloudflare'
    AND (d.claim_id IS NULL OR d.lease_expires_at <= clock_timestamp())
    AND (p_after_id IS NULL OR d.id > p_after_id)
  ORDER BY d.id ASC LIMIT 5;
$$;

CREATE OR REPLACE FUNCTION public.website_claim_deployment(
  p_client_id uuid, p_project_id uuid, p_deployment_id uuid, p_claim_id uuid, p_lease_seconds integer DEFAULT 300
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_deployment public.website_deployments;
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_claim_id IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  PERFORM 1 FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL AND status <> 'archived' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  UPDATE public.website_deployments SET claim_id = p_claim_id, lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_deployment_id AND status = 'deploying'
      AND (claim_id IS NULL OR lease_expires_at <= clock_timestamp()) RETURNING * INTO v_deployment;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN to_jsonb(v_deployment);
END $$;

CREATE OR REPLACE FUNCTION public.website_renew_deployment(
  p_client_id uuid, p_project_id uuid, p_deployment_id uuid, p_claim_id uuid, p_lease_seconds integer DEFAULT 300
) RETURNS boolean LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_claim_id IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  PERFORM 1 FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL AND status <> 'archived' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  UPDATE public.website_deployments SET lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_deployment_id AND status = 'deploying'
      AND claim_id = p_claim_id AND lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'website_lease_lost'; END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.website_checkpoint_deployment(
  p_client_id uuid, p_project_id uuid, p_deployment_id uuid, p_claim_id uuid, p_provider_id text, p_phase text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_deployment public.website_deployments;
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_phase IS NULL OR p_phase NOT IN ('version_creating','version_ready','activating')
    OR (p_phase = 'version_creating' AND p_provider_id IS NOT NULL)
    OR (p_phase <> 'version_creating' AND (p_provider_id IS NULL OR p_provider_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))
    THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  PERFORM 1 FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  SELECT * INTO v_deployment FROM public.website_deployments WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_deployment_id
    AND claim_id = p_claim_id AND lease_expires_at > clock_timestamp() AND status = 'deploying' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_lease_lost'; END IF;
  IF (v_deployment.provider_id IS NOT NULL AND v_deployment.provider_id IS DISTINCT FROM p_provider_id)
    OR (v_deployment.phase = 'reserved' AND p_phase <> 'version_creating')
    OR (v_deployment.phase = 'version_creating' AND p_phase <> 'version_ready')
    OR (v_deployment.phase = 'version_ready' AND p_phase <> 'activating')
    OR v_deployment.phase = 'activating' THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  UPDATE public.website_deployments SET provider_id = p_provider_id, provider_version_id = p_provider_id, phase = p_phase,
    lease_expires_at = clock_timestamp() + interval '300 seconds'
    WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_deployment_id RETURNING * INTO v_deployment;
  RETURN to_jsonb(v_deployment);
END $$;

CREATE OR REPLACE FUNCTION public.website_finish_deployment(
  p_client_id uuid, p_project_id uuid, p_deployment_id uuid, p_claim_id uuid, p_status text, p_error text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_project public.website_projects; v_deployment public.website_deployments;
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_status IS NULL OR p_status NOT IN ('published','deploying','failed') OR length(p_error) > 4000 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  SELECT * INTO v_project FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  SELECT * INTO v_deployment FROM public.website_deployments WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_deployment_id
    AND claim_id = p_claim_id AND lease_expires_at > clock_timestamp() AND status = 'deploying' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_lease_lost'; END IF;
  IF p_status = 'failed' AND (v_deployment.phase = 'activating' OR coalesce(length(btrim(p_error)), 0) = 0) THEN
    RAISE EXCEPTION 'website_invalid_input';
  END IF;
  IF p_status = 'published' THEN
    IF v_project.current_revision_id IS DISTINCT FROM v_deployment.expected_revision_id THEN RAISE EXCEPTION 'website_revision_conflict'; END IF;
    IF v_deployment.phase <> 'activating' OR v_deployment.provider_id IS NULL THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  END IF;
  UPDATE public.website_deployments SET status = p_status, claim_id = NULL, lease_expires_at = NULL,
    error = CASE WHEN p_status = 'published' THEN NULL ELSE p_error END,
    url = CASE WHEN p_status = 'published' THEN 'https://' || hostname ELSE url END
    WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_deployment_id RETURNING * INTO v_deployment;
  IF p_status = 'failed' THEN
    UPDATE public.website_usage SET quantity = 0, settled_at = now(), metadata = metadata || '{"refunded":true}'::jsonb
      WHERE client_id = p_client_id AND kind = 'deploys' AND settled_at IS NULL
        AND metadata->>'deployment_id' = p_deployment_id::text;
  END IF;
  IF p_status = 'published' THEN
    UPDATE public.website_projects SET published_deployment_id = p_deployment_id, published_url = v_deployment.url,
      last_published_at = now(), status = 'published', updated_at = now() WHERE client_id = p_client_id AND id = p_project_id;
    UPDATE public.website_domains SET status = 'active' WHERE client_id = p_client_id AND project_id = p_project_id AND hostname = v_deployment.hostname;
  END IF;
  RETURN to_jsonb(v_deployment);
END $$;

CREATE OR REPLACE FUNCTION public.website_submit_form(
  p_client_id uuid, p_project_id uuid, p_idempotency_key text, p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_project public.website_projects;
  v_submission public.website_form_submissions;
  v_name text; v_email text; v_phone text; v_message text; v_remote text; v_lead_id bigint;
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_-]{16,128}$'
    OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  v_name := coalesce(p_payload->>'name', '');
  v_email := coalesce(p_payload->>'email', '');
  v_phone := coalesce(p_payload->>'phone', '');
  v_message := coalesce(p_payload->>'message', '');
  IF length(btrim(v_name)) NOT BETWEEN 2 AND 120 OR length(v_email) > 254 OR length(v_phone) > 30 OR length(v_message) > 3000
    OR p_payload->'consent' IS DISTINCT FROM 'true'::jsonb
    OR (v_phone = '' AND v_email = '') THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  SELECT * INTO v_project FROM public.website_projects
    WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL AND status = 'published' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
  SELECT * INTO v_submission FROM public.website_form_submissions
    WHERE client_id = p_client_id AND project_id = p_project_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF (v_submission.name, coalesce(v_submission.email, ''), coalesce(v_submission.phone, ''), v_submission.message)
      IS DISTINCT FROM (v_name, v_email, v_phone, v_message) THEN
      RAISE EXCEPTION 'website_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN to_jsonb(v_submission);
  END IF;
  v_remote := regexp_replace(v_phone, '\\D', '', 'g');
  IF v_phone <> '' AND length(v_remote) NOT BETWEEN 10 AND 15 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  IF v_phone <> '' THEN
    v_remote := v_remote || '@s.whatsapp.net';
    INSERT INTO public.leads_extraidos(client_id, nome_negocio, telefone, email, "remoteJid", status, observacoes,
      primeiro_contato_source, primeiro_contato_at, website_project_id)
      VALUES (p_client_id, v_name, v_phone, nullif(v_email, ''), v_remote, 'novo', 'Lead originado pelo formulário do Site Studio.',
        'website', now(), p_project_id)
      ON CONFLICT (client_id, "remoteJid") DO NOTHING RETURNING id INTO v_lead_id;
    IF v_lead_id IS NULL THEN
      SELECT id INTO v_lead_id FROM public.leads_extraidos WHERE client_id = p_client_id AND "remoteJid" = v_remote FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'website_not_found'; END IF;
    END IF;
  END IF;
  INSERT INTO public.website_form_submissions(client_id, project_id, deployment_id, name, email, phone, message, consent, idempotency_key, lead_id)
    VALUES (p_client_id, p_project_id, v_project.published_deployment_id, v_name, nullif(v_email, ''), nullif(v_phone, ''), v_message, true, p_idempotency_key, v_lead_id)
    RETURNING * INTO v_submission;
  RETURN to_jsonb(v_submission);
END $$;

INSERT INTO public.website_settings(id, value) VALUES (1, '{"creative_prompt":"","max_sites":10,"max_runs_per_day":30,"max_builds_per_day":20,"max_deploys_per_day":10,"max_storage_mb":160,"max_images_per_day":0,"max_tokens_per_month":1000000,"model_allowlist":[],"quality_model":"","economy_model":"","image_model":"","image_generation_enabled":false,"base_domain":""}'::jsonb)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE v_table text; v_function regprocedure; v_role text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['website_settings','website_skills','website_prompt_versions','website_projects','website_revisions',
    'website_assets','website_runs','website_messages','website_builds','website_deployments',
    'website_domains','website_form_submissions','website_usage','website_rate_limits','website_workers'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', v_table);
    FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', v_table, v_role);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', v_table);
    END IF;
  END LOOP;
  FOR v_function IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'website\\_%' ESCAPE '\\' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_function);
    FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_function, v_role);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_function);
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
      VALUES ('website-assets', 'website-assets', false, 10485760, ARRAY['image/png','image/jpeg','image/webp','image/gif','image/svg+xml'])
      ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;
    IF to_regclass('storage.objects'::text) IS NOT NULL THEN
      DROP POLICY IF EXISTS website_assets_private ON storage.objects;
      EXECUTE 'CREATE POLICY website_assets_private ON storage.objects AS RESTRICTIVE FOR ALL TO PUBLIC
        USING (bucket_id <> ''website-assets'') WITH CHECK (bucket_id <> ''website-assets'')';
    END IF;
  END IF;
END $$;

COMMIT;


-- Incremental defense: failed agent output must never replace the working revision.
-- Apply after 016. No table/schema changes and no SECURITY DEFINER elevation.
BEGIN;

CREATE OR REPLACE FUNCTION public.website_complete_run(
  p_client_id uuid, p_project_id uuid, p_run_id uuid, p_worker_id uuid,
  p_expected_revision_id uuid, p_files jsonb, p_build jsonb, p_summary text, p_model_used text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_run public.website_runs;
  v_revision jsonb;
  v_revision_id uuid;
  v_status text; v_success boolean; v_logs text; v_duration integer;
  v_artifact jsonb; v_errors jsonb; v_warnings jsonb; v_screens jsonb; v_qa jsonb;
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_summary IS NULL OR length(btrim(p_summary)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  PERFORM 1 FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL FOR UPDATE;
  SELECT * INTO v_run FROM public.website_runs WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_run_id
    AND worker_id = p_worker_id AND lease_expires_at > now() AND cancel_requested = false
    AND status IN ('planning','editing','validating') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_lease_lost'; END IF;
  IF v_run.base_revision_id IS DISTINCT FROM p_expected_revision_id THEN RAISE EXCEPTION 'website_lease_lost'; END IF;
  v_revision_id := v_run.base_revision_id;
  IF p_build IS NULL OR jsonb_typeof(p_build) <> 'object' OR octet_length(p_build::text) > 83886080
    OR length(p_model_used) > 160 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  v_status := coalesce(p_build->>'status', 'failed');
  IF v_status NOT IN ('ready','failed','unconfigured') THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  v_success := coalesce((p_build->>'success')::boolean, false);
  v_logs := left(coalesce(p_build->>'logs', ''), 100000);
  v_duration := coalesce((p_build->>'duration_ms')::integer, 0);
  v_artifact := coalesce(p_build->'artifact', '{}'::jsonb);
  v_errors := coalesce(p_build->'errors', '[]'::jsonb);
  v_warnings := coalesce(p_build->'warnings', '[]'::jsonb);
  v_screens := coalesce(p_build->'screenshots', '{}'::jsonb);
  v_qa := coalesce(p_build->'qa', '{"passed":false,"errors":[],"warnings":[]}'::jsonb);
  IF jsonb_typeof(v_artifact) <> 'object' OR octet_length(v_artifact::text) > 58720256
    OR jsonb_typeof(v_screens) <> 'object' OR octet_length(v_screens::text) > 25165824
    OR jsonb_typeof(v_qa) <> 'object' OR octet_length(v_qa::text) > 262144
    OR (jsonb_typeof(v_errors) <> 'array' AND v_errors <> '[]'::jsonb)
    OR (jsonb_typeof(v_warnings) <> 'array' AND v_warnings <> '[]'::jsonb)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_errors) = 'array' THEN v_errors ELSE '[]'::jsonb END) e WHERE jsonb_typeof(e) <> 'string' OR length(e #>> '{}') > 1000)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_warnings) = 'array' THEN v_warnings ELSE '[]'::jsonb END) w WHERE jsonb_typeof(w) <> 'string' OR length(w #>> '{}') > 1000)
  THEN RAISE EXCEPTION 'website_invalid_input'; END IF;

  -- Build-only runs retain their report, including a failed QA, without saving files.
  -- An explicit unconfigured result is a deliberate, unvalidated draft, never a ready build.
  IF v_run.kind = 'agent' THEN
    IF p_files IS NULL OR v_status = 'failed'
      OR (v_status = 'unconfigured' AND (p_build->'success' IS DISTINCT FROM 'false'::jsonb
        OR v_qa->'passed' IS DISTINCT FROM 'false'::jsonb))
      OR (v_status = 'ready' AND (p_build->'success' IS DISTINCT FROM 'true'::jsonb
        OR v_errors IS DISTINCT FROM '[]'::jsonb
        OR v_qa->'passed' IS DISTINCT FROM 'true'::jsonb
        OR v_qa->'errors' IS DISTINCT FROM '[]'::jsonb
        OR coalesce(v_screens->>'desktop', '') NOT LIKE 'data:image/png;base64,iVBOR%'
        OR coalesce(v_screens->>'mobile', '') NOT LIKE 'data:image/png;base64,iVBOR%'
        OR NOT (v_artifact ? '/index.html'))) THEN
      RAISE EXCEPTION 'website_invalid_input';
    END IF;
    v_revision := public.website_save_revision(p_client_id, p_project_id, p_files, 'Edição pelo agente',
      v_run.actor_id, p_expected_revision_id, p_run_id, p_worker_id);
    v_revision_id := (v_revision->>'id')::uuid;
  END IF;

  INSERT INTO public.website_builds(client_id, project_id, revision_id, status, success, logs, duration_ms, artifact, errors, warnings, screenshots, qa)
    VALUES (p_client_id, p_project_id, v_revision_id, v_status, v_success, v_logs, GREATEST(v_duration, 0), v_artifact, v_errors, v_warnings, v_screens, v_qa);
  UPDATE public.website_runs SET status = 'completed', model_used = p_model_used, worker_id = NULL, lease_expires_at = NULL, error = NULL, updated_at = now()
    WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_run_id RETURNING * INTO v_run;
  PERFORM public.website_liquidate_run_reservations(p_client_id, p_run_id);
  INSERT INTO public.website_messages(client_id, project_id, run_id, role, content)
    VALUES (p_client_id, p_project_id, p_run_id, 'assistant', p_summary);
  RETURN to_jsonb(v_run);
END $$;

-- CREATE OR REPLACE retains grants on installed databases. Explicitly harden fresh setups too.
REVOKE ALL ON FUNCTION public.website_complete_run(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text) FROM PUBLIC;
DO $$
DECLARE v_role text;
BEGIN
  FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.website_complete_run(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text) FROM %I', v_role);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.website_complete_run(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text) TO service_role;
  END IF;
END $$;

COMMIT;


-- Migration: Ativar Impeccable Design como skill global
-- Este módulo força design autoral e anti-template em todos os projetos

BEGIN;

-- Inserir a skill Impeccable Design como global (client_id = NULL)
-- Usando um UUID fixo determinístico derivado do slug
INSERT INTO public.website_skills (
  id,
  client_id,
  name,
  slug,
  description,
  instructions,
  category,
  tags,
  priority,
  trigger_mode,
  is_enabled,
  is_builtin,
  version
) VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid, -- UUID fixo para builtin
  NULL,
  'Impeccable Design (Anti-AI)',
  'impeccable-design',
  'Sistema de design profissional anti-template com 15 módulos de referência: briefing, direção visual, tipografia, layout, cor, imagens, movimento, interação, responsividade, acessibilidade, conteúdo e revisão visual. Força design autoral único para cada projeto.',
  'Sistema ativo. Referências especializadas injetadas automaticamente pelo runtime conforme o contexto. Não repita as instruções completas aqui; o agent.ts já carrega composeImpeccableGuidance() com todos os 15 módulos oficiais.',
  'design',
  ARRAY['design', 'visual', 'autoral', 'profissional', 'anti-template', 'ui', 'ux', 'tipografia', 'cor', 'layout', 'responsivo', 'acessibilidade'],
  100, -- Prioridade máxima
  'always', -- Sempre ativo
  true,
  true, -- É builtin
  1
) ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  trigger_mode = EXCLUDED.trigger_mode,
  is_enabled = EXCLUDED.is_enabled,
  priority = EXCLUDED.priority,
  tags = EXCLUDED.tags,
  updated_at = now();

COMMIT;
`;
